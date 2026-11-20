import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { request as rawRequest } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { SqliteD1 } from '../server/sqlite-d1.ts';

const project = fileURLToPath(new URL('../', import.meta.url));
const entry = join(project, 'standalone/server/index.mjs');
const TURN_TEST_SECRET = 'integration-test-only-turn-secret';

async function startServer(directory) {
  assert.ok(existsSync(entry), 'Build the Node server with vite build --config vite.server.config.ts before this test');
  const child = spawn(process.execPath, [entry], {
    cwd: project,
    env: {
      ...process.env, HOST: '127.0.0.1', PORT: '0', APP_BASE_PATH: '/tongzai',
      DATA_DIR: join(directory, 'data'), STATIC_DIR: join(directory, 'client'),
      MIGRATIONS_DIR: join(project, 'standalone/migrations'),
      LIVEKIT_URL: '', LIVEKIT_API_KEY: '', LIVEKIT_API_SECRET: '',
      STUN_URLS: 'stun:127.0.0.1:3478', TURN_URL: 'turn:127.0.0.1:3478?transport=udp',
      TURN_SHARED_SECRET: TURN_TEST_SECRET, TURN_TTL_SECONDS: '3600',
      TURN_USERNAME: '', TURN_CREDENTIAL: '', ICE_TRANSPORT_POLICY: 'all',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '', diagnostics = '';
  const address = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`Node server did not become ready: ${diagnostics}`)); }, 10_000);
    child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-6000); });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Node server exited before listening (${code}): ${diagnostics}`)); });
    child.stdout.on('data', chunk => {
      output += chunk;
      let end;
      while ((end = output.indexOf('\n')) >= 0) {
        const line = output.slice(0, end); output = output.slice(end + 1);
        try {
          const data = JSON.parse(line);
          if (data.event === 'listening') { clearTimeout(timeout); resolve(data); }
        } catch { /* Only the ready JSON is relevant to the test. */ }
      }
    });
  });
  return {
    origin: `http://127.0.0.1:${address.port}`,
    base: `http://127.0.0.1:${address.port}/tongzai`,
    async stop() {
      if (child.exitCode !== null) return;
      await new Promise(resolve => {
        const timeout = setTimeout(() => child.kill('SIGKILL'), 6000);
        child.once('exit', () => { clearTimeout(timeout); resolve(); });
        child.kill('SIGTERM');
      });
    },
  };
}

async function api(server, path, data, session) {
  const response = await fetch(server.base + path, {
    method: data === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(session ? { Authorization: `Bearer ${session.token}` } : {}) },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  return { status: response.status, data: await response.json() };
}

test('real HTTP: base path, atomic join, room lifecycle, scoped TURN, and SQLite restart persistence', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tongzai-node-test-'));
  await mkdir(join(directory, 'client/assets'), { recursive: true });
  await writeFile(join(directory, 'client/index.html'), '<!doctype html><title>Tongzai test</title><main>同在</main>');
  await writeFile(join(directory, 'client/assets/test.js'), 'export const ready = true;');
  let server = await startServer(directory);
  t.after(async () => { await server.stop(); await rm(directory, { recursive: true, force: true }); });

  const health = await api(server, '/api/health');
  assert.deepEqual(health.data, { ok: true, service: 'tongzai', runtime: 'node', storage: 'sqlite', basePath: '/tongzai' });
  assert.equal(health.status, 200);
  assert.equal((await fetch(server.origin + '/api/health')).status, 404);
  assert.match(await (await fetch(server.base + '/')).text(), /同在/);
  assert.match((await fetch(server.base + '/assets/test.js')).headers.get('content-type'), /javascript/);
  assert.equal((await fetch(server.base + '/.env')).status, 404);

  const traversal = await new Promise((resolve, reject) => {
    const request = rawRequest({ hostname: '127.0.0.1', port: new URL(server.origin).port, path: '/tongzai/%2e%2e/data/tongzai.sqlite' }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject); request.end();
  });
  assert.equal(traversal, 400);
  const tooLarge = await fetch(server.base + '/api/rooms', { method: 'POST', body: 'x'.repeat(110_000) });
  assert.equal(tooLarge.status, 413);

  const created = await api(server, '/api/rooms', { nickname: '甲', mode: 'duo', templateId: 'reading', durationMinutes: 20 });
  assert.equal(created.status, 200);
  const roomId = created.data.room.id;
  const host = created.data.session;
  assert.match(roomId, /^[A-F0-9]{12}$/);
  assert.match(await (await fetch(`${server.base}/r/${roomId}`)).text(), /同在/);
  const joins = await Promise.all([
    api(server, `/api/rooms/${roomId}/join`, { nickname: '乙' }),
    api(server, `/api/rooms/${roomId}/join`, { nickname: '丙' }),
  ]);
  assert.deepEqual(joins.map(value => value.status).sort(), [200, 409]);
  assert.equal(joins.find(value => value.status === 409).data.code, 'ROOM_FULL');
  const guest = joins.find(value => value.status === 200).data.session;
  let room = (await api(server, `/api/rooms/${roomId}`, undefined, host)).data.room;
  assert.equal(room.members.length, 2);
  assert.equal(JSON.stringify(room).includes(host.token), false);
  assert.equal((await api(server, `/api/rooms/${roomId}`)).status, 401);

  const publicVoice = await api(server, '/api/voice-config');
  assert.equal(publicVoice.data.relayConfigured, true);
  assert.equal(publicVoice.data.iceServers.some(ice => 'credential' in ice || 'username' in ice), false);
  assert.equal(JSON.stringify(publicVoice.data).includes(TURN_TEST_SECRET), false);
  assert.equal((await api(server, `/api/rooms/${roomId}/voice-config`)).status, 401);
  assert.equal((await api(server, `/api/rooms/${roomId}/voice-config`, undefined, { token: 'f'.repeat(64) })).status, 401);
  const privateVoice = await api(server, `/api/rooms/${roomId}/voice-config`, undefined, host);
  assert.equal(privateVoice.status, 200);
  const relay = privateVoice.data.iceServers.find(ice => ice.credential);
  assert.ok(relay);
  assert.equal(relay.credential, createHmac('sha1', TURN_TEST_SECRET).update(relay.username).digest('base64'));
  const expiresAt = Number(relay.username.split(':')[0]);
  assert.ok(expiresAt > Date.now() / 1000 + 3500 && expiresAt <= Date.now() / 1000 + 3600);
  assert.match(relay.username, new RegExp(`:${roomId}:${host.memberId}$`));
  assert.equal(privateVoice.data.credentialExpiresAt, expiresAt * 1000);

  const act = async (session, type, payload, actionId = randomUUID(), expectedRevision = room.revision) => {
    const result = await api(server, `/api/rooms/${roomId}/actions`, { actionId, type, expectedRevision, ...(payload ? { payload } : {}) }, session);
    if (result.status === 200) room = result.data.room;
    return result;
  };
  assert.equal((await act(host, 'ready', { ready: true })).status, 200);
  assert.equal((await act(guest, 'ready', { ready: true })).status, 200);
  assert.equal((await act(host, 'start')).status, 200);
  assert.equal(room.status, 'running');
  const actionId = randomUUID(), revision = room.revision;
  const advance = { actionId, type: 'next', expectedRevision: revision };
  const advances = await Promise.all([
    api(server, `/api/rooms/${roomId}/actions`, advance, host),
    api(server, `/api/rooms/${roomId}/actions`, advance, host),
  ]);
  assert.deepEqual(advances.map(value => value.status), [200, 200]);
  assert.deepEqual(advances.map(value => value.data.room.stepIndex), [1, 1]);
  assert.deepEqual(advances.map(value => value.data.room.revision), [revision + 1, revision + 1]);
  room = advances[0].data.room;
  const stale = await act(host, 'next', undefined, randomUUID(), revision);
  assert.equal(stale.status, 409); assert.equal(stale.data.code, 'STALE_REVISION');
  assert.equal((await act(guest, 'pause', undefined, randomUUID(), 0)).status, 200);
  assert.equal(room.status, 'paused');
  assert.ok(room.pausedRemainingMs > 0);
  assert.equal((await act(host, 'resume')).status, 409);
  await act(host, 'ready', { ready: true }); await act(guest, 'ready', { ready: true });
  assert.equal((await act(host, 'resume')).status, 200);
  assert.equal(room.status, 'running');
  assert.equal((await act(host, 'note', { note: '重启之后，仍然保留这一段共同记录。' })).status, 200);

  const signal = await api(server, `/api/rooms/${roomId}/signals`, { to: guest.memberId, kind: 'hangup', callId: 'reset', payload: {} }, host);
  assert.equal(signal.status, 200);
  assert.equal((await api(server, `/api/rooms/${roomId}/signals?after=0`, undefined, host)).data.signals.length, 0);
  const received = await api(server, `/api/rooms/${roomId}/signals?after=0`, undefined, guest);
  assert.equal(received.data.signals.length, 1);
  assert.equal(received.data.signals[0].from, host.memberId);
  const latest = await api(server, `/api/rooms/${roomId}/signals?latest=1`, undefined, guest);
  assert.deepEqual(latest.data.signals, []);
  assert.equal(latest.data.lastId, received.data.lastId);

  const saved = structuredClone(room);
  await server.stop();
  server = await startServer(directory);
  const resumed = await api(server, `/api/rooms/${roomId}`, undefined, host);
  assert.equal(resumed.status, 200);
  room = resumed.data.room;
  assert.equal(room.id, saved.id);
  assert.equal(room.sharedNote, saved.sharedNote);
  assert.equal(room.stepIndex, saved.stepIndex);
  assert.equal(room.revision, saved.revision);
  assert.equal(room.members.length, 2);
  assert.equal((await api(server, `/api/rooms/${roomId}/join`, { nickname: '再次加入' })).status, 409);
  assert.equal((await act(guest, 'end', undefined, randomUUID(), 0)).status, 200);
  assert.equal(room.status, 'ended');
  assert.equal(room.members.every(member => !member.voiceEnabled), true);
  await server.stop();

  const sqlite = new DatabaseSync(join(directory, 'data/tongzai.sqlite'));
  try {
    const migrations = (await readdir(join(project, 'standalone/migrations'))).filter(name => name.endsWith('.sql'));
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM _tongzai_migrations').get().count, migrations.length);
    assert.equal(sqlite.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  } finally { sqlite.close(); }
});

test('SQLite batch rolls back earlier writes when a later statement fails', async () => {
  const database = new SqliteD1(':memory:');
  try {
    database.sqlite.exec('CREATE TABLE transaction_check (id TEXT PRIMARY KEY, value TEXT NOT NULL)');
    await assert.rejects(database.batch([
      database.prepare('INSERT INTO transaction_check (id, value) VALUES (?, ?)').bind('same', 'first'),
      database.prepare('INSERT INTO transaction_check (id, value) VALUES (?, ?)').bind('same', 'second'),
    ]));
    assert.equal((await database.prepare('SELECT COUNT(*) AS count FROM transaction_check').first()).count, 0);
  } finally { database.close(); }
});
