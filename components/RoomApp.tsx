'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, CheckCheck, CircleCheck, Clock3, Copy, Headphones, Link2, LoaderCircle, LogOut, Mic, MicOff, Pause, Play, Plus, RefreshCw, RotateCcw, Save, Send, Share2, ShieldCheck, SkipForward, SlidersHorizontal, Sparkles, Volume2, Wifi, WifiOff, X } from 'lucide-react';
import type { Member, RoomResponse } from '@/lib/model';
import { getTemplate, stepDurationMs } from '@/lib/templates';
import { useRoom } from '@/hooks/useRoom';
import { useVoice } from '@/hooks/useVoice';
import { appPath } from '@/lib/paths';
import { Brand, TemplateIcon, accentStyle } from './Brand';
import { VoiceDiagnosticsPanel } from './VoiceDiagnosticsPanel';

function formatTime(ms: number) {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
}
async function copyText(value: string) {
  try { await navigator.clipboard.writeText(value); }
  catch {
    const text = document.createElement('textarea'); text.value = value; text.style.position = 'fixed'; text.style.opacity = '0'; document.body.appendChild(text); text.select(); const copied = document.execCommand('copy'); text.remove(); if (!copied) throw new Error('请手动复制地址栏中的链接。');
  }
}

export default function RoomApp({ roomId }: { roomId: string }) {
  const { room, info, session, initialized, error, terminalError, syncState, busy, offsetMs, join, action, forget, clearError } = useRoom(roomId);
  const onVoiceChange = useCallback(async (enabled: boolean) => {
    const result = await action('voice', { enabled });
    if (!result) throw new Error('语音状态没有同步，请重试。');
  }, [action]);
  const voice = useVoice({ room, session, onVoiceChange });
  const [nickname, setNickname] = useState('');
  const [nicknameError, setNicknameError] = useState('');
  const [now, setNow] = useState(Date.now());
  const [toast, setToast] = useState('');
  const [note, setNote] = useState('');
  const [noteDirty, setNoteDirty] = useState(false);
  const [noteSaved, setNoteSaved] = useState(false);
  const [showExit, setShowExit] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [savingNote, setSavingNote] = useState(false);
  const editingNote = useRef(false);
  const nicknameInput = useRef<HTMLInputElement>(null);
  const modalRef = useRef<HTMLElement | null>(null);
  useEffect(() => { setNickname(localStorage.getItem('tongzai.nickname') ?? ''); }, []);
  useEffect(() => {
    if (!showExit) return;
    const previous = document.activeElement as HTMLElement | null;
    modalRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setShowExit(false); }
      if (event.key === 'Tab') {
        const buttons = [...(modalRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
        const first = buttons[0]; const last = buttons[buttons.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', keyboard);
    return () => { document.removeEventListener('keydown', keyboard); previous?.focus(); };
  }, [showExit]);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 250); return () => clearInterval(timer); }, []);
  useEffect(() => { if (!noteDirty && !editingNote.current) setNote(room?.sharedNote ?? ''); }, [room?.sharedNote, noteDirty]);
  useEffect(() => { if (toast) { const timer = setTimeout(() => setToast(''), 2600); return () => clearTimeout(timer); } }, [toast]);

  const template = getTemplate(room?.templateId ?? info?.templateId ?? 'conversation');
  const current = template.steps[room?.stepIndex ?? 0] ?? template.steps[0];
  const me = room?.members.find(member => member.id === session?.memberId);
  const other = room?.members.find(member => member.id !== session?.memberId);
  const isController = room?.controllerId === session?.memberId;
  const controller = room?.members.find(member => member.id === room.controllerId);
  const allReady = !!room && room.members.length === (room.mode === 'solo' ? 1 : 2) && room.members.every(member => member.ready && member.connected);
  const stageDuration = room ? stepDurationMs(room, room.stepIndex) : 0;
  const rawRemaining = room?.status === 'paused' ? room.pausedRemainingMs ?? stageDuration : room?.status === 'running' ? (room.stepEndsAt ?? now) - (now + offsetMs) : stageDuration;
  const remaining = Math.max(0, Math.min(stageDuration, rawRemaining));
  const elapsedFraction = room ? Math.max(0, Math.min(1, 1 - remaining / Math.max(1, stageDuration))) : 0;
  const statusText = room?.status === 'running' ? '正在进行' : room?.status === 'paused' ? '暂停一下' : '准备开始';
  const voiceText = { idle: '语音未开启', requesting: '正在打开麦克风', waiting: '等待对方加入语音', connecting: '正在连接语音', connected: '语音已连接', error: '语音连接未完成' }[voice.status];

  async function invite() {
    try { await copyText(`${window.location.origin}${appPath(`/r/${encodeURIComponent(roomId)}`)}`); setToast('邀请链接已复制'); }
    catch (err) { setToast((err as Error).message); }
  }
  async function saveNote() {
    if (savingNote) return;
    setSavingNote(true); setNoteSaved(false);
    const result = await action('note', { note });
    if (result) { setNoteDirty(false); setNoteSaved(true); setNote(result.room.sharedNote); }
    setSavingNote(false);
  }
  async function exit(end: boolean) {
    void voice.stop().catch(() => undefined);
    if (!end) {
      void action('leave');
      forget();
      window.location.assign(appPath('/'));
      return;
    }
    const result = await action('end');
    setShowExit(false);
    if (!result) setToast('结束房间尚未成功，麦克风已关闭。可以重试或暂时离开。');
  }
  function onJoin(event: React.FormEvent) {
    event.preventDefault();
    if (!nickname.trim()) { setNicknameError('请填写一个昵称，让对方认出你。'); nicknameInput.current?.focus(); return; }
    setNicknameError(''); localStorage.setItem('tongzai.nickname', nickname.trim()); void join(nickname);
  }
  async function copyNote() {
    if (!room) return;
    try { await copyText(`同在 · ${template.name}\n${new Date(room.createdAt).toLocaleDateString('zh-CN')}\n\n${room.sharedNote || '这次相处没有留下文字记录。'}`); setToast('这次记录已复制'); }
    catch { setToast('复制未完成，请长按选择记录文字。'); }
  }

  const errorBlock = error ? <div className="error-notice room-error" role="alert"><span>{error}</span><button aria-label="关闭提示" onClick={clearError}><X size={17} /></button></div> : null;
  const header = <header className="site-header room-header"><Brand compact /><div className="room-header-center"><TemplateIcon icon={template.icon} size={17} /><span>{template.name}</span>{room && <span className="header-duration">{room.durationMinutes} 分钟</span>}</div>{room && room.status !== 'ended' ? <button className="text-button exit-link" onClick={() => setShowExit(true)}><LogOut size={17} /><span>离开</span></button> : <a className="text-button" href={appPath('/')}>返回首页</a>}</header>;
  const audio = <audio ref={voice.audioRef} autoPlay playsInline />;

  if (terminalError) return <div className="room-page" style={accentStyle(template.color)}>{header}<main className="join-room-main"><section className="join-room-card"><div className="big-template-icon"><Clock3 size={30} /></div><h1>这段时光已告一段落</h1><p className="join-room-detail">{terminalError}</p><a className="button primary full-button" href={appPath('/')}>创建新的房间</a></section></main>{audio}</div>;

  if (!initialized || (session && !room && !error)) return <div className="room-page" style={accentStyle(template.color)}>{header}<main className="loading-room"><LoaderCircle className="spin" size={30} /><h1>正在打开这段时光</h1><p>连接房间，马上就好。</p></main>{audio}</div>;

  if (!room || !session) return <div className="room-page" style={accentStyle(template.color)}>{header}<main className="join-room-main"><section className="join-room-card"><div className="big-template-icon"><TemplateIcon icon={template.icon} size={30} /></div><p className="eyebrow">有人为你留了一个位置</p><h1>{info?.status === 'ended' ? '这次相处已经结束' : '一起，把时间慢下来。'}</h1><p className="join-room-description">{info ? `${template.name} · ${info.durationMinutes} 分钟` : '正在查看邀请房间'}</p>{info && <p className="join-room-detail">{template.description}</p>}{errorBlock}{info && info.status !== 'ended' && info.mode !== 'solo' && <form onSubmit={onJoin}><label className="field-label" htmlFor="join-nickname">让对方知道你来了</label><input ref={nicknameInput} id="join-nickname" value={nickname} onChange={e => setNickname(e.target.value)} maxLength={20} autoComplete="nickname" placeholder="你的临时昵称" autoFocus />{nicknameError && <p className="field-error" role="alert">{nicknameError}</p>}<button className="button primary full-button" disabled={busy === 'join' || info.memberCount >= 2} type="submit">{busy === 'join' && <LoaderCircle className="spin" size={18} />}{info.memberCount >= 2 ? '房间已有两位伙伴' : busy === 'join' ? '正在加入' : '加入这次相处'}</button></form>}{info?.mode === 'solo' && <p className="muted-message">这是一个单人练习房间。你可以回到首页创建自己的空间。</p>}<p className="join-room-footnote"><ShieldCheck size={15} />加入后，你可以自行选择是否开启语音。</p>{(!info || info.status === 'ended' || info.mode === 'solo') && <a className="button secondary full-button" href={appPath('/')}>回到首页</a>}</section></main>{audio}</div>;

  if (room.status === 'ended') return <div className="room-page" style={accentStyle(template.color)}>{header}<main className="end-main"><section className="end-card"><div className="end-symbol"><Check size={32} /></div><p className="eyebrow">这一刻，已经一起走过</p><h1>谢谢你，认真在场。</h1><p className="end-description">{room.mode === 'solo' ? '把这一点安静，带回接下来的日常。' : `和 ${other?.nickname ?? '伙伴'} 共享的这段时间，值得被记住。`}</p><div className="end-meta"><span><TemplateIcon icon={template.icon} size={17} />{template.name}</span><span><Clock3 size={17} />计划 {room.durationMinutes} 分钟</span></div><div className="end-note"><div><h2>这次留下的文字</h2><button className="text-button" onClick={() => void copyNote()}><Copy size={16} />复制</button></div><p>{room.sharedNote || '没有文字记录，也是一段好好相处的时间。'}</p></div><div className="end-actions"><a className="button primary" href={appPath('/')}><Plus size={18} />开启下一段时光</a></div><p className="end-footnote">房间已结束，麦克风已释放。</p></section></main>{toast && <div className="toast" role="status"><Check size={17} />{toast}</div>}{audio}</div>;

  return <div className="room-page" style={accentStyle(template.color)}>{header}<main className="room-main">
    <div className="room-topline"><span className={`sync-label ${syncState === 'connected' ? '' : 'sync-lost'}`}>{syncState === 'connected' ? <Wifi size={15} /> : <RefreshCw className="spin" size={15} />}{syncState === 'connected' ? '互动已同步' : '正在恢复同步'}</span><div className="room-code"><span>房间 {room.id}</span>{room.mode === 'duo' && <button className="text-button" onClick={() => void invite()}><Link2 size={15} />复制邀请</button>}</div></div>
    {errorBlock}
    {syncState === 'reconnecting' && <div className="connection-notice" role="status">暂时无法同步房间。请稍等，恢复连接后会自动更新进度。</div>}
    <section className="participants" aria-label="房间参与者">
      {room.members.map(member => <Participant key={member.id} member={member} self={member.id === session.memberId} controller={member.id === room.controllerId} />)}
      {room.mode === 'duo' && room.members.length < 2 && <button className="participant empty-participant" onClick={() => void invite()}><span className="avatar empty-avatar"><Plus size={22} /></span><span className="participant-info"><strong>为另一位留个位置</strong><span>复制链接，邀请伙伴</span></span><Link2 size={18} /></button>}
      {room.mode === 'solo' && <div className="solo-label"><Headphones size={20} /><div><strong>一个人，先熟悉节奏</strong><span>当前为单人练习</span></div></div>}
    </section>

    <div className="room-grid"><section className="interaction-panel" aria-labelledby="current-title">
      <div className="interaction-topline"><span className={`activity-label ${room.status === 'running' ? 'is-running' : ''}`}>{room.status === 'running' ? <span className="status-dot" /> : room.status === 'paused' ? <Pause size={14} /> : <Clock3 size={14} />}{statusText}</span><span className="step-label">{room.stepIndex + 1} / {template.steps.length} · {current.eyebrow}</span></div>
      <div className="interaction-content"><span className="current-icon"><TemplateIcon icon={template.icon} size={29} /></span><h1 id="current-title">{room.status === 'waiting' ? '准备好，就一起开始。' : current.title}</h1><p className="current-prompt">{room.status === 'waiting' ? room.mode === 'solo' ? '先看看这个模板，按自己的节奏走一遍。' : other ? '你们都到齐了。可以先打个招呼，再确认准备。' : '把邀请链接发给想见的人。对方加入后，准备好就开始。' : current.prompt}</p><p className="current-hint">{room.status === 'waiting' ? template.description : current.hint}</p></div>
      <div className="timer-area"><span className="timer-label">{room.status === 'paused' ? '暂停在这一刻' : room.status === 'waiting' ? '第一环节时间' : remaining <= 0 ? '时间到，按自己的节奏继续' : '这一环节还剩'}</span><span className={`timer-display ${room.status === 'paused' ? 'paused-timer' : ''}`} aria-label={`剩余时间 ${formatTime(remaining)}`}>{formatTime(remaining)}</span><div className="timer-track"><span style={{ width: `${room.status === 'waiting' ? 0 : elapsedFraction * 100}%` }} /></div></div>
      <div className="interaction-actions">
        {(room.status === 'waiting' || room.status === 'paused') && <><button className={`button ${me?.ready ? 'ready-button' : 'primary'}`} disabled={!!busy || syncState !== 'connected'} onClick={() => void action('ready', { ready: !me?.ready })}>{me?.ready ? <CheckCheck size={18} /> : <Check size={18} />}{me?.ready ? '已准备好' : room.status === 'paused' ? '准备继续' : '我准备好了'}</button>{isController && <button className="button secondary" disabled={!allReady || !!busy || syncState !== 'connected'} onClick={() => void action(room.status === 'paused' ? 'resume' : 'start')}><Play size={17} />{room.status === 'paused' ? '继续这一环节' : '开始这次相处'}</button>}</>}
        {room.status === 'running' && <><button className="button secondary" disabled={busy === 'pause'} onClick={() => void action('pause')}><Pause size={18} />暂停一下</button>{isController && <button className="button primary" disabled={!!busy || syncState !== 'connected'} onClick={() => void action('next')}><SkipForward size={18} />{room.stepIndex === template.steps.length - 1 ? '完成这次相处' : '下一环节'}</button>}</>}
      </div>
      <p className="controller-caption">{room.status === 'waiting' && !allReady ? room.mode === 'solo' ? '准备好后，就可以开始单人练习。' : '双方都准备好后，由流程主持者开始。' : room.status === 'paused' && !allReady ? '重新确认准备后，就可以一起继续。' : isController ? '你正在主持流程；任何人都可以暂停。' : `${controller?.nickname ?? '伙伴'} 正在主持流程；你随时可以暂停。`}</p>
    </section>

    <aside className="room-sidebar"><section className="journey-panel"><div className="panel-heading"><h2>这一段时光</h2><span>{room.durationMinutes} 分钟</span></div><ol className="journey-steps">{template.steps.map((step, index) => <li key={step.title} className={`${index === room.stepIndex ? 'current' : ''} ${index < room.stepIndex ? 'complete' : ''}`}><span className="journey-mark">{index < room.stepIndex ? <Check size={13} /> : <span />}</span><div><strong>{step.title}</strong><span>{Math.round(stepDurationMs(room, index) / 60_000 * 10) / 10} 分钟</span></div></li>)}</ol>{room.mode === 'duo' && other && <div className="control-section">{room.controlRequest ? room.controlRequest.to === session.memberId ? <div className="control-request"><p>{room.members.find(member => member.id === room.controlRequest?.from)?.nickname} 想请你接着主持。</p><div><button className="button small primary" disabled={!!busy} onClick={() => void action('accept_control')}>接受主持</button><button className="button small ghost" disabled={!!busy} onClick={() => void action('decline_control')}>暂时不了</button></div></div> : <p className="muted-message"><LoaderCircle className="spin" size={15} />等待对方接受主持</p> : isController ? <button className="text-button" disabled={!!busy} onClick={() => void action('transfer', { targetId: other.id })}><SlidersHorizontal size={16} />请对方主持下一段</button> : <span className="muted-message">由 {controller?.nickname ?? '伙伴'} 主持流程</span>}</div>}</section>
      <section className={`notes-panel ${noteOpen ? 'notes-expanded' : ''}`}><div className="panel-heading"><h2>{room.mode === 'solo' ? '练习记录' : '共同记录'}</h2><button className="text-button notes-toggle" onClick={() => setNoteOpen(!noteOpen)}>{noteOpen ? '收起' : '展开'}</button><span className="notes-desktop-caption">留下一点什么</span></div><div className="notes-content"><label className="sr-only" htmlFor="shared-note">{room.mode === 'solo' ? '练习记录，仅自己可见' : '共同记录，房间内双方可见'}</label><textarea id="shared-note" value={note} onChange={e => { setNote(e.target.value); setNoteDirty(true); setNoteSaved(false); }} onFocus={() => { editingNote.current = true; }} onBlur={() => { editingNote.current = false; }} placeholder={room.mode === 'solo' ? '记下一个想法、一句台词，或下次想继续练习的地方……' : '一个想法、一句台词，或想下次继续聊的问题……'} maxLength={6000} /><div className="notes-footer"><span>{noteSaved && !noteDirty ? <><Check size={14} />已保存</> : noteDirty ? '有未保存的修改' : room.mode === 'solo' ? '手动保存' : '双方可见 · 手动保存'}</span><button className="button small secondary" disabled={!noteDirty || savingNote || !!busy || syncState !== 'connected'} onClick={() => void saveNote()}>{savingNote ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />}保存</button></div></div></section>
    </aside></div>
    <section className="voice-bar" aria-label="语音控制">
      <div className="voice-state"><span className={`voice-state-icon ${voice.status === 'connected' ? 'voice-connected' : ''}`}>{voice.status === 'connecting' || voice.status === 'requesting' ? <LoaderCircle className="spin" size={21} /> : voice.active && !voice.muted ? <Mic size={21} /> : <Headphones size={21} />}</span><div><strong>{room.mode === 'solo' ? '单人练习' : voiceText}</strong><span>{room.mode === 'solo' ? '按自己的节奏体验提示与流程' : voice.active ? voice.muted ? '你的麦克风已静音' : '不自动录音，随时可以关闭' : '你决定什么时候开口'}</span></div></div>
      <div className="voice-actions">{room.mode === 'duo' && <>
        {voice.active ? <>
          {voice.status === 'error' && <button className="button primary" disabled={!other || syncState !== 'connected'} onClick={() => void voice.retry()}><RefreshCw size={17} />重新连接</button>}
          <button className={`button secondary ${voice.muted ? 'muted-control' : ''}`} onClick={voice.toggleMute} aria-pressed={voice.muted}>{voice.muted ? <MicOff size={18} /> : <Mic size={18} />}{voice.muted ? '取消静音' : '静音'}</button>
          <button className="button ghost voice-close" onClick={() => void voice.stop()}>关闭语音</button>
        </> : <button className="button primary" disabled={voice.status === 'requesting' || !other || syncState !== 'connected'} onClick={() => void voice.start()}>{voice.status === 'requesting' ? <LoaderCircle className="spin" size={18} /> : <Mic size={18} />}开启语音</button>}
        {voice.needsPlayback && <button className="button secondary" onClick={() => void voice.enablePlayback()}><Volume2 size={18} />开启声音</button>}
      </>}</div>
      {room.mode === 'duo' && voice.status === 'connected' && voice.connectionPath && <p className="voice-network-hint voice-connection-path">连接方式：<strong>{voice.connectionPath === 'relay' ? '中继连接' : voice.connectionPath === 'livekit' ? 'LiveKit 连接' : '设备直连'}</strong></p>}
      {voice.active && room.mode === 'duo' && voice.provider === 'p2p' && (voice.status !== 'connected' || !voice.connectionPath) && <p className="voice-network-hint">{voice.relayConfigured ? voice.iceTransportPolicy === 'relay' ? '语音将通过中继尝试连接。' : '已配置中继，连接时会尝试可用路径。' : '当前为直连模式，部分网络可能无法连通。'}</p>}
      {voice.error && <p className="voice-error" role="alert">{voice.error}</p>}
    </section>
    {room.mode === 'duo' && <VoiceDiagnosticsPanel roomId={room.id} token={session.token} enabled={syncState === 'connected'} voiceActive={voice.active || voice.status === 'requesting'} />}
    <p className="room-footnote"><ShieldCheck size={14} />你可以随时暂停，也可以安静地待一会儿。</p>
  </main>{audio}
  {toast && <div className="toast" role="status"><Check size={17} />{toast}</div>}
  {showExit && <div className="modal-overlay" onClick={() => setShowExit(false)}><section ref={modalRef} className="exit-modal" role="dialog" aria-modal="true" aria-labelledby="exit-title" onClick={event => event.stopPropagation()}><button className="modal-close" aria-label="关闭" onClick={() => setShowExit(false)}><X size={20} /></button><span className="exit-modal-icon"><LogOut size={24} /></span><h2 id="exit-title">先离开一会儿？</h2><p>暂时离开会暂停互动。也可以结束整个房间，为这次相处画个句号。</p>{noteDirty && <p className="unsaved-notice">{room.mode === 'solo' ? '练习记录还有未保存的修改。' : '共同记录还有未保存的修改。'}</p>}<div className="exit-modal-actions"><button className="button secondary" disabled={!!busy} onClick={() => void exit(false)}>暂时离开</button><button className="button end-button" disabled={!!busy} onClick={() => void exit(true)}>结束房间</button></div><button className="text-button stay-button" onClick={() => setShowExit(false)}>再待一会儿</button></section></div>}
  </div>;
}

function Participant({ member, self, controller }: { member: Member; self: boolean; controller: boolean }) {
  return <div className={`participant ${member.ready ? 'participant-ready' : ''}`}><span className={`avatar ${self ? 'avatar-self' : 'avatar-other'}`}>{member.nickname.slice(0, 1)}{member.ready && <span className="avatar-ready"><Check size={10} /></span>}</span><span className="participant-info"><strong>{member.nickname}{self && <span className="self-label">你</span>}{controller && <span className="host-label">主持</span>}</strong><span>{!member.connected ? '正在恢复连接' : member.ready ? '已经准备好' : '按自己的节奏准备'}</span></span>{member.voiceEnabled && <span className="member-voice" title="已加入语音"><Mic size={17} /></span>}</div>;
}
