import { useEffect, useMemo, useRef, useState } from 'react';
import { Activity, ArrowLeft, CheckCircle2, XCircle, Zap } from 'lucide-react';

export type QteStatus = 'rest' | 'ready' | 'recording' | 'processing' | 'complete';

export interface GameQteViewState {
  status: QteStatus;
  /** Progress through the current phase, from 0 to 1. */
  progress: number;
  targetGestureName?: string | null;
  resultLabel?: string | null;
  trialIndex?: number;
  trialCount?: number;
}

interface EmgDisplayPoint {
  time: number;
  normalizedActivity?: number;
  value?: number;
}

const QTE_COPY: Record<QteStatus, { label: string; hint: string; color: string }> = {
  rest: { label: 'Rest', hint: 'Relax and watch for the next cue', color: '#22d3ee' },
  ready: { label: 'Get Ready', hint: 'Prepare the target gesture', color: '#38bdf8' },
  recording: { label: 'Recording', hint: 'Perform and hold the gesture', color: '#fb7185' },
  processing: { label: 'Processing', hint: 'Reading your signal', color: '#a78bfa' },
  complete: { label: 'Complete', hint: 'Return to rest', color: '#34d399' },
};

function QteRing({ state }: { state: GameQteViewState }) {
  const visual = QTE_COPY[state.status];
  const radius = 66;
  const circumference = 2 * Math.PI * radius;
  const progress = Math.max(0, Math.min(1, state.progress));
  const readyProgress = state.status === 'ready'
    ? progress
    : state.status === 'recording' || state.status === 'processing' || state.status === 'complete'
      ? 1
      : 0;
  const showPhaseOverlay = state.status === 'recording' || state.status === 'processing' || state.status === 'complete';
  const phaseProgress = state.status === 'recording' ? progress : showPhaseOverlay ? 1 : 0;

  return (
    <div className="flex flex-col items-center">
      <div className="relative h-40 w-40">
        <svg viewBox="0 0 160 160" className="h-full w-full -rotate-90" aria-hidden="true">
          <circle cx="80" cy="80" r={radius} fill="rgba(2, 6, 23, .74)" stroke="rgba(148, 163, 184, .2)" strokeWidth="8" />
          <circle
            cx="80"
            cy="80"
            r={radius}
            fill="none"
            stroke="#38bdf8"
            strokeWidth="8"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - readyProgress)}
            className="transition-[stroke-dashoffset] duration-100 ease-linear"
            style={{ filter: 'drop-shadow(0 0 8px #38bdf888)' }}
          />
          {showPhaseOverlay && (
            <circle
              cx="80"
              cy="80"
              r={radius}
              fill="none"
              stroke={visual.color}
              strokeWidth="8"
              strokeLinecap="round"
              strokeDasharray={circumference}
              strokeDashoffset={circumference * (1 - phaseProgress)}
              className="transition-[stroke-dashoffset,stroke] duration-100 ease-linear"
              style={{ filter: `drop-shadow(0 0 8px ${visual.color}88)` }}
            />
          )}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
          <span className="mb-1 h-2 w-2 rounded-full" style={{ background: visual.color, boxShadow: `0 0 12px ${visual.color}` }} />
          <span className="text-[10px] font-semibold uppercase tracking-[0.22em] text-slate-400">Status</span>
          <span className="mt-1 text-xl font-semibold text-white">{visual.label}</span>
          <span className="mt-1 text-xs tabular-nums text-slate-400">{Math.round(progress * 100)}%</span>
        </div>
      </div>
      <p className="mt-2 max-w-44 text-center text-xs leading-5 text-slate-400">{state.resultLabel || visual.hint}</p>
    </div>
  );
}

function EmgTrace({
  points,
  qteState,
}: {
  points: EmgDisplayPoint[];
  qteState: GameQteViewState;
}) {
  const captureStartRef = useRef<number | null>(null);
  const captureEndRef = useRef<number | null>(null);
  const previousStatusRef = useRef<QteStatus>(qteState.status);
  const visiblePoints = useMemo(() => points.slice(-100), [points]);

  const path = useMemo(() => {
    if (visiblePoints.length < 2) return '';
    return visiblePoints.map((point, index) => {
      const activity = Math.max(0, Math.min(1, point.normalizedActivity ?? point.value ?? 0));
      const x = (index / (visiblePoints.length - 1)) * 300;
      const y = 58 - activity * 48;
      return `${index === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
    }).join(' ');
  }, [visiblePoints]);

  const latest = points[points.length - 1];
  const activity = Math.max(0, Math.min(1, latest?.normalizedActivity ?? latest?.value ?? 0));

  if (qteState.status === 'recording' && previousStatusRef.current !== 'recording') {
    captureStartRef.current = latest?.time ?? null;
    captureEndRef.current = null;
  } else if (qteState.status !== 'recording' && previousStatusRef.current === 'recording') {
    captureEndRef.current = latest?.time ?? captureStartRef.current;
  }
  previousStatusRef.current = qteState.status;

  const visibleStart = visiblePoints[0]?.time;
  const visibleEnd = visiblePoints[visiblePoints.length - 1]?.time;
  const captureStart = captureStartRef.current;
  const captureEnd = qteState.status === 'recording'
    ? latest?.time ?? captureStart
    : captureEndRef.current;
  const visibleDuration = visibleStart !== undefined && visibleEnd !== undefined
    ? Math.max(1, visibleEnd - visibleStart)
    : 1;
  const captureX1 = captureStart !== null && visibleStart !== undefined
    ? Math.max(0, Math.min(300, ((captureStart - visibleStart) / visibleDuration) * 300))
    : 0;
  const captureX2 = captureEnd !== null && captureEnd !== undefined && visibleStart !== undefined
    ? Math.max(0, Math.min(300, ((captureEnd - visibleStart) / visibleDuration) * 300))
    : captureX1;
  const showCapture = captureStart !== null
    && captureEnd !== null
    && captureEnd !== undefined
    && visibleStart !== undefined
    && visibleEnd !== undefined
    && captureEnd >= visibleStart
    && captureStart <= visibleEnd;

  return (
    <section className="rounded-2xl border border-cyan-300/15 bg-slate-950/80 p-4 shadow-2xl backdrop-blur-md">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-cyan-100">
          <Activity className="h-4 w-4 text-cyan-300" />
          EMG Activity
        </div>
        <span className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-slate-400">
          <span className={`h-1.5 w-1.5 rounded-full ${points.length ? 'bg-emerald-400 shadow-[0_0_8px_#34d399]' : 'bg-slate-600'}`} />
          {points.length ? 'Live' : 'Waiting'}
        </span>
      </div>
      <div className="mt-3 h-16 overflow-hidden rounded-lg border border-white/5 bg-slate-950/70">
        <svg viewBox="0 0 300 64" preserveAspectRatio="none" className="h-full w-full">
          {showCapture && (
            <>
              <rect
                x={Math.min(captureX1, captureX2)}
                y="0"
                width={Math.max(1, Math.abs(captureX2 - captureX1))}
                height="64"
                fill="rgba(251, 113, 133, .16)"
              />
              <line
                x1={captureX1}
                x2={captureX1}
                y1="0"
                y2="64"
                stroke="rgba(251, 113, 133, .8)"
                strokeWidth="1"
                vectorEffect="non-scaling-stroke"
              />
              <line
                x1={captureX2}
                x2={captureX2}
                y1="0"
                y2="64"
                stroke="rgba(251, 113, 133, .8)"
                strokeWidth="1"
                vectorEffect="non-scaling-stroke"
              />
            </>
          )}
          <path d="M0 32H300" stroke="rgba(148,163,184,.12)" strokeDasharray="4 5" />
          {path && <path d={path} fill="none" stroke="#22d3ee" strokeWidth="2" vectorEffect="non-scaling-stroke" style={{ filter: 'drop-shadow(0 0 4px #22d3ee88)' }} />}
        </svg>
      </div>
      <div className="mt-2 flex items-center justify-between text-[10px] uppercase tracking-wider text-slate-500">
        <span>Single channel</span>
        <span className="tabular-nums text-cyan-200">{Math.round(activity * 100)}%</span>
      </div>
    </section>
  );
}

export default function GameScreen({
  onExit,
  exitLabel = 'Back to training',
  onSecondary,
  secondaryLabel,
  score,
  streak,
  qteState,
  emgPoints = [],
}: {
  onExit: () => void;
  exitLabel?: string;
  onSecondary?: () => void;
  secondaryLabel?: string;
  score?: number;
  streak?: number;
  qteState?: GameQteViewState;
  emgPoints?: EmgDisplayPoint[];
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [runnerQteState, setRunnerQteState] = useState<GameQteViewState>({
    status: 'rest',
    progress: 0,
    targetGestureName: 'Jump',
  });
  const [runnerScore, setRunnerScore] = useState(0);
  const [runnerStreak, setRunnerStreak] = useState(0);
  const [correctAttempts, setCorrectAttempts] = useState(0);
  const [totalAttempts, setTotalAttempts] = useState(0);
  const [feedback, setFeedback] = useState<{ correct: boolean; id: number } | null>(null);
  const feedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let cancelled = false;
    let unmountGame = () => {};

    import('../../game/main.js').then((game) => {
      if (!cancelled) {
        unmountGame = game.mountGame(container, {
          onQteUpdate: setRunnerQteState,
          onObstacleResult: (correct: boolean) => {
            setTotalAttempts((current) => current + 1);
            setFeedback({ correct, id: Date.now() });
            if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current);
            feedbackTimerRef.current = setTimeout(() => setFeedback(null), 850);
            if (correct) {
              setCorrectAttempts((current) => current + 1);
              setRunnerScore((current) => current + 100);
              setRunnerStreak((current) => current + 1);
            } else {
              setRunnerStreak(0);
            }
          },
        });
      }
    });

    return () => {
      cancelled = true;
      unmountGame();
      if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current);
    };
  }, []);

  const visibleQteState = qteState ?? runnerQteState;
  const visibleScore = score ?? runnerScore;
  const visibleStreak = streak ?? runnerStreak;
  const accuracy = totalAttempts > 0 ? Math.round((correctAttempts / totalAttempts) * 100) : 0;
  const targetLabel = visibleQteState.targetGestureName || 'Stand by';
  const trialLabel = visibleQteState.trialIndex && visibleQteState.trialCount
    ? `${visibleQteState.trialIndex} / ${visibleQteState.trialCount}`
    : '—';

  return (
    <div className="fixed inset-0 z-[100] overflow-hidden bg-slate-950 text-white">
      <div ref={containerRef} className="h-full w-full" />
      <div className="pointer-events-none fixed inset-0 z-40 bg-[linear-gradient(180deg,rgba(2,6,23,.76)_0%,transparent_25%,transparent_72%,rgba(2,6,23,.62)_100%)]" />

      <header className="pointer-events-none fixed inset-x-0 top-0 z-[110] flex items-start justify-between gap-3 p-3 md:p-5">
        <div className="pointer-events-auto flex items-center gap-3 rounded-2xl border border-cyan-300/15 bg-slate-950/80 px-3 py-2.5 shadow-2xl backdrop-blur-md md:px-4">
          <button type="button" onClick={onExit} className="rounded-lg border border-white/10 bg-white/5 p-2 text-slate-300 transition hover:bg-white/10 hover:text-white" aria-label={exitLabel} title={exitLabel}>
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-cyan-300">EMG Gesture</p>
            <p className="text-sm font-semibold text-white">Neural Runner</p>
          </div>
        </div>

        <div className="flex items-stretch gap-2">
          <div className="relative rounded-2xl border border-cyan-300/15 bg-slate-950/80 px-4 py-2.5 text-right shadow-2xl backdrop-blur-md">
            <p className="text-[9px] font-semibold uppercase tracking-[0.18em] text-slate-500">Score</p>
            <p key={visibleScore} className="text-xl font-bold tabular-nums text-white animate-[pulse_350ms_ease-out_1]">{visibleScore.toLocaleString().padStart(6, '0')}</p>
            {feedback?.correct && (
              <span key={feedback.id} className="absolute -bottom-5 right-2 font-bold tabular-nums text-emerald-300 drop-shadow-[0_0_8px_rgba(52,211,153,.8)] animate-[bounce_650ms_ease-out_1]">
                +100
              </span>
            )}
          </div>
          <div className="hidden rounded-2xl border border-cyan-300/15 bg-slate-950/80 px-4 py-2.5 shadow-2xl backdrop-blur-md sm:block">
            <p className="text-[9px] font-semibold uppercase tracking-[0.18em] text-slate-500">Accuracy</p>
            <p className="mt-0.5 text-base font-semibold tabular-nums text-cyan-100">{totalAttempts ? `${accuracy}%` : '—'}</p>
          </div>
          <div className="hidden rounded-2xl border border-cyan-300/15 bg-slate-950/80 px-4 py-2.5 shadow-2xl backdrop-blur-md sm:block">
            <p className="text-[9px] font-semibold uppercase tracking-[0.18em] text-slate-500">Trial</p>
            <p className="mt-0.5 text-base font-semibold tabular-nums text-cyan-100">{trialLabel}</p>
          </div>
          <div
            key={`${visibleStreak}-${totalAttempts}`}
            className={`hidden items-center gap-2 rounded-2xl border px-4 py-2.5 shadow-2xl backdrop-blur-md md:flex ${
              visibleStreak > 0
                ? 'border-amber-300/20 bg-slate-950/80 animate-[pulse_400ms_ease-out_1]'
                : totalAttempts > 0
                  ? 'border-rose-300/20 bg-rose-950/35 animate-[pulse_400ms_ease-out_1]'
                  : 'border-white/10 bg-slate-950/80'
            }`}
          >
            <Zap className={`h-4 w-4 ${visibleStreak > 0 ? 'text-amber-300' : 'text-slate-600'}`} />
            <span className={`font-bold ${visibleStreak > 0 ? 'text-amber-100' : 'text-slate-500'}`}>{visibleStreak}x</span>
          </div>
        </div>
      </header>

      {feedback && (
        <div key={feedback.id} className="pointer-events-none fixed inset-0 z-[105] flex items-center justify-center animate-[pulse_650ms_ease-out_1]">
          <div className={`absolute inset-0 ${
            feedback.correct
              ? 'bg-emerald-400/[0.08] shadow-[inset_0_0_90px_rgba(52,211,153,.28)]'
              : 'bg-rose-500/[0.10] shadow-[inset_0_0_100px_rgba(244,63,94,.3)]'
          }`} />
          <div className={`relative -translate-y-24 flex items-center gap-3 rounded-2xl border bg-slate-950/80 px-6 py-4 shadow-2xl backdrop-blur-md md:-translate-y-28 ${
            feedback.correct
              ? 'border-emerald-300/35 text-emerald-200'
              : 'border-rose-300/35 text-rose-200'
          }`}>
            {feedback.correct ? <CheckCircle2 className="h-7 w-7" /> : <XCircle className="h-7 w-7" />}
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.2em] opacity-70">Obstacle</p>
              <p className="text-xl font-bold">{feedback.correct ? 'Correct' : 'Missed'}</p>
            </div>
          </div>
        </div>
      )}

      <aside className="pointer-events-none fixed right-3 top-24 z-[110] flex max-h-[calc(100vh-7rem)] w-52 flex-col gap-3 overflow-y-auto pb-2 md:right-5 md:top-28 md:w-60">
        <section className="rounded-2xl border border-cyan-300/15 bg-slate-950/80 p-4 shadow-2xl backdrop-blur-md">
          <QteRing state={visibleQteState} />
          <div className="mt-3 border-t border-white/8 pt-3 text-center">
            <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-500">Target Gesture</p>
            <p className="mt-1 text-lg font-semibold text-white">{targetLabel}</p>
          </div>
        </section>
        <EmgTrace points={emgPoints} qteState={visibleQteState} />
        {onSecondary && secondaryLabel && (
          <button type="button" onClick={onSecondary} className="pointer-events-auto self-end rounded-xl border border-white/10 bg-slate-950/80 px-4 py-2 text-xs font-medium text-slate-300 shadow-lg backdrop-blur-md transition hover:bg-white/10 hover:text-white">
            {secondaryLabel}
          </button>
        )}
      </aside>

      <div className="pointer-events-none fixed bottom-4 left-1/2 z-40 -translate-x-1/2 rounded-full border border-white/10 bg-slate-950/65 px-4 py-2 text-[10px] uppercase tracking-[0.16em] text-slate-300 backdrop-blur-md">
        Arrow keys to jump and switch lanes
      </div>
    </div>
  );
}
