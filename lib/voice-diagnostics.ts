import type { VoiceConfig } from './model';

export type VoiceConnectionPath = 'direct' | 'relay' | 'livekit' | null;
export type BrowserVoiceSupport = { secureContext: boolean; webrtc: boolean; microphoneApi: boolean };
export type IceProbeResult = {
  candidates: { host: number; srflx: number; relay: number };
  iceErrors: number[];
  completed: boolean;
};
export type VoiceNetworkReport = IceProbeResult & {
  checkedAt: string;
  elapsedMs: number;
  browser: BrowserVoiceSupport;
  provider: 'p2p' | 'livekit' | null;
  configFetched: boolean;
  stunConfigured: boolean;
  turnConfigured: boolean;
  error: string | null;
};

export function browserVoiceSupport(): BrowserVoiceSupport {
  return {
    secureContext: typeof window !== 'undefined' && window.isSecureContext,
    webrtc: typeof RTCPeerConnection !== 'undefined',
    microphoneApi: typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getUserMedia === 'function',
  };
}

export function configuredIceServices(config: VoiceConfig) {
  const urls = config.iceServers.flatMap(server => typeof server.urls === 'string' ? [server.urls] : server.urls);
  return {
    stunConfigured: urls.some(url => /^stuns?:/i.test(url)),
    turnConfigured: urls.some(url => /^turns?:/i.test(url)),
  };
}

/** Only the transport-selected pair describes the path in use. A gathered
 * relay candidate or a different successful pair is not evidence of that path. */
export function connectionPathFromStats(stats: Pick<RTCStatsReport, 'forEach' | 'get'>): 'direct' | 'relay' | null {
  const selected: string[] = [];
  stats.forEach(item => {
    if (item.type === 'transport' && typeof item.selectedCandidatePairId === 'string') selected.push(item.selectedCandidatePairId);
  });
  let direct = false;
  for (const id of selected) {
    const pair = stats.get(id);
    if (!pair || pair.type !== 'candidate-pair' || pair.state !== 'succeeded') continue;
    const local = stats.get(pair.localCandidateId)?.candidateType;
    const remote = stats.get(pair.remoteCandidateId)?.candidateType;
    if (local === 'relay' || remote === 'relay') return 'relay';
    const nonRelay = ['host', 'srflx', 'prflx'];
    if (nonRelay.includes(local) && nonRelay.includes(remote)) direct = true;
  }
  return direct ? 'direct' : null;
}

/** Gather addresses using a data channel. Never requests microphone access,
 * never connects to another participant, and returns only counts/error codes. */
export function probeIceServers(config: VoiceConfig, options: {
  signal?: AbortSignal;
  timeoutMs?: number;
  createPeer?: (configuration: RTCConfiguration) => RTCPeerConnection;
} = {}): Promise<IceProbeResult> {
  const { signal, timeoutMs = 8000, createPeer = configuration => new RTCPeerConnection(configuration) } = options;
  if (signal?.aborted) return Promise.reject(new DOMException('检测已取消。', 'AbortError'));
  return new Promise((resolve, reject) => {
    let peer: RTCPeerConnection | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let finished = false;
    const candidates = { host: 0, srflx: 0, relay: 0 };
    const errors = new Set<number>();
    const finish = (completed: boolean, error?: unknown) => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (peer) {
        peer.onicecandidate = null;
        peer.onicegatheringstatechange = null;
        peer.onicecandidateerror = null;
        try { peer.close(); } catch { /* Already closed. */ }
      }
      if (error) reject(error);
      else resolve({ candidates: { ...candidates }, iceErrors: [...errors].sort((a, b) => a - b), completed });
    };
    const abort = () => finish(false, new DOMException('检测已取消。', 'AbortError'));
    try {
      peer = createPeer({ iceServers: config.iceServers, iceTransportPolicy: 'all', iceCandidatePoolSize: 0 });
      peer.onicecandidate = event => {
        if (finished) return;
        if (!event.candidate) { finish(true); return; }
        const kind = event.candidate.type || /\btyp\s+(host|srflx|relay)\b/.exec(event.candidate.candidate)?.[1];
        if (kind === 'host' || kind === 'srflx' || kind === 'relay') candidates[kind] += 1;
      };
      peer.onicecandidateerror = event => {
        if (!finished && Number.isInteger(event.errorCode)) errors.add(event.errorCode);
      };
      peer.onicegatheringstatechange = () => { if (peer?.iceGatheringState === 'complete') finish(true); };
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      timer = setTimeout(() => finish(false), Math.max(1, timeoutMs));
      peer.createDataChannel('tongzai-network-check');
      const gather = async () => {
        const offer = await peer!.createOffer();
        if (finished) return;
        await peer!.setLocalDescription(offer);
        if (!finished && peer!.iceGatheringState === 'complete') finish(true);
      };
      void gather().catch(error => finish(false, error));
    } catch (error) { finish(false, error); }
  });
}
