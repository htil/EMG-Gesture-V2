import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import {
  Activity,
  ArrowRight,
  Check,
  CircleDot,
  Hand,
  Pause,
  Play,
  Radio,
  Trash2,
  Waves,
} from 'lucide-react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from 'recharts';
import { buildInferenceSample, DEFAULT_GESTURES, getChannelMockSignalValue } from '../pipeline';
import { useGestureRecorder, type CaptureTriggerMode } from '../useGestureRecorder';
import { useSignalSource, type SignalPoint, type SignalSourceMode } from '../useSignalSource';
import {
  isModelReady,
  getConditionPredictionEngine,
  markDatasetChanged,
  trainConditionModel,
  type ConditionModelState,
  type ModelStatus,
} from './conditionTraining';
import GameScreen from '../GameScreen';
import DarkSelect from './DarkSelect';
import { DEFAULT_DIFFICULTY, registerGameRunListener, type StoredGameRun } from './gameHandoff';
import ResultsPanel from './ResultsPanel';
import { gestureQuotas, keptForGesture, sampleNumber, samplesComplete } from './samplePlan';
import { alignWaveform, sharedWaveDomain, type WaveDomain } from './waveScale';
import {
  clearClientSession,
  loadClientSession,
  saveClientSession,
  saveGameRun,
  saveRound,
  type Assignment,
  type ClientSession,
  type FlowStage,
  type StoredTrial,
  type StudyStage,
} from './api';

const DISPLAY_WINDOW_MS = 5000;
const SEGMENT_DURATION_MS = 1200;
const ACTIVITY_GUIDE = 0.6;

const FLOW: FlowStage[] = ['capture', 'review', 'game', 'results'];

const STEPS: Array<{ id: FlowStage; label: string; detail: string }> = [
  { id: 'capture', label: 'Capture', detail: 'Record the gesture' },
  { id: 'review', label: 'Review', detail: 'Inspect each signal' },
  { id: 'game', label: 'Play', detail: 'Use the captures' },
  { id: 'results', label: 'Results', detail: 'Score and recognition' },
];

function flowIndex(stage: StudyStage) {
  if (stage === 'done') return FLOW.length - 1;
  return Math.max(0, FLOW.indexOf(stage));
}

function calculateMetrics(points: Array<{ time: number; value: number }>) {
  if (points.length === 0) return { rms: 0, peak: 0, range: 0, durationMs: 0 };
  const values = points.map((point) => point.value);
  const rms = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length);
  return {
    rms,
    peak: Math.max(...values.map((value) => Math.abs(value))),
    range: Math.max(...values) - Math.min(...values),
    durationMs: Math.max(0, points[points.length - 1].time - points[0].time),
  };
}

function StepMap({
  stage,
  round,
  repetitions,
  reachedIndex,
  canVisit,
  onSelect,
}: {
  stage: StudyStage;
  round: number;
  repetitions: number;
  reachedIndex: number;
  canVisit: (stage: FlowStage) => boolean;
  onSelect: (stage: FlowStage) => void;
}) {
  const activeIndex = stage === 'done' ? STEPS.length : STEPS.findIndex((step) => step.id === stage);
  return (
    <section className="rounded-[28px] border border-white/10 bg-slate-950/55 p-4 md:p-6" aria-label="Session steps">
      <div className="mb-4 flex items-end justify-between gap-3">
        <div>
          <p className="text-[10px] font-medium uppercase tracking-[0.2em] text-cyan-300/80">Round {round} of {repetitions}</p>
          <h1 className="mt-1 text-2xl font-light text-white">Capture, review, play, then see results</h1>
        </div>
      </div>
      <ol className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {STEPS.map((step, index) => {
          const active = index === activeIndex;
          const available = stage !== 'done' && canVisit(step.id);
          const visited = stage === 'done' || (index <= reachedIndex && !active);
          return (
            <li key={step.id}>
              <button
                type="button"
                disabled={!available || active}
                onClick={() => onSelect(step.id)}
                className={`flex w-full items-center gap-3 rounded-2xl border px-4 py-4 text-left transition disabled:cursor-default ${
                  active
                    ? 'border-cyan-300/40 bg-cyan-300/10'
                    : available
                      ? 'border-white/10 bg-white/[0.03] hover:bg-white/[0.06]'
                      : 'border-white/8 bg-transparent opacity-45'
                }`}
              >
                <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-medium ${
                  active ? 'bg-cyan-300 text-slate-950' : visited ? 'bg-emerald-300/15 text-emerald-200' : 'border border-white/10 text-slate-500'
                }`}>
                  {visited ? <Check className="h-4 w-4" /> : String(index + 1).padStart(2, '0')}
                </span>
                <span>
                  <span className="block text-sm font-medium text-white">{step.label}</span>
                  <span className="block text-xs text-slate-500">{step.detail}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function CaptureCounter({
  isRecording,
  recordingProgress,
}: {
  isRecording: boolean;
  recordingProgress: number;
}) {
  const radius = 26;
  const circumference = 2 * Math.PI * radius;
  const secondsRemaining = Math.max(0, (SEGMENT_DURATION_MS - Math.round(recordingProgress * SEGMENT_DURATION_MS)) / 1000);
  const dashOffset = isRecording ? circumference * (1 - recordingProgress) : circumference;

  return (
    <div className={`relative flex h-16 w-16 items-center justify-center rounded-full border bg-slate-950/80 ${isRecording ? 'border-cyan-300/40' : 'border-white/10 opacity-40'}`}>
      <svg className="absolute inset-0 -rotate-90" viewBox="0 0 64 64" aria-hidden="true">
        <circle cx="32" cy="32" r={radius} fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth="4" />
        <circle
          cx="32"
          cy="32"
          r={radius}
          fill="none"
          stroke={isRecording ? '#22d3ee' : 'rgba(255,255,255,0.18)'}
          strokeWidth="4"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
        />
      </svg>
      <div className="relative text-center">
        <div className={`text-xs font-medium tabular-nums ${isRecording ? 'text-cyan-200' : 'text-slate-500'}`}>
          {isRecording ? `${Math.ceil(secondsRemaining * 10) / 10}s` : '--'}
        </div>
        <div className="text-[10px] text-slate-500">{isRecording ? `${Math.round(recordingProgress * 100)}%` : 'idle'}</div>
      </div>
    </div>
  );
}

function LivePanel({
  signalData,
  recordingSignalData,
  isRecording,
  recordingStartTime,
  recordingProgress,
  showGuide,
}: {
  signalData: SignalPoint[];
  recordingSignalData: SignalPoint[];
  isRecording: boolean;
  recordingStartTime: number | null;
  recordingProgress: number;
  showGuide: boolean;
}) {
  const chartEnd = Math.max(
    signalData[signalData.length - 1]?.time ?? 0,
    recordingSignalData[recordingSignalData.length - 1]?.time ?? 0,
    Date.now(),
  );
  const chartStart = chartEnd - DISPLAY_WINDOW_MS;
  const activityData = signalData.filter((point) => point.time >= chartStart);
  const rawData = recordingSignalData.filter((point) => point.time >= chartStart);
  const activeSegmentEnd = recordingStartTime !== null
    ? Math.min(recordingStartTime + SEGMENT_DURATION_MS, chartEnd)
    : null;
  const segmentLabelLeft = recordingStartTime !== null
    ? Math.max(0, Math.min(78, ((recordingStartTime - chartStart) / DISPLAY_WINDOW_MS) * 100))
    : null;

  return (
    <section className={`overflow-hidden rounded-[28px] border bg-slate-950/55 transition-colors ${isRecording ? 'border-cyan-300/40 shadow-[0_0_48px_rgba(34,211,238,0.14)]' : 'border-white/10'}`}>
      <div className="flex items-center justify-between gap-3 border-b border-white/8 px-5 py-4">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-cyan-400/10 text-cyan-300">
            <Waves className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-sm font-medium text-white">Live activity</h2>
            <p className="text-xs text-slate-500">Rolling 5 second window</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {isRecording && (
            <span className="flex items-center gap-2 rounded-full bg-cyan-300/10 px-3 py-1.5 text-xs text-cyan-200">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-cyan-300" /> Capturing
            </span>
          )}
          <CaptureCounter isRecording={isRecording} recordingProgress={recordingProgress} />
        </div>
      </div>
      <div className="relative h-[300px] px-2 pt-3">
        {recordingStartTime !== null && activeSegmentEnd !== null && segmentLabelLeft !== null && (
          <div
            className="pointer-events-none absolute top-5 z-10 rounded-md bg-cyan-300/10 px-2 py-1 text-[11px] text-cyan-100"
            style={{ left: `${segmentLabelLeft}%` }}
          >
            Segment {(SEGMENT_DURATION_MS / 1000).toFixed(1)}s
          </div>
        )}
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={activityData} margin={{ top: 12, right: 12, left: 0, bottom: 12 }}>
            <defs>
              <linearGradient id="sessionActivity" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#22d3ee" stopOpacity={isRecording ? 0.55 : 0.38} />
                <stop offset="100%" stopColor="#22d3ee" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} stroke="rgba(148,163,184,0.08)" />
            <XAxis dataKey="time" type="number" domain={[chartStart, chartEnd]} hide />
            <YAxis domain={[0, 1]} hide />
            {showGuide && <ReferenceLine y={ACTIVITY_GUIDE} stroke="#fbbf24" strokeDasharray="6 6" opacity={0.75} />}
            {recordingStartTime !== null && activeSegmentEnd !== null && (
              <ReferenceArea
                x1={recordingStartTime}
                x2={activeSegmentEnd}
                fill="#22d3ee"
                fillOpacity={0.16}
                ifOverflow="extendDomain"
              />
            )}
            <Area type="monotone" dataKey="normalizedActivity" stroke="#22d3ee" strokeWidth={isRecording ? 3 : 2.4} fill="url(#sessionActivity)" isAnimationActive={false} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <div className="border-t border-white/8 px-5 py-3">
        <p className="mb-2 text-xs text-slate-500">Raw signal</p>
        <div className="h-24">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={rawData} margin={{ top: 4, right: 4, bottom: 4, left: 4 }}>
              <ReferenceLine y={0} stroke="rgba(148,163,184,0.16)" />
              <Line type="monotone" dataKey="raw" stroke="#94a3b8" strokeWidth={1.15} dot={false} isAnimationActive={false} />
              <XAxis dataKey="time" type="number" domain={[chartStart, chartEnd]} hide />
              <YAxis domain={['auto', 'auto']} hide />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
    </section>
  );
}

function TrialWave({ trial, domain }: { trial: StoredTrial; domain: WaveDomain }) {
  const data = useMemo(
    () => alignWaveform(trial.points, trial.preTriggerPointCount, trial.triggeredAt),
    [trial],
  );
  return (
    <div className="h-28 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 4, bottom: 4, left: 4 }}>
          <ReferenceLine x={0} stroke="#22d3ee" strokeDasharray="3 3" opacity={0.45} />
          <Line type="monotone" dataKey="value" stroke="#22d3ee" strokeWidth={1.8} dot={false} isAnimationActive={false} />
          <XAxis dataKey="time" type="number" domain={[domain.xMin, domain.xMax]} hide allowDataOverflow />
          <YAxis domain={[domain.yMin, domain.yMax]} hide allowDataOverflow />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function TrialCard({
  trial,
  sampleIndex,
  kept,
  required,
  domain,
  onDelete,
}: {
  trial: StoredTrial;
  sampleIndex: number;
  kept: number;
  required: number;
  domain: WaveDomain;
  onDelete?: () => void;
}) {
  return (
    <article className="rounded-2xl border border-white/10 bg-slate-950/50 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs text-slate-500">Sample {sampleIndex}</p>
          <p className="mt-1 text-sm font-medium text-white">{trial.gestureName}</p>
          <p className="mt-1 text-[11px] tabular-nums text-slate-400">{kept}/{required} kept</p>
        </div>
        {onDelete && (
          <button
            type="button"
            onClick={onDelete}
            className="rounded-lg p-1.5 text-slate-500 transition hover:bg-rose-400/10 hover:text-rose-200"
            aria-label={`Delete ${trial.gestureName} sample ${sampleIndex}`}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      <TrialWave trial={trial} domain={domain} />
    </article>
  );
}

function ModelStatusNote({ state }: { state: ConditionModelState }) {
  const copy: Record<ModelStatus, { title: string; detail: string; tone: string }> = {
    incomplete: {
      title: 'Incomplete',
      detail: 'Collect the required examples, then train this condition.',
      tone: 'border-white/10 bg-white/[0.03] text-slate-300',
    },
    training: {
      title: 'Training',
      detail: 'This condition’s model is training.',
      tone: 'border-cyan-300/30 bg-cyan-300/10 text-cyan-50',
    },
    ready: {
      title: 'Ready',
      detail: 'This condition’s model matches the kept examples.',
      tone: 'border-emerald-300/30 bg-emerald-300/10 text-emerald-50',
    },
    error: {
      title: 'Error',
      detail: state.error || 'This condition’s model could not be trained.',
      tone: 'border-rose-300/30 bg-rose-400/10 text-rose-50',
    },
    outdated: {
      title: 'Out of date',
      detail: 'A sample changed, so this condition’s model cannot be tested until you train again.',
      tone: 'border-amber-300/30 bg-amber-300/10 text-amber-50',
    },
  };
  const status = copy[state.status];
  return (
    <div className={`rounded-2xl border px-4 py-3 ${status.tone}`}>
      <p className="text-xs font-medium uppercase tracking-[0.16em]">Model {status.title}</p>
      <p className="mt-1 text-sm leading-6">{status.detail}</p>
    </div>
  );
}

export default function StudySession() {
  const navigate = useNavigate();
  const [session, setSession] = useState<ClientSession | null>(() => loadClientSession());
  const [signalMode, setSignalMode] = useState<SignalSourceMode>('mock');
  const [channelIndex, setChannelIndex] = useState(0);
  const [gestureId, setGestureId] = useState(DEFAULT_GESTURES[0].id);
  const [manualTriggerToken, setManualTriggerToken] = useState(0);
  const [notice, setNotice] = useState('Start the stream, then perform the gesture.');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [modelState, setModelState] = useState<ConditionModelState | null>(null);
  const [training, setTraining] = useState(false);

  useEffect(() => {
    if (!session) navigate('/', { replace: true });
  }, [navigate, session]);

  useEffect(() => {
    if (!session || session.stage === 'done') {
      if (session?.stage === 'done') clearClientSession();
      return;
    }
    saveClientSession(session);
  }, [session]);

  const gesture = DEFAULT_GESTURES.find((item) => item.id === gestureId) ?? DEFAULT_GESTURES[0];
  const generateMockSignalValue = useCallback(() => {
    const cycleMs = 4800;
    const cyclePosition = Date.now() % cycleMs;
    const state = cyclePosition > 1500 && cyclePosition < 3300 ? 'active' : 'idle';
    return getChannelMockSignalValue(channelIndex, cyclePosition / cycleMs, state);
  }, [channelIndex]);

  const {
    signalData,
    recordingSignalData,
    isStreaming,
    selectSignalSourceMode,
    startStream,
    stopStream,
    liveConnectionStatus,
    liveDeviceName,
    liveSampleRateHz,
    isBluetoothAvailable,
  } = useSignalSource(generateMockSignalValue, DISPLAY_WINDOW_MS, channelIndex, 1);

  const trials = session?.trials ?? [];
  const stage = session?.stage ?? 'capture';
  const manualTrigger = session?.manualTrigger ?? false;
  const triggerMode: CaptureTriggerMode = manualTrigger ? 'button' : 'threshold';
  const requiredPerGesture = session?.capturesPerRound ?? 1;
  const selectedKept = keptForGesture(trials, gestureId);
  const selectedFull = selectedKept >= requiredPerGesture;
  const roundComplete = samplesComplete(DEFAULT_GESTURES, trials, requiredPerGesture);
  const armed = stage === 'capture' && isStreaming && !selectedFull;
  const waveDomain = useMemo(() => sharedWaveDomain(
    trials.map((trial) => alignWaveform(trial.points, trial.preTriggerPointCount, trial.triggeredAt)),
  ), [trials]);

  const {
    recorderState,
    isRecording,
    recordingStartTime,
    recordingProgress,
    completedSegment,
    acknowledgeCompletedSegment,
  } = useGestureRecorder({
    signalPoints: recordingSignalData,
    threshold: ACTIVITY_GUIDE,
    segmentDurationMs: SEGMENT_DURATION_MS,
    isStreaming,
    resetKey: `${signalMode}:${channelIndex}:${gestureId}:${session?.round ?? 1}`,
    triggerMode,
    manualTriggerToken,
    isArmed: armed,
    cooldownMs: 450,
  });

  const sessionRef = useRef(session);
  sessionRef.current = session;
  const handledSegment = useRef<typeof completedSegment>(null);

  useEffect(() => {
    if (!completedSegment || handledSegment.current === completedSegment) return;
    const current = sessionRef.current;
    if (!current) return;
    handledSegment.current = completedSegment;
    const metrics = calculateMetrics(completedSegment.points);
    const savedForGesture = keptForGesture(current.trials, gesture.id) + 1;
    setSession((previous) => {
      if (!previous) return previous;
      const trial: StoredTrial = {
        id: `${gesture.id}-${previous.round}-${completedSegment.completedAt}`,
        gestureId: gesture.id,
        gestureName: gesture.name,
        pairIndex: keptForGesture(previous.trials, gesture.id) + 1,
        capturedAt: Date.now(),
        triggeredAt: completedSegment.triggeredAt,
        completedAt: completedSegment.completedAt,
        preTriggerPointCount: completedSegment.preTriggerPointCount,
        points: completedSegment.points,
        quality: completedSegment.points.length >= 12 && metrics.durationMs >= SEGMENT_DURATION_MS * 0.85 ? 'usable' : 'review',
        metrics,
      };
      return { ...previous, trials: [...previous.trials, trial] };
    });
    setNotice(`${gesture.name} sample ${Math.min(savedForGesture, current.capturesPerRound)} of ${current.capturesPerRound} kept.`);
    acknowledgeCompletedSegment();
  }, [acknowledgeCompletedSegment, completedSegment, gesture.id, gesture.name]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches('input, select, textarea')) return;
      if (event.code === 'Space' && manualTrigger && armed && recorderState === 'idle') {
        event.preventDefault();
        setManualTriggerToken((token) => token + 1);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [armed, manualTrigger, recorderState]);

  useEffect(() => {
    if (!session) return;
    const condition: Assignment = session.condition;
    setModelState(markDatasetChanged(
      session.participantId,
      condition,
      session.trials.map((trial) => trial.id),
    ));
  }, [session]);

  useEffect(() => registerGameRunListener((handoff) => {
    const current = sessionRef.current;
    if (!current || handoff.condition !== current.condition) return;
    if (!isModelReady(current.participantId, current.condition, current.trials.map((trial) => trial.id))) return;
    const run: StoredGameRun = {
      id: `${current.participantId}-${Date.now()}`,
      round: current.round,
      recordedAt: Date.now(),
      condition: current.condition,
      difficulty: handoff.difficulty || DEFAULT_DIFFICULTY,
      gameScore: handoff.gameScore,
      outcomes: handoff.outcomes,
    };
    setSession((previous) => {
      if (!previous) return previous;
      return {
        ...previous,
        runs: [...previous.runs, run],
        stage: 'results',
        unlockedThrough: 'results',
      };
    });
    void saveGameRun(current.participantId, run).catch(() => {
      setSaveError('The game result could not be saved.');
    });
  }), []);

  if (!session) return null;

  const signalValue = signalData[signalData.length - 1]?.normalizedActivity ?? 0;
  const condition: Assignment = session.condition;
  const trialIds = trials.map((trial) => trial.id);
  const modelReady = isModelReady(session.participantId, condition, trialIds);
  const gamePredictionEngine = getConditionPredictionEngine(
    session.participantId,
    condition,
    trialIds,
  );
  const predictGameWindow = (points: Array<{ time: number; raw: number }>) => {
    if (!gamePredictionEngine || points.length === 0) return null;
    const durationMs = Math.max(0, points[points.length - 1].time - points[0].time);
    const sample = buildInferenceSample(points, durationMs);
    return sample ? gamePredictionEngine.predict(sample) : null;
  };
  const quotas = gestureQuotas(DEFAULT_GESTURES, trials, session.capturesPerRound);
  const missingQuotas = quotas.filter((row) => row.missing > 0);
  const cappedKept = quotas.reduce((sum, row) => sum + Math.min(row.kept, row.required), 0);
  const totalRequired = DEFAULT_GESTURES.length * session.capturesPerRound;
  const reachedIndex = flowIndex(session.unlockedThrough ?? stage);
  const renderTrial = (trial: StoredTrial) => {
    const quota = quotas.find((row) => row.gesture.id === trial.gestureId);
    return (
      <TrialCard
        key={trial.id}
        trial={trial}
        sampleIndex={sampleNumber(trials, trial.id)}
        kept={quota?.kept ?? 0}
        required={session.capturesPerRound}
        domain={waveDomain}
        onDelete={() => deleteKeptTrial(trial.id)}
      />
    );
  };

  const hasRunThisRound = session.runs.some((run) => run.round === session.round && run.condition === condition);
  const canVisit = (next: FlowStage) => {
    if (stage === 'done') return false;
    if (next === 'capture') return true;
    if (next === 'review') return trials.length > 0 || stage === 'review' || stage === 'game' || stage === 'results';
    if (next === 'game') return roundComplete && modelReady;
    return hasRunThisRound || (roundComplete && modelReady && reachedIndex >= flowIndex('game'));
  };

  const deleteKeptTrial = (trialId: string) => {
    setSession((current) => {
      if (!current) return current;
      return { ...current, trials: current.trials.filter((trial) => trial.id !== trialId) };
    });
    setNotice('Example removed. Return to Capture if that gesture is now short.');
  };

  const trainModel = async () => {
    if (!roundComplete || training) return;
    setTraining(true);
    setModelState((current) => (current ? { ...current, status: 'training', error: '' } : current));
    try {
      const next = await trainConditionModel(session.participantId, condition, trials, DEFAULT_GESTURES);
      setModelState(next);
      setNotice(next.status === 'ready' ? 'Model ready for this condition.' : next.error || 'The model is not ready.');
    } finally {
      setTraining(false);
    }
  };

  const goTo = (next: FlowStage) => {
    if (!canVisit(next)) return;
    setSession((current) => {
      if (!current || current.stage === 'done') return current;
      const reached = Math.max(flowIndex(current.unlockedThrough ?? current.stage), flowIndex(next));
      return { ...current, stage: next, unlockedThrough: FLOW[reached] };
    });
  };

  const toggleStream = async () => {
    if (isStreaming) {
      await stopStream();
      setNotice('Stream paused. Captures from this round are still here.');
      return;
    }
    await startStream();
    setNotice(manualTrigger ? 'Press Capture when the gesture begins.' : 'Perform the gesture when you are ready.');
  };

  const finishRound = async () => {
    if (!roundComplete) return;
    setSaving(true);
    setSaveError('');
    try {
      const result = await saveRound(session.participantId, session.round, trials);
      if (result.status === 'completed') {
        setSession({ ...session, status: 'completed', stage: 'done', trials: [] });
        return;
      }
      setSession({
        ...session,
        status: 'in_progress',
        stage: 'capture',
        unlockedThrough: 'capture',
        round: result.round,
        trials: [],
      });
      setNotice('Next round is ready. Start the stream if it is paused.');
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'This round could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  const leave = async () => {
    if (isStreaming) await stopStream();
    navigate('/');
  };

  return (
    <div className="min-h-screen bg-[#050812] text-slate-100">
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -left-32 top-20 h-96 w-96 rounded-full bg-cyan-400/[0.05] blur-3xl" />
        <div className="absolute inset-0 opacity-[0.025] [background-image:linear-gradient(rgba(255,255,255,.25)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,.25)_1px,transparent_1px)] [background-size:48px_48px]" />
      </div>

      <header className="sticky top-0 z-40 border-b border-white/8 bg-[#050812]/85 backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 md:px-6">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-cyan-300/20 bg-cyan-300/10 text-cyan-300">
              <Activity className="h-5 w-5" />
            </div>
            <div>
              <p className="text-sm font-medium text-white">{session.experimentName}</p>
              <p className="font-mono text-[11px] tracking-wider text-slate-500">{session.participantId}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="hidden items-center gap-2 rounded-full border border-white/8 px-3 py-2 text-xs text-slate-400 sm:flex">
              <span className={`h-2 w-2 rounded-full ${isStreaming ? 'bg-emerald-300' : 'bg-slate-600'}`} />
              {isStreaming ? (signalMode === 'live' ? liveDeviceName ?? 'Device live' : 'Mock live') : 'Stream idle'}
            </span>
            <button type="button" onClick={() => void leave()} className="rounded-xl border border-white/10 px-3 py-2 text-xs text-slate-400 hover:text-white">
              Leave
            </button>
          </div>
        </div>
      </header>

      <main className="relative mx-auto max-w-6xl space-y-5 px-4 py-6 md:px-6">
        <StepMap stage={stage} round={session.round} repetitions={session.repetitions} reachedIndex={reachedIndex} canVisit={canVisit} onSelect={goTo} />

        {stage === 'done' && (
          <section className="rounded-[28px] border border-emerald-300/20 bg-emerald-300/10 p-8 text-center">
            <Check className="mx-auto h-8 w-8 text-emerald-200" />
            <h2 className="mt-4 text-2xl font-light text-white">Session complete</h2>
            <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-emerald-100/80">
              All {session.repetitions} rounds are saved. You can close this page.
            </p>
          </section>
        )}

        {stage === 'capture' && (
          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
            <div className="space-y-5">
              <LivePanel
                signalData={signalData}
                recordingSignalData={recordingSignalData}
                isRecording={isRecording}
                recordingStartTime={recordingStartTime}
                recordingProgress={recordingProgress}
                showGuide={!manualTrigger}
              />
              <section className="rounded-[24px] border border-white/8 bg-white/[0.025] p-4">
                <div className="flex items-center justify-between gap-3">
                  <h2 className="text-sm font-medium text-white">This round</h2>
                  <span className="text-xs tabular-nums text-slate-500">{cappedKept}/{totalRequired}</span>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {quotas.map((row) => (
                    <span key={row.gesture.id} className="rounded-full border border-white/10 px-3 py-1 text-[11px] text-slate-300">
                      {row.gesture.name} <span className="tabular-nums text-slate-100">{row.kept}/{row.required}</span>
                    </span>
                  ))}
                </div>
                {trials.length > 0 ? (
                  <div className="mt-4 grid gap-3 sm:grid-cols-2">
                    {trials.map((trial) => renderTrial(trial))}
                  </div>
                ) : (
                  <div className="mt-4 flex min-h-28 items-center justify-center rounded-2xl border border-dashed border-white/10 text-sm text-slate-500">
                    <div className="text-center"><CircleDot className="mx-auto mb-2 h-5 w-5 text-slate-700" />Captures will show up here</div>
                  </div>
                )}
              </section>
            </div>

            <aside className="space-y-4">
              <section className="rounded-[28px] border border-white/10 bg-slate-950/70 p-5">
                <div className="flex items-center justify-between text-[11px] text-slate-500">
                  <span>Examples kept</span>
                  <span className="tabular-nums">{cappedKept}/{totalRequired}</span>
                </div>
                <div className="mt-3 h-1 overflow-hidden rounded-full bg-white/10">
                  <div className="h-full rounded-full bg-cyan-300" style={{ width: `${Math.min(100, (cappedKept / totalRequired) * 100)}%` }} />
                </div>

                <label className="mt-5 block text-[10px] font-medium uppercase tracking-[0.18em] text-slate-500">Gesture</label>
                <div className="mt-2">
                  <DarkSelect
                    label="Gesture"
                    value={gestureId}
                    options={DEFAULT_GESTURES.map((item) => ({ value: item.id, label: item.name }))}
                    onChange={setGestureId}
                  />
                </div>

                <div className="mt-4 grid grid-cols-2 gap-2">
                  {(['mock', 'live'] as SignalSourceMode[]).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      disabled={mode === 'live' && !isBluetoothAvailable}
                      onClick={() => {
                        setSignalMode(mode);
                        void selectSignalSourceMode(mode);
                      }}
                      className={`rounded-xl border px-3 py-2 text-xs ${signalMode === mode ? 'border-cyan-300/30 bg-cyan-300/10 text-cyan-100' : 'border-white/10 text-slate-400'} disabled:opacity-30`}
                    >
                      {mode === 'mock' ? 'Mock' : 'Ganglion'}
                    </button>
                  ))}
                </div>
                <label className="mt-3 block text-[10px] uppercase tracking-[0.16em] text-slate-500">Channel</label>
                <div className="mt-2">
                  <DarkSelect
                    label="Channel"
                    value={String(channelIndex)}
                    options={[0, 1, 2, 3].map((index) => ({ value: String(index), label: `Channel ${index + 1}` }))}
                    onChange={(value) => setChannelIndex(Number(value))}
                    triggerClassName="rounded-xl py-2 text-sm"
                  />
                </div>

                <div className="mt-4 rounded-2xl border border-white/10 bg-white/[0.03] p-4">
                  <p className="text-xs font-medium text-cyan-100">
                    {!isStreaming ? 'Waiting for the stream' : isRecording ? 'Recording' : recorderState === 'cooldown' ? 'Short pause' : selectedFull ? `${gesture.name} has its examples` : roundComplete ? 'Required examples kept' : 'Ready'}
                  </p>
                  <p className="mt-2 text-xs leading-5 text-slate-400">
                    {manualTrigger ? 'Press Capture at the start of the gesture.' : 'Recording begins when you perform the gesture.'}
                  </p>
                </div>

                {manualTrigger && (
                  <button
                    type="button"
                    onClick={() => setManualTriggerToken((token) => token + 1)}
                    disabled={!armed || recorderState !== 'idle'}
                    className="mt-4 flex w-full items-center justify-center gap-3 rounded-2xl border border-cyan-300/30 bg-cyan-300/10 px-5 py-5 text-sm font-medium text-cyan-50 disabled:cursor-not-allowed disabled:opacity-35"
                  >
                    <Hand className="h-5 w-5" /> Capture <span className="rounded-md border border-white/10 px-2 py-1 text-[10px] text-cyan-100/70">Space</span>
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => void toggleStream()}
                  disabled={liveConnectionStatus === 'connecting'}
                  className={`mt-3 flex w-full items-center justify-center gap-2 rounded-2xl px-5 py-3.5 text-sm font-medium ${isStreaming ? 'border border-white/10 text-slate-300' : 'bg-cyan-300 text-slate-950'} disabled:opacity-50`}
                >
                  {isStreaming ? <><Pause className="h-4 w-4" /> Pause stream</> : <><Play className="h-4 w-4" /> {signalMode === 'live' ? 'Connect device' : 'Start mock stream'}</>}
                </button>
                <button
                  type="button"
                  disabled={trials.length === 0}
                  onClick={() => goTo('review')}
                  className="mt-3 flex w-full items-center justify-center gap-2 rounded-2xl border border-white/10 px-5 py-3 text-sm text-slate-200 disabled:cursor-not-allowed disabled:opacity-35"
                >
                  Review captures <ArrowRight className="h-4 w-4" />
                </button>
              </section>

              <section className="rounded-[24px] border border-white/8 p-5">
                <div className="flex items-center justify-between text-xs text-slate-400">
                  <span>Live context</span>
                  <Radio className="h-4 w-4" />
                </div>
                <dl className="mt-4 grid grid-cols-2 gap-4 text-sm">
                  <div><dt className="text-[10px] uppercase tracking-[0.16em] text-slate-500">Activity</dt><dd className="mt-1 tabular-nums">{signalValue.toFixed(2)}</dd></div>
                  <div><dt className="text-[10px] uppercase tracking-[0.16em] text-slate-500">Capture</dt><dd className="mt-1 tabular-nums">{Math.round(recordingProgress * 100)}%</dd></div>
                  <div><dt className="text-[10px] uppercase tracking-[0.16em] text-slate-500">Sample rate</dt><dd className="mt-1">{liveSampleRateHz ? `${liveSampleRateHz} Hz` : signalMode === 'mock' && isStreaming ? '20 Hz' : '—'}</dd></div>
                  <div><dt className="text-[10px] uppercase tracking-[0.16em] text-slate-500">Saved</dt><dd className="mt-1 tabular-nums">{trials.length}</dd></div>
                </dl>
                <p className="mt-4 border-t border-white/8 pt-3 text-xs leading-5 text-slate-500">{notice}</p>
              </section>
            </aside>
          </div>
        )}

        {stage === 'review' && (
          <section className="space-y-4">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <p className="text-xs uppercase tracking-[0.18em] text-cyan-300/70">Review</p>
                <h2 className="mt-1 text-2xl font-light text-white">Captures from this round</h2>
              </div>
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={() => goTo('capture')} className="rounded-xl border border-white/10 px-4 py-2.5 text-xs text-slate-300">Back to capture</button>
                <button type="button" disabled={!roundComplete || training} onClick={() => void trainModel()} className="rounded-xl border border-white/10 px-4 py-2.5 text-xs text-slate-100 disabled:cursor-not-allowed disabled:opacity-35">
                  {modelState?.status === 'training' || training ? 'Training' : modelState?.status === 'ready' ? 'Retrain' : 'Train model'}
                </button>
                <button type="button" disabled={!roundComplete || !modelReady} onClick={() => goTo('game')} className="flex items-center gap-2 rounded-xl bg-cyan-300 px-4 py-2.5 text-xs font-medium text-slate-950 disabled:cursor-not-allowed disabled:opacity-35">Play <ArrowRight className="h-3.5 w-3.5" /></button>
              </div>
            </div>
            {modelState && <ModelStatusNote state={modelState} />}
            <div className="flex flex-wrap gap-2">
              {quotas.map((row) => (
                <span key={row.gesture.id} className="rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 text-xs text-slate-200">
                  {row.gesture.name} <span className="tabular-nums">{row.kept}/{row.required} kept</span>
                </span>
              ))}
            </div>
            {missingQuotas.length > 0 && (
              <div className="rounded-2xl border border-amber-300/20 bg-amber-300/10 px-4 py-4 text-sm text-amber-50">
                <p className="font-medium">Missing examples</p>
                <ul className="mt-2 space-y-1">
                  {missingQuotas.map((row) => (
                    <li key={row.gesture.id}>
                      {row.gesture.name} needs {row.missing} more {row.missing === 1 ? 'example' : 'examples'} ({row.kept}/{row.required} kept)
                    </li>
                  ))}
                </ul>
                <button type="button" onClick={() => goTo('capture')} className="mt-3 rounded-xl bg-amber-100 px-4 py-2 text-xs font-medium text-slate-950">
                  Return to Capture
                </button>
              </div>
            )}
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {trials.map((trial) => renderTrial(trial))}
            </div>
          </section>
        )}

        {stage === 'game' && modelReady && (
          <GameScreen
            onExit={() => goTo('review')}
            exitLabel="Back to review"
            onSecondary={() => goTo('results')}
            secondaryLabel="Finish Run"
            emgPoints={recordingSignalData}
            actionGestures={{
              jump: DEFAULT_GESTURES[0],
              switchLane: DEFAULT_GESTURES[1],
            }}
            predictWindow={predictGameWindow}
            condition={condition}
          />
        )}

        {stage === 'game' && !modelReady && (
          <section className="overflow-hidden rounded-[28px] border border-dashed border-emerald-300/30 bg-slate-950/55">
            <div className="flex flex-wrap items-end justify-between gap-3 border-b border-white/8 p-5 md:p-6">
              <div>
                <p className="text-xs uppercase tracking-[0.18em] text-emerald-300/80">Play</p>
                <h2 className="mt-1 text-2xl font-light text-white">Review game</h2>
                <p className="mt-2 max-w-xl text-sm leading-6 text-slate-500">Testing stays closed until this condition’s model is ready.</p>
              </div>
              <div className="flex gap-2">
                <button type="button" onClick={() => goTo('review')} className="rounded-xl border border-white/10 px-4 py-2.5 text-xs text-slate-300">Back to review</button>
                <button type="button" disabled={!hasRunThisRound} onClick={() => goTo('results')} className="flex items-center gap-2 rounded-xl bg-cyan-300 px-4 py-2.5 text-xs font-medium text-slate-950 disabled:cursor-not-allowed disabled:opacity-35">Results <ArrowRight className="h-3.5 w-3.5" /></button>
              </div>
            </div>
            <div className="space-y-4 p-4 md:p-6">
              {modelState && <ModelStatusNote state={modelState} />}
              <p className="text-sm text-amber-100">Testing is closed until this condition’s model is ready and matches the kept examples.</p>
            </div>
          </section>
        )}

        {stage === 'results' && (
          <ResultsPanel
            runs={session.runs}
            currentRun={session.runs
              .filter((run) => run.round === session.round && run.condition === condition)
              .sort((left, right) => right.recordedAt - left.recordedAt)[0] ?? null}
            gestures={DEFAULT_GESTURES}
            tryAgainEnabled={roundComplete && modelReady}
            onTryAgain={() => goTo('game')}
            onReview={() => goTo('review')}
            onContinue={() => void finishRound()}
            continueEnabled={roundComplete}
            continueLabel={session.round >= session.repetitions ? 'Finish session' : 'Continue'}
            saving={saving}
            saveError={saveError}
          />
        )}
      </main>
    </div>
  );
}
