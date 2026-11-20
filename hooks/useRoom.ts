'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ActionType, RoomAction, RoomInfo, RoomResponse, RoomSnapshot, Session } from '@/lib/model';
import { appPath } from '@/lib/paths';

export const sessionKey = (id: string) => `tongzai.room.${id}`;
export function saveRoomSession(id: string, session: Session) {
  sessionStorage.setItem(sessionKey(id), JSON.stringify(session));
}
export async function jsonRequest<T>(url: string, options: RequestInit = {}): Promise<T> {
  const controller = options.signal ? null : new AbortController();
  const timer = controller ? setTimeout(() => controller.abort(), 10_000) : null;
  try {
    const response = await fetch(appPath(url), { ...options, signal: options.signal ?? controller?.signal, headers: { 'Content-Type': 'application/json', ...options.headers }, cache: 'no-store' });
    let data: any;
    try { data = await response.json(); }
    catch (cause) {
      if ((cause as Error).name === 'AbortError') throw cause;
      throw new Error('暂时没有收到有效回复，请稍后重试。');
    }
    if (!response.ok) {
      const error = new Error(data.error || '这次操作没有完成，请重试。') as Error & { status?: number };
      error.status = response.status;
      throw error;
    }
    return data as T;
  } catch (cause) {
    if ((cause as Error).name === 'AbortError') throw new Error('连接超时了，请检查网络后重试。');
    if (cause instanceof TypeError) throw new Error('暂时无法连接房间，请检查网络后重试。');
    throw cause;
  } finally { if (timer) clearTimeout(timer); }
}

export function useRoom(roomId: string) {
  const [session, setSession] = useState<Session | null>(null);
  const [room, setRoom] = useState<RoomSnapshot | null>(null);
  const [info, setInfo] = useState<RoomInfo | null>(null);
  const [initialized, setInitialized] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [terminalError, setTerminalError] = useState<string | null>(null);
  const [syncState, setSyncState] = useState<'connecting' | 'connected' | 'reconnecting'>('connecting');
  const [busy, setBusy] = useState<ActionType | 'join' | null>(null);
  const [offsetMs, setOffsetMs] = useState(0);
  const roomRef = useRef<RoomSnapshot | null>(null);
  const sessionRef = useRef<Session | null>(null);
  const busyRef = useRef(false);

  const apply = useCallback((data: RoomResponse, startedAt: number) => {
    setOffsetMs(data.serverNow - (startedAt + Date.now()) / 2);
    if (!roomRef.current || data.room.revision >= roomRef.current.revision) {
      roomRef.current = data.room;
      setRoom(data.room);
    }
    setSyncState('connected');
  }, []);

  useEffect(() => {
    let stored: Session | null = null;
    try {
      const value = sessionStorage.getItem(sessionKey(roomId));
      if (value) stored = JSON.parse(value);
    } catch { sessionStorage.removeItem(sessionKey(roomId)); }
    sessionRef.current = stored;
    setSession(stored);
    setInitialized(true);
  }, [roomId]);

  useEffect(() => {
    if (!initialized || session || terminalError) return;
    let cancelled = false;
    jsonRequest<RoomInfo>(`/api/rooms/${encodeURIComponent(roomId)}/info`)
      .then(data => { if (!cancelled) setInfo(data); })
      .catch(err => { if (!cancelled) { if (err.status === 404 || err.status === 410) setTerminalError(err.status === 410 ? '这个房间已经到期。可以重新创建一段相处的时间。' : '没有找到这个房间，请确认邀请链接是否完整。'); else setError(err.message); } });
    return () => { cancelled = true; };
  }, [initialized, roomId, session, terminalError]);

  useEffect(() => {
    if (!session || terminalError) return;
    let cancelled = false;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (inFlight || cancelled) return;
      inFlight = true;
      const startedAt = Date.now();
      try {
        const data = await jsonRequest<RoomResponse>(`/api/rooms/${encodeURIComponent(roomId)}`, { headers: { Authorization: `Bearer ${session.token}` } });
        if (!cancelled) apply(data, startedAt);
      } catch (err) {
        if (!cancelled) {
          setSyncState('reconnecting');
          const status = (err as Error & { status?: number }).status;
          if (status === 404 || status === 410) {
            setTerminalError(status === 410 ? '这个房间已经到期。可以重新创建一段相处的时间。' : '这个房间已经不可用，请确认邀请链接。');
            setRoom(null); roomRef.current = null;
            sessionStorage.removeItem(sessionKey(roomId));
            sessionRef.current = null; setSession(null);
            cancelled = true;
          } else if (status === 401 || status === 403) {
            sessionStorage.removeItem(sessionKey(roomId));
            sessionRef.current = null;
            setSession(null);
            setRoom(null);
            roomRef.current = null;
            setError('房间身份已失效，请重新加入。');
          } else if (!roomRef.current) setError((err as Error).message);
        }
      }
      inFlight = false;
      if (!cancelled && roomRef.current?.status !== 'ended') timer = setTimeout(poll, 1100);
    };
    void poll();
    const visible = () => { if (document.visibilityState === 'visible') { clearTimeout(timer); void poll(); } };
    document.addEventListener('visibilitychange', visible);
    return () => { cancelled = true; clearTimeout(timer); document.removeEventListener('visibilitychange', visible); };
  }, [roomId, session, terminalError, apply]);

  const join = useCallback(async (nickname: string) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy('join');
    setError(null);
    const startedAt = Date.now();
    try {
      const data = await jsonRequest<RoomResponse>(`/api/rooms/${encodeURIComponent(roomId)}/join`, { method: 'POST', body: JSON.stringify({ nickname: nickname.trim() }) });
      if (!data.session) throw new Error('未能取得房间身份，请重新加入。');
      saveRoomSession(roomId, data.session);
      sessionRef.current = data.session;
      setSession(data.session);
      apply(data, startedAt);
    } catch (err) { setError((err as Error).message); }
    finally { busyRef.current = false; setBusy(null); }
  }, [roomId, apply]);

  const action = useCallback(async (type: ActionType, payload?: RoomAction['payload']): Promise<RoomResponse | null> => {
    const currentSession = sessionRef.current;
    if (!currentSession || (busyRef.current && !['pause', 'end', 'leave', 'voice'].includes(type))) return null;
    const ownsBusy = !busyRef.current;
    if (ownsBusy) { busyRef.current = true; setBusy(type); }
    setError(null);
    const startedAt = Date.now();
    try {
      const body: RoomAction = { type, actionId: crypto.randomUUID(), expectedRevision: roomRef.current?.revision, payload };
      const data = await jsonRequest<RoomResponse>(`/api/rooms/${encodeURIComponent(roomId)}/actions`, { method: 'POST', keepalive: type === 'leave', headers: { Authorization: `Bearer ${currentSession.token}` }, body: JSON.stringify(body) });
      apply(data, startedAt);
      return data;
    } catch (err) { setError((err as Error).message); return null; }
    finally { if (ownsBusy) { busyRef.current = false; setBusy(null); } }
  }, [roomId, apply]);

  const forget = useCallback(() => { sessionStorage.removeItem(sessionKey(roomId)); }, [roomId]);
  return { room, info, session, initialized, error, terminalError, syncState, busy, offsetMs, join, action, forget, clearError: () => setError(null) };
}
