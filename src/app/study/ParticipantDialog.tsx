import { useEffect, useId, useRef, type ReactNode } from 'react';

interface Props {
  label: string;
  title: string;
  children: ReactNode;
  role?: 'dialog' | 'alertdialog';
  onCancel: () => void;
  cancelLabel?: string;
  cancelDisabled?: boolean;
  action: { label: string; onClick: () => void; disabled?: boolean };
}

/** Presentation only: opening or dismissing a dialog never changes study state. */
export default function ParticipantDialog({ label, title, children, role = 'dialog', onCancel, cancelLabel = 'Not now', cancelDisabled = false, action }: Props) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const previous = document.activeElement as HTMLElement | null;
    (panel.current?.querySelector?.('button:not([disabled])') as HTMLElement | null)?.focus?.({ preventScroll: true });
    return () => { if (previous?.isConnected) previous.focus?.({ preventScroll: true }); };
  }, []);
  return <div data-participant-dialog-overlay style={{ position: 'fixed', inset: 0, zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, background: 'rgba(2,6,23,0.78)' }}>
    <div ref={panel} role={role} aria-modal="true" aria-label={label} aria-labelledby={titleId} tabIndex={-1} className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-3xl border border-white/30 bg-slate-950 p-6 text-slate-100 shadow-2xl" onKeyDown={event => {
      event.stopPropagation(); // Keep dialog keys away from background Capture shortcuts.
      if (event.key === 'Escape') { if (!cancelDisabled) onCancel(); }
      if (event.key !== 'Tab') return;
      const controls = Array.from(panel.current?.querySelectorAll?.('button:not([disabled])') ?? []) as HTMLElement[];
      const first = controls[0], last = controls[controls.length - 1];
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus({ preventScroll: true }); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus({ preventScroll: true }); }
    }}>
      <h2 id={titleId} className="text-xl font-medium">{title}</h2>
      <div className="mt-3 space-y-3 text-sm leading-6 text-slate-300">{children}</div>
      <div className="mt-6 flex flex-wrap justify-end gap-3">
        <button type="button" disabled={cancelDisabled} onClick={onCancel} className="rounded-xl border border-white/30 px-4 py-3 disabled:opacity-40">{cancelLabel}</button>
        <button type="button" disabled={action.disabled} onClick={action.onClick} className="rounded-xl bg-cyan-300 px-4 py-3 font-medium text-slate-950 disabled:opacity-40">{action.label}</button>
      </div>
    </div>
  </div>;
}
