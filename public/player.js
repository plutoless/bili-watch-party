const pollMs = 200;
const driftCheckMs = 100;
const stallConfirmMs = 200;
const alignmentTolerance = 0.05;
const initialDriftSeekLeadMs = 200;
const maxStartLeadMs = 650;

function formatTime(seconds) {
  const whole = Math.floor(seconds || 0);
  return Math.floor(whole / 60) + ':' + String(whole % 60).padStart(2, '0');
}

export function createPlayer({ apiOrigin, roomPath, role }) {
  const byId = id => document.getElementById(id);
  const video = byId('video');
  const prepare = byId('prepare');
  const play = byId('play');
  const seek = byId('seek');
  const host = role === 'host';
  const endpoint = apiOrigin + roomPath + '/playback';
  if (apiOrigin) video.crossOrigin = 'use-credentials';
  const playerId = crypto.randomUUID();
  const storageKey = 'watch-party-player:' + endpoint + ':' + role;
  let previousPlayerId;
  let queuedCommand;
  let playbackStartLeadMs = 0;
  try {
    const remembered = JSON.parse(sessionStorage.getItem(storageKey));
    previousPlayerId = remembered?.playerId;
    playbackStartLeadMs = remembered?.startLeadMs ?? 0;
    if (host && previousPlayerId && remembered.pause?.action === 'pause') queuedCommand = remembered.pause;
  } catch {
    // Storage may be disabled. The room cookie still authorizes a fresh player.
  }
  let loadGeneration = 0;
  let state;
  let poll;
  let startTimer;
  let driftTimer;
  let stallTimer;
  let inFlight = false;
  let priming = false;
  let primed = false;
  let claim = false;
  let gestureFailed = false;
  let reportBlocked;
  let reportBuffering;
  let outage;
  let reloadAfterReconnect = false;
  let rememberedSeat = false;
  let pendingStart;
  let networkError = false;
  let commandMessage = '';
  let clockSamples = [];
  let offset = 0;
  let hardDriftSamples = 0;
  let nextHardSeek = 0;
  let driftSeekStarted;
  let driftSeekLeadMs = initialDriftSeekLeadMs;
  let currentTimeline;
  let seekPreview = false;

  function setText(id, message) {
    const element = byId(id);
    if (element.textContent !== message) element.textContent = message;
  }

  function renderTime() {
    if (!Number.isFinite(video.duration)) return;
    if (Number(seek.max) !== video.duration) seek.max = video.duration;
    if (!seekPreview) seek.value = video.currentTime;
    const time = seekPreview ? Number(seek.value) : video.currentTime;
    seek.setAttribute('aria-valuetext', formatTime(time));
    setText('playback-time', formatTime(time) + ' / ' + formatTime(video.duration));
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
    play.textContent = state?.wantsPlay ? '暂停' : '播放';
    play.disabled = !canToggle || Boolean(queuedCommand);
    byId('seek-controls').hidden = !host;
    seek.disabled = !canControl || Boolean(queuedCommand);

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
      video.currentTime = target;
    }
  }

  function markGestureFailed() {
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

  function mediaPosition() {
    return video.seeking ? undefined : video.currentTime;
  }

  function playbackOutage(reason) {
    return { reason, position: mediaPosition(), epoch: state?.epoch, version: state?.version };
  }

  function rememberSeat() {
    try {
      const pause = queuedCommand?.action === 'pause' ? queuedCommand : undefined;
      sessionStorage.setItem(storageKey, JSON.stringify({ playerId, startLeadMs: playbackStartLeadMs, pause }));
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

  function beginPlayback(target) {
    if (!hasPlaybackData()) {
      checkBuffering();
      return;
    }
    if (pendingStart || video.seeking) return;
    if (Math.abs(video.currentTime - target) > 0.25) {
      video.currentTime = target;
      return;
    }
    const { epoch, version } = state;
    const attempt = { action: 'blocked', epoch, version };
    pendingStart = attempt;
    video.play().catch(error => {
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
        video.paused || video.seeking || video.readyState < video.HAVE_FUTURE_DATA) return;
    const now = performance.now() + offset;
    const target = positionAt(now);
    if (now < state.startsAt || !Number.isFinite(target) || target >= video.duration) return;
    const drift = target - video.currentTime;
    const distance = Math.abs(drift);
    hardDriftSamples = distance > 0.9 ? hardDriftSamples + 1 : 0;
    if ((distance > 1.25 || hardDriftSamples >= 2) && now >= nextHardSeek) {
      // Allow for the time spent decoding the destination while the room keeps playing.
      driftSeekStarted = performance.now();
      video.currentTime = positionAt(now + driftSeekLeadMs);
      setRate(1);
      nextHardSeek = now + 1500;
      hardDriftSamples = 0;
    } else if (video.playbackRate === 1 && distance > 0.30) {
      const correction = distance > 0.35 ? 0.10 : 0.05;
      setRate(1 + Math.sign(drift) * correction);
    } else if (distance < 0.04 || drift * (video.playbackRate - 1) < 0) {
      setRate(1);
    }
  }

  function followTimeline() {
    clearTimeout(startTimer);
    if (!state || priming) return;
    if (reportBlocked || reportBuffering || outage || networkError || document.hidden) {
      pauseVideo();
      return;
    }
    if (state.startsAt === null || !state.ownsSeat || !primed) {
      pauseAndAlign(state.position);
      return;
    }
    const now = performance.now() + offset;
    const untilStart = state.startsAt - now - playbackStartLeadMs;
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
    if (video.paused) beginPlayback(target);
  }

  function updateClock(sent, received, serverTime) {
    clockSamples = clockSamples.filter(sample => received - sample.received < 10_000);
    clockSamples.push({ received, rtt: received - sent, offset: serverTime - (sent + received) / 2 });
    offset = clockSamples.reduce((best, sample) => sample.rtt < best.rtt ? sample : best).offset;
  }

  function nextOperation() {
    if (previousPlayerId) return { action: 'recover', previousPlayerId };
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

  async function requestPlayback(operation) {
    const sent = performance.now();
    const response = await sendPlayback(operation, { signal: AbortSignal.timeout(2000) });
    if (!response.ok && response.status !== 409) throw new Error('Playback request failed');
    const result = await response.json();
    return { ok: response.ok, result, sent, received: performance.now() };
  }

  async function synchronize() {
    const generation = loadGeneration;
    const reportedOutage = outage;
    const operation = nextOperation();
    inFlight = true;
    try {
      const reply = await requestPlayback(operation).catch(() => null);
      if (generation !== loadGeneration) return;
      if (!reply) {
        networkError = true;
        reloadAfterReconnect = true;
        outage ??= playbackOutage('connection');
        clearTimeout(startTimer);
        if (!priming) pauseVideo();
        if (operation === queuedCommand) {
          commandMessage = operation.action === 'pause' ? '已请求暂停，重新连接后将同步。' : '连接中断，请确认播放状态后重试。';
        }
        return;
      }
      const { ok, result, sent, received } = reply;
      networkError = false;
      if (result.epoch !== state?.epoch) {
        clockSamples = [];
        if (state) primed = claim = false;
      }
      updateClock(sent, received, result.serverTime);
      if (state?.ownsSeat && !result.ownsSeat) primed = claim = false;
      state = result;
      if (operation.action === 'recover') {
        previousPlayerId = null;
        primed = result.ownsSeat;
      }
      if (result.ownsSeat && !rememberedSeat) {
        rememberSeat();
        rememberedSeat = true;
      }
      if (document.hidden && result.ready[role] && result.ownsSeat) {
        outage ??= playbackOutage('background');
      }
      const outageAcknowledged = ok && operation.action === 'unavailable' && outage === reportedOutage && operation.reason === outage?.reason;
      if (!result.ownsSeat || outageAcknowledged) {
        // The playback endpoint can recover while an interrupted media request stays stalled.
        if (reloadAfterReconnect && (outageAcknowledged || video.error)) video.load();
        reloadAfterReconnect = false;
        outage = undefined;
      }
      if (operation === reportBuffering) reportBuffering = undefined;
      if (operation === queuedCommand) {
        commandMessage = ok ? '' : '播放状态已更新，请重试操作。';
      }
      if (operation === reportBlocked) {
        reportBlocked = undefined;
        if (ok || state.blocked.includes(role)) markGestureFailed();
      }
      if (state.ownsSeat && state.ready[role]) claim = false;
      if (claim && state.otherPlayer) primed = claim = false;

      const timeline = state.epoch + ':' + state.version;
      if (timeline !== currentTimeline) {
        currentTimeline = timeline;
        clearTimeout(stallTimer);
        pendingStart = undefined;
        hardDriftSamples = 0;
        nextHardSeek = 0;
        driftSeekStarted = undefined;
      }
      followTimeline();
      if (operation === queuedCommand) {
        queuedCommand = undefined;
        if (operation.action === 'pause' && state.ownsSeat) rememberSeat();
      }
    } finally {
      if (generation === loadGeneration) {
        if (networkError && operation === queuedCommand && operation.action !== 'pause') queuedCommand = undefined;
        inFlight = false;
        render();
        const pendingReport = queuedCommand || reportBlocked || outage || reportBuffering;
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
    if (!state?.ownsSeat || queuedCommand || (networkError && action !== 'pause')) return;
    queuedCommand = { action, ...details, epoch: state.epoch, version: state.version };
    if (action === 'pause') rememberSeat();
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
    priming = true;
    render();
    try {
      // Call play from the tap itself so WebKit can authorize this element for later starts.
      const startPosition = video.currentTime;
      const started = performance.now();
      await video.play();
      const startLeadMs = await measurePlaybackStart(generation, startPosition, started);
      if (generation !== loadGeneration) return;
      playbackStartLeadMs = startLeadMs;
      pauseVideo();
      primed = true;
      claim = true;
      gestureFailed = false;
    } catch {
      if (generation === loadGeneration) markGestureFailed();
    } finally {
      if (generation === loadGeneration) {
        priming = false;
        followTimeline();
        wake();
      }
    }
  });
  play.addEventListener('click', () => command(state.wantsPlay ? 'pause' : 'play'));
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
  video.addEventListener('seeked', () => {
    if (driftSeekStarted !== undefined) {
      driftSeekLeadMs = Math.min(750, performance.now() - driftSeekStarted);
      driftSeekStarted = undefined;
    }
    wake();
  });
  for (const event of ['waiting', 'stalled', 'emptied', 'error']) video.addEventListener(event, () => {
    // A local seek can briefly lower readyState without interrupting continuous playback.
    clearTimeout(stallTimer);
    stallTimer = setTimeout(checkBuffering, stallConfirmMs);
    render();
  });
  video.addEventListener('timeupdate', renderTime);
  video.addEventListener('playing', render);

  return {
    load(url) {
      url = apiOrigin + url;
      if (video.getAttribute('src') === url) return;
      video.src = url;
      clearInterval(driftTimer);
      driftTimer = setInterval(correctDrift, driftCheckMs);
      byId('player').hidden = false;
      wake();
    },
    stop() {
      if (!video.hasAttribute('src')) return;
      loadGeneration++;
      clearTimeout(poll);
      clearTimeout(startTimer);
      clearInterval(driftTimer);
      clearTimeout(stallTimer);
      state = undefined;
      queuedCommand = undefined;
      reportBlocked = reportBuffering = outage = pendingStart = undefined;
      reloadAfterReconnect = false;
      inFlight = priming = primed = claim = gestureFailed = networkError = false;
      seekPreview = false;
      commandMessage = '';
      driftSeekStarted = undefined;
      driftSeekLeadMs = initialDriftSeekLeadMs;
      clockSamples = [];
      video.removeAttribute('src');
      video.load();
      byId('player').hidden = true;
    },
  };
}
