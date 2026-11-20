import { type CSSProperties } from 'react';
import { BookOpen, Mic2, Sparkles } from 'lucide-react';
import type { InteractionTemplate } from '@/lib/model';
import { appPath } from '@/lib/paths';

export function Brand({ compact = false }: { compact?: boolean }) {
  return <a className="brand" href={appPath('/')} aria-label="同在首页"><span className="brand-mark" aria-hidden="true"><i /><i /></span><span className="brand-word">同在</span>{!compact && <span className="brand-subtitle">双人互动空间</span>}</a>;
}
export function TemplateIcon({ icon, size = 24 }: { icon: InteractionTemplate['icon']; size?: number }) {
  if (icon === 'book') return <BookOpen size={size} strokeWidth={1.7} />;
  if (icon === 'mic') return <Mic2 size={size} strokeWidth={1.7} />;
  return <Sparkles size={size} strokeWidth={1.7} />;
}
export const accentStyle = (color: string) => ({ '--accent': color } as CSSProperties);
