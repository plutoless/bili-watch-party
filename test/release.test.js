import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

test('production release on isolated Git, SSH, Compose and Vercel command boundaries', t => {
  const dir = mkdtempSync(join(tmpdir(), 'watch-release-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, 'repo');
  const home = join(dir, 'remote');
  const bin = join(dir, 'bin');
  const conf = join(home, '.config/bili-watch-party');
  const stateFile = join(dir, 'state');
  const fixture = join(dir, 'release-command-fixture.js');
  for (const folder of [repo, conf, bin]) mkdirSync(folder, { recursive: true });
  copyFileSync('test/release-command-fixture.js', fixture);
  chmodSync(fixture, 0o700);
  for (const command of ['ssh', 'flock', 'sleep', 'docker', 'vercel', 'curl']) symlinkSync(fixture, join(bin, command));
  for (const file of ['compose.yaml', 'compose.release.yaml', 'Dockerfile', 'Caddyfile', '.dockerignore',
    'package.json', 'package-lock.json', 'vercel.json', 'public', 'src', 'scripts']) {
    cpSync(file, join(repo, file), { recursive: true });
  }
  writeFileSync(join(conf, 'compose-project'), 'existing-project\n');
  writeFileSync(join(conf, 'compose.env'), 'HOST_PASSWORD=synthetic-password\n');
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.org');
  git('add', '.');
  git('commit', '-qm', 'First release');
  git('init', '-q', '--bare', join(dir, 'origin'));
  git('remote', 'add', 'origin', join(dir, 'origin'));
  const advance = () => {
    git('commit', '--allow-empty', '-qm', 'Next release');
    git('push', '-q', 'origin', 'main');
    return git('rev-parse', 'HEAD');
  };
  git('push', '-q', 'origin', 'main');
  const first = git('rev-parse', 'HEAD');
  const rawHostKey = join(dir, 'host-key');
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', rawHostKey]);
  const hostKey = readFileSync(rawHostKey + '.pub', 'utf8').trim();
  const sshHost = 'ssh.fixture.test';
  const env = {
    ...process.env, PATH: bin + ':' + process.env.PATH, FIXTURE_STATE: stateFile, FIXTURE_REMOTE_HOME: home,
    FIXTURE_NODE_MODULES: fileURLToPath(new URL('../node_modules', import.meta.url)),
    DEPLOY_SSH_HOST: sshHost, DEPLOY_SSH_USER: 'fixture', DEPLOY_SSH_KEY: 'synthetic-ssh-key',
    DEPLOY_SSH_KNOWN_HOSTS: sshHost + ' ' + hostKey, DEPLOY_SSH_PORT: '',
    API_ORIGIN: 'https://api.fixture.test', WEB_ORIGIN: 'https://web.fixture.test', MEDIA_ORIGIN: '',
    VERCEL_ORG_ID: 'team_fixture', VERCEL_PROJECT_ID: 'prj_fixture', VERCEL_TOKEN: 'synthetic-vercel-token',
    VERCEL_AUTOMATION_BYPASS_SECRET: '',
  };
  writeFileSync(stateFile, JSON.stringify({ pages: {}, players: {} }));
  const readState = () => JSON.parse(readFileSync(stateFile, 'utf8'));
  function release(sha, failure, expected, variables = {}) {
    writeFileSync(stateFile, JSON.stringify({ ...readState(), stages: [], failure }));
    const result = spawnSync('bash', ['scripts/release.sh'], {
      cwd: repo, env: { ...env, RELEASE_SHA: sha, ...variables }, encoding: 'utf8',
    });
    const output = result.stdout + result.stderr;
    assert.equal(result.status, expected ? 1 : 0, output);
    if (expected) assert.match(output, expected);
    assert.doesNotMatch(output, /synthetic-ssh-key|synthetic-vercel-token|synthetic-password/);
    return readState();
  }
  assert.deepEqual(release(first, '', /缺少生产发布配置 VERCEL_TOKEN/, { VERCEL_TOKEN: '' }).stages, []);
  assert.deepEqual(release(first, '', /主机密钥配置/, { DEPLOY_SSH_PORT: '2222' }).stages, []);
  assert.deepEqual(release(first, 'host-key', /主机密钥校验失败/).stages, ['ssh-offline']);
  assert.deepEqual(release(first, 'ssh-offline', /SSH 不可达/).stages, ['ssh-offline']);
  assert.deepEqual(release(first, 'web-build', /网页构建失败/).stages, ['ssh-offline', 'web-build']);
  assert.equal(release(first, 'missing-player-build', /产物缺少播放器脚本/).backend, undefined);
  assert.equal(release(first, 'stage-web', /候选网页部署失败/).backend, undefined);
  assert.equal(release(first, 'stage-https', /候选网页 HTTPS/).backend, undefined);
  assert.equal(release(first, 'stage-player', /候选网页 HTTPS/).backend, undefined);
  assert.equal(release(first, 'candidate-project', /候选网页不属于配置的项目/).backend, undefined);
  assert.equal(release(first, 'backend-build', /镜像构建或拉取失败/).backend, undefined);
  assert.equal(release(first, 'compose-up', /Compose 启动或健康检查失败/).liveId, undefined);
  let state = release(first);
  assert.equal(state.liveId, 'dpl_' + first);
  assert.equal(state.backend, first);
  assert.ok(state.stages.indexOf('backend-https') < state.stages.indexOf('promote'));

  const second = advance();
  const custom = { DEPLOY_SSH_PORT: '2222', DEPLOY_SSH_KNOWN_HOSTS: '[ssh.fixture.test]:2222 ' + hostKey };
  assert.equal(release(second, 'backend-build', /现有容器仍在运行/, custom).backend, first);
  assert.equal(release(second, 'backend-https', /后台 HTTPS.*未切换/, custom).liveId, 'dpl_' + first);
  state = release(second, 'promote', /HTTP 403 \(forbidden\)[\s\S]*上一个正式网页部署已恢复/, custom);
  assert.equal(state.liveId, 'dpl_' + first);
  assert.equal(state.backend, second);
  state = release(second, 'live-https', /上一个正式网页部署已恢复/, custom);
  assert.ok(state.stages.includes('restore-web'));
  assert.equal(state.liveId, 'dpl_' + first);
  assert.equal(release(second, '', undefined, custom).liveId, 'dpl_' + second);

  const third = advance();
  state = release(third, '', undefined, { VERCEL_ORG_ID: "account_fixture", MEDIA_ORIGIN: 'https://media.fixture.test' });
  assert.equal(state.liveId, 'dpl_' + third);
  assert.match(state.pages[state.liveId], /media-src https:\/\/api\.fixture\.test https:\/\/media\.fixture\.test/);
  git('checkout', '-q', '--detach', second);
  state = release(second);
  assert.equal(state.liveId, 'dpl_' + third);
  assert.equal(state.backend, third);
  assert.deepEqual(state.stages, []);
});
