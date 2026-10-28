import { useEffect, useRef, useState } from 'react';

export interface PracticeGuideStep {
  id: string;
  title: string;
  body: string;
  target?: string;
  action?: { label: string; onClick: () => void; disabled?: boolean };
}

// Presentation only: step completion belongs to the actual stream/recorder/
// archive/model state. Hiding or replaying guidance never changes study data.
export default function PracticeGuide({ step, busy = false }: { step: PracticeGuideStep; busy?: boolean }) {
  const [expanded, setExpanded] = useState(true);
  const panel = useRef<HTMLElement | null>(null);
  const [placement, setPlacement] = useState<{ top: number; left: number; width: number; side: string } | null>(null);
  const [rect, setRect] = useState<{ top: number; left: number; width: number; height: number } | null>(null);
  useEffect(() => { setExpanded(true); }, [step.id]);
  useEffect(() => {
    setRect(null); setPlacement(null);
    if (typeof document === 'undefined' || busy || !expanded || !step.target) return;
    const element = document.querySelector<HTMLElement>(step.target);
    if (!element) return;
    element.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    const update = () => {
      const next = element.getBoundingClientRect();
      if (!element.isConnected || next.width <= 0 || next.height <= 0 || next.bottom < 0 || next.top > window.innerHeight) { setRect(null); return; }
      const margin = 12, gap = 12;
      let width = Math.min(360, window.innerWidth - margin * 2);
      if (next.right + gap + width > window.innerWidth - margin && next.left - gap - width < margin) width = Math.min(960, window.innerWidth - margin * 2);
      const height = Math.min(panel.current?.getBoundingClientRect().height || 180, window.innerHeight - margin * 2);
      let left = next.left, top = next.bottom + gap, side = 'below';
      if (next.right + gap + width <= window.innerWidth - margin) { left = next.right + gap; top = next.top; side = 'right'; }
      else if (next.left - gap - width >= margin) { left = next.left - gap - width; top = next.top; side = 'left'; }
      else if (top + height > window.innerHeight - margin && next.top - gap - height >= margin) { top = next.top - gap - height; side = 'above'; }
      const position = { left: Math.max(margin, Math.min(left, window.innerWidth - width - margin)), top: Math.max(margin, Math.min(top, window.innerHeight - height - margin)), width, side };
      setPlacement(current => current && current.left === position.left && current.top === position.top && current.width === position.width && current.side === position.side ? current : position);
      const value = { top: next.top - 5, left: next.left - 5, width: next.width + 10, height: next.height + 10 };
      setRect(current => current && Object.keys(value).every(key => current[key as keyof typeof value] === value[key as keyof typeof value]) ? current : value);
    };
    update();
    const frame = window.requestAnimationFrame?.(update);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(element);
    if (panel.current) observer?.observe(panel.current);
    return () => { if (frame !== undefined) window.cancelAnimationFrame?.(frame); window.removeEventListener('resize', update); window.removeEventListener('scroll', update, true); observer?.disconnect(); };
  }, [step.id, step.target, step.title, step.body, busy, expanded]);
  return <>
    {rect && <div data-practice-highlight aria-hidden="true" className="pointer-events-none fixed z-30 rounded-2xl border-[3px] border-cyan-300 shadow-[0_0_0_9999px_rgba(2,6,23,0.28)]" style={rect} />}
    <section ref={panel} aria-label="Practice guidance" data-guide-step={step.id} data-guide-side={placement?.side} style={placement ? { position: 'fixed', left: placement.left, top: placement.top, width: placement.width, maxHeight: 'calc(100vh - 24px)', overflowY: 'auto', zIndex: 40 } : undefined} className="relative z-40 rounded-2xl border-2 border-cyan-300/60 bg-slate-950 px-5 py-4 text-white shadow-xl">
      <div className="flex items-start justify-between gap-4">
        <div><p className="text-xs uppercase tracking-wider text-cyan-200">Practice</p><h2 aria-live="polite" className="mt-1 text-lg font-semibold">{step.title}</h2></div>
        <button type="button" aria-expanded={expanded} className="shrink-0 rounded-lg border border-white/30 px-3 py-2 text-xs" onClick={() => setExpanded(value => !value)}>{expanded ? 'Hide guidance' : 'Show guidance again'}</button>
      </div>
      {expanded && <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-200">{step.body}</p>}
      {step.action && <button type="button" disabled={busy || step.action.disabled} className="mt-3 rounded-xl bg-cyan-300 px-5 py-3 text-sm font-medium text-slate-950 disabled:opacity-40" onClick={step.action.onClick}>{step.action.label}</button>}
    </section>
  </>;
}
