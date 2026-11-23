const pollMs = 200;
const alignmentTolerance = 0.05;

function formatTime(seconds) {
  const whole = Math.floor(seconds || 0);
  return Math.floor(whole / 60) + ':' + String(whole % 60).padStart(2, '0');
}

export function createPlayer({ roomPath, role }) {
  const byId = id => document.getElementById(id);
  const video = byId('video');
  const prepare = byId('prepare');
  const play = byId('play');
  const seek = byId('seek');
  const host = role === 'host';
  const endpoint = roomPath + '/playback';
  const playerId = crypto.randomUUID();
  let loadGeneration = 0;
  let state;
  let poll;
  let startTimer;
  let inFlight = false;
  let queuedCommand;
  let priming = false;
  let primed = false;
  let claim = false;
  let gestureFailed = false;
  let reportBlocked = false;
  let starting = false;
  let networkError = false;
  let commandMessage = '';
  let clockSamples = [];
  let offset = 0;
  let hardDriftSamples = 0;
  let nextHardSeek = 0;
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
    const canControl = host && state?.ownsSeat && primed && !networkError;
    const bothReady = state?.ready.host && state.ready.visitor;
    prepare.hidden = primed || Boolean(state?.otherPlayer);
    prepare.disabled = priming || !state || networkError || video.readyState < video.HAVE_CURRENT_DATA;
    prepare.textContent = gestureFailed ? '再次点按以准备' : '准备好了';
    play.hidden = !host;
    play.textContent = state?.wantsPlay ? '暂停' : '播放';
    play.disabled = !canControl || Boolean(queuedCommand) || (!state.wantsPlay && !bothReady);
    byId('seek-controls').hidden = !host;
    seek.disabled = !canControl || Boolean(queuedCommand);

    for (const [seat, name] of [['host', '房主'], ['visitor', '访客']]) {
      setText(seat + '-ready', name + ' · ' + (state?.ready[seat] ? '已就绪' : '未就绪'));
    }
    let status = '正在连接播放状态…';
    if (networkError) status = '连接中断，等待播放状态。';
    else if (gestureFailed || state?.blocked.length) status = '等待点按以允许播放。';
    else if (state?.startsAt != null) status = video.paused ? '即将同时播放…' : '正在同步播放';
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

  function pauseVideo() {
    video.pause();
    video.playbackRate = 1;
  }

  function pauseAndAlign(target) {
    pauseVideo();
    if (video.readyState >= video.HAVE_METADATA && !video.seeking &&
        Math.abs(video.currentTime - target) > alignmentTolerance) {
      video.currentTime = target;
    }
  }

  function allowPlaybackRetry() {
    primed = false;
    claim = false;
    gestureFailed = true;
    reportBlocked = Boolean(state?.ownsSeat);
    pauseVideo();
    wake();
  }

  function beginPlayback(target) {
    if (starting || video.seeking) return;
    if (Math.abs(video.currentTime - target) > 0.25) {
      video.currentTime = target;
      return;
    }
    const generation = loadGeneration;
    starting = true;
    video.play().catch(error => {
      if (generation === loadGeneration && error.name !== 'AbortError') allowPlaybackRetry();
    }).finally(() => {
      if (generation !== loadGeneration) return;
      starting = false;
      render();
    });
  }

  function correctDrift(target, now) {
    if (video.seeking || video.readyState < video.HAVE_FUTURE_DATA) return;
    const drift = target - video.currentTime;
    const distance = Math.abs(drift);
    hardDriftSamples = distance > 0.65 ? hardDriftSamples + 1 : 0;
    if (hardDriftSamples >= 2 && now >= nextHardSeek) {
      video.currentTime = target;
      video.playbackRate = 1;
      nextHardSeek = now + 1500;
      hardDriftSamples = 0;
    } else if (distance > 0.10) {
      video.playbackRate = drift > 0 ? 1.05 : 0.95;
    } else if (distance < 0.04 || drift * (video.playbackRate - 1) < 0) {
      video.playbackRate = 1;
    }
  }

  function followTimeline() {
    clearTimeout(startTimer);
    if (!state || priming) return;
    if (state.startsAt === null || !state.ownsSeat || !primed || networkError) {
      pauseAndAlign(state.position);
      return;
    }
    const now = performance.now() + offset;
    const untilStart = state.startsAt - now;
    if (untilStart > 0) {
      pauseAndAlign(state.position);
      startTimer = setTimeout(() => {
        followTimeline();
        render();
      }, untilStart);
      return;
    }
    const target = Math.min(video.duration, state.position - untilStart / 1000);
    if (!Number.isFinite(target) || target >= video.duration) return;
    if (video.paused) beginPlayback(target);
    else correctDrift(target, now);
  }

  function updateClock(sent, received, serverTime) {
    clockSamples = clockSamples.filter(sample => received - sample.received < 10_000);
    clockSamples.push({ received, rtt: received - sent, offset: serverTime - (sent + received) / 2 });
    offset = clockSamples.reduce((best, sample) => sample.rtt < best.rtt ? sample : best).offset;
  }

  function nextOperation() {
    if (!state) return { action: 'observe' };
    const { epoch, version } = state;
    if (queuedCommand) return queuedCommand;
    if (reportBlocked) return { action: 'blocked', epoch, version };
    const buffered = video.readyState >= video.HAVE_FUTURE_DATA ||
      (video.readyState >= video.HAVE_CURRENT_DATA && state.position >= video.duration - alignmentTolerance);
    if (primed && !priming && buffered && !video.seeking && !state.ready[role] &&
        (claim || state.ownsSeat) && Math.abs(state.position - video.currentTime) <= alignmentTolerance) {
      return { action: 'ready', epoch, version, position: video.currentTime, claim };
    }
    return { action: 'observe' };
  }

  async function synchronize() {
    const generation = loadGeneration;
    const operation = nextOperation();
    const sent = performance.now();
    inFlight = true;
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role, playerId, ...operation }),
        signal: AbortSignal.timeout(2000),
      });
      if (!response.ok && response.status !== 409) throw new Error('Playback request failed');
      const result = await response.json();
      if (generation !== loadGeneration) return;
      networkError = false;
      if (result.epoch !== state?.epoch) {
        clockSamples = [];
        if (state) primed = claim = false;
      }
      updateClock(sent, performance.now(), result.serverTime);
      if (state?.ownsSeat && !result.ownsSeat) primed = claim = false;
      state = result;
      if (operation === queuedCommand) {
        commandMessage = response.ok ? '' : '播放状态已更新，请重试操作。';
      }
      if (operation.action === 'blocked' && (response.ok || !state.ownsSeat)) reportBlocked = false;
      if (state.ownsSeat && state.ready[role]) claim = false;
      if (claim && state.otherPlayer) primed = claim = false;

      const timeline = state.epoch + ':' + state.version;
      if (timeline !== currentTimeline) {
        currentTimeline = timeline;
        hardDriftSamples = 0;
        nextHardSeek = 0;
      }
      followTimeline();
    } catch {
      if (generation !== loadGeneration) return;
      networkError = true;
      clearTimeout(startTimer);
      if (!priming) pauseVideo();
      if (operation === queuedCommand) commandMessage = '连接中断，请确认播放状态后重试。';
    } finally {
      if (generation === loadGeneration) {
        if (operation === queuedCommand) queuedCommand = undefined;
        inFlight = false;
        render();
        poll = setTimeout(synchronize, queuedCommand || reportBlocked && !networkError ? 0 : pollMs);
      }
    }
  }

  function wake() {
    clearTimeout(poll);
    if (!inFlight && video.hasAttribute('src')) poll = setTimeout(synchronize, 0);
    render();
  }

  function command(action, details) {
    if (!state?.ownsSeat || queuedCommand || networkError) return;
    queuedCommand = { action, ...details, epoch: state.epoch, version: state.version };
    commandMessage = '';
    wake();
  }

  prepare.addEventListener('click', async () => {
    const generation = loadGeneration;
    priming = true;
    render();
    try {
      // Call play from the tap itself so WebKit can authorize this element for later starts.
      await video.play();
      if (generation !== loadGeneration) return;
      pauseVideo();
      primed = true;
      claim = true;
      gestureFailed = false;
    } catch {
      if (generation === loadGeneration) allowPlaybackRetry();
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
  for (const event of ['canplay', 'seeked', 'error']) video.addEventListener(event, wake);
  video.addEventListener('timeupdate', renderTime);
  video.addEventListener('playing', render);

  return {
    load(url) {
      if (video.getAttribute('src') === url) return;
      video.src = url;
      byId('player').hidden = false;
      wake();
    },
    stop() {
      if (!video.hasAttribute('src')) return;
      loadGeneration++;
      clearTimeout(poll);
      clearTimeout(startTimer);
      state = undefined;
      queuedCommand = undefined;
      inFlight = priming = primed = claim = gestureFailed = reportBlocked = starting = networkError = false;
      seekPreview = false;
      commandMessage = '';
      clockSamples = [];
      video.removeAttribute('src');
      video.load();
      byId('player').hidden = true;
    },
  };
}
