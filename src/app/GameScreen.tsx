import { useEffect, useRef } from 'react';

export default function GameScreen({ onExit }: { onExit: () => void }) {
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
      <button
        type="button"
        onClick={onExit}
        className="absolute left-4 top-4 z-10 rounded-lg border border-white/20 bg-slate-950/80 px-3 py-2 text-sm text-white"
      >
        Back to training
      </button>
    </div>
  );
}
