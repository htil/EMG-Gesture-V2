import { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';

export interface DarkSelectOption {
  value: string;
  label: string;
}

export default function DarkSelect({
  label,
  value,
  options,
  onChange,
  triggerClassName = '',
}: {
  label: string;
  value: string;
  options: DarkSelectOption[];
  onChange: (value: string) => void;
  triggerClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const selected = options.find((option) => option.value === value) ?? options[0];

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((current) => !current)}
        className={`flex w-full items-center justify-between gap-3 rounded-2xl border border-white/15 bg-slate-900 px-4 py-3 text-left text-slate-50 outline-none focus-visible:border-cyan-300/60 ${triggerClassName}`}
        style={{ color: '#f8fafc', backgroundColor: '#0f172a' }}
      >
        <span>{selected?.label ?? 'Select'}</span>
        <ChevronDown className="h-4 w-4 shrink-0 text-slate-300" aria-hidden="true" />
      </button>
      {open && (
        <ul
          id={listId}
          role="listbox"
          aria-label={label}
          className="absolute z-30 mt-2 max-h-64 w-full overflow-auto rounded-2xl border border-slate-600 bg-slate-900 p-1 shadow-2xl"
          style={{ backgroundColor: '#0f172a' }}
        >
          {options.map((option) => {
            const active = option.value === value;
            return (
              <li key={option.value} role="option" aria-selected={active}>
                <button
                  type="button"
                  onClick={() => {
                    onChange(option.value);
                    setOpen(false);
                  }}
                  className={`w-full rounded-xl px-3 py-2.5 text-left text-sm ${active ? 'bg-cyan-300/20 text-cyan-50' : 'text-slate-100 hover:bg-white/10'}`}
                  style={{ color: active ? '#ecfeff' : '#f1f5f9', backgroundColor: active ? 'rgba(34,211,238,0.18)' : '#0f172a' }}
                >
                  {option.label}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
