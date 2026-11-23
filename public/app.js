import { createPlayer } from './player.js';

const byId = id => document.getElementById(id);
const loginForm = byId('login-form');
const sourceForm = byId('source-form');
const retry = byId('retry');
const roomError = byId('room-error');
const actionMessage = byId('action-message');
const visitor = location.pathname.startsWith('/invite/');
const path = visitor ? location.pathname.replace('/invite/', '/rooms/') : location.pathname;
const roomPath = path.startsWith('/rooms/') ? '/api' + path : null;
const player = createPlayer({ roomPath, role: visitor ? 'visitor' : 'host' });
let invitationToken = visitor ? location.hash.slice(1) : '';
let pollVersion = 0;
let actionPending = false;
let displayedRequests = '';
let pollTimer;
let failedAttempt;

const statusLabels = {
  queued: '等待导入',
  downloading: '正在下载',
  preparing: '正在准备视频',
  ready: '视频已就绪',
  failed: '导入失败',
  pending: '等待房主批准',
  waiting: '等待视频就绪',
  expired: '邀请已失效或房间已结束，请向房主索取新邀请。',
  full: '唯一访客席位已被占用。',
  ended: '房间已结束。',
  missing: '找不到房间。',
};

function show(section) {
  byId('startup').hidden = true;
  for (const name of ['signin', 'create', 'room']) byId(name).hidden = name !== section;
  if (section === 'signin') {
    clearTimeout(pollTimer);
    player.stop();
    byId('invite-url').value = '';
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

function setText(element, text) {
  if (element.textContent !== text) element.textContent = text;
}

function setStatus(state) {
  const status = byId('status');
  if (status.dataset.status === state && status.textContent) return;
  status.dataset.status = state;
  status.textContent = statusLabels[state];
}

function showTerminal(state) {
  setStatus(state);
  player.stop();
  byId('title').textContent = '观影房间';
  byId('source-detail').hidden = true;
  byId('host-tools').hidden = true;
  byId('invite-url').value = '';
  byId('request-code').hidden = true;
  retry.hidden = true;
  roomError.textContent = '';
}

function render(room) {
  if (room.status === 'ended') return showTerminal('ended');
  const waiting = visitor && ['queued', 'downloading', 'preparing'].includes(room.status);
  setStatus(waiting ? 'waiting' : room.status);
  byId('title').textContent = room.title || '观影房间';
  const detail = byId('source-detail');
  detail.textContent = [room.bvid, 'P' + room.part, room.partTitle].filter(Boolean).join(' · ');
  detail.hidden = false;
  setText(roomError, room.error?.message ?? '');
  failedAttempt = room.error?.retryable ? room.attempt : undefined;
  retry.hidden = visitor || !room.error?.retryable;
  if (room.mediaUrl) player.load(room.mediaUrl);
  if (!visitor) renderHostTools(room);
}

function renderHostTools({ invitation, occupied, requests, id }) {
  byId('host-tools').hidden = false;
  const invitationStatus = occupied ? '访客已加入。'
    : invitation ? '邀请有效至 ' + new Date(invitation.expiresAt).toLocaleTimeString()
    : '当前没有有效邀请。';
  setText(byId('invitation-status'), invitationStatus);
  const link = invitation ? location.origin + '/invite/' + id + '#' + invitation.token : '';
  if (byId('invite-url').value !== link) byId('invite-url').value = link;
  byId('invitation-link').hidden = !invitation;
  byId('copy-invite').hidden = !invitation;
  byId('revoke-invite').hidden = !invitation;
  byId('generate-invite').textContent = invitation ? '更换邀请' : '生成邀请';

  const requestIds = requests.map(request => request.id).join(',');
  if (requestIds === displayedRequests) return;
  displayedRequests = requestIds;
  byId('join-requests').replaceChildren(...requests.map(({ id }) => {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = '批准访客 ' + id.slice(0, 8);
    button.addEventListener('click', () => hostAction('approve', { requestId: id }, button));
    item.append(button);
    return item;
  }));
}

function renderVisitor(result) {
  if (result.state === 'approved') {
    byId('request-code').hidden = true;
    render(result.room);
  } else if (result.state === 'pending') {
    setStatus('pending');
    setText(roomError, '');
    const code = byId('request-code');
    code.textContent = '申请编号 ' + result.requestId.slice(0, 8) + '。可发给房主核对。';
    code.hidden = false;
  } else {
    showTerminal(result.state);
  }
  return ['pending', 'approved'].includes(result.state);
}

function schedulePoll(delay) {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(refreshRoom, delay);
}

async function refreshRoom() {
  clearTimeout(pollTimer);
  const version = ++pollVersion;
  try {
    const result = visitor
      ? await request(roomPath + '/join', invitationToken ? { token: invitationToken } : undefined)
      : await request(roomPath);
    if (version !== pollVersion) return;
    if (invitationToken) {
      invitationToken = '';
      history.replaceState(null, '', location.pathname);
    }
    if (visitor) {
      if (renderVisitor(result)) schedulePoll(1500);
    } else {
      render(result);
      if (result.status !== 'ended') schedulePoll(1000);
    }
  } catch (error) {
    if (version !== pollVersion) return;
    if (error.status === 401 && !visitor) return show('signin');
    if (error.status === 404) showTerminal(visitor ? 'expired' : 'missing');
    else {
      roomError.textContent = error.message;
      schedulePoll(2000);
    }
  }
}

async function hostAction(action, body, button) {
  if (actionPending) return;
  actionPending = true;
  pollVersion++;
  clearTimeout(pollTimer);
  button.disabled = true;
  actionMessage.textContent = '';
  let resume = true;
  try {
    const room = await request(roomPath + '/' + action, body);
    render(room);
    resume = room.status !== 'ended';
  } catch (error) {
    if (error.status === 401) {
      resume = false;
      show('signin');
    } else {
      actionMessage.textContent = error.message;
    }
  } finally {
    button.disabled = false;
    actionPending = false;
    if (resume) schedulePoll(1000);
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

retry.addEventListener('click', () => hostAction('retry', { attempt: failedAttempt }, retry));
for (const [id, action] of [['generate-invite', 'generate'], ['revoke-invite', 'revoke']]) {
  const button = byId(id);
  button.addEventListener('click', () => hostAction('invitation', { action }, button));
}
byId('copy-invite').addEventListener('click', async () => {
  const input = byId('invite-url');
  try {
    await navigator.clipboard.writeText(input.value);
    actionMessage.textContent = '已复制邀请。';
  } catch {
    input.focus();
    input.select();
    actionMessage.textContent = '请复制已选中的邀请链接。';
  }
});
byId('end-room').addEventListener('click', event => {
  if (confirm('结束房间后，邀请和视频访问将立即失效。确定结束？')) {
    hostAction('end', {}, event.currentTarget);
  }
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

if (visitor) {
  byId('back').hidden = true;
  show('room');
  window.addEventListener('hashchange', () => {
    invitationToken = location.hash.slice(1);
    if (invitationToken) refreshRoom();
  });
  refreshRoom();
} else {
  connect();
}
