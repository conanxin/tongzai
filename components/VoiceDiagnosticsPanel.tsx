'use client';

import { useEffect, useState } from 'react';
import { Check, ChevronDown, Copy, LoaderCircle, RefreshCw, Wifi, X } from 'lucide-react';
import { useVoiceCheck } from '@/hooks/useVoiceCheck';
import type { VoiceNetworkReport } from '@/lib/voice-diagnostics';

type Props = {
  roomId: string;
  token: string | null;
  enabled: boolean;
  voiceActive: boolean;
};
type CheckRow = { label: string; value: string; tone: 'good' | 'neutral' | 'attention' };

function reportRows(report: VoiceNetworkReport): CheckRow[] {
  const browserReady = report.browser.secureContext && report.browser.webrtc && report.browser.microphoneApi;
  const browserValue = !report.browser.secureContext ? '需要通过 HTTPS 打开'
    : !report.browser.webrtc ? '浏览器不支持语音连接'
      : !report.browser.microphoneApi ? '浏览器未提供麦克风接口' : '支持语音功能';
  const rows: CheckRow[] = [
    { label: '浏览器环境', value: browserValue, tone: browserReady ? 'good' : 'attention' },
    { label: '服务配置', value: report.configFetched ? '已获取' : report.error && browserReady ? '未能获取' : '尚未检测', tone: report.configFetched ? 'good' : 'neutral' },
  ];
  if (report.provider === 'livekit') {
    rows.push({ label: '语音服务', value: 'LiveKit · 媒体通道未检测', tone: 'neutral' });
    return rows;
  }
  rows.push(
    { label: '直连辅助', value: !report.configFetched ? '尚未检测' : !report.stunConfigured ? '未配置' : report.candidates.srflx > 0 ? '已发现公网地址' : '未确认可用', tone: !report.configFetched || !report.stunConfigured ? 'neutral' : report.candidates.srflx > 0 ? 'good' : 'attention' },
    { label: '中继分配', value: !report.configFetched ? '尚未检测' : !report.turnConfigured ? '未配置' : report.candidates.relay > 0 ? '中继分配成功' : '未确认可用', tone: !report.configFetched || !report.turnConfigured ? 'neutral' : report.candidates.relay > 0 ? 'good' : 'attention' },
  );
  return rows;
}

function diagnosticSummary(report: VoiceNetworkReport): string {
  // Copy only this explicit summary; never serialize the session or ICE configuration.
  return [
    '同在 · 连接检测',
    `检测时间：${report.checkedAt}`,
    `检测用时：${(report.elapsedMs / 1000).toFixed(1)} 秒`,
    `语音服务：${report.provider === 'livekit' ? 'LiveKit' : report.provider === 'p2p' ? 'WebRTC' : '未获取'}`,
    ...reportRows(report).map(row => `${row.label}：${row.value}`),
    `地址候选数量：本地 ${report.candidates.host} / 公网 ${report.candidates.srflx} / 中继 ${report.candidates.relay}`,
    `地址收集：${report.provider === 'livekit' ? '未执行' : report.completed ? '已结束' : '未完成'}`,
    `ICE 错误码：${report.iceErrors.length ? report.iceErrors.join('、') : '无'}`,
    ...(report.error ? [`提示：${report.error}`] : []),
    '本次检测未开启麦克风。地址分配结果不代表双向声音已通过验证。',
  ].join('\n');
}

export function VoiceDiagnosticsPanel({ roomId, token, enabled, voiceActive }: Props) {
  const { state, report, run, cancel } = useVoiceCheck({ roomId, token, enabled });
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [notice, setNotice] = useState('');
  const checking = state === 'checking';
  const rows = report ? reportRows(report) : [];
  const summary = report ? diagnosticSummary(report) : '';

  useEffect(() => {
    if (voiceActive && checking) cancel();
  }, [voiceActive, checking, cancel]);
  useEffect(() => {
    setCopied(false); setCopyFailed(false);
  }, [report]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2400);
    return () => clearTimeout(timer);
  }, [copied]);

  async function copySummary() {
    try {
      await navigator.clipboard.writeText(summary);
      setCopied(true); setCopyFailed(false);
    } catch { setCopyFailed(true); }
  }

  return <details className="voice-diagnostics">
    <summary><span><Wifi size={16} />连接检测</span><span className="voice-diagnostics-summary-note">不开启麦克风<ChevronDown size={16} /></span></summary>
    <div className="voice-diagnostics-body">
      <p className="voice-check-intro">先看看当前网络是否能获取语音连接地址。不需要对方在线，也不会开启麦克风。</p>
      <div className="voice-check-actions">
        <button className="button small secondary" disabled={!enabled || !token || voiceActive || checking} onClick={() => { setNotice(''); void run(); }}>
          {checking ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}
          {checking ? '正在检测' : report ? '重新检测' : '检测当前网络'}
        </button>
        {checking && <button className="button small ghost" onClick={() => { cancel(); setNotice('检测已取消。'); }}><X size={15} />取消检测</button>}
        {report && !checking && <button className="button small ghost" onClick={() => void copySummary()}>{copied ? <Check size={15} /> : <Copy size={15} />}{copied ? '已复制' : '复制检测结果'}</button>}
      </div>
      {voiceActive && <p className="voice-check-note">请先关闭语音，再检测当前网络。</p>}
      {!enabled && !voiceActive && <p className="voice-check-note">房间恢复同步后，就可以开始检测。</p>}
      <div aria-live="polite" aria-atomic="true">
        {checking && <p className="voice-check-note">正在检查浏览器、服务配置和连接地址……</p>}
        {notice && !checking && <p className="voice-check-note">{notice}</p>}
        {report && !checking && <div className="voice-check-result">
          <dl className="voice-check-rows">{rows.map(row => <div key={row.label}><dt>{row.label}</dt><dd className={`voice-check-status-${row.tone}`}>{row.value}</dd></div>)}</dl>
          {report.error && <p className="voice-check-warning">{report.error}</p>}
          {report.provider === 'livekit'
            ? <p className="voice-check-note">本次只检查浏览器与服务配置，没有验证 LiveKit 的媒体通道。双向声音需要双方开启语音后确认。</p>
            : report.candidates.relay > 0
              ? <p className="voice-check-note">当前网络已获得中继连接地址。是否能互相听见，仍需双方开启语音后确认。</p>
              : report.configFetched && report.turnConfigured
                ? <p className="voice-check-note">这次没有获得中继地址，可能与网络、服务配置或检测超时有关。可以换个网络再试，并复制检测结果用于排查。</p>
                : <p className="voice-check-note">检测结果只反映当前网络的地址获取情况。双向声音仍需双方开启语音后确认。</p>}
          <p className="voice-check-meta">本次检测用时 {(report.elapsedMs / 1000).toFixed(1)} 秒 · 摘要不包含地址、身份凭证或房间记录</p>
        </div>}
        {copyFailed && !checking && <div className="voice-check-copy-fallback"><p className="voice-check-note">复制未完成，可以选择下方文字手动复制。</p><textarea aria-label="连接检测摘要" readOnly value={summary} onFocus={event => event.currentTarget.select()} /></div>}
      </div>
    </div>
  </details>;
}
