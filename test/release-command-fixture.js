#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const [command, ...args] = [basename(process.argv[1]), ...process.argv.slice(2)];
const stateFile = process.env.FIXTURE_STATE;
const state = JSON.parse(readFileSync(stateFile, 'utf8'));
const value = flag => args[args.indexOf(flag) + 1];
const has = option => args.includes(option);
const save = () => writeFileSync(stateFile, JSON.stringify(state));
function stage(name) {
  state.stages.push(name);
  save();
  return state.failure === name;
}
const fail = () => process.exit(1);
const home = process.env.FIXTURE_REMOTE_HOME;

switch (command) {
  case 'ssh': {
    assert.ok(has('BatchMode=yes') && has('IdentitiesOnly=yes') && has('StrictHostKeyChecking=yes'));
    assert.ok(has('GlobalKnownHostsFile=/dev/null'));
    assert.equal(value('-p'), process.env.DEPLOY_SSH_PORT || '22');
    assert.equal(value('-F'), '/dev/null');
    assert.equal(readFileSync(value('-i'), 'utf8').trim(), 'synthetic-ssh-key');
    if (args.at(-1) === 'true') {
      if (stage('ssh-offline')) {
        console.error('Connection refused');
        process.exit(255);
      }
      if (state.failure === 'host-key') {
        console.error('Host key verification failed.');
        process.exit(255);
      }
      break;
    }
    const result = spawnSync('bash', ['-c', args.at(-1)], {
      env: { ...process.env, HOME: home }, stdio: 'inherit',
    });
    process.exit(result.status ?? 1);
  }
  case 'flock':
  case 'sleep':
    break;
  case 'docker': {
    assert.equal(value('--project-name'), 'existing-project');
    assert.equal(value('--env-file'), join(home, '.config/bili-watch-party/compose.env'));
    assert.ok(has('compose.yaml') && has('compose.release.yaml'));
    if (has('config')) {
      const environment = { PUBLIC_ORIGIN: process.env.API_ORIGIN, WEB_ORIGIN: process.env.WEB_ORIGIN };
      console.log(JSON.stringify({ services: { app: { environment }, caddy: { environment } } }));
    } else if (has('build')) {
      if (stage('backend-build')) fail();
    } else if (has('pull')) {
      if (stage('backend-pull')) fail();
    } else {
      assert.ok(has('up') && has('--wait') && has('--no-build') && has('never'));
      state.backend = process.env.RELEASE_SHA;
      if (stage('compose-up')) fail();
    }
    break;
  }
  case 'vercel': {
    const cwd = value('--cwd');
    const output = join(cwd, '.vercel/output/static');
    if (has('build')) {
      assert.equal(process.env.VERCEL_TOKEN, undefined);
      if (stage('web-build')) fail();
      const { settings } = JSON.parse(readFileSync(join(cwd, '.vercel/project.json'), 'utf8'));
      assert.match(settings.installCommand, /^npm ci --omit=dev\b/);
      symlinkSync(process.env.FIXTURE_NODE_MODULES, join(cwd, 'node_modules'));
      const result = spawnSync(process.execPath, ['scripts/build-web.js'], { cwd, stdio: 'inherit' });
      if (result.status !== 0) fail();
      mkdirSync(output, { recursive: true });
      copyFileSync(join(cwd, 'dist/index.html'), join(output, 'index.html'));
      if (state.failure !== 'missing-player-build') copyFileSync(join(cwd, 'dist/xgplayer.js'), join(output, 'xgplayer.js'));
    } else if (has('deploy')) {
      assert.ok(has('--prod') && has('--prebuilt') && has('--skip-domain'));
      if (stage('stage-web')) fail();
      state.candidate = readFileSync(join(output, 'index.html'), 'utf8');
      state.candidatePlayer = readFileSync(join(output, 'xgplayer.js'), 'utf8');
      save();
      console.log('https://staged-fixture.vercel.app');
    } else {
      fail();
    }
    break;
  }
  case 'curl': {
    const url = new URL(args.at(-1));
    let body = '';
    let status = 200;
    if (url.hostname === 'api.vercel.com') {
      const org = process.env.VERCEL_ORG_ID;
      const project = process.env.VERCEL_PROJECT_ID;
      const candidateId = 'dpl_' + process.env.RELEASE_SHA;
      const promotePath = '/v10/projects/' + project + '/promote/';
      assert.equal(url.searchParams.get('teamId'), org.startsWith('team_') ? org : null);
      if (url.pathname.startsWith('/v9/projects/')) {
        body = JSON.stringify({ verified: true });
      } else if (url.pathname === '/v13/deployments/staged-fixture.vercel.app') {
        const projectId = stage('candidate-project') ? 'prj_other' : project;
        body = JSON.stringify({ id: candidateId, projectId, readyState: 'READY', target: 'production' });
      } else if (url.pathname.startsWith(promotePath)) {
        assert.equal(value('--data'), '{}');
        const target = url.pathname.slice(promotePath.length);
        if (target === candidateId) {
          if (stage('promote')) {
            status = 403;
            body = JSON.stringify({ error: { code: 'forbidden' } });
          } else {
            assert.equal(state.backend, process.env.RELEASE_SHA);
            assert.ok(state.stages.includes('backend-https'));
            state.liveId = target;
            state.pages[target] = state.candidate;
            state.players[target] = state.candidatePlayer;
            status = 202;
          }
        } else {
          assert.ok(Object.hasOwn(state.pages, target));
          state.liveId = target;
          stage('restore-web');
        }
        save();
      } else {
        assert.equal(url.pathname, '/v4/aliases/' + new URL(process.env.WEB_ORIGIN).hostname);
        if (!state.liveId) status = 404;
        else body = JSON.stringify({ projectId: project, deploymentId: state.liveId });
      }
    } else if (url.origin === process.env.API_ORIGIN) {
      if (url.pathname === '/api/session') status = 401;
      else {
        if (stage('backend-https')) status = 502;
        body = JSON.stringify({ sha: state.backend });
        writeFileSync(value('-D'), 'HTTP/2 200\r\nAccess-Control-Allow-Origin: ' + process.env.WEB_ORIGIN +
          '\r\nAccess-Control-Allow-Credentials: true\r\n');
      }
    } else if (url.origin === 'https://staged-fixture.vercel.app') {
      if (url.pathname === '/xgplayer.js') {
        if (stage('stage-player')) status = 404;
        body = state.candidatePlayer;
      } else {
        if (stage('stage-https')) status = 404;
        body = state.candidate;
      }
    } else {
      assert.equal(url.origin, process.env.WEB_ORIGIN);
      const isNew = state.liveId === 'dpl_' + process.env.RELEASE_SHA;
      if (!state.liveId || (isNew && state.failure === 'live-https')) status = 502;
      if (url.pathname === '/xgplayer.js') {
        if (isNew && state.failure === 'live-player') status = 404;
        body = state.players[state.liveId] ?? '';
      } else {
        body = state.pages[state.liveId] ?? '';
      }
    }
    writeFileSync(value('-o'), body);
    process.stdout.write(String(status));
    break;
  }
  default:
    throw new Error('Unexpected command ' + command);
}
