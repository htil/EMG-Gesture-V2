import { useId, useState, type ReactNode } from 'react';

interface Props {
  message: string;
  summary: string;
  resetKey?: string | number | boolean;
  actions?: ReactNode;
  className?: string;
}

/** Presentation only: hiding details never clears the issue or changes readiness. */
export default function DismissibleNotice(props: Props) {
  if (!props.message) return null;
  // A new message or retry starts expanded, including identical retry failures.
  return <NoticeDetails key={JSON.stringify([props.message, props.resetKey])} {...props} />;
}

function NoticeDetails({ message, summary, actions, className = '' }: Props) {
  const [expanded, setExpanded] = useState(true);
  const detailsId = useId();
  return (
    <section aria-label={`${summary} — unresolved`} className={`rounded-xl border border-amber-300/25 bg-amber-300/10 p-3 text-sm text-amber-100 ${className}`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p role="alert" className="font-medium">{summary} — unresolved</p>
        <button type="button" aria-expanded={expanded} aria-controls={detailsId}
          onClick={() => setExpanded(value => !value)}
          className="rounded-lg border border-current px-3 py-2 text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">
          {expanded ? 'Hide details' : 'Show details'}
        </button>
      </div>
      <p id={detailsId} hidden={!expanded} className="mt-2 whitespace-pre-wrap break-words leading-6">{message}</p>
      {actions && <div className="mt-3">{actions}</div>}
    </section>
  );
}
