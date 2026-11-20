'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Room as LiveKitRoom } from 'livekit-client';
import type { RoomSnapshot, Session, Signal, VoiceConfig } from '@/lib/model';
import { appPath } from '@/lib/paths';
import { connectionPathFromStats, type VoiceConnectionPath } from '@/lib/voice-diagnostics';

type VoiceStatus = 'idle' | 'requesting' | 'waiting' | 'connecting' | 'connected' | 'error';
type Props = { room: RoomSnapshot | null; session: Session | null; onVoiceChange: (enabled: boolean) => Promise<void> };

function friendlyError(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError') return '麦克风权限尚未开启。请在浏览器的网站设置中允许使用麦克风，再试一次。';
    if (error.name === 'NotFoundError') return '没有找到可用的麦克风。请连接耳机或检查设备设置。';
    if (error.name === 'NotReadableError') return '麦克风暂时无法使用，可能正被其他应用占用。';
  }
  return error instanceof Error ? error.message : '语音连接暂时没有成功，请稍后重试。';
}

export function useVoice(props: Props) {
  const latest = useRef(props);
  latest.current = props;
  const [status, setStatus] = useState<VoiceStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [active, setActive] = useState(false);
  const [provider, setProvider] = useState<'p2p' | 'livekit'>('p2p');
  const [needsPlayback, setNeedsPlayback] = useState(false);
  const [relayConfigured, setRelayConfigured] = useState(false);
  const [iceTransportPolicy, setIceTransportPolicy] = useState<RTCIceTransportPolicy>('all');
  const [connectionPath, setConnectionPath] = useState<VoiceConnectionPath>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const livekitRef = useRef<LiveKitRoom | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const connectionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const statsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const generation = useRef(0);
  const callRef = useRef('');
  const remoteIdRef = useRef('');
  const candidateBuffer = useRef(new Map<string, RTCIceCandidateInit[]>());
  const lastSignalRef = useRef(0);
  const signalTail = useRef<Promise<void>>(Promise.resolve());
  const voiceStateTail = useRef<Promise<void>>(Promise.resolve());
  const mounted = useRef(true);
  const starting = useRef(false);
  const skipOffersUntil = useRef(0);
  const peerObservedEnabled = useRef(false);

  const changeVoiceState = useCallback((enabled: boolean, run?: number) => {
    const change = latest.current.onVoiceChange;
    const next = voiceStateTail.current.catch(() => {}).then(async () => {
      if (enabled && run !== generation.current) return;
      await change(enabled);
    });
    voiceStateTail.current = next;
    return next;
  }, []);

  const request = useCallback(async <T,>(path: string, body?: unknown): Promise<T> => {
    const session = latest.current.session;
    const response = await fetch(appPath(path), {
      method: body === undefined ? 'GET' : 'POST', cache: 'no-store',
      signal: AbortSignal.timeout(8000),
      headers: { 'Content-Type': 'application/json', ...(session ? { Authorization: `Bearer ${session.token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await response.json() as T & { error?: string };
    if (!response.ok) throw new Error(data.error || '语音服务暂时不可用。');
    return data as T;
  }, []);

  const enablePlayback = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio?.srcObject) return;
    try { await audio.play(); if (mounted.current) setNeedsPlayback(false); }
    catch { if (mounted.current) setNeedsPlayback(true); }
  }, []);

  const closePeer = useCallback(() => {
    if (connectionTimerRef.current) clearTimeout(connectionTimerRef.current);
    connectionTimerRef.current = null;
    if (statsTimerRef.current) clearTimeout(statsTimerRef.current);
    statsTimerRef.current = null;
    if (mounted.current) setConnectionPath(null);
    const peer = peerRef.current;
    peerRef.current = null;
    if (peer) {
      peer.onicecandidate = null; peer.ontrack = null; peer.onconnectionstatechange = null;
      peer.close();
    }
    if (audioRef.current) { audioRef.current.pause(); audioRef.current.srcObject = null; }
    callRef.current = '';
    peerObservedEnabled.current = false;
    candidateBuffer.current.clear();
  }, []);

  const sendSignal = useCallback((kind: Signal['kind'], callId: string, payload: unknown, to = remoteIdRef.current, run = generation.current) => {
    const roomId = latest.current.room?.id;
    const session = latest.current.session;
    if (!roomId || !to || !session) return Promise.resolve();
    const queued = signalTail.current.catch(() => {}).then(async () => {
      if (generation.current !== run) return;
      const result = await fetch(appPath(`/api/rooms/${encodeURIComponent(roomId)}/signals`), {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}` },
        body: JSON.stringify({ kind, callId, to, payload }), signal: AbortSignal.timeout(8000),
      });
      if (!result.ok) throw new Error('语音连接信令没有送达，请重试。');
    });
    signalTail.current = queued;
    return queued;
  }, []);

  const stopInternal = useCallback(async (announce = true) => {
    generation.current += 1;
    starting.current = false;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    // Stop capture immediately, before awaiting network or SDK calls.
    streamRef.current?.getTracks().forEach(track => track.stop());
    streamRef.current = null;
    const call = callRef.current;
    if (announce && call && remoteIdRef.current) void sendSignal('hangup', call, {}).catch(() => {});
    closePeer();
    const livekit = livekitRef.current;
    livekitRef.current = null;
    if (livekit) void livekit.disconnect().catch(() => {});
    if (mounted.current) {
      setActive(false); setMuted(false); setStatus('idle'); setNeedsPlayback(false);
    }
    if (announce && latest.current.session && latest.current.room?.status !== 'ended') {
      try { await changeVoiceState(false); } catch { /* Local capture is already stopped. */ }
    }
  }, [closePeer, sendSignal, changeVoiceState]);

  const makePeer = useCallback((callId: string, config: VoiceConfig, run: number) => {
    if (generation.current !== run) throw new DOMException('语音连接已取消。', 'AbortError');
    closePeer();
    const pc = new RTCPeerConnection({ iceServers: config.iceServers, iceTransportPolicy: config.iceTransportPolicy ?? 'all' });
    peerRef.current = pc;
    callRef.current = callId;
    const stream = streamRef.current;
    if (!stream) throw new Error('请先开启麦克风。');
    stream.getTracks().forEach(track => pc.addTrack(track, stream));
    const outgoing: RTCIceCandidateInit[] = [];
    let descriptionSent = false;
    let readingPath = false;
    const currentPeer = () => generation.current === run && peerRef.current === pc && mounted.current;
    const readPath = async () => {
      if (!currentPeer() || pc.connectionState !== 'connected' || readingPath) return;
      readingPath = true;
      try {
        const stats = await pc.getStats();
        if (currentPeer() && pc.connectionState === 'connected') setConnectionPath(connectionPathFromStats(stats));
      } catch { if (currentPeer()) setConnectionPath(null); }
      finally {
        readingPath = false;
        if (currentPeer() && pc.connectionState === 'connected') {
          if (statsTimerRef.current) clearTimeout(statsTimerRef.current);
          statsTimerRef.current = setTimeout(() => void readPath(), 5000);
        }
      }
    };
    const watchConnection = () => {
      if (connectionTimerRef.current) clearTimeout(connectionTimerRef.current);
      connectionTimerRef.current = setTimeout(() => {
        if (currentPeer() && pc.connectionState !== 'connected') {
          setConnectionPath(null); setStatus('error');
          setError('语音连接超时。可以重新连接，或关闭语音后使用连接检测。');
        }
      }, 30_000);
    };
    pc.onicecandidate = event => {
      if (!event.candidate || generation.current !== run) return;
      const candidate = event.candidate.toJSON();
      if (descriptionSent) void sendSignal('ice', callId, candidate, remoteIdRef.current, run).catch(() => {});
      else outgoing.push(candidate);
    };
    pc.ontrack = event => {
      if (generation.current !== run) return;
      const audio = audioRef.current;
      if (audio) {
        audio.srcObject = event.streams[0] || new MediaStream([event.track]);
        void enablePlayback();
      }
    };
    pc.onconnectionstatechange = () => {
      if (generation.current !== run || peerRef.current !== pc || !mounted.current) return;
      if (pc.connectionState === 'connected') {
        if (connectionTimerRef.current) clearTimeout(connectionTimerRef.current);
        connectionTimerRef.current = null;
        setStatus('connected'); setError(null);
        void readPath();
      } else if (pc.connectionState === 'connecting' || pc.connectionState === 'disconnected') {
        setStatus('connecting'); setConnectionPath(null); watchConnection();
      } else if (pc.connectionState === 'failed') {
        if (connectionTimerRef.current) clearTimeout(connectionTimerRef.current);
        connectionTimerRef.current = null;
        setConnectionPath(null); setStatus('error'); setError('语音连接没有建立成功。可以重新连接，或关闭语音后使用连接检测。');
      }
    };
    setStatus('connecting');
    watchConnection();
    return {
      pc,
      async sentDescription() {
        descriptionSent = true;
        for (const candidate of outgoing.splice(0)) await sendSignal('ice', callId, candidate, remoteIdRef.current, run);
      },
    };
  }, [closePeer, enablePlayback, sendSignal]);

  const startP2P = useCallback((config: VoiceConfig, run: number, initialCursor: number) => {
    lastSignalRef.current = initialCursor;
    peerObservedEnabled.current = false;
    let failures = 0;
    const consume = async (signal: Signal) => {
      if (generation.current !== run || !streamRef.current) return;
      const peerMember = latest.current.room?.members.find(member => member.id === signal.from);
      if (!peerMember || peerMember.id === latest.current.session?.memberId) return;
      if (signal.kind === 'hangup') {
        if (signal.callId === 'reset' || signal.callId === callRef.current) { closePeer(); skipOffersUntil.current = Date.now() + 1200; setStatus('waiting'); }
        return;
      }
      if (signal.kind === 'offer') {
        remoteIdRef.current = signal.from;
        const buffered = candidateBuffer.current.get(signal.callId) || [];
        const { pc, sentDescription } = makePeer(signal.callId, config, run);
        await pc.setRemoteDescription(signal.payload as RTCSessionDescriptionInit);
        if (generation.current !== run) return;
        for (const candidate of buffered) await pc.addIceCandidate(candidate);
        const answer = await pc.createAnswer();
        if (generation.current !== run) return;
        await pc.setLocalDescription(answer);
        if (generation.current !== run) return;
        await sendSignal('answer', signal.callId, { type: answer.type, sdp: answer.sdp }, signal.from, run);
        await sentDescription();
      } else if (signal.kind === 'answer') {
        const pc = peerRef.current;
        if (!pc || callRef.current !== signal.callId || pc.signalingState !== 'have-local-offer') return;
        await pc.setRemoteDescription(signal.payload as RTCSessionDescriptionInit);
        for (const candidate of candidateBuffer.current.get(signal.callId) || []) await pc.addIceCandidate(candidate);
        candidateBuffer.current.delete(signal.callId);
      } else if (signal.kind === 'ice') {
        const pc = peerRef.current;
        const candidate = signal.payload as RTCIceCandidateInit;
        if (pc && callRef.current === signal.callId && pc.remoteDescription) await pc.addIceCandidate(candidate);
        else {
          const buffered = candidateBuffer.current.get(signal.callId) || [];
          if (buffered.length < 100) buffered.push(candidate);
          if (candidateBuffer.current.size < 10 || candidateBuffer.current.has(signal.callId)) candidateBuffer.current.set(signal.callId, buffered);
        }
      }
    };
    const poll = async () => {
      if (generation.current !== run || !streamRef.current) return;
      const { room, session } = latest.current;
      if (!room || !session || room.status === 'ended') return;
      try {
        const data = await request<{ signals: Signal[]; lastId: number }>(`/api/rooms/${encodeURIComponent(room.id)}/signals?after=${lastSignalRef.current}`);
        if (generation.current !== run) return;
        for (const signal of data.signals) {
          lastSignalRef.current = Math.max(lastSignalRef.current, signal.id);
          try { await consume(signal); } catch (err) {
            if (peerRef.current?.connectionState !== 'connected' && signal.kind !== 'ice') throw err;
          }
          if (generation.current !== run) return;
        }
        lastSignalRef.current = Math.max(lastSignalRef.current, data.lastId || 0);
        failures = 0;
        const other = latest.current.room?.members.find(member => member.id !== session.memberId);
        if (other?.voiceEnabled && other.connected) peerObservedEnabled.current = true;
        if (other && peerObservedEnabled.current && (!other.voiceEnabled || !other.connected) && peerRef.current) {
          closePeer(); peerObservedEnabled.current = false; setStatus('waiting');
        }
        // A deterministic caller avoids offer collisions when both people join together.
        if (other?.voiceEnabled && other.connected && session.memberId < other.id && !peerRef.current && Date.now() >= skipOffersUntil.current) {
          remoteIdRef.current = other.id;
          const callId = crypto.randomUUID();
          const { pc, sentDescription } = makePeer(callId, config, run);
          const offer = await pc.createOffer();
          if (generation.current !== run) return;
          await pc.setLocalDescription(offer);
          if (generation.current !== run) return;
          await sendSignal('offer', callId, { type: offer.type, sdp: offer.sdp }, other.id, run);
          await sentDescription();
        }
      } catch (err) {
        failures += 1;
        if (failures >= 3 && generation.current === run && mounted.current) {
          setError(friendlyError(err));
          if (peerRef.current?.connectionState !== 'connected') setStatus('error');
        }
      } finally {
        if (generation.current === run && streamRef.current) timerRef.current = setTimeout(poll, failures ? 1800 : 850);
      }
    };
    void poll();
  }, [request, closePeer, makePeer, sendSignal]);

  const startLiveKit = useCallback(async (run: number) => {
    const { room } = latest.current;
    if (!room) return;
    const { Room, RoomEvent, Track } = await import('livekit-client');
    const credentials = await request<{ url: string; token: string }>(`/api/rooms/${encodeURIComponent(room.id)}/voice-token`, {});
    if (generation.current !== run) return;
    const mediaRoom = new Room();
    livekitRef.current = mediaRoom;
    mediaRoom.on(RoomEvent.TrackSubscribed, track => {
      if (track.kind !== Track.Kind.Audio || generation.current !== run) return;
      if (audioRef.current) { track.attach(audioRef.current); void enablePlayback(); }
      setStatus('connected'); setConnectionPath('livekit'); setError(null);
    });
    mediaRoom.on(RoomEvent.TrackUnsubscribed, track => {
      track.detach();
      if (generation.current === run) { setStatus('waiting'); setConnectionPath(null); }
    });
    mediaRoom.on(RoomEvent.Reconnecting, () => { if (generation.current === run) { setStatus('connecting'); setConnectionPath(null); } });
    mediaRoom.on(RoomEvent.Reconnected, () => { if (generation.current === run) { setStatus(mediaRoom.remoteParticipants.size ? 'connected' : 'waiting'); setConnectionPath(mediaRoom.remoteParticipants.size ? 'livekit' : null); } });
    mediaRoom.on(RoomEvent.Disconnected, () => {
      if (generation.current === run && mounted.current) { setConnectionPath(null); setStatus('error'); setError('语音连接已断开，请重新连接。'); }
    });
    setStatus('connecting');
    await mediaRoom.connect(credentials.url, credentials.token);
    if (generation.current !== run) { await mediaRoom.disconnect(); return; }
    const track = streamRef.current?.getAudioTracks()[0];
    if (!track) throw new Error('麦克风已经关闭。');
    await mediaRoom.localParticipant.publishTrack(track, { name: 'microphone', source: Track.Source.Microphone });
    if (generation.current !== run) { await mediaRoom.disconnect(); return; }
    setStatus(current => current === 'connected' ? current : mediaRoom.remoteParticipants.size ? 'connecting' : 'waiting');
  }, [request, enablePlayback]);

  const start = useCallback(async () => {
    if (starting.current || !latest.current.room || !latest.current.session || latest.current.room.status === 'ended') return;
    if (streamRef.current) {
      const stopped = stopInternal();
      const stoppingGeneration = generation.current;
      starting.current = true;
      setStatus('requesting');
      await stopped;
      if (generation.current !== stoppingGeneration || !mounted.current) return;
    }
    starting.current = true;
    const run = ++generation.current;
    setError(null); setStatus('requesting');
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('当前浏览器无法开启麦克风，请使用 HTTPS 页面并在 Safari 或 Chrome 中打开。');
      const configPromise = request<VoiceConfig>(`/api/rooms/${encodeURIComponent(latest.current.room.id)}/voice-config`);
      void configPromise.catch(() => {});
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      if (generation.current !== run) { stream.getTracks().forEach(track => track.stop()); return; }
      streamRef.current = stream;
      const config = await configPromise;
      if (generation.current !== run) return;
      setProvider(config.provider); setRelayConfigured(config.relayConfigured); setIceTransportPolicy(config.iceTransportPolicy ?? 'all'); setMuted(false); setActive(true);
      const cursor = config.provider === 'p2p'
        ? await request<{ lastId: number }>(`/api/rooms/${encodeURIComponent(latest.current.room!.id)}/signals?latest=1`)
        : { lastId: 0 };
      if (generation.current !== run) return;
      await changeVoiceState(true, run);
      if (generation.current !== run) return;
      setStatus('waiting');
      if (config.provider === 'livekit') await startLiveKit(run);
      else {
        const other = latest.current.room?.members.find(member => member.id !== latest.current.session?.memberId);
        if (other?.voiceEnabled) {
          remoteIdRef.current = other.id;
          await sendSignal('hangup', 'reset', {}, other.id, run);
        }
        if (generation.current !== run) return;
        startP2P(config, run, cursor.lastId);
      }
    } catch (err) {
      if (generation.current !== run) return;
      const stopped = stopInternal();
      const stoppingGeneration = generation.current;
      await stopped;
      if (generation.current !== stoppingGeneration || !mounted.current) return;
      setError(friendlyError(err)); setStatus('error');
    } finally { if (generation.current === run) starting.current = false; }
  }, [request, startLiveKit, startP2P, stopInternal, sendSignal, changeVoiceState]);

  const toggleMute = useCallback(() => {
    const tracks = streamRef.current?.getAudioTracks() || [];
    if (!tracks.length) return;
    const nextMuted = tracks[0].enabled;
    tracks.forEach(track => { track.enabled = !nextMuted; });
    setMuted(nextMuted);
  }, []);
  const stop = useCallback(() => stopInternal(), [stopInternal]);
  const stopRef = useRef(stopInternal);
  stopRef.current = stopInternal;
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; void stopRef.current(false); };
  }, []);
  useEffect(() => {
    if (props.room?.status === 'ended') void stopRef.current(false);
  }, [props.room?.status]);
  const identityRef = useRef('');
  useEffect(() => {
    const identity = props.room && props.session ? `${props.room.id}:${props.session.memberId}` : '';
    if (identityRef.current && identityRef.current !== identity) void stopRef.current(false);
    identityRef.current = identity;
    if (!props.room || !props.session) return;
    const expiryTimer = setTimeout(() => { void stopRef.current(false); }, Math.max(0, props.room.expiresAt - Date.now()));
    return () => clearTimeout(expiryTimer);
  }, [props.room?.id, props.session?.memberId, props.room?.expiresAt]);
  useEffect(() => {
    const onPageHide = () => {
      streamRef.current?.getTracks().forEach(track => track.stop());
      const { room, session } = latest.current;
      if (room && session && streamRef.current) {
        void fetch(appPath(`/api/rooms/${encodeURIComponent(room.id)}/actions`), { method: 'POST', keepalive: true,
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}` },
          body: JSON.stringify({ actionId: crypto.randomUUID(), type: 'voice', payload: { enabled: false } }),
        }).catch(() => {});
      }
    };
    window.addEventListener('pagehide', onPageHide);
    const onPageShow = (event: PageTransitionEvent) => { if (event.persisted) void stopRef.current(); };
    window.addEventListener('pageshow', onPageShow);
    return () => { window.removeEventListener('pagehide', onPageHide); window.removeEventListener('pageshow', onPageShow); };
  }, []);
  return { status, error, muted, active, provider, start, retry: start, stop, toggleMute, enablePlayback, needsPlayback, audioRef, relayConfigured, iceTransportPolicy, connectionPath };
}
