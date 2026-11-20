'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, Clock3, Headphones, Link2, LoaderCircle, Plus, ShieldCheck, Users, X } from 'lucide-react';
import type { RoomMode, RoomResponse, TemplateId } from '@/lib/model';
import { templates, getTemplate } from '@/lib/templates';
import { jsonRequest, saveRoomSession } from '@/hooks/useRoom';
import { appPath } from '@/lib/paths';
import { Brand, TemplateIcon, accentStyle } from './Brand';

export default function Home() {
  const [selected, setSelected] = useState<TemplateId>('conversation');
  const [minutes, setMinutes] = useState(20);
  const [nickname, setNickname] = useState('');
  const [invite, setInvite] = useState('');
  const [error, setError] = useState('');
  const [joinError, setJoinError] = useState('');
  const [busy, setBusy] = useState<RoomMode | null>(null);
  const creating = useRef(false);
  const nicknameInput = useRef<HTMLInputElement>(null);
  const joinInput = useRef<HTMLInputElement>(null);
  const active = getTemplate(selected);
  useEffect(() => { setNickname(localStorage.getItem('tongzai.nickname') ?? ''); }, []);

  async function create(mode: RoomMode) {
    if (creating.current) return;
    if (!nickname.trim()) { setError('先给自己起一个昵称吧。'); nicknameInput.current?.focus(); return; }
    creating.current = true;
    setBusy(mode); setError('');
    try {
      const result = await jsonRequest<RoomResponse>('/api/rooms', { method: 'POST', body: JSON.stringify({ nickname: nickname.trim(), templateId: selected, durationMinutes: minutes, mode }) });
      if (!result.session) throw new Error('房间创建后未能获取身份，请重试。');
      saveRoomSession(result.room.id, result.session);
      localStorage.setItem('tongzai.nickname', nickname.trim());
      window.location.assign(appPath(`/r/${encodeURIComponent(result.room.id)}`));
    } catch (err) { setError((err as Error).message); creating.current = false; setBusy(null); }
  }
  function joinRoom(event: React.FormEvent) {
    event.preventDefault();
    const raw = invite.trim();
    const match = raw.match(/\/r\/([a-zA-Z0-9_-]+)/);
    const id = match ? match[1] : raw;
    if (!/^[a-zA-Z0-9_-]{6,80}$/.test(id)) { setJoinError('请输入完整的邀请链接或房间码。'); joinInput.current?.focus(); return; }
    window.location.assign(appPath(`/r/${encodeURIComponent(id)}`));
  }

  return <div className="home-page">
    <header className="site-header"><Brand /><button className="text-button header-join" onClick={() => { document.querySelector('#join-room')?.scrollIntoView({ behavior: 'smooth', block: 'center' }); joinInput.current?.focus({ preventScroll: true }); }}><Link2 size={17} />加入房间</button></header>
    <main className="home-main">
      <section className="home-hero" aria-labelledby="hero-title">
        <div className="hero-copy"><p className="eyebrow">A LITTLE TIME, TOGETHER</p><h1 id="hero-title">此刻，<br />和你<span>同在。</span></h1><p className="hero-description">一段对话，一页共读，一次排练。<br />邀请一个人，把这段时间留给彼此。</p><div className="hero-details"><span><Users size={16} />两个人的空间</span><span><Clock3 size={16} />自己的节奏</span></div></div>
        <div className="hero-art" aria-hidden="true"><div className="orbit orbit-one" /><div className="orbit orbit-two" /><div className="orbit orbit-three" /><span className="orbit-stroke" /><span className="art-person art-person-you">你</span><span className="art-person art-person-them">TA</span><div className="art-center"><span className="art-small">刚好两个人</span><span>一起，在场</span></div><span className="art-caption">MAKE ROOM FOR EACH OTHER</span></div>
      </section>

      <section className="choose-section" aria-labelledby="choose-title"><div className="section-heading"><div><p className="eyebrow">从一个小小的选择开始</p><h2 id="choose-title">今天，想一起做什么？</h2></div><span className="section-caption">选择一种相处方式</span></div>
        <div className="template-grid" role="radiogroup" aria-label="互动模板">{templates.map(template => <button key={template.id} role="radio" aria-checked={selected === template.id} className={`template-card ${selected === template.id ? 'selected' : ''}`} style={accentStyle(template.color)} onClick={() => setSelected(template.id)}><div className="template-card-top"><span className="template-icon"><TemplateIcon icon={template.icon} /></span><span className="selection-circle">{selected === template.id && <Check size={14} />}</span></div><h3>{template.name}</h3><p>{template.subtitle}</p><span className="template-card-footer">{template.tag}</span></button>)}</div>
      </section>

      <section className="create-panel" style={accentStyle(active.color)} aria-label="创建房间">
        <div className="create-panel-top"><div className="field"><label htmlFor="nickname">怎么称呼你？</label><input id="nickname" ref={nicknameInput} value={nickname} onChange={e => setNickname(e.target.value)} placeholder="起一个临时昵称" maxLength={20} autoComplete="nickname" onKeyDown={e => { if (e.key === 'Enter') void create('duo'); }} /></div><div className="duration-field"><span className="field-label" id="duration-label">留出一点时间</span><div className="duration-options" role="radiogroup" aria-labelledby="duration-label">{[10, 20, 30, 45].map(duration => <button key={duration} role="radio" aria-checked={minutes === duration} className={minutes === duration ? 'active' : ''} onClick={() => setMinutes(duration)}>{duration}<span>分钟</span></button>)}</div></div></div>
        {error && <div className="error-notice" role="alert"><span>{error}</span><button aria-label="关闭提示" onClick={() => setError('')}><X size={17} /></button></div>}
        <div className="create-panel-bottom"><p><ShieldCheck size={17} />链接邀请 · 随时暂停 · 不自动录音</p><div className="create-actions"><button className="button secondary" disabled={!!busy} onClick={() => void create('solo')}>{busy === 'solo' ? <LoaderCircle className="spin" size={18} /> : <Headphones size={18} />}一个人先试试</button><button className="button primary" disabled={!!busy} onClick={() => void create('duo')}>{busy === 'duo' ? <LoaderCircle className="spin" size={18} /> : <Plus size={19} />}{busy === 'duo' ? '正在准备房间' : '创建好友房间'}</button></div></div>
      </section>

      <section className="join-panel" id="join-room"><div><span className="join-icon"><Link2 size={20} /></span><div><h3>有人在等你？</h3><p>带着邀请链接或房间码，加入这次相遇。</p></div></div><form onSubmit={joinRoom}><div><label className="sr-only" htmlFor="invite">邀请链接或房间码</label><input id="invite" ref={joinInput} value={invite} onChange={e => { setInvite(e.target.value); setJoinError(''); }} placeholder="粘贴邀请链接或房间码" autoComplete="off" />{joinError && <span className="field-error" role="alert">{joinError}</span>}</div><button className="button secondary" type="submit">加入房间</button></form></section>
    </main><footer className="site-footer"><span>同在 · 把时间留给彼此</span><span>无需赶路，好好相处。</span></footer>
  </div>;
}
