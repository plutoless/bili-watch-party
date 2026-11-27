import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
  const composeEnv = join(conf, 'compose.env');
  const hostSettings = 'HOST_PASSWORD=synthetic-password\nENDED_ROOM_RETENTION_HOURS=48\n';
  writeFileSync(composeEnv, hostSettings);
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
    R2_ACCOUNT_ID: '', R2_BUCKET: '', R2_ACCESS_KEY_ID: '', R2_SECRET_ACCESS_KEY: '',
    VERCEL_ORG_ID: 'team_fixture', VERCEL_PROJECT_ID: 'prj_fixture', VERCEL_TOKEN: 'synthetic-vercel-token',
    VERCEL_AUTOMATION_BYPASS_SECRET: '',
  };
  writeFileSync(stateFile, JSON.stringify({ pages: {}, players: {} }));
  const readState = () => JSON.parse(readFileSync(stateFile, 'utf8'));
  function release(sha, failure, expected, variables = {}) {
    writeFileSync(stateFile, JSON.stringify({ ...readState(), stages: [], failure }));
    const result = spawnSync('bash', ['-x', 'scripts/release.sh'], {
      cwd: repo, env: { ...env, RELEASE_SHA: sha, ...variables }, encoding: 'utf8',
    });
    const output = result.stdout + result.stderr;
    assert.equal(/synthetic-ssh-key|synthetic-vercel-token|synthetic-password|synthetic-r2-/.test(output), false,
      'Release output must exclude credential values');
    assert.equal(result.status, expected ? 1 : 0, output);
    if (expected) assert.match(output, expected);
    assert.equal(readFileSync(composeEnv, 'utf8'), hostSettings);
    return readState();
  }
  assert.deepEqual(release(first, '', /缺少生产发布配置 VERCEL_TOKEN/, { VERCEL_TOKEN: '' }).stages, []);
  assert.deepEqual(release(first, '', /R2.*完整/, {
    MEDIA_ORIGIN: 'https://media.fixture.test', R2_BUCKET: 'fixture-finished-media',
  }).stages, []);
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
  assert.equal(state.r2EnvFile, null);
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
  const mediaOrigin = 'https://media.fixture.test';
  const r2 = {
    MEDIA_ORIGIN: mediaOrigin, R2_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
    R2_BUCKET: 'fixture-finished-media', R2_ACCESS_KEY_ID: 'synthetic-r2-access+id',
    R2_SECRET_ACCESS_KEY: 'synthetic-r2-secret/with=padding',
  };
  assert.deepEqual(release(third, '', /R2.*格式无效/, { ...r2,
    R2_SECRET_ACCESS_KEY: 'synthetic-r2-invalid\nOVERRIDE=value',
  }).stages, []);
  state = release(third, '', /正式网页尚未允许 R2 媒体源/, r2);
  assert.equal(state.backend, second);
  assert.ok(!state.stages.includes('backend-build') && !state.stages.includes('stage-web'));

  assert.equal(release(third, 'missing-media-csp', /Vercel 产物未允许/, { MEDIA_ORIGIN: mediaOrigin }).backend, second);
  state = release(third, '', undefined, { VERCEL_ORG_ID: 'account_fixture', MEDIA_ORIGIN: mediaOrigin });
  assert.equal(state.liveId, 'dpl_' + third);
  assert.equal(state.r2EnvFile, null);
  assert.match(state.pages[state.liveId], /media-src https:\/\/api\.fixture\.test https:\/\/media\.fixture\.test/);

  const beforeActivation = state;
  const fourth = advance();
  // The backend may have published with its new configuration before HTTPS failed.
  state = release(fourth, 'backend-https', /后台 HTTPS.*未切换/, r2);
  assert.equal(state.backend, fourth);
  assert.equal(state.liveId, 'dpl_' + third);
  const { r2EnvFile: activationEnv, backendDir: activationDir } = state;
  assert.ok(existsSync(join(activationDir, '.ci-r2')));
  assert.ok(!existsSync(join(beforeActivation.backendDir, '.ci-r2')));
  const releases = dirname(activationDir);
  const releaseRoot = dirname(releases);
  const lock = join(releaseRoot, 'deploy.lock');
  writeFileSync(lock, 'existing fixture lock');
  chmodSync(releaseRoot, 0o755);
  state = release(fourth, '', /发布根目录.*0700/, r2);
  assert.ok(!state.stages.includes('backend-build'));
  assert.equal(readFileSync(lock, 'utf8'), 'existing fixture lock');
  chmodSync(releaseRoot, 0o700);
  chmodSync(releases, 0o755);
  state = release(fourth, '', /后台源码目录.*0700/, r2);
  assert.ok(!state.stages.includes('backend-build'));
  chmodSync(releases, 0o700);
  chmodSync(dirname(activationEnv), 0o755);
  state = release(fourth, '', /R2 配置目录.*0700/, r2);
  assert.ok(!state.stages.includes('backend-build'));
  chmodSync(dirname(activationEnv), 0o700);
  const recoveryBlock = readFileSync('docs/production-release.md', 'utf8').match(/  ```bash\n([\s\S]+?)  ```/)[1];
  const recover = (config, directory = beforeActivation.backendDir, sha = third) => {
    const recovery = recoveryBlock.replace('<上一次健康后台的完整 SHA>', sha);
    return spawnSync('bash', ['-c', 'set -eo pipefail\n' + recovery], {
      cwd: directory, encoding: 'utf8', env: {
        ...env, ...r2, HOME: home, R2_ROLLBACK_CONFIG: config,
      },
    });
  };
  assert.equal(recover('').status, 1);
  assert.equal(recover('host', activationDir, fourth).status, 1);
  assert.equal(recover(activationEnv + '.missing', activationDir, fourth).status, 1);
  assert.equal(readState().backend, fourth);
  writeFileSync(stateFile, JSON.stringify({ ...readState(), failure: '', rollbackEnvFile: activationEnv }));
  const restored = recover(activationEnv);
  assert.equal(restored.status, 0, restored.stdout + restored.stderr);
  assert.equal(readState().backend, third);
  assert.equal(readState().r2EnvFile, activationEnv);
  const restoredHost = recover('host');
  assert.equal(restoredHost.status, 0, restoredHost.stdout + restoredHost.stderr);
  assert.equal(readState().r2EnvFile, null);
  writeFileSync(stateFile, JSON.stringify({ ...readState(), rollbackEnvFile: null }));

  state = release(fourth, 'live-https', /上一个正式网页部署已恢复/, r2);
  assert.equal(state.backend, fourth);
  assert.equal(state.liveId, 'dpl_' + third);
  assert.ok(state.stages.indexOf('check-current-web') < state.stages.indexOf('backend-build'));
  const overlayContents = Object.entries(r2).map(([key, value]) => key + '=' + value + '\n').join('');
  const rollbackFile = state.r2EnvFile;
  assert.equal(statSync(rollbackFile).mode & 0o777, 0o600);
  assert.equal(readFileSync(rollbackFile, 'utf8') === overlayContents, true, 'App overlay must match the input');
  assert.ok(!state.pages[state.liveId].includes('synthetic-r2-'));

  state = release(fourth, '', undefined, r2);
  assert.equal(state.liveId, 'dpl_' + fourth);
  assert.notEqual(state.r2EnvFile, rollbackFile);
  assert.equal(readFileSync(state.r2EnvFile, 'utf8') === overlayContents, true);
  assert.equal(readFileSync(rollbackFile, 'utf8') === overlayContents, true);
  assert.ok(!state.pages[state.liveId].includes('synthetic-r2-'));

  state = release(fourth, '', undefined, { MEDIA_ORIGIN: mediaOrigin });
  assert.equal(state.r2EnvFile, null);
  git('checkout', '-q', '--detach', second);
  state = release(second);
  assert.equal(state.liveId, 'dpl_' + fourth);
  assert.equal(state.backend, fourth);
  assert.deepEqual(state.stages, []);
});
