const pollMs = 200;
const driftCheckMs = 100;
const startSnapshotLeadMs = 2 * pollMs;
const stallConfirmMs = 200;
const alignmentTolerance = 0.05;
const initialDriftSeekLeadMs = 200;
const maxStartLeadMs = 650;
const legacyRecoveryBatchSize = 32;

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

export function createPlayer({ apiOrigin, roomPath, role }) {
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
  let hasStartedScheduledPlayback = false;
  let inFlight;
  let priming = false;
  let primed = false;
  let claim = false;
  let gestureFailed = false;
  let reportBlocked;
  let reportBuffering;
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
  let sustainedDriftSamples = 0;
  let nextHardSeek = 0;
  let driftSeekStarted;
  let driftSeekLeadMs = initialDriftSeekLeadMs;
  let currentTimeline;
  let initialRewindRetry;
  let initialReloadClosed = false;
  let prepareIntent = 0;
  let seekPreview = false;
  let useRateCorrection = true;

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

  function render() {
    const ownsControls = host && state?.ownsSeat;
    const canControl = ownsControls && !networkError;
    const bothReady = state?.ready.host && state.ready.visitor;
    const waiting = Object.values(state?.waiting ?? {});
    const canToggle = ownsControls && (state.wantsPlay || (canControl && bothReady && primed));
    prepare.hidden = primed || Boolean(state?.otherPlayer);
    prepare.disabled = priming || !state || networkError || video.readyState < video.HAVE_CURRENT_DATA;
    prepare.textContent = gestureFailed ? '再次点按以准备' : '准备好了';
    play.hidden = !host;
    setText('play', state?.wantsPlay ? '暂停' : state?.ended ? '重播' : '播放');
    byId('end-after-playback').hidden = !host || !state?.ended;
    byId('end-room').hidden = Boolean(state?.ended);
    const canPauseSeek = state?.wantsPlay && queuedCommand?.action === 'seek';
    play.disabled = !canToggle || Boolean(queuedCommand && !canPauseSeek);
    byId('seek-controls').hidden = !host || Boolean(state?.ended);
    seek.disabled = !canControl || !hasDuration() || Boolean(queuedCommand);

    for (const [seat, name] of [['host', '房主'], ['visitor', '访客']]) {
      setText(seat + '-ready', name + ' · ' + (state?.ready[seat] ? '已就绪' : '未就绪'));
    }
    let status = '正在连接播放状态…';
    if (networkError) status = '连接中断，等待播放状态。';
    else if (gestureFailed || state?.blocked.length) status = '等待点按以允许播放。';
    else if (outage?.reason === 'connection' || waiting.includes('connection')) {
      status = '等待重新连接并对齐进度。';
    } else if (document.hidden || waiting.includes('background')) {
      status = '等待双方回到观影页面。';
    } else if (reportBuffering || waiting.includes('buffering')) {
      status = '缓冲中，等待双方在同一位置就绪。';
    } else if (state?.startsAt != null) status = video.paused ? '即将同时播放…' : '正在同步播放';
    else if (state?.wantsPlay) status = '正在对齐进度，等待双方就绪。';
    else if (state?.ended) status = host ? '播放结束。请选择重播或结束房间。' : '播放结束，等待房主决定。';
    else if (bothReady) status = '已暂停，等待房主播放。';
    else if (state) status = '等待双方就绪。';
    setText('playback-status', status);
    setText('playback-message', video.error ? '无法读取视频，请刷新页面后重试。'
      : gestureFailed ? '浏览器阻止了起播。请再次点按准备按钮，房间会等待你。'
      : state?.otherPlayer ? '这个席位已由另一个页面使用。'
      : commandMessage);
    renderTime();
  }

  function setRate(rate) {
    if (video.playbackRate !== rate) video.playbackRate = rate;
  }

  function pauseVideo() {
    video.pause();
    setRate(1);
  }

  function pauseAndAlign(target) {
    pauseVideo();
    if (video.readyState >= video.HAVE_METADATA && !video.seeking &&
        Math.abs(video.currentTime - target) > alignmentTolerance) {
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

  async function measurePlaybackStart(generation, startPosition, started) {
    // Some players resolve play() before their media clock starts moving.
    while (generation === loadGeneration && !video.paused) {
      const elapsed = performance.now() - started;
      const advanced = video.currentTime - startPosition;
      if (advanced >= 0.08) return Math.max(0, Math.min(maxStartLeadMs, elapsed - advanced * 1000));
      if (elapsed >= 1000) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    return playbackStartLeadMs;
  }

  function hasPlaybackData() {
    return video.readyState >= video.HAVE_FUTURE_DATA ||
      (video.readyState >= video.HAVE_CURRENT_DATA && state.position >= video.duration - alignmentTolerance);
  }

  function canRetryInitialRewind() {
    return !host && !initialReloadClosed && video.hasAttribute('src') && state &&
      primed && claim && !priming && !needsRecovery && !networkError && !outage && !document.hidden &&
      !state.ownsSeat && !state.otherPlayer && !state.ready.visitor &&
      !state.wantsPlay && state.startsAt === null && state.position === 0;
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

  function checkBuffering() {
    if (reportBuffering || state?.startsAt == null || !state.ownsSeat || priming || hasPlaybackData()) return;
    const { epoch, version } = state;
    reportBuffering = { action: 'unavailable', reason: 'buffering', epoch, version, position: mediaPosition() };
    pendingStart = undefined;
    pauseVideo();
    wake();
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
    if (pendingStart || video.seeking) return;
    // Readiness already aligned the media. Chasing a moving target before starting can seek forever on slow media.
    const { epoch, version } = state;
    const attempt = { action: 'blocked', epoch, version };
    pendingStart = attempt;
    mediaReloaded = false;
    video.play().then(() => {
      if (pendingStart === attempt) hasStartedScheduledPlayback = true;
    }).catch(error => {
      if (pendingStart === attempt && error.name !== 'AbortError') {
        reportBlocked = attempt;
        pauseVideo();
        wake();
      }
    }).finally(() => {
      if (pendingStart === attempt) {
        pendingStart = undefined;
        render();
      }
    });
  }

  function positionAt(serverTime) {
    return Math.min(video.duration, state.position + Math.max(0, serverTime - state.startsAt) / 1000);
  }

  function correctDrift() {
    if (state?.startsAt == null || !state.ownsSeat || !primed || priming ||
        networkError || outage || reportBlocked || reportBuffering || document.hidden ||
        video.paused || video.seeking || video.readyState < video.HAVE_FUTURE_DATA) {
      if (!useRateCorrection) sustainedDriftSamples = 0;
      return;
    }
    const now = performance.now() + offset;
    const target = positionAt(now);
    if (now < state.startsAt || !Number.isFinite(target) || target >= video.duration) return;
    const drift = target - video.currentTime;
    const distance = Math.abs(drift);
    hardDriftSamples = distance > 0.9 ? hardDriftSamples + 1 : 0;
    // Changing playback rate can briefly stop frame presentation even with data buffered.
    // Leave short phase differences alone and require a sustained, same-direction error.
    // A midpoint clock estimate can err by half its RTT on an asymmetric path.
    // Leave at least 40 ms of media tolerance even when the clock budget is exhausted.
    const correctionStart = Math.max(0.04, Math.min(rateDriftLimit, driftBudgetSeconds - clockRtt / 2000));
    const correctionStop = Math.min(rateDriftSettled, correctionStart * 0.6);
    const direction = Math.sign(drift);
    // Two public players each need room within the shared 0.5 s alignment budget.
    const threshold = useRateCorrection ? correctionStart : 0.24;
    sustainedDriftSamples = distance <= threshold ? 0
      : (Math.sign(sustainedDriftSamples) === direction ? sustainedDriftSamples : 0) + direction;
    const sustainedPublicDrift = !useRateCorrection && Math.abs(sustainedDriftSamples) >= 4;
    if ((distance > 1.25 || hardDriftSamples >= 2 || sustainedPublicDrift) && now >= nextHardSeek) {
      // Allow for the time spent decoding the destination while the room keeps playing.
      driftSeekStarted = performance.now();
      video.currentTime = positionAt(now + driftSeekLeadMs);
      setRate(1);
      nextHardSeek = now + 1500;
      hardDriftSamples = 0;
      sustainedDriftSamples = 0;
    } else if (useRateCorrection && video.playbackRate === 1 && Math.abs(sustainedDriftSamples) >= 4) {
      setRate(1 + direction * 0.10);
    } else if (video.playbackRate !== 1 && (distance <= correctionStop || drift * (video.playbackRate - 1) < 0)) {
      sustainedDriftSamples = 0;
      setRate(1);
    }
  }

  function followTimeline() {
    clearTimeout(startTimer);
    if (!state || priming) return;
    if (queuedCommand?.action === 'pause' || reportBlocked || reportBuffering || outage ||
        networkError || document.hidden) {
      pauseVideo();
      return;
    }
    if (state.startsAt === null || !state.ownsSeat || !primed) {
      pauseAndAlign(state.position);
      return;
    }
    const now = performance.now() + offset;
    // The first start after a media reload can be quicker than the original gesture calibration.
    const lead = mediaReloaded ? Math.min(playbackStartLeadMs, 250) : playbackStartLeadMs;
    const untilStart = state.startsAt - now - lead;
    if (untilStart > 0) {
      pauseAndAlign(state.position);
      startTimer = setTimeout(() => {
        followTimeline();
        render();
      }, untilStart);
      return;
    }
    const target = positionAt(now);
    if (!Number.isFinite(target) || target >= video.duration) return;
    if (video.paused) {
      // An early readiness snapshot can precede a Pause that supersedes the scheduled start.
      if (!host && state.serverTime < state.startsAt - lead - startSnapshotLeadMs) {
        wake();
        return;
      }
      beginPlayback();
    }
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
    if (reportBuffering) return reportBuffering;
    if (primed && !priming && !document.hidden && hasPlaybackData() && !video.seeking && !state.ready[role] &&
        (claim || state.ownsSeat) && Math.abs(state.position - video.currentTime) <= alignmentTolerance) {
      return { action: 'ready', epoch, version, position: video.currentTime, claim };
    }
    return { action: 'observe', epoch, version, position: mediaPosition() };
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
      if (operation.action === 'ready' && operation.claim && !state.ownsSeat) {
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
          result.wantsPlay || result.startsAt !== null || result.otherPlayer) {
        initialRewindRetry = undefined;
      }
      if (state && (epochChanged || (previouslyOwned && !result.ownsSeat) || result.otherPlayer)) {
        prepareIntent++;
        hasStartedScheduledPlayback = primed = claim = false;
        visitorBufferingTimeline = undefined;
        pendingClaimId = undefined;
      }
      if (!host && result.ownsSeat) closeInitialReload();
      updateClock(sent, received, result.serverTime);
      state = result;
      if (operation.action === 'recover') {
        primed = result.ownsSeat;
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
      if (operation === reportBuffering) reportBuffering = undefined;
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
        const visitorInterrupted = state.waiting.visitor === 'buffering' || state.waiting.visitor === 'connection' ||
          (wasWaitingForVisitor && state.ready.visitor && operation.action === 'observe');
        // A host stall can cancel a start scheduled after visitor buffering.
        const recoveringVisitorInterruption = host && readyBeforeRecovery && visitorInterrupted;
        const mayRetry = !epochChanged && previouslyOwned && primed && state.ownsSeat &&
          state.wantsPlay && state.startsAt === null && !state.ready[role] && !queuedCommand;
        mediaRecoveryRetry = mayRetry && (recoveringVisitorInterruption || hostInterruptedBufferingStart)
          ? { timeline, source: video.getAttribute('src'), afterVisitorInterruption: recoveringVisitorInterruption } : undefined;
        visitorBufferingTimeline = mayRetry && hasStartedScheduledPlayback && state.waiting.visitor === 'buffering'
          ? timeline : undefined;
        pendingStart = undefined;
        hardDriftSamples = 0;
        sustainedDriftSamples = 0;
        nextHardSeek = 0;
        driftSeekStarted = undefined;
      }
      if (!state.ownsSeat || state.ready[role] || !state.wantsPlay) mediaRecoveryRetry = undefined;
      followTimeline();
    } finally {
      if (generation === loadGeneration) {
        if (networkError && operation === queuedCommand && operation.action !== 'pause') queuedCommand = undefined;
        inFlight = undefined;
        render();
        const pendingReport = needsRecovery || queuedCommand || reportBlocked || outage || reportBuffering;
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
    if (!host || !state?.ownsSeat || (queuedCommand && !pausesSeek) || (networkError && action !== 'pause')) return;
    mediaRecoveryRetry = visitorBufferingTimeline = undefined;
    queuedCommand = { action, ...details, epoch: state.epoch, version: state.version };
    if (action === 'seek') queuedCommand.seekId = crypto.randomUUID();
    if (action === 'pause') {
      const interrupted = inFlight?.operation;
      queuedCommand.afterSeekId = interrupted?.action === 'seek' ? interrupted.seekId : unacknowledgedSeekId;
      clearTimeout(startTimer);
      pendingStart = undefined;
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
    pendingStart = undefined;
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

  prepare.addEventListener('click', async () => {
    const generation = loadGeneration;
    const intent = prepareIntent;
    priming = true;
    render();
    try {
      // Call play from the tap itself so WebKit can authorize this element for later starts.
      const startPosition = video.currentTime;
      const started = performance.now();
      await video.play();
      const startLeadMs = await measurePlaybackStart(generation, startPosition, started);
      if (generation !== loadGeneration || intent !== prepareIntent) return;
      playbackStartLeadMs = startLeadMs;
      mediaReloaded = false;
      pauseVideo();
      primed = true;
      claim = true;
      gestureFailed = false;
    } catch {
      if (generation === loadGeneration && intent === prepareIntent) markGestureFailed();
    } finally {
      if (generation === loadGeneration) {
        priming = false;
        followTimeline();
        wake();
      }
    }
  });
  play.addEventListener('click', () => command(state?.wantsPlay ? 'pause' : 'play'));
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
  for (const event of ['progress', 'durationchange', 'emptied']) video.addEventListener(event, renderBuffer);

  function stop() {
    if (!video.hasAttribute('src')) return;
    loadGeneration++;
    mediaRecoveryRetry = visitorBufferingTimeline = initialRewindRetry = undefined;
    hasStartedScheduledPlayback = initialReloadClosed = false;
    clearTimeout(poll);
    clearTimeout(startTimer);
    clearInterval(driftTimer);
    clearTimeout(stallTimer);
    state = undefined;
    queuedCommand = unacknowledgedSeekId = undefined;
    reportBlocked = reportBuffering = outage = pendingStart = undefined;
    reloadAfterReconnect = false;
    mediaReloaded = false;
    inFlight = pendingClaimId = undefined;
    priming = primed = claim = gestureFailed = networkError = false;
    seekPreview = false;
    commandMessage = '';
    driftSeekStarted = undefined;
    driftSeekLeadMs = initialDriftSeekLeadMs;
    clockSamples = [];
    video.removeAttribute('src');
    video.load();
    byId('player').hidden = true;
  }

  return {
    load(url, publicMedia = false) {
      if (!publicMedia) url = apiOrigin + url;
      if (video.getAttribute('src') === url) return;
      if (publicMedia || !useRateCorrection) stop();
      if (publicMedia) video.crossOrigin = 'anonymous';
      else if (apiOrigin) video.crossOrigin = 'use-credentials';
      else video.removeAttribute('crossorigin');
      // Direct public streams stay at normal speed and retain hard-seek correction.
      useRateCorrection = !publicMedia;
      mediaRecoveryRetry = visitorBufferingTimeline = initialRewindRetry = pendingStart = undefined;
      hasStartedScheduledPlayback = initialReloadClosed = false;
      video.src = url;
      clearInterval(driftTimer);
      driftTimer = setInterval(correctDrift, driftCheckMs);
      byId('player').hidden = false;
      wake();
    },
    stop,
  };
}
