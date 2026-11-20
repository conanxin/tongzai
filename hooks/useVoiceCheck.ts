'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { VoiceConfig } from '@/lib/model';
import { appPath } from '@/lib/paths';
import { browserVoiceSupport, configuredIceServices, probeIceServers, type VoiceNetworkReport } from '@/lib/voice-diagnostics';

type Props = { roomId: string; token: string | null; enabled: boolean };
type State = 'idle' | 'checking' | 'complete' | 'error';

export function useVoiceCheck({ roomId, token, enabled }: Props) {
  const [state, setState] = useState<State>('idle');
  const [report, setReport] = useState<VoiceNetworkReport | null>(null);
  const controller = useRef<AbortController | null>(null);
  const cancel = useCallback(() => {
    controller.current?.abort();
    controller.current = null;
    setState('idle');
    setReport(null);
  }, []);
  useEffect(() => {
    cancel();
    return () => { controller.current?.abort(); controller.current = null; };
  }, [roomId, token, enabled, cancel]);

  const run = useCallback(async () => {
    if (!enabled || !token || controller.current) return;
    const active = new AbortController();
    controller.current = active;
    const started = Date.now();
    const result: VoiceNetworkReport = {
      checkedAt: new Date(started).toISOString(), elapsedMs: 0,
      browser: browserVoiceSupport(), provider: null, configFetched: false,
      stunConfigured: false, turnConfigured: false,
      candidates: { host: 0, srflx: 0, relay: 0 }, iceErrors: [], completed: false, error: null,
    };
    setState('checking'); setReport(null);
    let requestTimer: ReturnType<typeof setTimeout> | null = null;
    let requestTimedOut = false;
    try {
      if (!result.browser.secureContext) throw new Error('请通过 HTTPS 打开房间，再检测语音连接。');
      if (!result.browser.webrtc || !result.browser.microphoneApi) throw new Error('当前浏览器缺少语音能力，请在 Safari 或 Chrome 中打开房间。');
      requestTimer = setTimeout(() => { requestTimedOut = true; active.abort(); }, 8000);
      const response = await fetch(appPath(`/api/rooms/${encodeURIComponent(roomId)}/voice-config`), {
        headers: { Authorization: `Bearer ${token}` }, cache: 'no-store', signal: active.signal,
      });
      if (!response.ok) throw new Error(response.status === 401 || response.status === 403
        ? '房间身份已失效，请重新加入房间后检测。'
        : '暂时无法读取房间的语音配置，请稍后重试。');
      const config = await response.json() as VoiceConfig;
      if (active.signal.aborted) throw new DOMException('检测已取消。', 'AbortError');
      clearTimeout(requestTimer); requestTimer = null;
      result.configFetched = true;
      result.provider = config.provider;
      Object.assign(result, configuredIceServices(config));
      if (config.provider === 'p2p') Object.assign(result, await probeIceServers(config, { signal: active.signal }));
      // LiveKit uses a separate media connection; this check does not request a token or claim it is reachable.
    } catch (error) {
      if (active.signal.aborted && !requestTimedOut) return;
      result.error = requestTimedOut ? '读取语音配置超时，请检查网络后重试。'
        : error instanceof Error && /^请通过 HTTPS|^当前浏览器|^房间身份|^暂时无法读取/.test(error.message)
          ? error.message : '这次检测没有完成，请稍后重试或换一个网络。';
    } finally {
      if (requestTimer) clearTimeout(requestTimer);
      if (controller.current === active) {
        controller.current = null;
        result.elapsedMs = Date.now() - started;
        setReport(result);
        setState(result.error ? 'error' : 'complete');
      }
    }
  }, [enabled, token, roomId]);
  return { state, report, run, cancel };
}
