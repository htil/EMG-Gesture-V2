import { useEffect, useMemo, useRef, useState } from 'react';
import { Activity, ArrowLeft, CheckCircle2, Heart, XCircle, Zap } from 'lucide-react';
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
import { inferenceWindow, validateOfficialSequence } from './study/evaluationProtocol.mjs';
import type { Gesture } from './pipeline';
import GameGuide from './GameGuide';
import type { TutorialBeat } from '../../game/main.js';

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
  tutorialHeld?: boolean;
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

function arrowHead(tip: { x: number; y: number }, tail: { x: number; y: number }, length = 18) {
  const dx = tip.x - tail.x;
  const dy = tip.y - tail.y;
  const span = Math.hypot(dx, dy) || 1;
  const ux = dx / span;
  const uy = dy / span;
  const px = -uy;
  const py = ux;
  const baseX = tip.x - ux * length;
  const baseY = tip.y - uy * length;
  const wing = length * 0.62;
  return { x2: baseX, y2: baseY, points: `${tip.x},${tip.y} ${baseX + px * wing},${baseY + py * wing} ${baseX - px * wing},${baseY - py * wing}` };
}

function TrackGuideArrows({ points }: { points: Array<{ x: number; y: number }> }) {
  return <svg data-game-track-guide aria-hidden="true" className="pointer-events-none fixed inset-0 z-[155] h-screen w-screen">
    {points.map((tip, index) => {
      const tail = { x: tip.x + (index === 0 ? -1 : 1) * 36, y: tip.y + 78 };
      const head = arrowHead(tip, tail);
      return <g key={index}>
        <line x1={tail.x} y1={tail.y} x2={head.x2} y2={head.y2} stroke="#082f49" strokeWidth="9" strokeLinecap="round" />
        <line x1={tail.x} y1={tail.y} x2={head.x2} y2={head.y2} stroke="#67e8f9" strokeWidth="4" strokeLinecap="round" />
        <polygon points={head.points} fill="#67e8f9" stroke="#082f49" strokeWidth="3" strokeLinejoin="round" />
      </g>;
    })}
  </svg>;
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
  streamActive = points.length > 0,
}: {
  points: EmgDisplayPoint[];
  qteState: GameQteViewState;
  streamActive?: boolean;
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
          <span className={`h-1.5 w-1.5 rounded-full ${streamActive ? 'bg-emerald-400 shadow-[0_0_8px_#34d399]' : 'bg-slate-600'}`} />
          {streamActive ? 'Live' : 'Waiting'}
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


export interface GameScreenProps {
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
  testControls?: boolean;
  practice?: boolean;
  officialSequence?: string[];
  runKind?: 'official' | 'replay' | 'practice';
  /** Caller attests ready model and active LIVE source, never Mock/file/paused. */
  streamReady?: boolean;
  sourceEpoch?: number;
  recoveryReady?: boolean;
  recoveryToken?: string;
  subscribeSourceInterruptions?: (listener: (reason: string) => void) => () => void;
  recoveryControls?: import('react').ReactNode;
  onRunInvalidated?: (reason: string) => void;

  /** Server-verified, fully scoped Practice receipt. Omitted for legacy callers. */
  tutorialPractice?: { status: 'completed' | 'skipped'; scopeKey: string };
}

export default function GameScreen(props: GameScreenProps) {
  const scope = props.tutorialPractice?.scopeKey ?? 'legacy';
  return <GameCoordinator key={`${scope}:${props.runKind ?? 'practice'}`} {...props} />;
}

function GameCoordinator(props: GameScreenProps) {
  const receipt = props.tutorialPractice;
  const hintKey = receipt ? `emg-game-tutorial:${receipt.scopeKey}` : null;
  const [completed, setCompleted] = useState(() => {
    try { return !!hintKey && globalThis.localStorage?.getItem(hintKey) === 'complete'; }
    catch { return false; }
  });
  const needsTutorial = props.runKind === 'official' && receipt?.status === 'completed' && !completed;
  const completeTutorial = () => {
    try { if (hintKey) globalThis.localStorage?.setItem(hintKey, 'complete'); } catch { /* UX hint only; never a receipt. */ }
    setCompleted(true);
  };
  return needsTutorial
    ? <GameRun key="tutorial" {...props} runKind="practice" practice tutorial obstacleCount={8}
        officialSequence={undefined} condition={undefined} onSecondary={undefined} secondaryLabel={undefined}
        onRunInvalidated={undefined} onTutorialComplete={completeTutorial} />
    : <GameRun key="measured" {...props} />;
}

function GameRun({
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
  testControls = true,
  practice = false,
  officialSequence,
  runKind = 'practice',
  streamReady,
  sourceEpoch, recoveryReady, recoveryToken, subscribeSourceInterruptions, recoveryControls,
  onRunInvalidated,
  tutorial = false,
  onTutorialComplete,
}: GameScreenProps & { tutorial?: boolean; onTutorialComplete?: () => void; }) {
  const fixedProtocol = runKind === 'official' || runKind === 'replay';
  const [tutorialBeat, setTutorialBeat] = useState<TutorialBeat | null>(null);
  const [tutorialComplete, setTutorialComplete] = useState(false);
  // Presentation substeps share the existing intro hold: no new recording/run state.
  const [tutorialIntroStep, setTutorialIntroStep] = useState<'timer' | 'lives' | 'track'>('timer');
  const [trackArrowPoints, setTrackArrowPoints] = useState<Array<{ x: number; y: number }>>([]);
  const launchedRef = useRef(false);
  const [sourceHeld, setSourceHeld] = useState(false);
  const sourceHeldRef = useRef(false);
  const heldCalibrationRef = useRef<string | undefined>(undefined);
  const holdSourceRef = useRef<(reason: string) => void>(() => {});
  const readyToLaunch = launchedRef.current || (tutorial ? streamReady === true && !!predictWindow && !!actionGestures : !fixedProtocol || (streamReady === true && !!predictWindow && !!actionGestures
    && validateOfficialSequence(officialSequence)
    && actionGestures.jump.id === 'wrist-up' && actionGestures.switchLane.id === 'wrist-down'));
  const streamReadyRef = useRef(streamReady);
  streamReadyRef.current = streamReady;
  const invalidatedRef = useRef<string | null>(null);
  const startedAtRef = useRef<number | null>(null);
  const recoveryPausesRef = useRef<Array<{ startedAt: number; endedAt: number; reason: string }>>([]);
  const openRecoveryPauseRef = useRef<{ startedAt: number; reason: string } | null>(null);
  const runIdRef = useRef(`${runKind}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`}`);
  const submittedRef = useRef(false);
  const trialMetadataRef = useRef(new Map<string, {trialIndex:number;cueAt:number;latestSampleAt?:number|null;recordingStartedAt?:number|null;recordingEndedAt?:number|null;inferenceStartedAt?:number;inferenceEndedAt?:number;sampleCount?:number}>());
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
  const livesRef = useRef(startingLives);
  const [maxLives, setMaxLives] = useState(startingLives);
  const [correctAttempts, setCorrectAttempts] = useState(0);
  const [totalAttempts, setTotalAttempts] = useState(0);
  const [feedback, setFeedback] = useState<{ correct: boolean; id: number } | null>(null);
  const feedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const emgPointsRef = useRef(emgPoints);
  const predictWindowRef = useRef(predictWindow);
  const actionGesturesRef = useRef(actionGestures);
  const gameModuleRef = useRef<typeof import('../../game/main.js') | null>(null);
  const tutorialHeldRef = useRef(false);
  const recordingStartRef = useRef<number | null>(null);
  const previousQteStatusRef = useRef<QteStatus>('rest');
  const processedEncountersRef = useRef(new Set<string>());
  const completedEncountersRef = useRef(new Set<string>());
  const predictionsRef = useRef(new Map<string, GamePrediction | null>());
  const outcomesRef = useRef<Array<GestureTestOutcome & {trialIndex?:number;cueAt?:number;recordingStartedAt?:number|null;recordingEndedAt?:number|null;inferenceStartedAt?:number;inferenceEndedAt?:number;sampleCount?:number}>>([]);
  const scoreRef = useRef(0);
  const finishRunRef = useRef<(obstacleSuccess?: boolean) => void>(() => {});
  const gameOverStartedRef = useRef(false);

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
    if (!container || !readyToLaunch || invalidatedRef.current) return;
    launchedRef.current = true;
    startedAtRef.current = Date.now();

    let cancelled = false;
    let unmountGame = () => {};
    debugKeyboardEnabledRef.current = testControls && !fixedProtocol;
    setDebugKeyboardEnabled(testControls && !fixedProtocol);
    scoreRef.current = 0;
    outcomesRef.current = [];
    completedEncountersRef.current.clear();
    gameOverStartedRef.current = false;
    processedEncountersRef.current = new Set();
    predictionsRef.current = new Map();
    setLives(startingLives);
    setMaxLives(startingLives);
    setRunnerScore(0);
    setRunnerStreak(0);
    setCorrectAttempts(0);
    setTotalAttempts(0);

    const endRun = (obstacleSuccess: boolean) => {
      if (gameOverStartedRef.current) return;
      gameOverStartedRef.current = true;
      finishRunRef.current(obstacleSuccess);
    };
    const invalidate = (reason: string) => {
      if (invalidatedRef.current || gameOverStartedRef.current) return;
      invalidatedRef.current = reason;
      onRunInvalidated?.(reason);
      endRun(false);
    };

    import('../../game/main.js').then((game) => {
      if (!cancelled) {
        gameModuleRef.current = game;
        unmountGame = game.mountGame(container, {
          runKind,
          tutorial,
          preserveLives: tutorial,
          onTutorialHold: tutorial ? (beat) => { tutorialHeldRef.current = true; setTutorialBeat(beat); } : undefined,
          officialSequence: fixedProtocol && validateOfficialSequence(officialSequence) ? officialSequence : undefined,
          jumpGestureId: actionGesturesRef.current?.jump.id,
          isStreamReady: () => !sourceHeldRef.current && !invalidatedRef.current && (!(fixedProtocol || tutorial) || streamReadyRef.current === true),
          getRecordingProgress: (encounterId, trialIndex) => {
            if (sourceHeldRef.current || (tutorial && tutorialHeldRef.current)) return 0;
            let metadata = trialMetadataRef.current.get(encounterId);
            if (!metadata) {
              metadata = {trialIndex, cueAt: Date.now()};
              trialMetadataRef.current.set(encounterId, metadata);
            }
            const now = Date.now();
            const window = inferenceWindow(emgPointsRef.current, metadata.cueAt, now, metadata.latestSampleAt);
            metadata.latestSampleAt = window.latestAt ?? metadata.latestSampleAt;
            metadata.recordingStartedAt = window.startedAt;
            metadata.recordingEndedAt = window.endedAt;
            metadata.sampleCount = window.points.length;
            const latest = window.latestAt;
            if (fixedProtocol && window.invalidReason) {
              holdSourceRef.current(window.invalidReason);
              return 0;
            }
            if (fixedProtocol && (streamReadyRef.current !== true || (now - metadata.cueAt > 1000 && (!latest || now - latest > 1000)))) {
              holdSourceRef.current('Live signal stopped during evaluation');
              return 0;
            }
            if (!fixedProtocol && now - metadata.cueAt > 5000 && !window.complete) return 1;
            return window.complete ? 1 : Math.min(window.progress, 0.999);
          },
          isDebugKeyboardEnabled: () => debugKeyboardEnabledRef.current,
          obstacleCount,
          startingLives,
          onQteUpdate: (nextState) => {
            if (sourceHeldRef.current) return;
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
              recordingStartRef.current = trialMetadataRef.current.get(nextState.encounterId ?? '')?.cueAt ?? Date.now();
            }

            if (
              nextState.status === 'processing'
              && nextState.encounterId
              && !processedEncountersRef.current.has(nextState.encounterId)
            ) {
              processedEncountersRef.current.add(nextState.encounterId);
              const metadata = trialMetadataRef.current.get(nextState.encounterId);
              const window = inferenceWindow(emgPointsRef.current, metadata?.cueAt ?? recordingStartRef.current ?? Date.now(), Date.now(), metadata?.latestSampleAt);
              if (fixedProtocol && (invalidatedRef.current || window.invalidReason || streamReadyRef.current !== true)) {
                holdSourceRef.current(window.invalidReason ?? 'Live signal stopped during evaluation');
                return;
              }
              if (metadata) metadata.inferenceStartedAt = Date.now();
              let prediction: GamePrediction | null = null;
              try { prediction = window.complete ? predictWindowRef.current?.(window.points) ?? null : null; }
              catch { prediction = null; }
              if (metadata) metadata.inferenceEndedAt = Date.now();
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
          onObstacleResult: ({ correct, encounterId, expectedAction, trialIndex }) => {
            if (sourceHeldRef.current) return;
            const indexed = typeof trialIndex === 'number' && Number.isInteger(trialIndex) && trialIndex > 0;
            if (indexed
              ? outcomesRef.current.some(outcome => outcome.trialIndex === trialIndex)
              : completedEncountersRef.current.has(encounterId)) return;
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
              completedEncountersRef.current.add(encounterId);
              outcomesRef.current.push({
                ...trialMetadataRef.current.get(encounterId),
                trialIndex,
                attemptId: `${runIdRef.current}:${trialIndex ?? outcomesRef.current.length + 1}`,
                expectedGestureId: expectedGesture.id,
                expectedGestureName: expectedGesture.name,
                result: recognitionResult(expectedGesture.id, prediction),
                predictedGestureId: prediction?.predictedGestureId ?? null,
                predictedGestureName: prediction?.predictedGestureName ?? null,
              });
            }
          },
          onLivesChange: (nextLives, nextMaxLives) => {
            livesRef.current = nextLives;
            setLives(nextLives);
            setMaxLives(nextMaxLives);
          },
          onGameOver: () => endRun(false),
          onRunComplete: () => tutorial ? setTutorialComplete(true) : endRun(livesRef.current > 0),
        });
      }
    });

    return () => {
      cancelled = true;
      unmountGame();
      if (tutorial && streamReadyRef.current === false) onExit();
      if (fixedProtocol && !gameOverStartedRef.current) invalidate(streamReadyRef.current === false ? 'Live signal stopped during evaluation' : 'Evaluation exited before all trials completed');
      debugKeyboardEnabledRef.current = testControls;
      gameModuleRef.current = null;
      if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current);
    };
  }, [obstacleCount, startingLives, testControls, readyToLaunch]);

  holdSourceRef.current = (reason) => {
    if (!launchedRef.current || sourceHeldRef.current || gameOverStartedRef.current) return;
    openRecoveryPauseRef.current = { startedAt: Math.max(startedAtRef.current ?? Date.now(), Date.now()), reason };
    heldCalibrationRef.current = recoveryToken;
    sourceHeldRef.current = true;
    gameModuleRef.current?.holdForSourceRecovery();
    setSourceHeld(true);
  };
  useEffect(() => subscribeSourceInterruptions?.(reason => holdSourceRef.current(reason)), [subscribeSourceInterruptions]);
  const previousEpochRef = useRef(sourceEpoch);
  useEffect(() => {
    if (streamReady === false || previousEpochRef.current !== sourceEpoch) holdSourceRef.current('Source changed');
    previousEpochRef.current = sourceEpoch;
  }, [streamReady, sourceEpoch]);

  const watchdogBoundaryRef = useRef(Date.now());
  useEffect(() => {
    if (!(fixedProtocol || tutorial)) return;
    const timer = setInterval(() => {
      if (!launchedRef.current || sourceHeldRef.current || gameOverStartedRef.current) return;
      const now = Date.now();
      const window = inferenceWindow(emgPointsRef.current, watchdogBoundaryRef.current, now);
      if (window.invalidReason || (now - watchdogBoundaryRef.current > 1000 && (window.latestAt === null || now - window.latestAt > 1000))) {
        holdSourceRef.current(window.invalidReason ?? 'No fresh live signal');
      }
    }, 100);
    return () => clearInterval(timer);
  }, [fixedProtocol, tutorial]);
  useEffect(() => {
    if (!tutorial || tutorialComplete || tutorialBeat !== 'intro' || tutorialIntroStep !== 'track') return;
    let frame = 0;
    const tick = () => {
      const next = gameModuleRef.current?.closestRecordingZoneScreenPoints() ?? [];
      setTrackArrowPoints(current => current.length === next.length && current.every((point, index) => point.x === next[index].x && point.y === next[index].y) ? current : next);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [tutorial, tutorialComplete, tutorialBeat, tutorialIntroStep]);

  const visibleQteState = qteState ?? runnerQteState;
  const visibleScore = score ?? runnerScore;
  const visibleStreak = streak ?? runnerStreak;
  const accuracy = totalAttempts > 0 ? Math.round((correctAttempts / totalAttempts) * 100) : 0;
  const targetLabel = visibleQteState.targetGestureName || 'Stand by';
  const trialLabel = visibleQteState.trialIndex && visibleQteState.trialCount
    ? `${visibleQteState.trialIndex} / ${visibleQteState.trialCount}`
    : '—';

  const finishRun = (obstacleSuccess?: boolean) => {
    if (tutorial) return;
    if (submittedRef.current) return;
    const complete = !invalidatedRef.current && (fixedProtocol ? outcomesRef.current.length === 20 : typeof obstacleSuccess === 'boolean');
    const endedAt = Date.now();
    const sourceRecoveryPauses = [...recoveryPausesRef.current];
    if (openRecoveryPauseRef.current) sourceRecoveryPauses.push({ ...openRecoveryPauseRef.current, endedAt: Math.max(openRecoveryPauseRef.current.startedAt, endedAt) });
    const activeDurationMs = Math.max(0, endedAt - (startedAtRef.current ?? endedAt) - sourceRecoveryPauses.reduce((sum, pause) => sum + pause.endedAt - pause.startedAt, 0));
    const payload = {
      runKind,
      runId: runIdRef.current,
      officialSequence: fixedProtocol && validateOfficialSequence(officialSequence) ? officialSequence : undefined,
      completionStatus: complete ? 'complete' as const : 'incomplete' as const,
      invalidationReason: invalidatedRef.current ?? (complete ? null : 'Run exited before completion'),
      startedAt: startedAtRef.current ?? undefined,
      endedAt,
      activeDurationMs,
      sourceRecoveryPauses,
      condition: condition!,
      difficulty: DEFAULT_DIFFICULTY,
      gameScore: score ?? scoreRef.current,
      outcomes: [...outcomesRef.current],
      obstacleSuccess: complete && typeof obstacleSuccess === 'boolean' ? obstacleSuccess : null,
    };
    if (condition) {
      submittedRef.current = true;
      const submitted = submitGameRun(payload);
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
      {sourceHeld && <section role="alert" aria-label="Game signal recovery" className="fixed inset-0 z-[200] overflow-auto bg-slate-950/95 p-8">
        <h2>Game held — reconnect, then redo resting setup</h2>
        <p>Completed trials and the current model are kept. The interrupted cue will restart, not count as a wrong prediction. Do not reload.</p>
        {recoveryControls}
        <button type="button" disabled={streamReady !== true || recoveryReady !== true || recoveryToken === heldCalibrationRef.current} onClick={() => {
          if (streamReadyRef.current !== true || recoveryReady !== true || recoveryToken === heldCalibrationRef.current) return;
          for (const [id, metadata] of trialMetadataRef.current) {
            if (!outcomesRef.current.some(outcome => outcome.trialIndex === metadata.trialIndex)) {
              trialMetadataRef.current.delete(id); processedEncountersRef.current.delete(id); predictionsRef.current.delete(id);
            }
          }
          if (openRecoveryPauseRef.current) {
            recoveryPausesRef.current.push({ ...openRecoveryPauseRef.current, endedAt: Math.max(openRecoveryPauseRef.current.startedAt, Date.now()) });
            openRecoveryPauseRef.current = null;
          }
          watchdogBoundaryRef.current = Date.now();
          recordingStartRef.current = null; previousQteStatusRef.current = 'rest';
          gameModuleRef.current?.resumeAfterSourceRecovery();
          sourceHeldRef.current = false; setSourceHeld(false);
        }}>Resume same run</button>
      </section>}
      {!readyToLaunch && <p role="alert" className="fixed inset-x-0 top-1/2 z-[120] text-center text-rose-200">Evaluation requires a ready model, active live stream, and valid saved 20-trial sequence.</p>}
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
            {practice && <p className="mt-1 text-sm font-semibold text-cyan-200">{tutorial ? 'Tutorial — unscored · current frozen model · 8 obstacles' : 'Practice — separate model'}</p>}
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
            <p className="text-[9px] font-semibold uppercase tracking-[0.18em] text-slate-500">Game accuracy</p>
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
        <section data-game-guide-target="timer" className="rounded-2xl border border-cyan-300/15 bg-slate-950/80 p-4 shadow-2xl backdrop-blur-md">
          <QteRing state={visibleQteState} />
          <div className="mt-3 border-t border-white/8 pt-3 text-center">
            <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-500">Target Gesture</p>
            <p className="mt-1 text-lg font-semibold text-white">{targetLabel}</p>
          </div>
        </section>
        <EmgTrace points={emgPoints} qteState={visibleQteState} streamActive={fixedProtocol ? streamReady === true && !invalidatedRef.current : undefined} />
        {onSecondary && secondaryLabel && (
          <button type="button" onClick={() => finishRun()} className="pointer-events-auto self-end rounded-xl border border-white/10 bg-slate-950/80 px-4 py-2 text-xs font-medium text-slate-300 shadow-lg backdrop-blur-md transition hover:bg-white/10 hover:text-white">
            {secondaryLabel}
          </button>
        )}
      </aside>

      {tutorial && (tutorialBeat || tutorialComplete) && <GameGuide
        centered={tutorialComplete || tutorialBeat !== 'intro'}
        dock={!tutorialComplete && tutorialBeat === 'intro' && tutorialIntroStep === 'track' ? 'top' : undefined}
        target={!tutorialComplete && tutorialBeat === 'intro' && tutorialIntroStep !== 'track' ? `[data-game-guide-target="${tutorialIntroStep}"]` : undefined}
        body={tutorialComplete ? 'Practice complete. Next starts the 20-trial evaluation.'
          : tutorialBeat === 'intro' ? tutorialIntroStep === 'timer' ? "This timer displays Rest and Recording. Stay ready."
            : tutorialIntroStep === 'lives' ? 'Lives are tracked here. Missed obstacles cost a life during the evaluation.'
            : 'When you enter the red portion of the track, perform and hold the gesture.'
          : tutorialBeat === 'wrist-up' ? 'Wrist up jumps over hurdles. Select Next, then perform the gesture.'
          : tutorialBeat === 'wrist-down' ? 'Wrist down switches lanes. Select Next, then perform the gesture.'
          : 'Continue the practice run. Mistakes here do not cost lives.'}
        onNext={() => {
          if (tutorialComplete) { onTutorialComplete?.(); return; }
          if (tutorialBeat === 'intro' && tutorialIntroStep === 'timer') { setTutorialIntroStep('lives'); return; }
          if (tutorialBeat === 'intro' && tutorialIntroStep === 'lives') { setTutorialIntroStep('track'); return; }
          tutorialHeldRef.current = false;
          setTutorialBeat(null);
          gameModuleRef.current?.releaseTutorialHold();
        }} />}
      {tutorial && !tutorialComplete && tutorialBeat === 'intro' && tutorialIntroStep === 'track' && <TrackGuideArrows points={trackArrowPoints} />}
      <button
        type="button"
        onClick={() => fixedProtocol ? finishRun() : onExit()}
        className={`pointer-events-auto fixed bottom-4 left-4 ${tutorial ? 'z-[170]' : 'z-[110]'} rounded-2xl border border-cyan-300/15 bg-slate-950/80 p-2.5 text-slate-300 shadow-2xl backdrop-blur-md transition hover:bg-white/10 hover:text-white md:left-5`}
        aria-label={exitLabel}
        title={exitLabel}
      >
        <ArrowLeft className="h-4 w-4" />
      </button>

      {testControls && !fixedProtocol && <div className="pointer-events-auto fixed bottom-4 left-1/2 z-[110] -translate-x-1/2 rounded-2xl border border-white/10 bg-slate-950/80 px-4 py-2 text-xs text-slate-300 backdrop-blur-md">
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
    </div>
  );
}
