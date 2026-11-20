import { env } from 'cloudflare:workers';
import type { Member, RoomAction, RoomInfo, RoomResponse, Signal, TemplateId, VoiceConfig } from '../model';
import { getTemplate, stepDurationMs } from '../templates';
import { applyRoomAction, createStoredRoom, ensureRoomUsable, pauseDisconnected, RoomError, withPresence, type StoredRoom } from './state';

type RoomRow = { id: string; state: string; revision: number; expires_at: number; updated_at: number };
type PresenceRow = { member_id: string; last_seen_at: number; left_at: number | null };
const utf8 = new TextEncoder();

function db(): D1Database {
  if (!env.DB) throw new RoomError('房间服务正在准备，请稍后再试。', 503, 'DATABASE_UNAVAILABLE');
  return env.DB;
}

export function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store, max-age=0', 'X-Content-Type-Options': 'nosniff' } });
}

export async function endpoint(run: () => Promise<unknown>): Promise<Response> {
  try { return json(await run()); }
  catch (error) {
    if (error instanceof RoomError) return json({ error: error.message, code: error.code }, error.status);
    console.error('Tongzai API error', error instanceof Error ? error.name + ': ' + error.message : 'unknown');
    return json({ error: '房间服务暂时没有响应，请稍后重试。', code: 'SERVER_ERROR' }, 500);
  }
}

export async function body(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (text.length > 64_000) throw new RoomError('提交的内容太长。', 413, 'PAYLOAD_TOO_LARGE');
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch { throw new RoomError('提交的内容格式不正确。'); }
}

function normalizeId(id: string): string {
  const value = id.trim().toUpperCase();
  if (!/^[A-F0-9]{12}$/.test(value)) throw new RoomError('没有找到这个房间，请检查邀请链接。', 404, 'ROOM_NOT_FOUND');
  return value;
}

function nickname(input: unknown): string {
  if (typeof input !== 'string') throw new RoomError('先告诉对方怎么称呼你。');
  const result = input.trim().replace(/[\u0000-\u001F\u007F]/g, '');
  if (!result || result.length > 20) throw new RoomError('昵称请填写 1–20 个字。');
  return result;
}

function randomToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), n => n.toString(16).padStart(2, '0')).join('');
}

async function hashToken(value: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', utf8.encode(value))), n => n.toString(16).padStart(2, '0')).join('');
}

async function requestHash(request: Request): Promise<string> {
  const token = request.headers.get('authorization')?.match(/^Bearer ([a-f0-9]{64})$/i)?.[1];
  if (!token) throw new RoomError('请通过邀请链接重新加入房间。', 401, 'INVALID_SESSION');
  return hashToken(token);
}

async function loadRoom(id: string, now = Date.now()): Promise<StoredRoom> {
  const row = await db().prepare('SELECT * FROM rooms WHERE id = ?').bind(normalizeId(id)).first<RoomRow>();
  if (!row) throw new RoomError('没有找到这个房间，请检查邀请链接。', 404, 'ROOM_NOT_FOUND');
  const stored = JSON.parse(row.state) as StoredRoom;
  ensureRoomUsable(stored.snapshot, now);
  return stored;
}

function identify(stored: StoredRoom, tokenHash: string): string {
  const memberId = Object.entries(stored.tokenHashes).find(([, hash]) => hash === tokenHash)?.[0];
  if (!memberId || !stored.snapshot.members.some(m => m.id === memberId)) throw new RoomError('房间凭证已失效，请重新加入。', 401, 'INVALID_SESSION');
  return memberId;
}

async function touch(roomId: string, memberId: string, now: number): Promise<void> {
  await db().prepare(`INSERT INTO room_presence (member_id, room_id, last_seen_at, left_at) VALUES (?, ?, ?, NULL)
    ON CONFLICT(member_id) DO UPDATE SET last_seen_at = excluded.last_seen_at, left_at = NULL
    WHERE room_presence.last_seen_at < ? OR room_presence.left_at IS NOT NULL`).bind(memberId, roomId, now, now - 5_000).run();
}

async function present(stored: StoredRoom, now: number): Promise<StoredRoom> {
  const rows = await db().prepare('SELECT member_id, last_seen_at, left_at FROM room_presence WHERE room_id = ?').bind(stored.snapshot.id).all<PresenceRow>();
  return withPresence(stored, new Map(rows.results.map(row => [row.member_id, { lastSeenAt: row.last_seen_at, leftAt: row.left_at }])), now);
}

async function saveCAS(previous: StoredRoom, next: StoredRoom, now: number): Promise<boolean> {
  const result = await db().prepare('UPDATE rooms SET state = ?, revision = ?, updated_at = ? WHERE id = ? AND revision = ?')
    .bind(JSON.stringify(next), next.snapshot.revision, now, previous.snapshot.id, previous.snapshot.revision).run();
  return result.meta.changes === 1;
}

function response(stored: StoredRoom, serverNow = Date.now()): RoomResponse {
  return { room: stored.snapshot, serverNow };
}

export async function createRoom(input: Record<string, unknown>): Promise<RoomResponse> {
  const name = nickname(input.nickname);
  if (!['conversation', 'reading', 'rehearsal'].includes(String(input.templateId))) throw new RoomError('请选择一个互动主题。');
  if (![10, 20, 30, 45].includes(Number(input.durationMinutes))) throw new RoomError('请选择 10、20、30 或 45 分钟。');
  if (input.mode !== 'duo' && input.mode !== 'solo') throw new RoomError('请选择双人互动或单人预览。');
  const now = Date.now();
  const id = crypto.randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase();
  const memberId = crypto.randomUUID();
  const token = randomToken();
  const member: Member = { id: memberId, nickname: name, role: 'host', ready: false, connected: true, voiceEnabled: false, lastSeenAt: now };
  const stored = createStoredRoom(id, member, await hashToken(token), { templateId: input.templateId as TemplateId, mode: input.mode, durationMinutes: Number(input.durationMinutes) }, now);
  await db().batch([
    db().prepare('INSERT INTO rooms (id, state, revision, expires_at, updated_at) VALUES (?, ?, ?, ?, ?)').bind(id, JSON.stringify(stored), 1, stored.snapshot.expiresAt, now),
    db().prepare('INSERT INTO room_presence (member_id, room_id, last_seen_at, left_at) VALUES (?, ?, ?, NULL)').bind(memberId, id, now),
  ]);
  return { ...response(stored, now), session: { memberId, token } };
}

export async function roomInfo(id: string): Promise<RoomInfo> {
  const { snapshot: room } = await loadRoom(id);
  return { id: room.id, templateId: room.templateId, mode: room.mode, durationMinutes: room.durationMinutes, status: room.status, memberCount: room.members.length };
}

export async function joinRoom(id: string, input: Record<string, unknown>): Promise<RoomResponse> {
  const name = nickname(input.nickname);
  const token = randomToken();
  const tokenHash = await hashToken(token);
  const memberId = crypto.randomUUID();
  for (let attempt = 0; attempt < 6; attempt++) {
    const now = Date.now();
    const stored = await loadRoom(id, now);
    const room = stored.snapshot;
    if (room.mode === 'solo') throw new RoomError('这是一个单人预览房间，请创建双人房间来邀请朋友。', 409, 'SOLO_ROOM');
    if (room.status === 'ended') throw new RoomError('这个房间已经结束，请创建新的房间。', 410, 'ROOM_ENDED');
    if (room.members.length >= 2) throw new RoomError('这个房间已经有两位参与者了。', 409, 'ROOM_FULL');
    const next = structuredClone(stored);
    next.snapshot.members.push({ id: memberId, nickname: name, role: 'guest', ready: false, connected: true, voiceEnabled: false, lastSeenAt: now });
    next.snapshot.revision++;
    next.tokenHashes[memberId] = tokenHash;
    // Both statements share a D1 transaction. The second is conditional on the exact successful join.
    const results = await db().batch([
      db().prepare('UPDATE rooms SET state = ?, revision = ?, updated_at = ? WHERE id = ? AND revision = ?').bind(JSON.stringify(next), next.snapshot.revision, now, room.id, room.revision),
      db().prepare(`INSERT INTO room_presence (member_id, room_id, last_seen_at, left_at)
        SELECT ?, ?, ?, NULL WHERE EXISTS (SELECT 1 FROM rooms WHERE id = ? AND json_extract(state, ?) = ?)`)
        .bind(memberId, room.id, now, room.id, `$.tokenHashes."${memberId}"`, tokenHash),
    ]);
    if (results[0].meta.changes === 1) return { ...response(await present(next, now), now), session: { memberId, token } };
  }
  throw new RoomError('房间正在更新，请重试加入。', 409, 'BUSY');
}

export async function readRoom(id: string, request: Request): Promise<RoomResponse> {
  const tokenHash = await requestHash(request);
  for (let attempt = 0; attempt < 6; attempt++) {
    const now = Date.now();
    const stored = await loadRoom(id, now);
    const memberId = identify(stored, tokenHash);
    await touch(stored.snapshot.id, memberId, now);
    const visible = await present(stored, now);
    const paused = pauseDisconnected(visible, now);
    if (paused === visible) return response(visible, now);
    if (await saveCAS(stored, paused, now)) return response(paused, now);
  }
  throw new RoomError('正在同步房间，请稍后重试。', 409, 'BUSY');
}

export async function performAction(id: string, request: Request, input: Record<string, unknown>): Promise<RoomResponse> {
  const tokenHash = await requestHash(request);
  const action = input as unknown as RoomAction;
  for (let attempt = 0; attempt < 6; attempt++) {
    const now = Date.now();
    const stored = await loadRoom(id, now);
    const memberId = identify(stored, tokenHash);
    if (action.type !== 'leave') await touch(stored.snapshot.id, memberId, now);
    const visible = await present(stored, now);
    const disconnected = pauseDisconnected(visible, now);
    if (disconnected !== visible) {
      await saveCAS(stored, disconnected, now);
      continue;
    }
    const durations = getTemplate(visible.snapshot.templateId).steps.map((_, i) => stepDurationMs(visible.snapshot, i));
    const next = applyRoomAction(visible, memberId, action, now, durations);
    if (next === visible) return response(visible, now);
    if (!await saveCAS(stored, next, now)) continue;
    if (action.type === 'leave') {
      await db().prepare('UPDATE room_presence SET left_at = ? WHERE member_id = ? AND room_id = ?').bind(now, memberId, next.snapshot.id).run();
      await closeMediaRoom(next.snapshot.id, memberId);
    } else if (next.snapshot.status === 'ended' && stored.snapshot.status !== 'ended') {
      await db().prepare('DELETE FROM room_signals WHERE room_id = ?').bind(next.snapshot.id).run();
      await closeMediaRoom(next.snapshot.id);
    }
    return response(next, now);
  }
  throw new RoomError('房间刚刚发生变化，请再试一次。', 409, 'BUSY');
}

export async function authenticateRoom(id: string, request: Request): Promise<{ stored: StoredRoom; memberId: string }> {
  const stored = await loadRoom(id);
  const memberId = identify(stored, await requestHash(request));
  return { stored, memberId };
}

export async function getSignals(id: string, request: Request): Promise<{ signals: Signal[]; lastId: number }> {
  const { stored, memberId } = await authenticateRoom(id, request);
  const params = new URL(request.url).searchParams;
  if (params.get('latest') === '1') {
    const latest = await db().prepare('SELECT MAX(id) AS last_id FROM room_signals WHERE room_id = ? AND to_id = ?')
      .bind(stored.snapshot.id, memberId).first<{ last_id: number | null }>();
    return { signals: [], lastId: latest?.last_id ?? 0 };
  }
  const rawAfter = Number(params.get('after') ?? 0);
  const after = Number.isSafeInteger(rawAfter) && rawAfter >= 0 ? rawAfter : 0;
  const rows = await db().prepare('SELECT * FROM room_signals WHERE room_id = ? AND to_id = ? AND id > ? AND created_at > ? ORDER BY id ASC LIMIT 100')
    .bind(stored.snapshot.id, memberId, after, Date.now() - 120_000).all<{ id: number; from_id: string; to_id: string; kind: Signal['kind']; call_id: string; payload: string; created_at: number }>();
  const signals = rows.results.map(row => ({ id: row.id, from: row.from_id, to: row.to_id, kind: row.kind, callId: row.call_id, payload: JSON.parse(row.payload), createdAt: row.created_at }));
  return { signals, lastId: signals.at(-1)?.id ?? after };
}

export async function postSignal(id: string, request: Request, input: Record<string, unknown>): Promise<{ ok: true }> {
  const { stored, memberId } = await authenticateRoom(id, request);
  if (stored.snapshot.status === 'ended') throw new RoomError('本次互动已经结束。', 409, 'ROOM_ENDED');
  if (stored.snapshot.mode === 'solo') throw new RoomError('单人预览无需语音连接。', 409, 'SOLO_ROOM');
  if (typeof input.to !== 'string' || input.to === memberId || !stored.snapshot.members.some(m => m.id === input.to)) throw new RoomError('请等待另一位加入房间。', 400, 'INVALID_RECIPIENT');
  if (!['offer', 'answer', 'ice', 'hangup'].includes(String(input.kind))) throw new RoomError('语音信令格式不正确。');
  const reset = input.kind === 'hangup' && input.callId === 'reset';
  if (!reset && (typeof input.callId !== 'string' || input.callId.length < 8 || input.callId.length > 100)) throw new RoomError('语音会话格式不正确。');
  const payload = JSON.stringify(input.payload ?? null);
  if (payload.length > 30_000) throw new RoomError('语音信令过长。', 413, 'PAYLOAD_TOO_LARGE');
  const now = Date.now();
  await db().batch([
    db().prepare('DELETE FROM room_signals WHERE room_id = ? AND created_at < ?').bind(stored.snapshot.id, now - 120_000),
    db().prepare('INSERT INTO room_signals (room_id, from_id, to_id, kind, call_id, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(stored.snapshot.id, memberId, input.to, input.kind as string, input.callId as string, payload, now),
  ]);
  return { ok: true };
}

function livekitConfigured(): boolean {
  return Boolean(env.LIVEKIT_URL && env.LIVEKIT_API_KEY && env.LIVEKIT_API_SECRET);
}

export function voiceConfig(): VoiceConfig {
  const urls = (env.STUN_URLS ?? '').split(',').map(s => s.trim()).filter(s => /^stuns?:/i.test(s));
  const iceServers: RTCIceServer[] = urls.length ? [{ urls }] : [];
  const relayConfigured = Boolean(env.TURN_URL && (env.TURN_SHARED_SECRET || (env.TURN_USERNAME && env.TURN_CREDENTIAL)));
  return { provider: livekitConfigured() ? 'livekit' : 'p2p', livekitConfigured: livekitConfigured(), iceServers, relayConfigured,
    stunConfigured: urls.length > 0, iceTransportPolicy: env.ICE_TRANSPORT_POLICY === 'relay' ? 'relay' : 'all' };
}

// Public capability discovery never contains relay passwords. Room members receive
// time-limited coturn credentials through the authenticated room endpoint.
export async function roomVoiceConfig(id: string, request: Request): Promise<VoiceConfig> {
  const { stored, memberId } = await authenticateRoom(id, request);
  if (stored.snapshot.status === 'ended') throw new RoomError('本次互动已经结束。', 409, 'ROOM_ENDED');
  if (stored.snapshot.mode === 'solo') throw new RoomError('单人练习无需语音连接。', 409, 'SOLO_ROOM');
  const config = voiceConfig();
  const urls = (env.TURN_URL ?? '').split(',').map(s => s.trim()).filter(s => /^turns?:/i.test(s));
  if (!config.relayConfigured || !urls.length) return { ...config, relayConfigured: false };
  if (env.TURN_SHARED_SECRET) {
    const requestedTtl = Number(env.TURN_TTL_SECONDS ?? 7200);
    const ttl = Number.isFinite(requestedTtl) ? Math.max(120, Math.min(86400, Math.floor(requestedTtl))) : 7200;
    const expires = Math.min(Math.floor(Date.now() / 1000) + ttl, Math.floor(stored.snapshot.expiresAt / 1000));
    const username = `${expires}:${stored.snapshot.id}:${memberId}`;
    const key = await crypto.subtle.importKey('raw', utf8.encode(env.TURN_SHARED_SECRET), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
    const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, utf8.encode(username)));
    const credential = btoa(Array.from(signature, n => String.fromCharCode(n)).join(''));
    config.iceServers.push({ urls, username, credential });
    config.credentialExpiresAt = expires * 1000;
  } else {
    config.iceServers.push({ urls, username: env.TURN_USERNAME, credential: env.TURN_CREDENTIAL });
  }
  return config;
}

function base64url(value: Uint8Array | string): string {
  const bytes = typeof value === 'string' ? utf8.encode(value) : value;
  return btoa(Array.from(bytes, n => String.fromCharCode(n)).join('')).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

async function jwt(claims: Record<string, unknown>): Promise<string> {
  if (!livekitConfigured()) throw new RoomError('托管语音尚未配置，当前可使用直连语音。', 503, 'LIVEKIT_NOT_CONFIGURED');
  const encoded = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' })) + '.' + base64url(JSON.stringify(claims));
  const key = await crypto.subtle.importKey('raw', utf8.encode(env.LIVEKIT_API_SECRET!), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return encoded + '.' + base64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, utf8.encode(encoded))));
}

export async function voiceToken(id: string, request: Request): Promise<{ url: string; token: string }> {
  const { stored, memberId } = await authenticateRoom(id, request);
  if (stored.snapshot.status === 'ended') throw new RoomError('本次互动已经结束。', 409, 'ROOM_ENDED');
  if (stored.snapshot.mode === 'solo') throw new RoomError('单人预览无需连接语音。', 409, 'SOLO_ROOM');
  if (!livekitConfigured()) throw new RoomError('托管语音尚未配置，当前可使用直连语音。', 503, 'LIVEKIT_NOT_CONFIGURED');
  const now = Math.floor(Date.now() / 1000);
  const token = await jwt({ iss: env.LIVEKIT_API_KEY, sub: memberId, iat: now, nbf: now - 5, exp: now + 600,
    video: { roomJoin: true, room: stored.snapshot.id, canPublish: true, canSubscribe: true, canPublishData: false, canPublishSources: ['microphone'] },
  });
  return { url: env.LIVEKIT_URL!, token };
}

async function closeMediaRoom(roomId: string, memberId?: string): Promise<void> {
  if (!livekitConfigured()) return;
  try {
    const now = Math.floor(Date.now() / 1000);
    const token = await jwt({ iss: env.LIVEKIT_API_KEY, iat: now, nbf: now - 5, exp: now + 60, video: { roomCreate: true, roomAdmin: true, room: roomId } });
    const origin = env.LIVEKIT_URL!.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:').replace(/\/$/, '');
    const result = await fetch(`${origin}/twirp/livekit.RoomService/${memberId ? 'RemoveParticipant' : 'DeleteRoom'}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(memberId ? { room: roomId, identity: memberId } : { room: roomId }), signal: AbortSignal.timeout(3000),
    });
    if (!result.ok && result.status !== 404) console.error('LiveKit cleanup failed', result.status);
  } catch { console.error('LiveKit cleanup request did not complete'); }
}
