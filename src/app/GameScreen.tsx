import { useEffect, useMemo, useRef, useState } from 'react';
import { Activity, ArrowLeft, CheckCircle2, Heart, XCircle, Zap } from 'lucide-react';
import GameGuide from './GameGuide';
import {
  DEFAULT_OBSTACLE_COUNT,
  DEFAULT_STARTING_LIVES,
} from './study/api';
import {
  DEFAULT_DIFFICULTY,
  submitGameRun,
  type GestureTestOutcome,
} from './study/gameHandoff';
import { recognitionResult } from './study/recognition';
import type { Gesture } from './pipeline';

export type QteStatus = 'rest' | 'ready' | 'recording' | 'processing' | 'complete';

export interface GameQteViewState {
  status: QteStatus;
  /** Progress through the current phase, from 0 to 1. */
  progress: number;
  targetGestureName?: string | null;
  resultLabel?: string | null;
  trialIndex?: number;
  trialCount?: number;
  encounterId?: string;
  expectedAction?: RunnerAction;
  switchDirection?: number;
}

type RunnerAction = 'jump' | 'switch-lane';

interface EmgDisplayPoint {
  time: number;
  normalizedActivity?: number;
  value?: number;
  raw?: number;
}

interface GamePrediction {
  predictedGestureId: string;
  predictedGestureName: string;
  confidence: number;
}

const TUTORIAL_OBSTACLE_COUNT = 10;
type TutorialGuide = 'intro' | 'lives' | 'wrist-up' | 'wrist-down' | 'farewell' | 'complete';

const TUTORIAL_COPY: Record<TutorialGuide, string> = {
  intro: "Now it's time to test our model! This timer will display your 'Rest' period and 'Recording' period. Stay ready, it moves fast!",
  lives: 'Your lives will be tracked here. Each incorrect gesture will cause you to lose a life during the actual trial. Try to make it to the end without losing them all.',
  'wrist-up': 'Now that the Rest period has passed, it\'s time to perform your first gesture. To jump over the hurdles, you will use the \'Wrist Up\' gesture. When you\'re ready, click "Next" and immediately perform the gesture!',
  'wrist-down': 'It\'s time for your other gesture. Use \'Wrist Down\' to dodge the incoming player. When you\'re ready, click "Next" and immediately perform the gesture!',
  farewell: 'Great job! The rest of this run will be a practice round. Remember that when the timer reads \'Recording\' it\'s time to perform your gesture. When you\'re ready, click "Next" to continue on your own!',
  complete: "Your practice round is complete! Click 'Next' to continue on to the real deal. Good luck!",
};

function tutorialStorageKey(key: string) {
  return `emg-game-tutorial:${key}`;
}

function tutorialStillPending(key?: string) {
  if (!key) return false;
  try {
    return localStorage.getItem(tutorialStorageKey(key)) !== 'done';
  } catch {
    return false;
  }
}

function markTutorialDone(key?: string) {
  if (!key) return;
  try {
    localStorage.setItem(tutorialStorageKey(key), 'done');
  } catch {
    // The practice run can still hand off to the recorded game in this tab.
  }
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
      <div data-game-guide-target="timer" className="relative h-40 w-40">
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
  const visibleEnd = points[points.length - 1]?.time ?? Date.now();
  const visibleStart = visibleEnd - 4000;
  const visiblePoints = useMemo(
    () => points.filter((point) => point.time >= visibleStart),
    [points, visibleStart],
  );

  const path = useMemo(() => {
    if (visiblePoints.length < 2) return '';
    return visiblePoints.map((point, index) => {
      const activity = Math.max(0, Math.min(1, point.value ?? 0));
      const x = ((point.time - visibleStart) / 4000) * 300;
      const y = 58 - activity * 48;
      return `${index === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
    }).join(' ');
  }, [visiblePoints, visibleStart]);

  const latest = points[points.length - 1];
  const activity = Math.max(0, Math.min(1, latest?.value ?? 0));

  if (qteState.status === 'recording' && previousStatusRef.current !== 'recording') {
    captureStartRef.current = latest?.time ?? null;
    captureEndRef.current = null;
  } else if (qteState.status !== 'recording' && previousStatusRef.current === 'recording') {
    captureEndRef.current = latest?.time ?? captureStartRef.current;
  }
  previousStatusRef.current = qteState.status;

  const captureStart = captureStartRef.current;
  const captureEnd = qteState.status === 'recording'
    ? latest?.time ?? captureStart
    : captureEndRef.current;
  const captureX1 = captureStart !== null
    ? Math.max(0, Math.min(300, ((captureStart - visibleStart) / 4000) * 300))
    : 0;
  const captureX2 = captureEnd !== null && captureEnd !== undefined
    ? Math.max(0, Math.min(300, ((captureEnd - visibleStart) / 4000) * 300))
    : captureX1;
  const showCapture = captureStart !== null
    && captureEnd !== null
    && captureEnd !== undefined
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
  actionGestures,
  predictWindow,
  condition,
  obstacleCount = DEFAULT_OBSTACLE_COUNT,
  startingLives = DEFAULT_STARTING_LIVES,
  tutorialKey,
  testControls = true,
  practice = false,
}: {
  onExit: () => void;
  exitLabel?: string;
  onSecondary?: () => void;
  secondaryLabel?: string;
  score?: number;
  streak?: number;
  qteState?: GameQteViewState;
  emgPoints?: EmgDisplayPoint[];
  actionGestures?: { jump: Gesture; switchLane: Gesture };
  predictWindow?: (points: Array<{ time: number; raw: number }>) => GamePrediction | null;
  condition?: 'button' | 'threshold';
  obstacleCount?: number;
  startingLives?: number;
  tutorialKey?: string;
  testControls?: boolean;
  practice?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [debugKeyboardEnabled, setDebugKeyboardEnabled] = useState(true);
  const debugKeyboardEnabledRef = useRef(true);
  const [runnerQteState, setRunnerQteState] = useState<GameQteViewState>({
    status: 'rest',
    progress: 0,
    targetGestureName: 'Jump',
    trialIndex: 1,
    trialCount: obstacleCount,
  });
  const [runnerScore, setRunnerScore] = useState(0);
  const [runnerStreak, setRunnerStreak] = useState(0);
  const [lives, setLives] = useState(startingLives);
  const [maxLives, setMaxLives] = useState(startingLives);
  const [correctAttempts, setCorrectAttempts] = useState(0);
  const [totalAttempts, setTotalAttempts] = useState(0);
  const [feedback, setFeedback] = useState<{ correct: boolean; id: number } | null>(null);
  const feedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const emgPointsRef = useRef(emgPoints);
  const predictWindowRef = useRef(predictWindow);
  const actionGesturesRef = useRef(actionGestures);
  const gameModuleRef = useRef<typeof import('../../game/main.js') | null>(null);
  const recordingStartRef = useRef<number | null>(null);
  const previousQteStatusRef = useRef<QteStatus>('rest');
  const processedEncountersRef = useRef(new Set<string>());
  const predictionsRef = useRef(new Map<string, GamePrediction | null>());
  const outcomesRef = useRef<GestureTestOutcome[]>([]);
  const scoreRef = useRef(0);
  const finishRunRef = useRef<(obstacleSuccess?: boolean) => void>(() => {});
  const gameOverStartedRef = useRef(false);
  const [runKind, setRunKind] = useState<'tutorial' | 'live'>(() => tutorialStillPending(tutorialKey) ? 'tutorial' : 'live');
  const [guideBeat, setGuideBeat] = useState<TutorialGuide | null>(runKind === 'tutorial' ? 'intro' : null);
  const [holdReady, setHoldReady] = useState(false);
  const runKindRef = useRef(runKind);
  runKindRef.current = runKind;

  useEffect(() => {
    emgPointsRef.current = emgPoints;
  }, [emgPoints]);

  useEffect(() => {
    predictWindowRef.current = predictWindow;
  }, [predictWindow]);

  useEffect(() => {
    actionGesturesRef.current = actionGestures;
  }, [actionGestures]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let cancelled = false;
    let unmountGame = () => {};
    debugKeyboardEnabledRef.current = testControls;
    setDebugKeyboardEnabled(testControls);
    scoreRef.current = 0;
    outcomesRef.current = [];
    gameOverStartedRef.current = false;
    processedEncountersRef.current = new Set();
    predictionsRef.current = new Map();
    setLives(startingLives);
    setMaxLives(startingLives);
    setRunnerScore(0);
    setRunnerStreak(0);
    setCorrectAttempts(0);
    setTotalAttempts(0);

    const tutorial = runKind === 'tutorial';

    const endRun = (obstacleSuccess: boolean) => {
      if (gameOverStartedRef.current) return;
      gameOverStartedRef.current = true;
      finishRunRef.current(obstacleSuccess);
    };

    import('../../game/main.js').then((game) => {
      if (!cancelled) {
        gameModuleRef.current = game;
        if (tutorial) {
          setGuideBeat('intro');
          setHoldReady(false);
        }
        unmountGame = game.mountGame(container, {
          isDebugKeyboardEnabled: () => debugKeyboardEnabledRef.current,
          obstacleCount: tutorial ? TUTORIAL_OBSTACLE_COUNT : obstacleCount,
          startingLives,
          tutorial,
          preserveLives: tutorial,
          onQteUpdate: (nextState) => {
            const gestures = actionGesturesRef.current;
            const expectedGesture = nextState.expectedAction === 'switch-lane'
              ? gestures?.switchLane
              : gestures?.jump;
            const displayState = {
              ...nextState,
              targetGestureName: expectedGesture?.name ?? nextState.targetGestureName,
            };

            if (
              nextState.status === 'recording'
              && previousQteStatusRef.current !== 'recording'
            ) {
              const points = emgPointsRef.current;
              recordingStartRef.current = points[points.length - 1]?.time ?? Date.now();
            }

            if (
              nextState.status === 'processing'
              && nextState.encounterId
              && !processedEncountersRef.current.has(nextState.encounterId)
            ) {
              processedEncountersRef.current.add(nextState.encounterId);
              const startedAt = recordingStartRef.current ?? 0;
              const inferencePoints = emgPointsRef.current
                .filter((point) => point.time >= startedAt && typeof point.raw === 'number')
                .map((point) => ({ time: point.time, raw: point.raw as number }));
              const prediction = predictWindowRef.current?.(inferencePoints) ?? null;
              predictionsRef.current.set(nextState.encounterId, prediction);

              if (prediction && gestures) {
                if (prediction.predictedGestureId === gestures.jump.id) {
                  game.queueGestureAction('jump', 0, nextState.encounterId);
                } else if (
                  prediction.predictedGestureId === gestures.switchLane.id
                  && nextState.switchDirection
                ) {
                  game.queueGestureAction('switch-lane', nextState.switchDirection, nextState.encounterId);
                }
              }

              displayState.resultLabel = prediction
                ? `Predicted ${prediction.predictedGestureName} · ${prediction.confidence.toFixed(0)}%`
                : 'No usable prediction';
            } else if (nextState.status === 'processing' && nextState.encounterId) {
              const prediction = predictionsRef.current.get(nextState.encounterId);
              displayState.resultLabel = prediction
                ? `Predicted ${prediction.predictedGestureName} · ${prediction.confidence.toFixed(0)}%`
                : 'No usable prediction';
            }

            previousQteStatusRef.current = nextState.status;
            setRunnerQteState(displayState);
          },
          onObstacleResult: ({ correct, encounterId, expectedAction }) => {
            setTotalAttempts((current) => current + 1);
            setFeedback({ correct, id: Date.now() });
            if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current);
            feedbackTimerRef.current = setTimeout(() => setFeedback(null), 850);
            if (correct) {
              scoreRef.current += 100;
              setCorrectAttempts((current) => current + 1);
              setRunnerScore(scoreRef.current);
              setRunnerStreak((current) => current + 1);
            } else {
              setRunnerStreak(0);
            }

            const gestures = actionGesturesRef.current;
            const expectedGesture = expectedAction === 'switch-lane'
              ? gestures?.switchLane
              : gestures?.jump;
            const prediction = predictionsRef.current.get(encounterId) ?? null;
            if (expectedGesture && !tutorial) {
              outcomesRef.current.push({
                attemptId: encounterId,
                expectedGestureId: expectedGesture.id,
                expectedGestureName: expectedGesture.name,
                result: recognitionResult(expectedGesture.id, prediction),
                predictedGestureId: prediction?.predictedGestureId ?? null,
                predictedGestureName: prediction?.predictedGestureName ?? null,
              });
            }
          },
          onLivesChange: (nextLives, nextMaxLives) => {
            setLives(nextLives);
            setMaxLives(nextMaxLives);
          },
          onGameOver: () => {
            if (tutorial) {
              setGuideBeat('complete');
              setHoldReady(true);
              return;
            }
            endRun(false);
          },
          onRunComplete: () => {
            if (tutorial) {
              setGuideBeat('complete');
              setHoldReady(true);
              return;
            }
            endRun(true);
          },
          onTutorialHold: (beat) => {
            setGuideBeat(beat);
            setHoldReady(true);
          },
        });
      }
    });

    return () => {
      cancelled = true;
      unmountGame();
      debugKeyboardEnabledRef.current = testControls;
      gameModuleRef.current = null;
      if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current);
    };
  }, [obstacleCount, runKind, startingLives, testControls]);

  const visibleQteState = qteState ?? runnerQteState;
  const visibleScore = score ?? runnerScore;
  const visibleStreak = streak ?? runnerStreak;
  const accuracy = totalAttempts > 0 ? Math.round((correctAttempts / totalAttempts) * 100) : 0;
  const targetLabel = visibleQteState.targetGestureName || 'Stand by';
  const trialLabel = visibleQteState.trialIndex && visibleQteState.trialCount
    ? `${visibleQteState.trialIndex} / ${visibleQteState.trialCount}`
    : '—';

  const advanceGuide = () => {
    if (guideBeat === 'complete') {
      markTutorialDone(tutorialKey);
      setGuideBeat(null);
      setRunKind('live');
      return;
    }
    if (guideBeat === 'intro') {
      setGuideBeat('lives');
      return;
    }
    gameModuleRef.current?.releaseTutorialHold();
    setGuideBeat(null);
    setHoldReady(false);
  };

  const finishRun = (obstacleSuccess?: boolean) => {
    if (runKind !== 'live') return;
    if (condition) {
      const submitted = submitGameRun({
        condition,
        difficulty: DEFAULT_DIFFICULTY,
        gameScore: score ?? scoreRef.current,
        outcomes: [...outcomesRef.current],
        obstacleSuccess: typeof obstacleSuccess === 'boolean' ? obstacleSuccess : null,
      });
      if (submitted) return;
    }
    if (onSecondary) {
      onSecondary();
      return;
    }
    onExit();
  };
  finishRunRef.current = finishRun;

  return (
    <div className="fixed inset-0 z-[100] overflow-hidden bg-slate-950 text-white">
      <div ref={containerRef} className="h-full w-full" />
      <div className="pointer-events-none fixed inset-0 z-40 bg-[linear-gradient(180deg,rgba(2,6,23,.76)_0%,transparent_25%,transparent_72%,rgba(2,6,23,.62)_100%)]" />

      <header className="pointer-events-none fixed inset-x-0 top-0 z-[110] flex items-start justify-between gap-3 p-3 md:p-5">
        <div className="flex items-stretch gap-2">
          <div data-game-guide-target="lives" className="rounded-2xl border border-rose-300/20 bg-slate-950/80 px-3 py-2.5 shadow-2xl backdrop-blur-md md:px-4" aria-live="polite">
            <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-rose-300">Lives</p>
            <div className="mt-1 flex max-w-36 flex-wrap items-center gap-1" role="img" aria-label={`${lives} of ${maxLives} lives remaining`}>
              {Array.from({ length: maxLives }, (_, index) => (
                <Heart
                  key={index}
                  className={`h-4 w-4 ${index < lives ? 'fill-rose-400 text-rose-300 drop-shadow-[0_0_6px_rgba(251,113,133,.75)]' : 'text-slate-600'}`}
                />
              ))}
            </div>
          </div>
          <div className="rounded-2xl border border-cyan-300/15 bg-slate-950/80 px-3 py-2.5 shadow-2xl backdrop-blur-md md:px-4">
            <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-cyan-300">EMG Gesture</p>
            <p className="text-sm font-semibold text-white">Neural Runner</p>
            {practice && <p className="mt-1 text-sm font-semibold text-cyan-200">Practice — separate model</p>}
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
            <p className="text-[9px] font-semibold uppercase tracking-[0.18em] text-slate-500">Obstacle</p>
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
        {runKind === 'live' && onSecondary && secondaryLabel && (
          <button type="button" onClick={() => finishRun()} className="pointer-events-auto self-end rounded-xl border border-white/10 bg-slate-950/80 px-4 py-2 text-xs font-medium text-slate-300 shadow-lg backdrop-blur-md transition hover:bg-white/10 hover:text-white">
            {secondaryLabel}
          </button>
        )}
      </aside>

      <button
        type="button"
        onClick={onExit}
        className="pointer-events-auto fixed bottom-4 left-4 z-[110] rounded-2xl border border-cyan-300/15 bg-slate-950/80 p-2.5 text-slate-300 shadow-2xl backdrop-blur-md transition hover:bg-white/10 hover:text-white md:left-5"
        aria-label={exitLabel}
        title={exitLabel}
      >
        <ArrowLeft className="h-4 w-4" />
      </button>

      {testControls && <div className="pointer-events-auto fixed bottom-4 left-1/2 z-[110] -translate-x-1/2 rounded-2xl border border-white/10 bg-slate-950/80 px-4 py-2 text-xs text-slate-300 backdrop-blur-md">
        <label className="flex cursor-pointer items-center justify-center gap-2">
          <input
            type="checkbox"
            checked={debugKeyboardEnabled}
            onChange={(event) => {
              debugKeyboardEnabledRef.current = event.target.checked;
              setDebugKeyboardEnabled(event.target.checked);
            }}
            className="accent-cyan-400"
          />
          Debug keyboard controls
        </label>
        <p className="mt-1 text-center text-[10px] text-slate-400">
          {debugKeyboardEnabled ? 'Arrow keys: jump / switch lanes · not EMG validation' : 'Arrow keys off · gesture recognition unchanged'}
        </p>
      </div>}
      {guideBeat && (
        <GameGuide
          body={TUTORIAL_COPY[guideBeat]}
          centered={guideBeat === 'complete'}
          target={guideBeat === 'lives' ? '[data-game-guide-target="lives"]' : '[data-game-guide-target="timer"]'}
          nextDisabled={guideBeat !== 'complete' && !holdReady}
          onNext={advanceGuide}
        />
      )}
    </div>
  );
}
