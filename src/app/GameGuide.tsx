import { useEffect, useRef, useState } from 'react';

interface Props {
  body: string;
  centered?: boolean;
  target?: string;
  nextDisabled?: boolean;
  onNext: () => void;
}

// Presentation only. The game decides when a step is showing and what happens next.
export default function GameGuide({ body, centered = false, target, nextDisabled = false, onNext }: Props) {
  const panel = useRef<HTMLElement | null>(null);
  const [placement, setPlacement] = useState<{ top: number; left: number; width: number } | null>(null);
  const [rect, setRect] = useState<{ top: number; left: number; width: number; height: number } | null>(null);

  useEffect(() => {
    setRect(null);
    setPlacement(null);
    if (centered || !target || typeof document === 'undefined') return;
    const element = document.querySelector<HTMLElement>(target);
    if (!element) return;
    element.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    const update = () => {
      const next = element.getBoundingClientRect();
      if (!element.isConnected || next.width <= 0 || next.height <= 0) {
        setRect(null);
        return;
      }
      const margin = 12;
      const gap = 12;
      let width = Math.min(420, window.innerWidth - margin * 2);
      if (next.right + gap + width > window.innerWidth - margin && next.left - gap - width < margin) {
        width = Math.min(960, window.innerWidth - margin * 2);
      }
      const height = Math.min(panel.current?.getBoundingClientRect().height || 220, window.innerHeight - margin * 2);
      let left = next.left;
      let top = next.bottom + gap;
      if (next.right + gap + width <= window.innerWidth - margin) {
        left = next.right + gap;
        top = next.top;
      } else if (next.left - gap - width >= margin) {
        left = next.left - gap - width;
        top = next.top;
      } else if (top + height > window.innerHeight - margin && next.top - gap - height >= margin) {
        top = next.top - gap - height;
      }
      const position = {
        left: Math.max(margin, Math.min(left, window.innerWidth - width - margin)),
        top: Math.max(margin, Math.min(top, window.innerHeight - height - margin)),
        width,
      };
      setPlacement((current) => current && current.left === position.left && current.top === position.top && current.width === position.width ? current : position);
      const value = { top: next.top - 5, left: next.left - 5, width: next.width + 10, height: next.height + 10 };
      setRect((current) => current && current.top === value.top && current.left === value.left && current.width === value.width && current.height === value.height ? current : value);
    };
    update();
    const frame = window.requestAnimationFrame?.(update);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(element);
    if (panel.current) observer?.observe(panel.current);
    return () => {
      if (frame !== undefined) window.cancelAnimationFrame?.(frame);
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
      observer?.disconnect();
    };
  }, [body, centered, target]);

  const card = (
    <section
      ref={panel}
      aria-label="Game guidance"
      style={centered || !placement ? undefined : { position: 'fixed', left: placement.left, top: placement.top, width: placement.width, maxHeight: 'calc(100vh - 24px)', overflowY: 'auto', zIndex: 160 }}
      className={`rounded-2xl border-2 border-cyan-300/60 bg-slate-950 px-5 py-4 text-white shadow-xl ${centered ? 'relative z-[160] w-[min(420px,calc(100vw-32px))]' : !placement ? 'fixed left-4 top-1/2 z-[160] w-[min(420px,calc(100vw-32px))] -translate-y-1/2' : ''}`}
    >
      <p className="text-xs uppercase tracking-wider text-cyan-200">Practice</p>
      <p className="mt-2 text-sm leading-6 text-slate-200">{body}</p>
      <div className="mt-4 flex justify-end">
        <button
          type="button"
          disabled={nextDisabled}
          className="rounded-xl bg-cyan-300 px-5 py-3 text-sm font-medium text-slate-950 disabled:opacity-40"
          onClick={onNext}
        >
          Next
        </button>
      </div>
    </section>
  );

  if (centered) {
    return (
      <div className="fixed inset-0 z-[160] flex items-center justify-center bg-slate-950/55 p-4">
        {card}
      </div>
    );
  }

  return (
    <>
      {rect && <div aria-hidden="true" className="pointer-events-none fixed z-[150] rounded-2xl border-[3px] border-cyan-300 shadow-[0_0_0_9999px_rgba(2,6,23,0.55)]" style={rect} />}
      {card}
    </>
  );
}
