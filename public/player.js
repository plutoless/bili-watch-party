const pollMs = 200;
const driftCheckMs = 100;
const startSnapshotLeadMs = 2 * pollMs;
const stallConfirmMs = 200;
const playbackProbeMs = 1000;
const alignmentTolerance = 0.05;
const initialDriftSeekLeadMs = 200;
const maxStartLeadMs = 650;
const legacyRecoveryBatchSize = 32;
const seatNames = { host: '房主', visitor: '访客' };
const seats = Object.keys(seatNames);
const describeSeats = roles => roles.map(role => seatNames[role]).join('和');

function formatTime(seconds) {
  const whole = Math.floor(seconds || 0);
  return Math.floor(whole / 60) + ':' + String(whole % 60).padStart(2, '0');
}

export function createPageFullscreen() {
  const page = document.getElementById('player');
  const button = document.getElementById('fullscreen');
  const reveal = document.getElementById('reveal-playback-controls');
  const actions = document.getElementById('playback-actions');
  const video = document.getElementById('video');
  const outside = [...page.parentElement.children, ...page.closest('main').children]
    .filter(element => !element.contains(page));
  // The room renders its own controls. Disable the preset that installs local playback gestures.
  const Player = window.Player;
  const xgplayer = new Player({
    el: page, mediaEl: video, presets: [class RoomPreset {}], controls: false,
    width: 0, height: 0, videoInit: false, loop: false,
  });
  let hideTimer;

  function showControls() {
    clearTimeout(hideTimer);
    hideTimer = undefined;
    actions.hidden = false;
    if (!xgplayer.cssfullscreen || video.paused) return;
    hideTimer = setTimeout(() => {
      hideTimer = undefined;
      if (!actions.contains(document.activeElement)) actions.hidden = true;
    }, 4500);
  }

  xgplayer.on(Player.Events.CSS_FULLSCREEN_CHANGE, active => {
    document.documentElement.classList.toggle('room-fullscreen', active);
    for (const element of outside) element.inert = active;
    button.textContent = active ? '退出全屏' : '网页全屏';
    button.setAttribute('aria-pressed', String(active));
    reveal.hidden = !active;
    button.focus({ preventScroll: true });
    showControls();
  });
  function exit() {
    if (xgplayer.cssfullscreen) xgplayer.exitCssFullscreen();
  }
  button.addEventListener('click', () => {
    if (xgplayer.cssfullscreen) exit();
    else xgplayer.getCssFullscreen();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && xgplayer.cssfullscreen) {
      event.preventDefault();
      exit();
    }
  });
  reveal.addEventListener('click', showControls);
  reveal.addEventListener('focus', showControls);
  video.addEventListener('pause', showControls);
  video.addEventListener('ended', showControls);
  video.addEventListener('playing', () => {
    if (!hideTimer && !actions.hidden) showControls();
  });
  actions.addEventListener('focusout', showControls);
  document.getElementById('player-screen').addEventListener('contextmenu', event => event.preventDefault());
  return { exit };
}

export function createPlayer({ apiOrigin, roomPath, role, cancelFirstStart }) {
  const byId = id => document.getElementById(id);
  const video = byId('video');
  const prepare = byId('prepare');
  const play = byId('play');
  const seek = byId('seek');
  const host = role === 'host';
  const rateDriftLimit = host ? 0.075 : 0.42;
  const rateDriftSettled = host ? 0.04 : 0.12;
  // Leave room for both peers' media error and uncertainty within the 0.5 s budget.
  const driftBudgetSeconds = host ? 0.10 : 0.385;
  const endpoint = apiOrigin + roomPath + '/playback';
  if (apiOrigin) video.crossOrigin = 'use-credentials';
  const playerId = crypto.randomUUID();
  const storageKey = 'watch-party-player:' + endpoint + ':' + role;
  let recoveryId = playerId;
  let recoveryGeneration = 0;
  let pendingClaimId;
  let needsRecovery = false;
  let legacySeats = [];
  let queuedCommand;
  let unacknowledgedSeekId;
  let playbackStartLeadMs = 0;
  try {
    const remembered = JSON.parse(sessionStorage.getItem(storageKey));
    if (remembered?.playerId) {
      recoveryId = remembered.recoveryId ?? remembered.playerId;
      recoveryGeneration = (remembered.recoveryGeneration ?? 0) + 1;
      needsRecovery = true;
      legacySeats = remembered.recoveryId ? remembered.legacySeats ?? []
        : [remembered.playerId, ...(remembered.recoveryCandidates ?? [])];
      playbackStartLeadMs = remembered.startLeadMs ?? 0;
      if (host && remembered.pause?.action === 'pause') queuedCommand = remembered.pause;
    }
  } catch {
    // Storage may be disabled. The room cookie still authorizes a fresh player.
  }
  let loadGeneration = 0;
  let state;
  let poll;
  let startTimer;
  let driftTimer;
  let stallTimer;
  let mediaRecoveryRetry;
  let visitorBufferingTimeline;
  let startedPlan;
  let inFlight;
  let priming;
  let primed = false;
  let claim = false;
  let gestureFailed = false;
  let reportBlocked;
  let unavailableReport;
  let outage;
  let reloadAfterReconnect = false;
  let mediaReloaded = false;
  let pendingStart;
  let networkError = false;
  let commandMessage = '';
  let clockSamples = [];
  let offset = 0;
  let clockRtt = 0;
  let hardDriftSamples = 0;
  let rateDriftSamples = 0;
  let nextHardSeek = 0;
  let driftSeekStarted;
  let driftSeekLeadMs = initialDriftSeekLeadMs;
  let currentTimeline;
  let initialRewindRetry;
  let initialReloadClosed = false;
  let admitted = false;
  let audio;
  let audioFailed = false;
  let audioRetryRequired = false;
  let audioLoss;
  let approvalAudioRetry;
  let authorizationRetryAt = 0;
  let firstStartCancellation;
  let seekPreview = false;

  function setText(id, message) {
    const element = byId(id);
    if (element.textContent !== message) element.textContent = message;
  }

  function hasDuration() {
    return Number.isFinite(video.duration) && video.duration > 0;
  }

  function renderTime() {
    const known = hasDuration();
    byId('playback-progress').hidden = host || !known;
    if (!known) return;
    if (Number(seek.max) !== video.duration) seek.max = video.duration;
    if (!seekPreview) seek.value = video.currentTime;
    const time = seekPreview ? Number(seek.value) : video.currentTime;
    seek.setAttribute('aria-valuetext', formatTime(time));
    setText('playback-time', formatTime(time) + ' / ' + formatTime(video.duration));
    if (!host) {
      const playhead = byId('playhead');
      playhead.max = video.duration;
      playhead.value = time;
    }
  }

  function renderBuffer() {
    const known = hasDuration();
    byId('playback-buffer').hidden = !known;
    if (!known || !video.buffered) return;
    const ranges = video.buffered;
    let seconds = 0;
    for (let index = 0; index < ranges.length; index++) seconds += ranges.end(index) - ranges.start(index);
    byId('buffered').value = Math.min(100, Math.round(seconds / video.duration * 100));
  }

  function awaitingLocalAudio() {
    return Boolean(priming?.waitingForAudio || priming?.waitingForPlay);
  }

  function render() {
    const ownsControls = host && state?.ownsSeat;
    const canControl = ownsControls && !networkError;
    const bothReady = state?.ready.host && state.ready.visitor;
    const waiting = Object.values(state?.waiting ?? {});
    const canPlay = admitted && state && !state.otherPlayer && !networkError;
    const canToggle = state?.wantsPlay ? ownsControls : canPlay || (canControl && bothReady && primed);
    const waitingForAudio = awaitingLocalAudio();
    const retryAudio = audioFailed || waitingForAudio;
    const retryPlayback = state?.ownsSeat && state.waiting[role] === 'stalled' && !primed;
    const prepareForManualStart = !host && state?.hostSupportsAutomaticStart !== true && state?.wantsPlay === false &&
      !state.ended && !state.ready[role] && !primed;
    const reloadAudio = (retryAudio || retryPlayback) && audio?.context.state === 'closed';
    prepare.hidden = !admitted || (!state?.wantsPlay && !prepareForManualStart) ||
      (!gestureFailed && !retryAudio && !retryPlayback && !prepareForManualStart) ||
      Boolean(state?.otherPlayer || firstStartCancellation || queuedCommand?.action === 'pause');
    prepare.disabled = Boolean((priming && !waitingForAudio) || unavailableReport || outage) ||
      networkError || video.readyState < video.HAVE_METADATA;
    setText('prepare', reloadAudio ? '刷新页面' : gestureFailed ? '允许播放'
      : retryPlayback ? '重试播放' : retryAudio ? '重试音频' : prepareForManualStart ? '准备好了' : '允许播放');
    play.hidden = !host;
    setText('play', state?.firstStartPending ? '取消开播' : state?.wantsPlay ? '暂停' : state?.ended ? '重播' : '播放');
    byId('end-after-playback').hidden = !host || !state?.ended;
    byId('end-room').hidden = Boolean(state?.ended);
    const canPauseSeek = state?.wantsPlay && queuedCommand?.action === 'seek';
    const canCancel = state?.firstStartPending && !state.otherPlayer;
    play.disabled = (!canToggle && !canCancel) || Boolean(firstStartCancellation || (queuedCommand && !canPauseSeek));
    byId('seek-controls').hidden = !host || Boolean(state?.ended);
    seek.disabled = !canControl || !hasDuration() || Boolean(queuedCommand);

    for (const seat of seats) {
      setText(seat + '-ready', seatNames[seat] + ' · ' + (state?.ready[seat] ? '已就绪' : '未就绪'));
    }
    let status = '正在连接播放状态…';
    const blocked = state?.wantsPlay ? seats.filter(seat => state.blocked.includes(seat) || (seat === role && gestureFailed)) : [];
    const unready = seats.filter(seat => !state?.ready[seat]);
    const stopped = seats.filter(seat => !state?.advancing?.[seat]);
    if (firstStartCancellation) status = '正在取消开播…';
    else if (networkError) status = '连接中断，等待播放状态。';
    else if (admitted && state?.wantsPlay === false && !state.ended) status = '已暂停，等待房主播放。';
    else if (blocked.length) status = '等待' + describeSeats(blocked) + '允许播放。';
    else if (outage?.reason === 'connection' || waiting.includes('connection')) {
      status = '等待重新连接并对齐进度。';
    } else if (document.hidden || waiting.includes('background')) {
      status = '等待双方回到观影页面。';
    } else if (waiting.includes('audio') || unavailableReport?.reason === 'audio') {
      const interrupted = seats.filter(seat => state?.waiting[seat] === 'audio' ||
        (seat === role && unavailableReport?.reason === 'audio'));
      status = '等待' + describeSeats(interrupted) + '恢复音频输出。';
    } else if (waiting.includes('stalled')) {
      status = '等待' + describeSeats(seats.filter(seat => state.waiting[seat] === 'stalled')) + '重试播放。';
    } else if (unavailableReport?.reason === 'buffering' || waiting.includes('buffering')) {
      const buffering = seats.filter(seat => state?.waiting[seat] === 'buffering' ||
        (seat === role && unavailableReport?.reason === 'buffering'));
      status = '等待' + describeSeats(buffering) + '缓冲并对齐进度。';
    } else if (state?.wantsPlay && waitingForAudio) {
      status = priming.waitingForAudio ? '正在等待本机音频输出就绪。' : '正在等待本机播放器就绪。';
    } else if (state?.startsAt != null) {
      status = mediaPlaying() && state.synchronized ? '正在同步播放'
        : state.awaitingStart ? '已对齐，等待同时开播。'
        : stopped.length ? '等待' + describeSeats(stopped) + '的播放进度推进。'
        : mediaPlaying() && !state.firstStartPending && state.playbackGap === null ? '双方播放进度在推进。'
        : '等待双方对齐播放进度。';
    } else if (state?.wantsPlay) status = '等待' + describeSeats(unready) + '缓冲并对齐进度。';
    else if (state?.ended) status = host ? '播放结束。请选择重播或结束房间。' : '播放结束，等待房主决定。';
    else if (bothReady) status = '已暂停，等待房主播放。';
    else if (host && !admitted) status = '等待访客加入后开播。';
    else if (state) status = '已暂停，等待' + describeSeats(unready) + '就绪。';
    setText('playback-status', status);
    setText('playback-message', video.error ? '无法读取视频，请刷新页面后重试。'
      : !prepare.hidden && gestureFailed ? '浏览器阻止了有声播放，请点「允许播放」。'
      : !prepare.hidden && reloadAudio ? '本机音频输出已关闭，请刷新页面。'
      : !prepare.hidden && audioFailed ? '无法准备本机播放，请点「重试音频」。'
      : state?.otherPlayer ? '这个席位已由另一个页面使用。'
      : commandMessage);
    renderTime();
  }

  function setRate(rate) {
    if (video.playbackRate !== rate) video.playbackRate = rate;
  }

  function pauseVideo() {
    if (audio) audio.gain.gain.value = 0;
    video.pause();
    setRate(1);
  }

  function pauseAndAlign(target) {
    pauseVideo();
    if (video.readyState >= video.HAVE_METADATA && !video.seeking &&
        ((video.ended && target < video.duration) || Math.abs(video.currentTime - target) > alignmentTolerance)) {
      if (target === 0 && canRetryInitialRewind()) initialRewindRetry = 'rewinding';
      video.currentTime = target;
    }
  }

  function markGestureFailed() {
    initialRewindRetry = undefined;
    primed = false;
    claim = false;
    gestureFailed = true;
    pauseVideo();
  }

  function prepareAudioGraph() {
    let context;
    try {
      if (!audio) {
        context = new AudioContext();
        const gain = context.createGain();
        gain.gain.value = 0;
        // Finish the output before associating the element, which cannot be associated twice.
        gain.connect(context.destination);
        const source = context.createMediaElementSource(video);
        audio = { context, gain, source, connected: false };
      }
      if (!audio.connected) {
        audio.source.connect(audio.gain);
        audio.connected = true;
        audio.context.addEventListener?.('statechange', () => {
          watchAudioOutput();
          wake();
        });
      }
      audioFailed = false;
    } catch {
      audioFailed = true;
      if (!audio && context) context.close().catch(() => {});
    }
  }

  async function resumeAudio() {
    const context = audio?.context;
    if (!context || context.state === 'running') return;
    await context.resume();
    if (context.state !== 'running') throw new Error('Audio output interrupted');
  }

  async function measurePlaybackStart(attempt, startPosition, started) {
    // Some players resolve play() before their media clock starts moving.
    while (priming === attempt && !video.paused) {
      const elapsed = performance.now() - started;
      const advanced = video.currentTime - startPosition;
      if (advanced >= 0.08) return Math.max(0, Math.min(maxStartLeadMs, elapsed - advanced * 1000));
      if (elapsed >= playbackProbeMs) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    return video.ended && video.currentTime > startPosition ? playbackStartLeadMs : null;
  }

  function hasPlaybackData() {
    return video.readyState >= video.HAVE_FUTURE_DATA ||
      (video.readyState >= video.HAVE_CURRENT_DATA && state.position >= video.duration - alignmentTolerance);
  }

  function mediaPlaying() {
    return !priming && !video.paused && !video.ended && !video.seeking && hasPlaybackData() &&
      audioReady();
  }

  function canRetryInitialRewind() {
    return !initialReloadClosed && video.hasAttribute('src') && state &&
      primed && claim && !priming && !needsRecovery && !networkError && !outage && !document.hidden &&
      !state.otherPlayer && !state.ready[role] && (!state.wantsPlay || state.firstStartPending) &&
      state.startsAt === null && state.position === 0;
  }

  function closeInitialReload() {
    initialRewindRetry = undefined;
    initialReloadClosed = true;
  }

  function retryInitialRewind(stallObserved = false) {
    if (!initialRewindRetry || (!stallObserved && initialRewindRetry !== 'stalled') ||
        !canRetryInitialRewind() || !video.paused || video.seeking ||
        video.currentTime !== 0 || video.readyState !== video.HAVE_CURRENT_DATA) return;
    if (inFlight?.operation.action === 'ready') {
      // The server may have accepted Ready before its reply reaches this player.
      initialRewindRetry = 'stalled';
      return;
    }
    // WebKit can stall after a paused rewind even when the media reports buffered data.
    closeInitialReload();
    video.load();
  }

  function mediaPosition() {
    return video.seeking ? undefined : video.currentTime;
  }

  function playbackOutage(reason) {
    return { reason, position: mediaPosition(), epoch: state?.epoch, version: state?.version };
  }

  function rememberSeat(claimPending = false) {
    try {
      if (!state?.ownsSeat && !needsRecovery && !claimPending) {
        sessionStorage.removeItem(storageKey);
        return;
      }
      const pause = queuedCommand?.action === 'pause' ? queuedCommand : undefined;
      sessionStorage.setItem(storageKey, JSON.stringify({
        playerId, recoveryId, recoveryGeneration, startLeadMs: playbackStartLeadMs, pause,
        ...(legacySeats.length ? { legacySeats } : {}),
      }));
    } catch {
      // Playback can continue in the current document.
    }
  }

  function reportUnavailable(reason) {
    const { epoch, version } = state;
    unavailableReport = { action: 'unavailable', reason, epoch, version, position: mediaPosition() };
    clearPendingStart();
    clearAudioLoss();
    pauseVideo();
    wake();
  }

  function checkBuffering() {
    if (unavailableReport || state?.startsAt == null || !state.ownsSeat || priming || hasPlaybackData() ||
        finishedPlan()) return;
    reportUnavailable('buffering');
  }

  function audioReady() {
    return !audio || (audio.connected && audio.context.state === 'running');
  }

  function activePlan() {
    return state?.startsAt != null && state.wantsPlay && state.ownsSeat && state.ready[role] &&
      primed && !priming && !queuedCommand && !firstStartCancellation && !reportBlocked && !unavailableReport &&
      !outage && !networkError && !document.hidden;
  }

  function planIdentity() {
    return { epoch: state.epoch, version: state.version, startsAt: state.startsAt, source: video.getAttribute('src') };
  }

  function samePlan(attempt) {
    return activePlan() && state.epoch === attempt.epoch && state.version === attempt.version &&
      state.startsAt === attempt.startsAt && video.getAttribute('src') === attempt.source;
  }

  function finishedPlan() {
    return video.ended && Boolean(startedPlan && samePlan(startedPlan));
  }

  function holdForAudio() {
    audioFailed = true;
    primed = claim = false;
    reportUnavailable('audio');
  }

  function clearAudioLoss() {
    clearTimeout(audioLoss?.timer);
    audioLoss = undefined;
  }

  function watchAudioOutput() {
    const unavailable = !audioReady();
    if (!unavailable) {
      const interrupted = audioLoss;
      clearAudioLoss();
      if (interrupted?.wasAudible && samePlan(interrupted) && state.startConfirmed !== false &&
          !video.seeking && !video.ended && performance.now() - interrupted.observedAt < stallConfirmMs) updateAudioGain();
      return;
    }
    const wasAudible = audio.gain.gain.value > 0;
    audio.gain.gain.value = 0;
    if (!activePlan() || video.ended) {
      clearAudioLoss();
      return;
    }
    if (audioLoss && samePlan(audioLoss)) return;
    clearAudioLoss();
    const attempt = { ...planIdentity(), wasAudible, observedAt: performance.now() };
    audioLoss = attempt;
    // Observe the device even while a playback response is in flight.
    attempt.timer = setTimeout(() => {
      if (audioLoss !== attempt) return;
      audioLoss = undefined;
      if (samePlan(attempt) && !video.ended && !audioReady()) holdForAudio();
    }, stallConfirmMs);
  }

  function clearPendingStart() {
    clearTimeout(pendingStart?.timer);
    pendingStart = undefined;
  }

  function completeScheduledStart(attempt) {
    if (!attempt?.played || !samePlan(attempt) || video.seeking) return false;
    const advanced = video.currentTime - attempt.position;
    const complete = video.ended ? advanced > 0 && video.currentTime >= video.duration - alignmentTolerance
      : !video.paused && advanced > 0.03;
    if (!complete) return false;
    startedPlan = attempt;
    clearPendingStart();
    return true;
  }

  function confirmStall(retry) {
    if (retry && retry === mediaRecoveryRetry && retry.timeline === currentTimeline &&
        retry.source === video.getAttribute('src') && state.ownsSeat && state.wantsPlay &&
        state.startsAt === null && !state.ready[role] && primed && !queuedCommand && !outage &&
        !networkError && !document.hidden && video.paused && !video.seeking &&
        video.readyState === video.HAVE_CURRENT_DATA &&
        Math.abs(video.currentTime - state.position) <= alignmentTolerance) {
      if (inFlight?.operation.action === 'ready') {
        // A delayed reply can hide readiness that the room has already accepted.
        retry.stallConfirmed = true;
        return;
      }
      // WebKit can remain stalled on an aligned, paused frame despite buffering that location.
      mediaRecoveryRetry = undefined;
      mediaReloaded = true;
      video.load();
      return;
    }
    checkBuffering();
  }

  function beginPlayback() {
    if (!hasPlaybackData()) {
      checkBuffering();
      return;
    }
    if (pendingStart || video.seeking || video.ended || !activePlan()) return;
    // Readiness already aligned the media. Chasing a moving target before starting can seek forever on slow media.
    const attempt = { ...planIdentity(), position: video.currentTime, played: false };
    pendingStart = attempt;
    mediaReloaded = false;
    attempt.timer = setTimeout(() => {
      if (pendingStart !== attempt || !samePlan(attempt)) return;
      if (completeScheduledStart(attempt)) return;
      audioRetryRequired = true;
      holdForAudio();
    }, playbackProbeMs);
    video.play().then(() => {
      if (pendingStart !== attempt || !samePlan(attempt)) return;
      attempt.played = true;
      completeScheduledStart(attempt);
    }).catch(error => {
      if (pendingStart !== attempt || !samePlan(attempt)) return;
      clearPendingStart();
      if (error.name === 'AbortError') return;
      if (error.name === 'NotAllowedError') {
        pauseVideo();
        reportBlocked = { action: 'blocked', epoch: attempt.epoch, version: attempt.version };
        wake();
      } else {
        authorizationRetryAt = performance.now() + playbackProbeMs;
        holdForAudio();
      }
    });
  }

  function positionAt(serverTime) {
    return Math.min(video.duration, state.position + Math.max(0, serverTime - state.startsAt) / 1000);
  }

  function correctDrift() {
    if (pendingStart && !completeScheduledStart(pendingStart)) return;
    if (state?.startsAt == null || !state.ownsSeat || !primed || priming ||
        networkError || outage || reportBlocked || unavailableReport || document.hidden ||
        video.paused || video.seeking || video.readyState < video.HAVE_FUTURE_DATA) return;
    const now = performance.now() + offset;
    const target = positionAt(now);
    if (now < state.startsAt || !Number.isFinite(target) || target >= video.duration) return;
    const drift = target - video.currentTime;
    const distance = Math.abs(drift);
    const hardDriftLimit = state.firstStartPending ? 0.55 : 0.9;
    hardDriftSamples = distance > hardDriftLimit ? hardDriftSamples + 1 : 0;
    // Changing playback rate can briefly stop frame presentation even with data buffered.
    // Leave short phase differences alone and require a sustained, same-direction error.
    // A midpoint clock estimate can err by half its RTT on an asymmetric path.
    // Leave at least 40 ms of media tolerance even when the clock budget is exhausted.
    const correctionStart = Math.max(0.04, Math.min(rateDriftLimit, driftBudgetSeconds - clockRtt / 2000));
    const correctionStop = Math.min(rateDriftSettled, correctionStart * 0.6);
    const direction = Math.sign(drift);
    rateDriftSamples = distance <= correctionStart ? 0
      : (Math.sign(rateDriftSamples) === direction ? rateDriftSamples : 0) + direction;
    // Avoid retiming the host for small clock errors while its peer is advancing in step.
    const needsRateCorrection = !(audio && host && state.playbackGap !== null && state.playbackGap < 0.3);
    if ((distance > 1.25 || hardDriftSamples >= 2) && now >= nextHardSeek) {
      // Allow for the time spent decoding the destination while the room keeps playing.
      const catchUp = positionAt(now + driftSeekLeadMs);
      // Let native playback reach the last frame instead of seeking to the duration.
      if (catchUp >= video.duration) return;
      driftSeekStarted = performance.now();
      video.currentTime = catchUp;
      setRate(1);
      nextHardSeek = now + 1500;
      hardDriftSamples = 0;
      rateDriftSamples = 0;
    } else if (video.playbackRate === 1 && Math.abs(rateDriftSamples) >= 4 && needsRateCorrection) {
      setRate(1 + direction * 0.10);
    } else if (video.playbackRate !== 1 && (distance <= correctionStop || drift * (video.playbackRate - 1) < 0)) {
      rateDriftSamples = 0;
      setRate(1);
    }
  }

  function followTimeline() {
    clearTimeout(startTimer);
    if (pendingStart && !samePlan(pendingStart)) clearPendingStart();
    completeScheduledStart(pendingStart);
    watchAudioOutput();
    if (!state || priming) return;
    if (firstStartCancellation || queuedCommand?.action === 'pause' || reportBlocked || unavailableReport || outage ||
        networkError || document.hidden) {
      pauseVideo();
      return;
    }
    if (state.startsAt === null && state.wantsPlay && !state.ready[role] && !audioReady()) primed = false;
    if (state.startsAt === null || !state.ownsSeat || !primed || state.startConfirmed === false) {
      pauseAndAlign(state.position);
      return;
    }
    if (!audioReady()) return;
    const now = performance.now() + offset;
    // The first start after a media reload can be quicker than the original gesture calibration.
    const firstAudibleStart = state.firstStartPending && !state.preview;
    const lead = firstAudibleStart ? 0 : mediaReloaded ? Math.min(playbackStartLeadMs, 250) : playbackStartLeadMs;
    const untilStart = state.startsAt - now - lead;
    if (untilStart > 0) {
      pauseAndAlign(state.position);
      startTimer = setTimeout(() => {
        followTimeline();
        render();
      }, untilStart);
      return;
    }
    if (!Number.isFinite(positionAt(now)) || video.ended) return;
    if (video.paused) {
      // An early readiness snapshot can precede a Pause that supersedes the scheduled start.
      if ((!host || state.firstStartPending) && state.serverTime < state.startsAt - lead - startSnapshotLeadMs) {
        wake();
        return;
      }
      beginPlayback();
    }
    updateAudioGain();
  }

  function updateAudioGain() {
    if (audio) audio.gain.gain.value = Number(!state.firstStartPending && !video.paused && audioReady());
  }

  function updateClock(sent, received, serverTime) {
    // Keep a low-latency estimate through a slow seek with delayed playback replies.
    clockSamples = clockSamples.filter(sample => received - sample.received < 30_000);
    clockSamples.push({ received, rtt: received - sent, offset: serverTime - (sent + received) / 2 });
    const best = clockSamples.reduce((lowest, sample) => sample.rtt < lowest.rtt ? sample : lowest);
    offset = best.offset;
    clockRtt = best.rtt;
  }

  function nextOperation() {
    if (needsRecovery) {
      const recovery = { action: 'recover', recoveryId, recoveryGeneration };
      // Migrate old saved histories in bounded batches. New recoveries use only the seat ID and generation.
      const [previousPlayerId, ...fallbackPlayerIds] = legacySeats.slice(0, legacyRecoveryBatchSize);
      return previousPlayerId ? { ...recovery, previousPlayerId, fallbackPlayerIds } : recovery;
    }
    if (!state) return { action: 'observe' };
    const { epoch, version } = state;
    if (queuedCommand) return queuedCommand;
    if (reportBlocked) return reportBlocked;
    if (outage && state.ownsSeat) {
      const position = outage.epoch === epoch && outage.version === version ? outage.position : undefined;
      return { action: 'unavailable', reason: outage.reason, epoch, version, position };
    }
    if (unavailableReport) return unavailableReport;
    if (state.wantsPlay && admitted && gestureFailed && !priming && !state.otherPlayer && !state.blocked.includes(role)) {
      return { action: 'blocked', epoch, version, claim: !state.ownsSeat };
    }
    if ((!audio || admitted) && audioReady() && primed && !priming && !document.hidden && hasPlaybackData() && !video.seeking && !state.ready[role] &&
        (claim || state.ownsSeat) && Math.abs(state.position - video.currentTime) <= alignmentTolerance) {
      return { action: 'ready', epoch, version, position: video.currentTime, claim, nativeEnd: true };
    }
    const startAcknowledgment = state.awaitingStart && primed && audioReady() &&
      video.paused && !video.seeking && hasPlaybackData() ? state.startsAt : undefined;
    const sampledAt = performance.now();
    return { action: 'observe', epoch, version, position: mediaPosition(), sampledAt, observedAt: sampledAt + offset,
      playing: mediaPlaying(), ended: finishedPlan(), startAcknowledgment,
      startConfirmation: state.startAcknowledged ? startAcknowledgment : undefined };
  }

  function sendPlayback(operation, options) {
    return fetch(endpoint, {
      credentials: 'include',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role, playerId, ...operation }),
      ...options,
    });
  }

  async function requestPlayback(operation, signal) {
    const sent = performance.now();
    const response = await sendPlayback(operation, { signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]) });
    if (!response.ok && response.status !== 409) throw new Error('Playback request failed');
    const result = await response.json();
    return { ok: response.ok, result, sent, received: performance.now() };
  }

  async function synchronize() {
    const generation = loadGeneration;
    const reportedOutage = outage;
    retryInitialRewind();
    if (mediaRecoveryRetry?.stallConfirmed) confirmStall(mediaRecoveryRetry);
    const operation = nextOperation();
    const controller = new AbortController();
    inFlight = { operation, controller };
    try {
      // Persist the proposed owner before a lost reply or refresh can hide its acknowledgment.
      if (operation.action === 'recover') rememberSeat();
      if (operation.claim && !state.ownsSeat) {
        // Each fresh claim has a different lineage, even when the document reclaims the seat.
        pendingClaimId ??= crypto.randomUUID();
        recoveryId = operation.recoveryId = pendingClaimId;
        recoveryGeneration = 0;
        rememberSeat(true);
      }
      const reply = await requestPlayback(operation, controller.signal).catch(() => null);
      if (generation !== loadGeneration || controller.signal.aborted) return;
      if (!reply) {
        networkError = true;
        reloadAfterReconnect = true;
        outage ??= playbackOutage('connection');
        clearTimeout(startTimer);
        if (!priming) pauseVideo();
        if (operation.action === 'seek') unacknowledgedSeekId = operation.seekId;
        if (queuedCommand?.action === 'pause') commandMessage = '已请求暂停，重新连接后将同步。';
        else if (operation === queuedCommand) commandMessage = '连接中断，请确认播放状态后重试。';
        return;
      }
      const { ok, result, sent, received } = reply;
      networkError = false;
      const epochChanged = result.epoch !== state?.epoch;
      const previouslyOwned = state?.ownsSeat;
      const readyBeforeRecovery = state?.ready.host || mediaRecoveryRetry?.afterVisitorInterruption;
      const wasWaitingForVisitor = state?.waiting.visitor === 'buffering' || state?.waiting.visitor === 'connection';
      const hostInterruptedBufferingStart = visitorBufferingTimeline === currentTimeline &&
        state?.startsAt != null && state.ready[role] && result.version === state.version + 1 &&
        result.waiting.host === 'buffering' && result.waiting.visitor === null;
      if (epochChanged) {
        clockSamples = [];
        initialReloadClosed = false;
      }
      // A new version invalidates the rewind even when its target is still zero.
      if (epochChanged || result.version !== state?.version || result.position !== 0 ||
          (result.wantsPlay && !result.firstStartPending) || result.startsAt !== null || result.otherPlayer) {
        initialRewindRetry = undefined;
      }
      if (state && (epochChanged || (previouslyOwned && !result.ownsSeat) || result.otherPlayer)) {
        if (priming) pauseVideo();
        priming = undefined;
        startedPlan = undefined;
        primed = claim = false;
        visitorBufferingTimeline = undefined;
        pendingClaimId = undefined;
      }
      if (state?.wantsPlay && !result.wantsPlay && priming) {
        priming = undefined;
        pauseVideo();
      }
      if (result.ready[role]) closeInitialReload();
      updateClock(sent, received, result.serverTime);
      state = result;
      if (operation.action === 'recover') {
        primed = result.ownsSeat && (primed || !admitted);
        legacySeats = result.ownsSeat ? [] : legacySeats.slice(legacyRecoveryBatchSize);
        needsRecovery = legacySeats.length > 0;
        if (!result.ownsSeat) {
          if (!needsRecovery) {
            recoveryId = playerId;
            recoveryGeneration = 0;
            queuedCommand = undefined;
          }
          rememberSeat();
        }
      }
      if (result.ownsSeat && !previouslyOwned) {
        pendingClaimId = undefined;
        rememberSeat();
      }
      if (document.hidden && result.ready[role] && result.ownsSeat) {
        outage ??= playbackOutage('background');
      }
      const outageAcknowledged = ok && operation.action === 'unavailable' && outage === reportedOutage && operation.reason === outage?.reason;
      if (!result.ownsSeat || outageAcknowledged) {
        // The playback endpoint can recover while an interrupted media request stays stalled.
        if (reloadAfterReconnect && (outageAcknowledged || video.error)) {
          mediaReloaded = true;
          video.load();
        }
        reloadAfterReconnect = false;
        outage = undefined;
      }
      if (operation === unavailableReport) unavailableReport = undefined;
      if (operation === queuedCommand) {
        if (ok) unacknowledgedSeekId = undefined;
        commandMessage = ok ? '' : '播放状态已更新，请重试操作。';
        queuedCommand = undefined;
        if (operation.action === 'pause') rememberSeat();
      }
      if (operation === reportBlocked) {
        reportBlocked = undefined;
        if (ok || state.blocked.includes(role)) markGestureFailed();
      }
      if (state.ownsSeat && state.ready[role]) claim = false;
      const timeline = state.epoch + ':' + state.version;
      if (timeline !== currentTimeline) {
        currentTimeline = timeline;
        clearTimeout(stallTimer);
        if (state.ownsSeat && state.waiting[role] === 'stalled') primed = claim = false;
        const visitorInterrupted = state.waiting.visitor === 'buffering' || state.waiting.visitor === 'connection' ||
          (wasWaitingForVisitor && state.ready.visitor && operation.action === 'observe');
        // A host stall can cancel a start scheduled after visitor buffering.
        const recoveringVisitorInterruption = host && readyBeforeRecovery && visitorInterrupted;
        const mayRetry = !epochChanged && previouslyOwned && primed && state.ownsSeat &&
          state.wantsPlay && state.startsAt === null && !state.ready[role] && !queuedCommand;
        mediaRecoveryRetry = mayRetry && (recoveringVisitorInterruption || hostInterruptedBufferingStart)
          ? { timeline, source: video.getAttribute('src'), afterVisitorInterruption: recoveringVisitorInterruption } : undefined;
        visitorBufferingTimeline = mayRetry && startedPlan && state.waiting.visitor === 'buffering'
          ? timeline : undefined;
        clearPendingStart();
        hardDriftSamples = 0;
        rateDriftSamples = 0;
        nextHardSeek = 0;
        driftSeekStarted = undefined;
      }
      if (!state.ownsSeat || state.ready[role] || !state.wantsPlay) mediaRecoveryRetry = undefined;
      followTimeline();
      if (state.wantsPlay && admitted && !primed && !priming && !gestureFailed && !audioRetryRequired && !state.otherPlayer &&
          !unavailableReport && !outage && state.waiting[role] !== 'stalled' &&
          !firstStartCancellation && queuedCommand?.action !== 'pause' &&
          !document.hidden && !video.error && !video.seeking && video.readyState >= video.HAVE_CURRENT_DATA &&
          performance.now() >= authorizationRetryAt) authorize();
    } finally {
      if (generation === loadGeneration) {
        if (networkError && operation === queuedCommand && operation.action !== 'pause') queuedCommand = undefined;
        inFlight = undefined;
        render();
        const pendingReport = needsRecovery || queuedCommand || reportBlocked || outage || unavailableReport;
        poll = setTimeout(synchronize, pendingReport && !networkError ? 0 : pollMs);
      }
    }
  }

  function wake() {
    clearTimeout(poll);
    if (!inFlight && video.hasAttribute('src')) poll = setTimeout(synchronize, 0);
    render();
  }

  function command(action, details) {
    const pausesSeek = action === 'pause' && queuedCommand?.action === 'seek';
    const preparesPlay = action === 'play' && admitted && state && !state.otherPlayer;
    if (!host || (!state?.ownsSeat && !preparesPlay) || (queuedCommand && !pausesSeek) ||
        (networkError && action !== 'pause')) return;
    if (preparesPlay) {
      authorize(true);
      details = { waitForReadiness: true, claim: !state.ownsSeat };
    }
    mediaRecoveryRetry = visitorBufferingTimeline = undefined;
    queuedCommand = { action, ...details, epoch: state.epoch, version: state.version };
    if (action === 'seek') queuedCommand.seekId = crypto.randomUUID();
    if (action === 'pause') {
      const interrupted = inFlight?.operation;
      queuedCommand.afterSeekId = interrupted?.action === 'seek' ? interrupted.seekId : unacknowledgedSeekId;
      clearTimeout(startTimer);
      clearPendingStart();
      clearAudioLoss();
      priming = undefined;
      pauseVideo();
      rememberSeat();
      // The previous request may already have applied. Let the server order the pause without waiting for its reply.
      inFlight?.controller.abort();
    }
    commandMessage = '';
    wake();
  }

  function reportOutage(reason) {
    if (!video.hasAttribute('src')) return;
    if (reason === 'connection') reloadAfterReconnect = true;
    outage = playbackOutage(reason);
    clearTimeout(startTimer);
    clearPendingStart();
    clearAudioLoss();
    priming = undefined;
    pauseVideo();
    wake();
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) reportOutage('background');
    else wake();
  });
  window.addEventListener('offline', () => reportOutage('connection'));
  window.addEventListener('online', wake);
  window.addEventListener('pageshow', wake);
  window.addEventListener('pagehide', () => {
    if (!state?.ownsSeat || !video.hasAttribute('src')) return;
    const { epoch, version } = state;
    reportOutage('background');
    sendPlayback({ action: 'unavailable', ...outage, epoch, version }, { keepalive: true }).catch(() => {});
  });

  async function probePlayback(attempt) {
    const startPosition = video.currentTime;
    const started = performance.now();
    attempt.waitingForPlay = true;
    await video.play();
    if (priming !== attempt) return;
    attempt.waitingForPlay = false;
    render();
    const startLeadMs = await measurePlaybackStart(attempt, startPosition, started);
    if (priming !== attempt) return;
    pauseVideo();
    if (startLeadMs === null) throw new Error('Media clock did not advance');
    return startLeadMs;
  }

  async function resumeAuthorization(attempt) {
    if (!audio || audio.context.state === 'running') return;
    attempt.waitingForAudio = true;
    const resuming = resumeAudio();
    render();
    await resuming;
    if (priming === attempt) {
      attempt.waitingForAudio = false;
      render();
    }
  }

  async function authorize(withGesture = false) {
    if (priming || primed || firstStartCancellation || queuedCommand?.action === 'pause' ||
        unavailableReport || outage || !video.hasAttribute('src') || state?.otherPlayer) return;
    if (audio?.context.state === 'closed') {
      audioFailed = audioRetryRequired = true;
      render();
      return;
    }
    const attempt = { waitingForAudio: false };
    priming = attempt;
    audioRetryRequired = false;
    gestureFailed = false;
    render();
    try {
      // Keep the unmuted element subject to the browser's policy while the gain silences the probe.
      if (!audio?.connected && (audio || admitted || withGesture)) {
        prepareAudioGraph();
        if (!audio?.connected) {
          authorizationRetryAt = performance.now() + 1000;
          return;
        }
      }
      if (audio) audio.gain.gain.value = 0;
      // Give native playback the gesture before resuming the audio context.
      const result = Promise.all([probePlayback(attempt), resumeAuthorization(attempt)]);
      render();
      const [startLeadMs] = await result;
      if (priming !== attempt) return;
      audioFailed = false;
      playbackStartLeadMs = startLeadMs;
      mediaReloaded = false;
      primed = true;
      claim = true;
    } catch (error) {
      if (priming !== attempt) return;
      pauseVideo();
      authorizationRetryAt = performance.now() + 1000;
      if (error.name === 'NotAllowedError') markGestureFailed();
      else if (error.name !== 'AbortError') audioFailed = true;
    } finally {
      if (priming === attempt) {
        priming = undefined;
        followTimeline();
        wake();
      }
    }
  }
  prepare.addEventListener('click', () => {
    if (!prepare.hidden && audio?.context.state === 'closed') return window.location.reload();
    if (awaitingLocalAudio()) {
      priming = undefined;
      pauseVideo();
    }
    authorize();
  });
  play.addEventListener('click', () => {
    if (state?.firstStartPending && !state.ownsSeat && cancelFirstStart) cancelPendingStart();
    else command(state?.firstStartPending || state?.wantsPlay ? 'pause' : 'play');
  });

  async function cancelPendingStart() {
    if (firstStartCancellation) return;
    clearTimeout(startTimer);
    clearPendingStart();
    clearAudioLoss();
    priming = undefined;
    pauseVideo();
    const cancellation = cancelFirstStart(playerId);
    firstStartCancellation = cancellation;
    render();
    try {
      await cancellation;
    } finally {
      if (firstStartCancellation === cancellation) {
        inFlight?.controller.abort();
        firstStartCancellation = undefined;
        wake();
      }
    }
  }
  seek.addEventListener('input', () => {
    seekPreview = true;
    renderTime();
  });
  seek.addEventListener('change', () => {
    const position = Number(seek.value);
    seekPreview = false;
    command('seek', { position });
  });
  seek.addEventListener('blur', () => {
    seekPreview = false;
    renderTime();
  });
  video.addEventListener('canplay', wake);
  video.addEventListener('canplaythrough', wake);
  video.addEventListener('stalled', () => retryInitialRewind(true));
  video.addEventListener('seeked', () => {
    if (driftSeekStarted !== undefined) {
      driftSeekLeadMs = Math.min(750, performance.now() - driftSeekStarted);
      driftSeekStarted = undefined;
    }
    wake();
  });
  for (const event of ['waiting', 'stalled', 'emptied', 'error']) video.addEventListener(event, () => {
    // A local seek can briefly lower readyState without interrupting continuous playback.
    const retry = event === 'stalled' ? mediaRecoveryRetry : undefined;
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => confirmStall(retry), stallConfirmMs);
    render();
  });
  video.addEventListener('timeupdate', renderTime);
  video.addEventListener('playing', render);
  video.addEventListener('ended', () => {
    completeScheduledStart(pendingStart);
    wake();
  });
  for (const event of ['progress', 'durationchange', 'emptied']) video.addEventListener(event, renderBuffer);

  return {
    admit() {
      admitted = true;
    },
    authorizeApproval() {
      if (audio?.connected) authorize(true);
    },
    cancelPendingStart,
    load(url, { prepareApproval = false } = {}) {
      url = apiOrigin + url;
      if (prepareApproval && !audio?.connected) {
        // Connect the silent graph when applying the room snapshot, before the approval gesture.
        prepareAudioGraph();
        if (!audio?.connected && approvalAudioRetry === undefined) {
          approvalAudioRetry = setTimeout(() => {
            approvalAudioRetry = undefined;
            if (!admitted && video.getAttribute('src') === url && !audio?.connected) prepareAudioGraph();
          }, 0);
        }
      }
      if (video.getAttribute('src') === url) return;
      if (video.hasAttribute('src')) {
        loadGeneration++;
        inFlight?.controller.abort();
        inFlight = undefined;
        clearTimeout(stallTimer);
        // A pending buffering or audio report describes the previous source.
        if (unavailableReport?.reason === 'audio') {
          audioFailed = audioRetryRequired = false;
        }
        unavailableReport = undefined;
      }
      if (priming || pendingStart) pauseVideo();
      priming = undefined;
      clearTimeout(startTimer);
      clearPendingStart();
      clearAudioLoss();
      mediaRecoveryRetry = visitorBufferingTimeline = initialRewindRetry = startedPlan = undefined;
      initialReloadClosed = false;
      video.src = url;
      clearInterval(driftTimer);
      driftTimer = setInterval(correctDrift, driftCheckMs);
      byId('player').hidden = false;
      wake();
    },
    stop() {
      loadGeneration++;
      mediaRecoveryRetry = visitorBufferingTimeline = initialRewindRetry = startedPlan = undefined;
      initialReloadClosed = false;
      clearTimeout(poll);
      clearTimeout(startTimer);
      clearInterval(driftTimer);
      clearTimeout(stallTimer);
      clearTimeout(approvalAudioRetry);
      approvalAudioRetry = undefined;
      state = undefined;
      queuedCommand = unacknowledgedSeekId = undefined;
      reportBlocked = unavailableReport = outage = undefined;
      clearPendingStart();
      reloadAfterReconnect = false;
      mediaReloaded = false;
      inFlight = pendingClaimId = undefined;
      priming = undefined;
      clearAudioLoss();
      primed = claim = gestureFailed = networkError = audioFailed = audioRetryRequired = false;
      admitted = false;
      firstStartCancellation = undefined;
      seekPreview = false;
      commandMessage = '';
      driftSeekStarted = undefined;
      driftSeekLeadMs = initialDriftSeekLeadMs;
      clockSamples = [];
      if (video.hasAttribute('src')) {
        pauseVideo();
        video.removeAttribute('src');
        video.load();
      }
      byId('player').hidden = true;
    },
  };
}
