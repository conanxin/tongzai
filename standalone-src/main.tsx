import { createRoot } from 'react-dom/client';
import Home from '@/components/Home';
import RoomApp from '@/components/RoomApp';
import { appPath } from '@/lib/paths';
import '@/app/globals.css';

const base = import.meta.env.BASE_URL.replace(/\/$/, '');
const pathname = window.location.pathname.slice(base.length) || '/';
const match = pathname.match(/^\/r\/([A-Fa-f0-9]{12})\/?$/);
const root = createRoot(document.getElementById('root')!);
root.render(match ? <RoomApp roomId={match[1].toUpperCase()} /> : pathname === '/' ? <Home /> : (
  <main className="loading-room"><h1>没有找到这个页面</h1><p>可以从首页开启一段新的时光。</p><a className="button primary" href={appPath('/')}>返回首页</a></main>
));
