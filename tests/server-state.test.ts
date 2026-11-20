import { test } from 'node:test';
import assert from 'node:assert/strict';
// Node 24 strips TypeScript directly; the production bundler uses the same source.
// @ts-ignore explicit extension is needed by Node's native TypeScript loader.
import { applyRoomAction, createStoredRoom, ensureRoomUsable, pauseDisconnected, RoomError, withPresence } from '../lib/server/state.ts';
import type { Member, RoomAction } from '../lib/model';

const NOW = 1_800_000_000_000;
const durations = [120_000, 240_000, 180_000];
const host: Member = { id: 'host', nickname: '甲', role: 'host', ready: false, connected: true, voiceEnabled: false, lastSeenAt: NOW };
const guest: Member = { ...host, id: 'guest', nickname: '乙', role: 'guest' };
function setup(mode: 'duo' | 'solo' = 'duo') {
  const stored = createStoredRoom('AB12CD34EF56', host, 'host-hash', { mode, templateId: 'conversation', durationMinutes: 10 }, NOW);
  if (mode === 'duo') { stored.snapshot.members.push(structuredClone(guest)); stored.tokenHashes.guest = 'guest-hash'; }
  return stored;
}
let serial = 0;
function action(type: RoomAction['type'], revision: number, payload?: RoomAction['payload']): RoomAction {
  return { actionId: `action-${++serial}`, type, expectedRevision: revision, payload };
}
function readyAndStart(mode: 'duo' | 'solo' = 'duo') {
  let room = setup(mode);
  room = applyRoomAction(room, 'host', action('ready', room.snapshot.revision), NOW, durations);
  if (mode === 'duo') room = applyRoomAction(room, 'guest', action('ready', room.snapshot.revision), NOW, durations);
  return applyRoomAction(room, 'host', action('start', room.snapshot.revision), NOW, durations);
}

test('both participants must be ready and only the controller advances', () => {
  let room = setup();
  assert.throws(() => applyRoomAction(room, 'host', action('start', room.snapshot.revision), NOW, durations), (e: unknown) => e instanceof RoomError && e.code === 'NOT_READY');
  room = readyAndStart();
  assert.equal(room.snapshot.stepEndsAt, NOW + durations[0]);
  assert.throws(() => applyRoomAction(room, 'guest', action('next', room.snapshot.revision), NOW, durations), (e: unknown) => e instanceof RoomError && e.code === 'NOT_CONTROLLER');
});

test('retried next is idempotent, and stale distinct next is rejected', () => {
  const room = readyAndStart();
  const nextAction = action('next', room.snapshot.revision);
  const advanced = applyRoomAction(room, 'host', nextAction, NOW + 1000, durations);
  const retried = applyRoomAction(advanced, 'host', nextAction, NOW + 2000, durations);
  assert.equal(retried.snapshot.stepIndex, 1);
  assert.equal(retried.snapshot.revision, advanced.snapshot.revision);
  assert.throws(() => applyRoomAction(advanced, 'host', action('next', room.snapshot.revision), NOW + 2000, durations), (e: unknown) => e instanceof RoomError && e.code === 'STALE_REVISION');
});

test('pause accepts an old revision and resume needs both new confirmations', () => {
  const room = readyAndStart();
  let paused = applyRoomAction(room, 'guest', action('pause', 0), NOW + 30_000, durations);
  assert.equal(paused.snapshot.status, 'paused');
  assert.equal(paused.snapshot.pausedRemainingMs, 90_000);
  assert.equal(paused.snapshot.members.every((m: Member) => !m.ready), true);
  assert.throws(() => applyRoomAction(paused, 'host', action('resume', paused.snapshot.revision), NOW + 60_000, durations), (e: unknown) => e instanceof RoomError && e.code === 'NOT_READY');
  paused = applyRoomAction(paused, 'host', action('ready', paused.snapshot.revision), NOW + 60_000, durations);
  paused = applyRoomAction(paused, 'guest', action('ready', paused.snapshot.revision), NOW + 60_000, durations);
  const resumed = applyRoomAction(paused, 'host', action('resume', paused.snapshot.revision), NOW + 60_000, durations);
  assert.equal(resumed.snapshot.stepEndsAt, NOW + 150_000);
});

test('control transfer needs acceptance from the designated participant', () => {
  const room = readyAndStart();
  const offered = applyRoomAction(room, 'host', action('transfer', room.snapshot.revision), NOW, durations);
  assert.equal(offered.snapshot.controllerId, 'host');
  assert.throws(() => applyRoomAction(offered, 'host', action('accept_control', offered.snapshot.revision), NOW, durations), (e: unknown) => e instanceof RoomError && e.code === 'NO_CONTROL_REQUEST');
  const accepted = applyRoomAction(offered, 'guest', action('accept_control', offered.snapshot.revision), NOW, durations);
  assert.equal(accepted.snapshot.controllerId, 'guest');
  assert.equal(accepted.snapshot.controlRequest, null);
});

test('lost heartbeat pauses a running duo and clears readiness', () => {
  const room = readyAndStart();
  const presence = new Map([['host', { lastSeenAt: NOW + 25_000, leftAt: null }], ['guest', { lastSeenAt: NOW, leftAt: null }]]);
  const visible = withPresence(room, presence, NOW + 25_000);
  const paused = pauseDisconnected(visible, NOW + 25_000);
  assert.equal(paused.snapshot.status, 'paused');
  assert.equal(paused.snapshot.pausedRemainingMs, 95_000);
  assert.equal(paused.snapshot.members.find((m: Member) => m.id === 'guest')?.connected, false);
});

test('solo starts with one member and final next ends all media state', () => {
  let room = readyAndStart('solo');
  assert.equal(room.snapshot.status, 'running');
  room = applyRoomAction(room, 'host', action('next', room.snapshot.revision), NOW + 1000, durations);
  room = applyRoomAction(room, 'host', action('next', room.snapshot.revision), NOW + 2000, durations);
  room = applyRoomAction(room, 'host', action('next', room.snapshot.revision), NOW + 3000, durations);
  assert.equal(room.snapshot.status, 'ended');
  assert.equal(room.snapshot.stepEndsAt, null);
  assert.equal(room.snapshot.endedAt, NOW + 3000);
});

test('expired rooms cannot be mutated, while ended-room notes can be saved', () => {
  let room = readyAndStart();
  assert.throws(() => ensureRoomUsable(room.snapshot, room.snapshot.expiresAt), (e: unknown) => e instanceof RoomError && e.code === 'ROOM_EXPIRED');
  room = applyRoomAction(room, 'guest', action('end', 0), NOW + 1000, durations);
  room = applyRoomAction(room, 'host', action('note', room.snapshot.revision, { note: '共同的问题' }), NOW + 2000, durations);
  assert.equal(room.snapshot.sharedNote, '共同的问题');
  assert.equal(room.snapshot.status, 'ended');
});
