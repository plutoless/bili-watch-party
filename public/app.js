const byId = id => document.getElementById(id);
const loginForm = byId('login-form');
const sourceForm = byId('source-form');
const video = byId('video');
const play = byId('play');
const retry = byId('retry');
const roomError = byId('room-error');
const roomPath = location.pathname.startsWith('/rooms/') ? '/api' + location.pathname : null;
let pollTimer;
let failedAttempt;

const statusLabels = {
  queued: '等待导入',
  downloading: '正在下载',
  preparing: '正在准备视频',
  ready: '视频已就绪',
  failed: '导入失败',
};

function show(section) {
  byId('startup').hidden = true;
  for (const name of ['signin', 'create', 'room']) byId(name).hidden = name !== section;
  if (section === 'signin') {
    clearTimeout(pollTimer);
    video.removeAttribute('src');
    video.load();
    byId('player').hidden = true;
    play.hidden = false;
  }
}

async function request(path, body) {
  let response;
  try {
    response = await fetch(path, {
      ...(body !== undefined && {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      }),
      signal: AbortSignal.timeout(12_000),
    });
  } catch {
    throw new Error('暂时无法连接服务，请检查网络后重试。');
  }
  if (response.ok) return response.status === 204 ? null : response.json();
  const message = (await response.json().catch(() => null))?.error?.message;
  const error = new Error(message || '请求失败，请稍后重试。');
  error.status = response.status;
  throw error;
}

function render(room) {
  const status = byId('status');
  if (status.dataset.status !== room.status || !status.textContent) {
    status.dataset.status = room.status;
    status.textContent = statusLabels[room.status];
  }
  byId('title').textContent = room.title || '观影房间';
  const detail = byId('source-detail');
  detail.textContent = [room.bvid, 'P' + room.part, room.partTitle].filter(Boolean).join(' · ');
  detail.hidden = false;
  roomError.textContent = room.error?.message ?? '';
  failedAttempt = room.error?.retryable ? room.attempt : undefined;
  retry.hidden = !room.error?.retryable;
  if (room.mediaUrl) {
    if (video.getAttribute('src') !== room.mediaUrl) video.setAttribute('src', room.mediaUrl);
    byId('player').hidden = false;
  }
  clearTimeout(pollTimer);
  if (!['ready', 'failed'].includes(room.status)) pollTimer = setTimeout(refreshRoom, 750);
}

async function refreshRoom() {
  try {
    render(await request(roomPath));
  } catch (error) {
    if (error.status === 401) {
      show('signin');
      return;
    }
    roomError.textContent = error.message;
    if (error.status !== 404) pollTimer = setTimeout(refreshRoom, 2000);
  }
}

function openHostPage() {
  show(roomPath ? 'room' : 'create');
  if (roomPath) refreshRoom();
}

loginForm.addEventListener('submit', async event => {
  event.preventDefault();
  const button = loginForm.querySelector('button');
  button.disabled = true;
  byId('login-error').textContent = '';
  try {
    await request('/api/session', { password: byId('password').value });
    loginForm.reset();
    openHostPage();
  } catch (error) {
    byId('login-error').textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

sourceForm.addEventListener('submit', async event => {
  event.preventDefault();
  const button = sourceForm.querySelector('button');
  button.disabled = true;
  byId('source-error').textContent = '';
  try {
    const created = await request('/api/rooms', { url: byId('source').value });
    location.assign('/rooms/' + created.id);
  } catch (error) {
    if (error.status === 401) show('signin');
    else byId('source-error').textContent = error.message;
    button.disabled = false;
  }
});

retry.addEventListener('click', async () => {
  retry.disabled = true;
  try {
    render(await request(roomPath + '/retry', { attempt: failedAttempt }));
  } catch (error) {
    if (error.status === 401) show('signin');
    else roomError.textContent = error.message;
  } finally {
    retry.disabled = false;
  }
});

play.addEventListener('click', async () => {
  try {
    await video.play();
  } catch {
    roomError.textContent = '无法播放。请刷新页面或重新登录后再试。';
  }
});
video.addEventListener('playing', () => { play.hidden = true; });
video.addEventListener('error', () => {
  roomError.textContent = '无法读取视频。请刷新页面或重新登录后再试。';
});

async function connect() {
  try {
    await request('/api/session');
    openHostPage();
  } catch (error) {
    if (error.status === 401) show('signin');
    else {
      byId('startup').textContent = error.message;
      setTimeout(connect, 2000);
    }
  }
}

connect();
