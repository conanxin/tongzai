import type { Member, RoomAction, RoomSnapshot } from '../model';

export class RoomError extends Error {
  status: number;
  code: string;
  constructor(message: string, status = 400, code = 'INVALID_REQUEST') {
    super(message); this.name = 'RoomError'; this.status = status; this.code = code;
  }
}

export type StoredRoom = {
  snapshot: RoomSnapshot;
  tokenHashes: Record<string, string>;
  applied: Record<string, { memberId: string; at: number }>;
};

export const OFFLINE_AFTER_MS = 20_000;
export const ROOM_TTL_MS = 24 * 60 * 60 * 1000;
const ADVANCING = new Set(['start', 'resume', 'next', 'transfer', 'accept_control']);
const ACTIONS = new Set(['ready', 'start', 'next', 'pause', 'resume', 'transfer', 'accept_control', 'decline_control', 'end', 'leave', 'note', 'voice']);

export function ensureRoomUsable(room: RoomSnapshot, now: number) {
  if (room.expiresAt <= now) throw new RoomError('这个房间已过期，请重新创建。', 410, 'ROOM_EXPIRED');
}

function stopRoom(room: RoomSnapshot, now: number) {
  room.status = 'ended'; room.endedAt = now; room.stepEndsAt = null; room.pausedRemainingMs = null;
  room.controlRequest = null;
  for (const member of room.members) { member.ready = false; member.voiceEnabled = false; }
}

function pauseRoom(room: RoomSnapshot, now: number) {
  if (room.status !== 'running') return;
  room.pausedRemainingMs = Math.max(0, (room.stepEndsAt ?? now) - now);
  room.stepEndsAt = null; room.status = 'paused'; room.controlRequest = null;
  for (const member of room.members) member.ready = false;
}

export function pauseDisconnected(stored: StoredRoom, now: number): StoredRoom {
  if (stored.snapshot.mode !== 'duo' || stored.snapshot.status !== 'running' || stored.snapshot.members.every(m => m.connected)) return stored;
  const next = structuredClone(stored);
  pauseRoom(next.snapshot, now);
  next.snapshot.revision += 1;
  return next;
}

export function withPresence(stored: StoredRoom, presence: Map<string, { lastSeenAt: number; leftAt: number | null }>, now: number): StoredRoom {
  const copy = structuredClone(stored);
  copy.snapshot.members = copy.snapshot.members.map(member => {
    const p = presence.get(member.id);
    const lastSeenAt = p?.lastSeenAt ?? member.lastSeenAt;
    return { ...member, lastSeenAt, connected: !p?.leftAt && now - lastSeenAt <= OFFLINE_AFTER_MS };
  });
  return copy;
}

export function applyRoomAction(stored: StoredRoom, memberId: string, action: RoomAction, now: number, stepDurations: number[]): StoredRoom {
  ensureRoomUsable(stored.snapshot, now);
  if (!action || typeof action.actionId !== 'string' || action.actionId.length < 8 || action.actionId.length > 128 || !ACTIONS.has(action.type)) {
    throw new RoomError('操作格式不正确，请刷新后重试。');
  }
  const old = stored.applied[action.actionId];
  if (old) {
    if (old.memberId !== memberId) throw new RoomError('操作标识已使用，请重试。', 409, 'ACTION_CONFLICT');
    return stored;
  }
  const next = structuredClone(stored);
  const room = next.snapshot;
  const member = room.members.find(m => m.id === memberId);
  if (!member) throw new RoomError('请重新加入这个房间。', 401, 'INVALID_SESSION');
  if (ADVANCING.has(action.type) && action.expectedRevision !== room.revision) {
    throw new RoomError('房间状态刚刚更新，请确认当前进度后再试。', 409, 'STALE_REVISION');
  }
  const payload = action.payload ?? {};
  const controller = () => {
    if (room.controllerId !== memberId) throw new RoomError('请由当前主持者操作。', 403, 'NOT_CONTROLLER');
  };
  const allReady = () => {
    if (room.mode === 'duo' && room.members.length !== 2) throw new RoomError('等另一位加入后再开始。', 409, 'WAITING_FOR_PARTNER');
    if (!room.members.every(m => m.ready && m.connected)) throw new RoomError('等所有参与者准备好后再开始。', 409, 'NOT_READY');
  };
  if (room.status === 'ended' && !['end', 'leave', 'note'].includes(action.type) && !(action.type === 'voice' && payload.enabled === false)) {
    throw new RoomError('本次互动已经结束。', 409, 'ROOM_ENDED');
  }
  switch (action.type) {
    case 'ready':
      if (!['waiting', 'paused'].includes(room.status)) throw new RoomError('当前无需重新准备。', 409, 'INVALID_STATE');
      if (payload.ready !== undefined && typeof payload.ready !== 'boolean') throw new RoomError('准备状态不正确。');
      member.ready = payload.ready ?? true;
      break;
    case 'start':
      controller();
      if (room.status !== 'waiting') throw new RoomError('房间已经开始，请同步当前状态。', 409, 'INVALID_STATE');
      allReady(); room.status = 'running'; room.stepIndex = 0; room.stepEndsAt = now + stepDurations[0]; room.pausedRemainingMs = null;
      break;
    case 'next':
      controller();
      if (room.status !== 'running') throw new RoomError('继续互动后才能进入下一环节。', 409, 'INVALID_STATE');
      if (room.stepIndex + 1 >= stepDurations.length) stopRoom(room, now);
      else { room.stepIndex++; room.stepEndsAt = now + stepDurations[room.stepIndex]; }
      break;
    case 'pause':
      pauseRoom(room, now);
      break;
    case 'resume':
      controller();
      if (room.status !== 'paused') throw new RoomError('房间当前没有暂停。', 409, 'INVALID_STATE');
      allReady(); room.status = 'running'; room.stepEndsAt = now + (room.pausedRemainingMs ?? stepDurations[room.stepIndex]); room.pausedRemainingMs = null;
      break;
    case 'transfer': {
      controller();
      const target = room.members.find(m => m.id !== memberId && (!payload.targetId || m.id === payload.targetId));
      if (!target || !target.connected) throw new RoomError('另一位在线时才能交接主持。', 409, 'PARTNER_UNAVAILABLE');
      room.controlRequest = { from: memberId, to: target.id };
      break;
    }
    case 'accept_control':
      if (!room.controlRequest || room.controlRequest.to !== memberId) throw new RoomError('没有等待你确认的交接。', 409, 'NO_CONTROL_REQUEST');
      room.controllerId = memberId; room.controlRequest = null;
      break;
    case 'decline_control':
      if (!room.controlRequest || room.controlRequest.to !== memberId) throw new RoomError('没有等待你确认的交接。', 409, 'NO_CONTROL_REQUEST');
      room.controlRequest = null;
      break;
    case 'end':
      if (room.status !== 'ended') stopRoom(room, now);
      break;
    case 'leave':
      member.ready = false; member.connected = false; member.voiceEnabled = false;
      room.controlRequest = null;
      pauseRoom(room, now);
      break;
    case 'note':
      if (typeof payload.note !== 'string' || payload.note.length > 6000) throw new RoomError('共同记录最多可写 6000 字。');
      room.sharedNote = payload.note;
      break;
    case 'voice':
      if (typeof payload.enabled !== 'boolean') throw new RoomError('语音状态不正确。');
      if (room.mode === 'solo' && payload.enabled) throw new RoomError('单人预览无需连接语音。', 409, 'SOLO_ROOM');
      member.voiceEnabled = payload.enabled;
      break;
  }
  room.revision += 1;
  next.applied[action.actionId] = { memberId, at: now };
  const history = Object.entries(next.applied).sort((a, b) => a[1].at - b[1].at);
  for (const [id] of history.slice(0, Math.max(0, history.length - 256))) delete next.applied[id];
  return next;
}

export function createStoredRoom(id: string, member: Member, tokenHash: string, settings: Pick<RoomSnapshot, 'mode' | 'templateId' | 'durationMinutes'>, now: number): StoredRoom {
  return {
    snapshot: { id, ...settings, status: 'waiting', members: [member], controllerId: member.id, stepIndex: 0, revision: 1, stepEndsAt: null, pausedRemainingMs: null, createdAt: now, expiresAt: now + ROOM_TTL_MS, endedAt: null, sharedNote: '', controlRequest: null },
    tokenHashes: { [member.id]: tokenHash }, applied: {},
  };
}
