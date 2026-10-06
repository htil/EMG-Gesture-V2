import { useEffect, useRef } from 'react';

export default function GameScreen({
  onExit,
  exitLabel = 'Back to training',
  onSecondary,
  secondaryLabel,
}: {
  onExit: () => void;
  exitLabel?: string;
  onSecondary?: () => void;
  secondaryLabel?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    let cancelled = false;
    let unmountGame = () => {};

    import('../../game/main.js').then((game) => {
      if (cancelled) {
        return;
      }
      unmountGame = game.mountGame(container);
    });

    return () => {
      cancelled = true;
      unmountGame();
    };
  }, []);

  return (
    <div className="fixed inset-0 bg-black">
      <div ref={containerRef} className="h-full w-full" />
      <div className="fixed left-4 top-20 z-50 flex gap-2">
        <button
          type="button"
          onClick={onExit}
          className="rounded-lg border border-slate-600 bg-slate-950 px-3 py-2 text-sm font-medium text-white shadow-lg"
        >
          {exitLabel}
        </button>
        {onSecondary && secondaryLabel && (
          <button
            type="button"
            onClick={onSecondary}
            className="rounded-lg border border-slate-600 bg-slate-950 px-3 py-2 text-sm font-medium text-white shadow-lg"
          >
            {secondaryLabel}
          </button>
        )}
      </div>
    </div>
  );
}
