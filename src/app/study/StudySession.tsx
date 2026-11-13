import DismissibleNotice from './DismissibleNotice';
import ParticipantDialog from './ParticipantDialog';
import { advanceCompletedRound, pendingRoundIntent, persistRoundSession, repeatRoundAvailable } from './roundTransition';
import { useCoreCaptureContextArchive } from './useCoreCaptureContextArchive';
import { pickSession } from './ParticipantGate';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { isPilotProtocol, requiresCollectionSurvey, practiceDisposition, skipGesturePractice } from './api';
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
import { buildInferenceSample, DEFAULT_FEATURE_SET_ID, DEFAULT_GESTURES, getChannelMockSignalValue } from '../pipeline';
import { useGestureRecorder, type CaptureTriggerMode } from '../useGestureRecorder';
import { useSignalSource, type SignalPoint, type SignalSourceMode } from '../useSignalSource';
import {
  isModelReady,
  isTrainingInFlight,
  getConditionPredictionEngine,
  markDatasetChanged,
  trainConditionModel,
  type ConditionModelState,
  type ModelStatus,
} from './conditionTraining';
import GameScreen from '../GameScreen';
import DarkSelect from './DarkSelect';
import {
  collectionId,
  makeEvent,
  recordCollection as recordMeasuredCollection,
  whenCollectionSaved,
  type CollectionContext,
} from './collection';
import { DEFAULT_DIFFICULTY, registerGameRunListener, type StoredGameRun } from './gameHandoff';
import SampleGraphPanel from './SampleGraphPanel';
import { INFERENCE_WINDOW_MS } from './evaluationProtocol.mjs';
import ResultsPanel from './ResultsPanel';
import GuidedPractice from './GuidedPractice';
import PracticeGuide from './PracticeGuide';
import { practiceGuidance } from './practiceGuidance';
import type { FrozenCalibration } from './frozenCalibration.mjs';
import { PracticeArchive, rehearsalSession } from './practiceArchive';
import { gestureQuotas, keptForGesture, sampleNumber, samplesComplete } from './samplePlan';
import { alignWaveform, displayEnvelopeWaveform, sharedWaveDomain, type WaveDomain } from './waveScale';
import {
  clearClientSession,
  confirmCollectionSurvey,
  lockOfficialDataset,
  joinStudy,
  loadClientSession,
  saveClientSession,
  saveRound,
  type Assignment,
  type ClientSession,
  type FlowStage,
  type StoredTrial,
  type StudyStage,
} from './api';

const DISPLAY_WINDOW_MS = 4000;
const DEFAULT_SEGMENT_DURATION_MS = 2000;
const DEFAULT_PRE_TRIGGER_WINDOW_MS = 0; // Surrounding raw context is archived separately, never labelled.
const DEFAULT_ACTIVITY_THRESHOLD = 0.6;
const DEFAULT_COUNTDOWN_MS = 3000;
const RECORDER_COOLDOWN_MS = 450;
const recoveredInterruptions = new Set<string>();

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
  repetitions?: number;
  reachedIndex: number;
  canVisit: (stage: FlowStage) => boolean;
  onSelect: (stage: FlowStage) => void;
}) {
  const activeIndex = stage === 'done' ? STEPS.length : STEPS.findIndex((step) => step.id === stage);
  return (
    <section className="rounded-[28px] border border-white/25 bg-slate-900/80 p-4 md:p-6" aria-label="Session steps">
      <div className="mb-4 flex items-end justify-between gap-3">
        <div>
          <p className="text-[10px] font-medium uppercase tracking-[0.2em] text-cyan-300/80">Round {round}{repetitions === undefined ? '' : ` of ${repetitions}`}</p>
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
                      ? 'border-white/25 bg-white/[0.03] hover:bg-white/[0.06]'
                      : 'border-white/20 bg-transparent opacity-45'
                }`}
              >
                <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-medium ${
                  active ? 'bg-cyan-300 text-slate-950' : visited ? 'bg-emerald-300/15 text-emerald-200' : 'border border-white/25 text-slate-500'
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

interface CaptureStatus {
  label: 'Rest' | 'Ready' | 'Recording' | 'Error' | 'Movement';
  detail: string;
}

function CaptureCounter({
  isRecording,
  recordingProgress,
  segmentDurationMs,
  status,
}: {
  isRecording: boolean;
  recordingProgress: number;
  segmentDurationMs: number;
  status: CaptureStatus;
}) {
  const radius = 26;
  const circumference = 2 * Math.PI * radius;
  const secondsRemaining = Math.max(0, (segmentDurationMs - Math.round(recordingProgress * segmentDurationMs)) / 1000);
  const dashOffset = isRecording ? circumference * (1 - recordingProgress) : circumference;

  return (
    <div role="status" aria-label="Capture status" data-capture-state={status.label} className="flex items-center gap-3">
      <p className="h-20 max-w-32 overflow-y-auto text-right text-xs leading-5 text-slate-300">{status.detail}</p>
    <div className={`relative flex h-20 w-20 shrink-0 items-center justify-center rounded-full border bg-slate-950/80 ${status.label === 'Error' ? 'border-rose-300/60 text-rose-200' : status.label === 'Ready' ? 'border-emerald-300/60 text-emerald-200' : isRecording ? 'border-cyan-300/60 text-cyan-200' : 'border-amber-200/40 text-amber-100'}`}>
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
        <div className="text-xs font-medium">{status.label}</div>
        {isRecording && <div aria-hidden="true" className="text-[10px] tabular-nums text-cyan-100">{`${Math.ceil(secondsRemaining * 10) / 10}s`}</div>}
      </div>
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
  thresholdGuideValue,
  segmentDurationMs,
  overlay,
  captureStatus,
}: {
  signalData: SignalPoint[];
  recordingSignalData: SignalPoint[];
  isRecording: boolean;
  recordingStartTime: number | null;
  recordingProgress: number;
  showGuide: boolean;
  thresholdGuideValue: number;
  segmentDurationMs: number;
  overlay: { label: string; text: string } | null;
  captureStatus: CaptureStatus;
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
    ? Math.min(recordingStartTime + segmentDurationMs, chartEnd)
    : null;
  const visibleSegmentStart = recordingStartTime !== null ? Math.max(recordingStartTime, chartStart) : null;
  const segmentLabelLeft = recordingStartTime !== null
    ? Math.max(0, Math.min(78, ((recordingStartTime - chartStart) / DISPLAY_WINDOW_MS) * 100))
    : null;

  return (
    <section className={`overflow-hidden rounded-[28px] border bg-slate-900/80 transition-colors ${isRecording ? 'border-cyan-300/40 shadow-[0_0_48px_rgba(34,211,238,0.14)]' : 'border-white/25'}`}>
      <div className="flex items-center justify-between gap-3 border-b border-white/20 px-5 py-4">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-cyan-400/10 text-cyan-300">
            <Waves className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-sm font-medium text-white">Live activity</h2>
            <p className="text-xs text-slate-500">Fixed 4 second window</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <CaptureCounter isRecording={isRecording} recordingProgress={recordingProgress} segmentDurationMs={segmentDurationMs} status={captureStatus} />
        </div>
      </div>
      <div data-practice-target="signal" className="relative h-[300px] px-2 pt-3">
        {overlay && (
          <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center">
            <div className="rounded-3xl border border-cyan-300/30 bg-slate-950/80 px-8 py-5 text-center shadow-2xl backdrop-blur-sm">
              <p className="text-[10px] uppercase tracking-[0.2em] text-cyan-200">{overlay.label}</p>
              <p className="mt-1 text-5xl font-light tabular-nums text-white">{overlay.text}</p>
            </div>
          </div>
        )}
        {recordingStartTime !== null && activeSegmentEnd !== null && segmentLabelLeft !== null && (
          <div
            className="pointer-events-none absolute top-5 z-10 rounded-md bg-cyan-300/10 px-2 py-1 text-[11px] text-cyan-100"
            style={{ left: `${segmentLabelLeft}%` }}
          >
            Segment {(segmentDurationMs / 1000).toFixed(1)}s
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
            <XAxis dataKey="time" type="number" domain={[chartStart, chartEnd]} hide allowDataOverflow />
            <YAxis domain={[0, 1]} hide />
            {showGuide && <ReferenceLine y={thresholdGuideValue} stroke="#fbbf24" strokeDasharray="6 6" opacity={0.75} />}
            {visibleSegmentStart !== null && activeSegmentEnd !== null && visibleSegmentStart < activeSegmentEnd && (
              <ReferenceArea
                x1={visibleSegmentStart}
                x2={activeSegmentEnd}
                fill="#22d3ee"
                fillOpacity={0.16}
                ifOverflow="hidden"
              />
            )}
            <Area type="monotone" dataKey="value" stroke="#22d3ee" strokeWidth={isRecording ? 3 : 2.4} fill="url(#sessionActivity)" isAnimationActive={false} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <div className="border-t border-white/20 px-5 py-3">
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
    () => displayEnvelopeWaveform(
      alignWaveform(trial.points, trial.preTriggerPointCount, trial.triggeredAt),
    ),
    [trial],
  );
  return (
    <div className="h-28 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 4, bottom: 4, left: 4 }}>
          <ReferenceLine x={0} stroke="#22d3ee" strokeDasharray="3 3" opacity={0.45} />
          <Line type="linear" dataKey="value" stroke="#22d3ee" strokeWidth={1.8} dot={false} isAnimationActive={false} />
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
  minimum,
  maximum,
  domain,
  onInspect,
  onDelete,
  deletingDisabled = false,
}: {
  trial: StoredTrial;
  sampleIndex: number;
  kept: number;
  minimum: number;
  maximum: number;
  domain: WaveDomain;
  onInspect?: () => void;
  onDelete?: () => void;
  deletingDisabled?: boolean;
}) {
  return (
    <article data-practice-sample={trial.id} className="rounded-2xl border border-white/25 bg-slate-950/50 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs text-slate-500">Sample {sampleIndex}</p>
          <p className="mt-1 text-sm font-medium text-white">{trial.gestureName}</p>
          <p className="mt-1 text-[11px] tabular-nums text-slate-400">{kept} kept · {minimum}–{maximum}</p>
        </div>
        <div className="flex items-center gap-1">
          {onInspect && (
            <button
              type="button"
              data-practice-target="inspect-sample" onClick={onInspect}
              className="rounded-lg border border-white/25 px-2 py-1 text-[11px] text-slate-200 transition hover:bg-white/10"
            >
              Graph
            </button>
          )}
          {onDelete && (
            <button
              type="button"
              data-practice-target="delete-sample" onClick={onDelete}
              disabled={deletingDisabled}
              className="rounded-lg p-1.5 text-slate-500 transition hover:bg-rose-400/10 hover:text-rose-200"
              aria-label={`Delete ${trial.gestureName} sample ${sampleIndex}`}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
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
      tone: 'border-white/25 bg-white/[0.03] text-slate-300',
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
  if (state.status === 'error' || state.status === 'outdated') {
    return <DismissibleNotice message={status.detail} summary={`Model ${status.title} — testing blocked`} />;
  }
  return (
    <div className={`rounded-2xl border px-4 py-3 ${status.tone}`}>
      <p className="text-xs font-medium uppercase tracking-[0.16em]">Model {status.title}</p>
      <p className="mt-1 text-sm leading-6">{status.detail}</p>
    </div>
  );
}

export default function StudySession() {
  const [scopeEpoch, setScopeEpoch] = useState(0);
  return <ScopedStudySession key={scopeEpoch} onNextScope={() => setScopeEpoch(n => n + 1)} />;
}

function ScopedStudySession({ onNextScope }: { onNextScope: () => void }) {
  const navigate = useNavigate();
  const nextRoundOperation = useRef(false);
  const [pauseConfirmation, setPauseConfirmation] = useState(false);
  const [confirmingPause, setConfirmingPause] = useState(false);
  const pauseOperation = useRef(false);
  const [dismissedRecoveryKey, setDismissedRecoveryKey] = useState('');
  const [advancingRound, setAdvancingRound] = useState(false);
  const [measuredSession, setMeasuredSession] = useState<ClientSession | null>(() => pendingRoundIntent()?.snapshot ?? loadClientSession());
  const [serverVerified, setServerVerified] = useState(() => !isPilotProtocol(loadClientSession()?.protocolVersion));
  const serverVerifiedRef = useRef(serverVerified); serverVerifiedRef.current = serverVerified;
  const [researcherPin, setResearcherPin] = useState('');
  const gameStreamRef = useRef({ ready: false, source: 'live' as SignalSourceMode });
  const activeGameRef = useRef<{
    participantId: string; sessionId: string; generation: number; round: number;
    condition: Assignment; modelRevisionId: string | null; source: SignalSourceMode;
    evidenceKind: 'practice' | 'synthetic-test' | 'measured-live';
  } | null>(null);
  const lockOperation = useRef(false);
  const [rehearsal, setRehearsal] = useState<ClientSession | null>(null);
  const [captureIntroduced, setCaptureIntroduced] = useState(false);
  const [firstSampleExplained, setFirstSampleExplained] = useState(false);
  const [gameIntroduction, setGameIntroduction] = useState<{ scope: string; revision: string } | null>(null);
  const [introducedGameRevision, setIntroducedGameRevision] = useState<string | null>(null);
  const [practiceMode, setPracticeMode] = useState<'setup' | 'rehearsal' | 'measured'>(() => {
    const saved = loadClientSession();
    return saved?.stage === 'capture' && !saved.trials.length && !practiceDisposition(saved) ? 'setup' : 'measured';
  });
  const [, refreshArchive] = useState(0);
  const practiceArchive = useRef<PracticeArchive | null>(null);
  const practiceExitOperation = useRef(false);
  const modeRef = useRef(practiceMode);
  modeRef.current = practiceMode;
  const session = rehearsal ?? measuredSession;
  // Synchronous ownership survives disabled-control render gaps and lost HTTP
  // responses. Never reconstruct a retry from mutable UI state.
  const submissionOperation = useRef<{
    snapshot: ClientSession;
    inFlight: boolean;
    rawSealed: boolean;
    phase: 'draining' | 'posting' | 'uncertain' | 'complete';
  } | null>(null);
  const setSession: typeof setMeasuredSession = useCallback((update) => {
    if (submissionOperation.current) return;
    if (modeRef.current === 'rehearsal') setRehearsal(update);
    else setMeasuredSession(update);
  }, []);
  const modelScope = (current: ClientSession) => practiceArchive.current?.scope ?? `${current.participantId}:${current.generation}:${current.sessionId}:${current.round}`;
  const recordCollection = useCallback((participantId: string, items: Parameters<typeof recordMeasuredCollection>[1]) => {
    if (modeRef.current !== 'measured') return modeRef.current === 'rehearsal' && practiceArchive.current
      ? practiceArchive.current.collect(items) : Promise.resolve();
    if (!serverVerifiedRef.current || (!isPilotProtocol(sessionRef.current?.protocolVersion) && sessionRef.current?.isTestParticipant !== true)) return Promise.resolve();
    // Only housekeeping producers are suppressed; already-produced evidence
    // still enters the ACK barrier while raw windows are being sealed.
    if (submissionOperation.current || sessionRef.current?.stage === 'done') {
      items = items.filter(item => item.kind !== 'meta' && item.kind !== 'checkpoint');
    }
    return recordMeasuredCollection(participantId, items);
  }, []);
  useEffect(() => {
    if (!measuredSession || !isPilotProtocol(measuredSession.protocolVersion)) return;
    let cancelled = false;
    whenCollectionSaved().then(() => joinStudy(measuredSession.participantId)).then(joined => {
      if (cancelled) return;
      if (pendingRoundIntent()) { setServerVerified(true); return; }
      if (joined.status === 'completed' && joined.repeatRoundsVersion !== 1) { clearClientSession(); navigate('/'); return; }
      const restored = pickSession(joined, measuredSession);
      setMeasuredSession(restored);
      setPracticeMode(restored.stage === 'capture' && !restored.trials.length && !practiceDisposition(restored) ? 'setup' : 'measured');
      setServerVerified(true);
    }).catch(cause => { if (!cancelled) setSaveError(cause instanceof Error ? cause.message : 'Rejoin required before continuing.'); });
    return () => { cancelled = true; };
  }, []);
  const [calibrationState, setCalibrationState] = useState<{ scope: string; epoch: number; value: FrozenCalibration } | null>(null);
  const [recalibrating, setRecalibrating] = useState(false);
  const [signalMode, setSignalMode] = useState<SignalSourceMode>('live');
  const [channelIndex, setChannelIndex] = useState(0);
  const [segmentDurationMs, setSegmentDurationMs] = useState(DEFAULT_SEGMENT_DURATION_MS);
  const [preTriggerWindowMs, setPreTriggerWindowMs] = useState(DEFAULT_PRE_TRIGGER_WINDOW_MS);
  const activityThreshold = DEFAULT_ACTIVITY_THRESHOLD; // Legacy metadata only; calibrated decisions use the envelope revision.
  const [countdownMs, setCountdownMs] = useState(DEFAULT_COUNTDOWN_MS);
  const [countdownEndsAt, setCountdownEndsAt] = useState<number | null>(null);
  const [countdownRemainingMs, setCountdownRemainingMs] = useState(0);
  const [captureTimerOn, setCaptureTimerOn] = useState(false);
  const [inspectedTrialId, setInspectedTrialId] = useState<string | null>(null);
  const [gestureId, setGestureId] = useState(DEFAULT_GESTURES[0].id);
  const [manualTriggerToken, setManualTriggerToken] = useState(0);
  const [opportunityTimedOut, setOpportunityTimedOut] = useState(false);
  const [opportunityRetry, setOpportunityRetry] = useState(0);
  const retryOfAttempt = useRef<string | undefined>(undefined);
  const [notice, setNotice] = useState('Start the stream, then perform the gesture.');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [modelState, setModelState] = useState<ConditionModelState | null>(null);
  const [training, setTraining] = useState(false);
  // This ref locks handlers synchronously, including callbacks from an older
  // render. State alone leaves a gap before React renders disabled controls.
  const trainingOperation = useRef<{ scope: string; condition: Assignment } | null>(null);
  const cancelTraining = useCallback(() => {
    const operation = trainingOperation.current;
    trainingOperation.current = null;
    if (operation) markDatasetChanged(operation.scope, operation.condition, []);
  }, []);
  useEffect(() => () => cancelTraining(), [cancelTraining]);
  const [pendingManualStart, setPendingManualStart] = useState(false);
  const practiceMockCue = useRef<'rest' | 'auto'>('auto');
  const setPracticeCue = useCallback((cue: 'rest' | 'auto') => { practiceMockCue.current = cue; }, []);

  useEffect(() => {
    if (!session) navigate('/', { replace: true });
  }, [navigate, session]);

  useEffect(() => {
    if (!measuredSession || measuredSession.stage === 'done') {
      if (measuredSession?.stage === 'done' && measuredSession.repeatRoundsVersion !== 1) clearClientSession();
      return;
    }
    saveClientSession(measuredSession);
  }, [measuredSession]);

  const gesture = DEFAULT_GESTURES.find((item) => item.id === gestureId) ?? DEFAULT_GESTURES[0];
  const generateMockSignalValue = useCallback(() => {
    const cycleMs = 4800;
    const cyclePosition = Date.now() % cycleMs;
    const state = practiceMockCue.current === 'rest' ? 'idle' : cyclePosition > 1500 && cyclePosition < 3300 ? 'active' : 'idle';
    return getChannelMockSignalValue(channelIndex, cyclePosition / cycleMs, state);
  }, [channelIndex]);

  const {
    signalData,
    recordingSignalData,
    isStreaming,
    streamEpoch,
    streamInterruptionReason,
    subscribeRawPoints,
    subscribeSourceInterruptions,
    selectSignalSourceMode,
    startStreamForMode,
    stopStream,
    liveConnectionStatus,
    liveConnectionMessage,
    liveDeviceName,
    liveSampleRateHz,
    isBluetoothAvailable,
    isDisplayScaleFrozen,
    freezeDisplayScale,
    getDisplayValueForNormalizedActivity,
  } = useSignalSource(generateMockSignalValue, DISPLAY_WINDOW_MS, channelIndex, 1);

  const calibrationScope = `${session?.participantId}:${session?.experimentId}:${session?.sessionId}:${session?.generation}:${session?.round}:${session?.condition}:${signalMode}:${channelIndex}`;
  const calibration = isStreaming && calibrationState?.scope === calibrationScope && calibrationState.epoch === streamEpoch ? calibrationState.value : null;
  // Historical archives never imply live readiness after reload or a stream boundary.
  useEffect(() => { setCalibrationState(null); }, [calibrationScope, streamEpoch, isStreaming]);
  const calibratedSignalData = useMemo(() => calibration ? signalData.map(point => ({ ...point, value: Math.min(1, Math.max(0, point.activityEnvelope / calibration.displayMax)) })) : signalData, [signalData, calibration]);

  useEffect(() => {
    if (!practiceSetupRef.current) practiceMockCue.current = gesture.id === 'relax' && session?.stage === 'capture' ? 'rest' : 'auto';
  }, [gesture.id, practiceMode, recalibrating, session?.stage]);

  const practiceSetupRef = useRef(practiceMode === 'setup');
  practiceSetupRef.current = practiceMode === 'setup' || recalibrating;
  const trials = session?.trials ?? [];
  const stage = session?.stage ?? 'capture';
  const isRelax = gesture.id === 'relax';
  const manualTrigger = (session?.manualTrigger ?? false) || isRelax;
  const triggerMode: CaptureTriggerMode = manualTrigger ? 'button' : 'threshold';
  const capturesMax = session?.capturesMax ?? session?.capturesPerRound ?? 1;
  const capturesMin = Math.min(session?.capturesMin ?? capturesMax, capturesMax);
  const selectedKept = keptForGesture(trials, gestureId);
  const selectedFull = selectedKept >= capturesMax;
  const roundComplete = samplesComplete(DEFAULT_GESTURES, trials, capturesMin);
  const countingDown = countdownEndsAt !== null;
  const practiceSetup = practiceMode === 'setup';
  const inPractice = practiceMode === 'rehearsal';
  const briefPractice = inPractice && (session?.protocolVersion === 'between-subject-v1' || session?.protocolVersion === 'between-subject-v2');
  const currentPractice = practiceDisposition(measuredSession);
  const practiceRequired = session?.protocolVersion === 'between-subject-v2' && !currentPractice;
  const practiceActive = practiceSetup || recalibrating;
  const recoveryDialogKey = JSON.stringify([calibrationScope, streamEpoch, isStreaming]);
  const showRecoveryDialog = signalMode === 'live' && !!streamInterruptionReason && stage !== 'done'
    && !submissionOperation.current && (!isStreaming || !calibration) && (!isStreaming || !practiceActive)
    && dismissedRecoveryKey !== recoveryDialogKey;
  useEffect(() => { if (!isStreaming) setPauseConfirmation(false); }, [isStreaming]);
  const datasetLocked = !inPractice && !!session?.protocolState?.lock;
  const streamReady = isStreaming && (inPractice || session?.isTestParticipant === true || (signalMode === 'live' && liveConnectionStatus === 'streaming'));
  gameStreamRef.current = { ready: streamReady, source: signalMode };

  const waveDomain = useMemo(() => sharedWaveDomain(
    trials.map((trial) => displayEnvelopeWaveform(
      alignWaveform(trial.points, trial.preTriggerPointCount, trial.triggeredAt),
    )),
  ), [trials]);

  const subscribeSubmissionRaw = useCallback((listener: (point: (typeof recordingSignalData)[number]) => void, includePending = false) =>
    subscribeRawPoints?.(point => {
      if (!submissionOperation.current?.rawSealed && sessionRef.current?.stage !== 'done') listener(point);
    }, includePending) ?? (() => {}), [subscribeRawPoints]);
  const subscribeSubmissionInterruptions = useCallback((listener: (reason: string) => void) =>
    subscribeSourceInterruptions?.(reason => {
      if (!submissionOperation.current?.rawSealed && sessionRef.current?.stage !== 'done') listener(reason);
    }) ?? (() => {}), [subscribeSourceInterruptions]);
  const captureContextArchive = useCoreCaptureContextArchive(session, (stage !== 'done' || session?.repeatRoundsVersion === 1) && !inPractice && !practiceActive && serverVerified && isPilotProtocol(session?.protocolVersion), signalMode, streamEpoch, channelIndex, recordingSignalData, subscribeSubmissionRaw, subscribeSubmissionInterruptions);
  const [parentRecoveryError, setParentRecoveryError] = useState('');
  const [retryingRecovery, setRetryingRecovery] = useState(false);
  const recoveryError = captureContextArchive.recoveryError || parentRecoveryError;
  const recoveryBlocked = useRef('');
  recoveryBlocked.current = recoveryError;
  const reportRecoveryFailure = useCallback((cause: unknown) => {
    const message = cause instanceof Error ? cause.message : String(cause);
    recoveryBlocked.current = message;
    setParentRecoveryError(message);
    setSaveError(message);
  }, []);
  const recoveryRetryOperation = useRef<object | null>(null);
  // Source/cue boundaries retire UI continuations, not the archive's immutable
  // destination or its pending raw evidence. Authorization also fences Retry.
  const recoveryRetryScope = JSON.stringify([calibrationScope, streamEpoch, isStreaming, practiceMode, practiceActive, stage, serverVerified, datasetLocked]);
  const recoveryRetryScopeRef = useRef(recoveryRetryScope);
  recoveryRetryScopeRef.current = recoveryRetryScope;
  const retryRawRecovery = async () => {
    const owner = recoveryCueOwner.current;
    const handoff = cueHandoff.current;
    const operation = {};
    recoveryRetryOperation.current = operation;
    const isCurrent = () => recoveryRetryOperation.current === operation
      && recoveryRetryScopeRef.current === recoveryRetryScope
      && recoveryCueOwner.current.recorder === owner.recorder
      && recoveryCueOwner.current.attemptId === owner.attemptId
      && cueHandoff.current === handoff;
    const finish = () => {
      if (!isCurrent()) return;
      recoveryRetryOperation.current = null;
      setRetryingRecovery(false);
    };
    setRetryingRecovery(true);
    // Retain the UI/producer fence even if retryRecovery clears its hook error
    // before the durable collection queue has actually acknowledged the bytes.
    setParentRecoveryError(recoveryError || 'Raw/context recovery is awaiting collection acknowledgement.');
    try {
      await captureContextArchive.retryRecovery();
      if (!isCurrent()) return;
      await captureContextArchive.drain();
      if (!isCurrent()) return;
      await whenCollectionSaved();
      if (!isCurrent()) return;
      // Finish under the captured handoff before replacing its ACK barrier.
      finish();
      cueHandoff.current = null;
      setReadyCueId(owner.attemptId);
      setParentRecoveryError('');
      setSaveError('');
    } catch (cause) { if (isCurrent()) reportRecoveryFailure(cause); }
    finally { finish(); }
  };
  const recorderAttempt = useMemo(() => ({ attemptId: collectionId('attempt'), gestureId, cueAt: Date.now(), ...(retryOfAttempt.current ? { retryOf: retryOfAttempt.current } : {}) }), [calibrationScope, streamEpoch, practiceMode, practiceActive, calibration?.revision, gestureId, trials.length, opportunityRetry]);
  const [readyCueId, setReadyCueId] = useState(recorderAttempt.attemptId);
  const cueHandoff = useRef<Promise<void> | null>(null);
  const recoveryCueOwner = useRef({ recorder: captureContextArchive.recorder, attemptId: recorderAttempt.attemptId });
  recoveryCueOwner.current = { recorder: captureContextArchive.recorder, attemptId: recorderAttempt.attemptId };
  useEffect(() => {
    recoveryRetryOperation.current = null;
    setRetryingRecovery(false);
    return () => { recoveryRetryOperation.current = null; };
  }, [recoveryRetryScope, recorderAttempt, captureContextArchive.recorder]);
  const armed = readyCueId === recorderAttempt.attemptId && !recoveryError && !opportunityTimedOut && serverVerified && !datasetLocked && !practiceActive && !saving && !training && stage === 'capture' && isStreaming && !(signalMode === 'live' && streamInterruptionReason && !calibration) && !selectedFull && !countingDown && (session?.protocolVersion === 'between-subject-v2' ? calibration !== null && (inPractice || !practiceRequired) : manualTrigger || calibration !== null) && (!inPractice || captureIntroduced) && gameIntroduction === null;
  const latestSourceTime = useRef(0); latestSourceTime.current = recordingSignalData[recordingSignalData.length - 1]?.time ?? Date.now();
  useEffect(() => () => {
    // Changing the displayed cue cancels an uncaptured opportunity, not the
    // independent post-context of an already completed center.
    const cancelled = captureContextArchive.recorder.cancelUncaptured(recorderAttempt.attemptId);
    const drained = captureContextArchive.drain();
    if (cancelled) cueHandoff.current = drained.then(() => whenCollectionSaved());
    void (cueHandoff.current ?? drained).catch(reportRecoveryFailure);
  }, [recorderAttempt, captureContextArchive.recorder, captureContextArchive.drain, reportRecoveryFailure]);
  useEffect(() => {
    let current = true;
    const handoff = cueHandoff.current;
    if (!handoff) setReadyCueId(recorderAttempt.attemptId);
    else void handoff.then(() => {
      if (current && !recoveryBlocked.current) {
        cueHandoff.current = null;
        setReadyCueId(recorderAttempt.attemptId);
      }
    }).catch(reportRecoveryFailure);
    return () => { current = false; };
  }, [recorderAttempt, reportRecoveryFailure]);

  const {
    cancelledOpportunityId,
    recorderState,
    thresholdReadiness,
    isRecording,
    recordingStartTime,
    recordingProgress,
    completedSegment,
    acknowledgeCompletedSegment,
  } = useGestureRecorder({
    signalPoints: recordingSignalData,
    contextRecorder: captureContextArchive.recorder,
    attemptMetadata: recorderAttempt,
    threshold: activityThreshold,
    frozenCalibration: calibration,
    segmentDurationMs,
    preTriggerWindowMs,
    isStreaming,
    resetKey: `${practiceActive}:${calibrationScope}:${streamEpoch}:${calibration?.revision}:${gestureId}:${segmentDurationMs}:${preTriggerWindowMs}`,
    triggerMode,
    manualTriggerToken,
    isArmed: armed,
    cooldownMs: RECORDER_COOLDOWN_MS,
  });

  useEffect(() => {
    setOpportunityTimedOut(false); retryOfAttempt.current = undefined;
  }, [calibrationScope, gestureId]);

  // A software opportunity is a displayed cue, not evidence that a person moved.
  // 15 seconds is an engineering timeout, never a physiological miss detector.
  useEffect(() => {
    if (inPractice || practiceActive || !armed || recorderState !== 'idle' || !isPilotProtocol(session?.protocolVersion)) return;
    try {
      if (captureContextArchive.recorder.hasUsedAttempt(recorderAttempt.attemptId) && !captureContextArchive.recorder.hasAttempt(recorderAttempt.attemptId)) return;
      if (!captureContextArchive.recorder.hasAttempt(recorderAttempt.attemptId)) captureContextArchive.recorder.beginAttempt(recorderAttempt);
    } catch (cause) { reportRecoveryFailure(cause); return; }
    if (manualTrigger) return;
    const timer = window.setTimeout(() => {
      if (!captureContextArchive.recorder.hasAttempt(recorderAttempt.attemptId)) return;
      captureContextArchive.recorder.endAttempt(recorderAttempt.attemptId, 'timeout', Math.max(recorderAttempt.cueAt, latestSourceTime.current));
      retryOfAttempt.current = recorderAttempt.attemptId;
      setOpportunityTimedOut(true);
      setNotice('This movement opportunity timed out without a recording. Rest, then choose Retry opportunity. This does not prove whether a movement was performed.');
    }, 15000);
    return () => window.clearTimeout(timer);
  }, [armed, recorderState, recorderAttempt, captureContextArchive.recorder, inPractice, practiceActive, manualTrigger, session?.protocolVersion, reportRecoveryFailure]);

  useEffect(() => {
    if (signalMode === 'live' && isRecording && !isDisplayScaleFrozen) {
      freezeDisplayScale();
    }
  }, [freezeDisplayScale, isDisplayScaleFrozen, isRecording, signalMode]);

  const sessionRef = useRef(session);
  sessionRef.current = session;
  const logRef = useRef<CollectionContext | null>(null);
  const handledSegment = useRef<typeof completedSegment>(null);
  const openCapture = useRef<{ sampleId: string; gestureId: string; gestureName: string; started: boolean } | null>(null);
  const reportedSignalError = useRef('');
  const revisionRef = useRef<string | null>(session?.modelRevisionId ?? null);
  const finishToken = useRef(0);
  const sawRecording = useRef(false);
  const captureSetupKey = useRef('');

  const cancelOpenCapture = useCallback((detail: string) => {
    const open = openCapture.current;
    openCapture.current = null;
    setCountdownEndsAt(null);
    setCountdownRemainingMs(0);
    setCaptureTimerOn(false);
    setPendingManualStart(false);
    sawRecording.current = false;
    if (!open) return;
    const context = logRef.current;
    if (context) {
      void recordCollection(context.participantId, [{
        kind: 'event',
        record: makeEvent(context, 'capture_cancelled', open.sampleId, null, detail),
      }]);
    }
    setSession((current) => (current ? { ...current, openCapture: null } : current));
  }, []);

  useEffect(() => {
    if (!cancelledOpportunityId) return;
    retryOfAttempt.current = cancelledOpportunityId;
    setOpportunityTimedOut(true);
    cancelOpenCapture('Opportunity interrupted; no sample was saved.');
    setNotice('Opportunity ended without a recording. Rest, then choose Retry opportunity for a new cue.');
  }, [cancelledOpportunityId, cancelOpenCapture]);

  const pressCapture = useCallback(() => {
    const current = sessionRef.current;
    if (submissionOperation.current || recoveryBlocked.current || trainingOperation.current || lockOperation.current || current?.protocolState?.lock && modeRef.current !== 'rehearsal' || !current || !manualTrigger || !armed || countdownEndsAt !== null || isRecording) return;
    const sampleId = collectionId('sample');
    const next = {
      sampleId,
      gestureId: gesture.id,
      gestureName: gesture.name,
      round: current.round,
      phase: 'countdown' as const,
    };
    openCapture.current = { sampleId, gestureId: gesture.id, gestureName: gesture.name, started: false };
    setSession((previous) => (previous ? { ...previous, openCapture: next } : previous));
    if (countdownMs <= 0) {
      openCapture.current.started = true;
      setSession((previous) => (previous?.openCapture ? { ...previous, openCapture: { ...previous.openCapture, phase: 'recording' } } : previous));
      setPendingManualStart(true);
      return;
    }
    setCountdownEndsAt(Date.now() + countdownMs);
  }, [armed, countdownEndsAt, countdownMs, gesture.id, gesture.name, isRecording, manualTrigger]);

  useEffect(() => {
    if (countdownEndsAt === null) return undefined;
    let finished = false;
    let timer = 0;
    const tick = () => {
      if (finished) return;
      const left = countdownEndsAt - Date.now();
      if (left > 0) {
        setCountdownRemainingMs(left);
        return;
      }
      finished = true;
      window.clearInterval(timer);
      setCountdownEndsAt(null);
      setCountdownRemainingMs(0);
      if (openCapture.current) openCapture.current.started = true;
      setSession((current) => (
        current?.openCapture
          ? { ...current, openCapture: { ...current.openCapture, phase: 'recording' } }
          : current
      ));
      setPendingManualStart(true);
    };
    timer = window.setInterval(tick, 100);
    tick();
    return () => {
      finished = true;
      window.clearInterval(timer);
    };
  }, [countdownEndsAt]);

  useEffect(() => {
    if (!pendingManualStart || !armed || !openCapture.current) return;
    const timer = window.setTimeout(() => {
      if (!openCapture.current) return;
      setManualTriggerToken(token => token + 1);
      setCaptureTimerOn(true);
      setPendingManualStart(false);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [pendingManualStart, armed]);

  useEffect(() => {
    const key = `${gestureId}|${channelIndex}|${signalMode}|${isStreaming}|${session?.round ?? ''}|${segmentDurationMs}|${preTriggerWindowMs}|${activityThreshold}`;
    if (!captureSetupKey.current) {
      captureSetupKey.current = key;
      return;
    }
    if (captureSetupKey.current === key) return;
    captureSetupKey.current = key;
    if (openCapture.current && !sawRecording.current) {
      cancelOpenCapture('Countdown stopped before recording started.');
    } else if (sawRecording.current && !isRecording) {
      setCaptureTimerOn(false);
    }
  }, [activityThreshold, cancelOpenCapture, channelIndex, gestureId, isRecording, isStreaming, preTriggerWindowMs, segmentDurationMs, session?.round, signalMode]);

  useEffect(() => {
    const context = logRef.current;
    if (!context || context.phase === 'done') return;
    void recordCollection(context.participantId, [{ kind: 'meta', record: context }]);
  }, [serverVerified, session?.sessionId, session?.round, session?.stage, session?.condition, session?.generation, signalMode, channelIndex, segmentDurationMs, preTriggerWindowMs, countdownMs, activityThreshold, liveSampleRateHz, liveDeviceName, capturesMin, capturesMax]);

  useEffect(() => {
    const context = logRef.current;
    const current = sessionRef.current;
    if (!context || !current) return;

    if (completedSegment && handledSegment.current !== completedSegment) {
      handledSegment.current = completedSegment;
      if (!inPractice && isPilotProtocol(current.protocolVersion) && !captureContextArchive.recorder.hasAttempt(completedSegment.attemptId)) {
        acknowledgeCompletedSegment();
        cancelOpenCapture('Delayed center has no bindable raw context; no sample was saved.');
        retryOfAttempt.current = completedSegment.attemptId;
        setOpportunityTimedOut(true);
        setNotice('The delayed center could not be associated with raw context. Retry with a new opportunity.');
        return;
      }
      const open = openCapture.current;
      // Retry lineage belongs to the accepted opportunity, not subsequent cues.
      retryOfAttempt.current = undefined;
      openCapture.current = null;
      sawRecording.current = false;
      setCaptureTimerOn(false);
      const sampleId = open?.sampleId ?? collectionId('sample');
      if (completedSegment.attemptId && captureContextArchive.recorder.hasAttempt(completedSegment.attemptId)) captureContextArchive.recorder.bindSample(completedSegment.attemptId, sampleId);
      const gestureIdForSample = open?.gestureId ?? gesture.id;
      const gestureName = open?.gestureName ?? gesture.name;
      const metrics = calculateMetrics(completedSegment.points);
      const points = completedSegment.points;
      const pending = current.pendingReplacements ?? [];
      const replacementIndex = pending.findIndex((item) => item.round === current.round && item.gestureId === gestureIdForSample);
      const replacedId = replacementIndex >= 0 ? pending[replacementIndex].sampleId : null;
      const nextPending = replacementIndex >= 0 ? pending.filter((_, index) => index !== replacementIndex) : pending;
      const savedForGesture = keptForGesture(current.trials, gestureIdForSample) + 1;
      const sample = {
        sampleId,
        centerDurationMs: completedSegment.centerDurationMs,
        attemptId: completedSegment.attemptId,
        sessionId: context.sessionId,
        participantId: context.participantId,
        experimentId: context.experimentId,
        condition: context.condition,
        round: context.round,
        phase: context.phase,
        gestureId: gestureIdForSample,
        gestureLabel: gestureName,
        capturedAt: Date.now(),
        recordingStartedAt: points[0]?.time ?? completedSegment.triggeredAt,
        recordingEndedAt: completedSegment.completedAt,
        triggeredAt: completedSegment.triggeredAt,
        preTriggerPointCount: completedSegment.preTriggerPointCount,
        calibration: completedSegment.calibration ?? null,
        firstCrossingAt: completedSegment.firstCrossingAt ?? null,
        pointCount: points.length,
        points,
        signalSource: context.signalSource,
        channelIndex: context.channelIndex,
        sampleRateHz: context.sampleRateHz,
        generation: context.generation,
        settings: context.settings,
      };
      const items = [
        { kind: 'sample' as const, record: sample },
        { kind: 'event' as const, record: makeEvent(context, 'capture_completed', sampleId, null, `captureProcedure=${gestureIdForSample === 'relax' ? 'cued_rest' : completedSegment.triggerMode}; assignedCondition=${context.condition}; recorderTriggerMode=${completedSegment.triggerMode}`) },
      ];
      if (replacedId) items.push({ kind: 'event', record: makeEvent(context, 'sample_replaced', replacedId, sampleId, '') });
      void recordCollection(context.participantId, items);
      setSession((previous) => {
        if (!previous) return previous;
        const trial: StoredTrial = {
          id: sampleId,
          centerDurationMs: completedSegment.centerDurationMs,
          attemptId: completedSegment.attemptId,
          condition: context.condition,
          gestureId: gestureIdForSample,
          gestureName,
          pairIndex: keptForGesture(previous.trials, gestureIdForSample) + 1,
          capturedAt: sample.capturedAt,
          triggeredAt: completedSegment.triggeredAt,
          completedAt: completedSegment.completedAt,
          preTriggerPointCount: completedSegment.preTriggerPointCount,
          calibration: completedSegment.calibration ?? null,
          firstCrossingAt: completedSegment.firstCrossingAt ?? null,
          points,
          quality: points.length >= 12 && metrics.durationMs >= segmentDurationMs * 0.85 ? 'usable' : 'review',
          metrics,
        };
        return { ...previous, protocolState: previous.protocolState ? { ...previous.protocolState, survey: null } : previous.protocolState, trials: [...previous.trials, trial], pendingReplacements: nextPending, openCapture: null };
      });
      if (savedForGesture >= capturesMax) setNotice(`${gestureName} has ${savedForGesture} examples, the maximum.`);
      else if (savedForGesture >= capturesMin) setNotice(`${gestureName} sample ${savedForGesture} kept. The minimum is in, and you can keep up to ${capturesMax}.`);
      else setNotice(`${gestureName} sample ${savedForGesture} of at least ${capturesMin} kept.`);
      acknowledgeCompletedSegment();
      return;
    }

    if (isRecording && openCapture.current && !openCapture.current.started) {
      openCapture.current.started = true;
    }

    if (isRecording && !openCapture.current) {
      const sampleId = collectionId('sample');
      openCapture.current = { sampleId, gestureId: gesture.id, gestureName: gesture.name, started: true };
      setSession((previous) => (previous ? {
        ...previous,
        openCapture: {
          sampleId,
          gestureId: gesture.id,
          gestureName: gesture.name,
          round: previous.round,
          phase: 'recording',
        },
      } : previous));
    }

    if (isRecording && openCapture.current?.started && !sawRecording.current) {
      sawRecording.current = true;
      void recordCollection(context.participantId, [{
        kind: 'event',
        record: makeEvent(context, 'capture_started', openCapture.current.sampleId, null, ''),
      }]);
      return;
    }

    if (!isRecording && sawRecording.current && !completedSegment) {
      sawRecording.current = false;
      setCaptureTimerOn(false);
      cancelOpenCapture('Recording stopped before a sample was saved.');
    }
  }, [acknowledgeCompletedSegment, cancelOpenCapture, capturesMax, capturesMin, completedSegment, gesture.id, gesture.name, isRecording, segmentDurationMs]);

  useEffect(() => {
    if (liveConnectionStatus !== 'error') {
      reportedSignalError.current = '';
      return;
    }
    const detail = liveConnectionMessage || 'The signal source reported an error.';
    if (reportedSignalError.current === detail) return;
    reportedSignalError.current = detail;
    const context = logRef.current;
    if (!context) return;
    void recordCollection(context.participantId, [{
      kind: 'event',
      record: makeEvent(context, 'capture_error', openCapture.current?.sampleId ?? null, null, detail),
    }]);
  }, [liveConnectionMessage, liveConnectionStatus]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      // Focused controls keep their native Space activation; only background
      // Space starts a manual capture. This also protects the theme/notices UI.
      if (target?.isContentEditable || target?.closest('button, a, input, select, textarea, summary, [role="button"], [data-practice-entry]')) return;
      if (event.code === 'Space' && manualTrigger && armed && recorderState === 'idle') {
        event.preventDefault();
        pressCapture();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [armed, manualTrigger, pressCapture, recorderState]);

  useEffect(() => {
    if (!session) return;
    const condition: Assignment = session.condition;
    setModelState(markDatasetChanged(
      modelScope(session),
      condition,
      session.trials.map((trial) => trial.id),
    ));
  }, [session]);

  useEffect(() => registerGameRunListener((handoff) => {
    const current = sessionRef.current;
    if (submissionOperation.current || current?.stage === 'done' || !current || handoff.condition !== current.condition || (current.stage !== 'game' && handoff.completionStatus !== 'incomplete') || (!gameStreamRef.current.ready && handoff.completionStatus !== 'incomplete')) return;
    const interrupted = handoff.completionStatus === 'incomplete';
    if (recoveryBlocked.current && !interrupted) return;
    const launched = activeGameRef.current;
    if (!isModelReady(modelScope(current), current.condition, current.trials.map((trial) => trial.id)) && !interrupted) return;
    if (interrupted && (!launched || launched.participantId !== current.participantId || launched.sessionId !== current.sessionId
      || launched.generation !== current.generation || launched.round !== current.round || launched.condition !== current.condition)) return;
    if (handoff.runId && current.runs.some(run=>run.id===handoff.runId)) return;
    if (modeRef.current !== 'rehearsal' && isPilotProtocol(current.protocolVersion)) {
      if (!handoff.runKind || !handoff.completionStatus || (handoff.completionStatus === 'complete' && (handoff.outcomes.length!==20 || JSON.stringify(handoff.officialSequence)!==JSON.stringify(current.officialSequence)))) {
        setNotice('The game did not return a complete protocol result. No official result was recorded.'); return;
      }
    }
    const run: StoredGameRun = {
      runKind: handoff.runKind ?? (modeRef.current === 'rehearsal' ? 'practice' : current.runs.some(r=>r.condition===current.condition && r.round===current.round && r.runKind==='official' && r.completionStatus==='complete') ? 'replay' : 'official'),
      completionStatus: handoff.completionStatus ?? 'complete',
      runId: handoff.runId,
      startedAt: handoff.startedAt,
      endedAt: handoff.endedAt,
      ...(handoff.activeDurationMs !== undefined ? { activeDurationMs: handoff.activeDurationMs, sourceRecoveryPauses: handoff.sourceRecoveryPauses } : {}),
      invalidationReason: handoff.invalidationReason,
      officialSequence: current.officialSequence,
      signalSource: launched?.source ?? gameStreamRef.current.source,
      streamReady: gameStreamRef.current.ready,
      evidenceKind: launched?.evidenceKind ?? (modeRef.current === 'rehearsal' ? 'practice' : current.isTestParticipant ? 'synthetic-test' : 'measured-live'),
      id: handoff.runId ?? `${current.participantId}-${Date.now()}`,
      sessionId: current.sessionId,
      round: current.round,
      recordedAt: Date.now(),
      condition: current.condition,
      difficulty: handoff.difficulty || DEFAULT_DIFFICULTY,
      gameScore: handoff.gameScore,
      outcomes: handoff.outcomes,
      modelRevisionId: launched?.modelRevisionId ?? current.modelRevisionId ?? revisionRef.current,
      obstacleSuccess: typeof handoff.obstacleSuccess === 'boolean' ? handoff.obstacleSuccess : null,
    };
    setSession((previous) => {
      if (!previous) return previous;
      return {
        ...previous,
        runs: [...previous.runs, run],
        stage: handoff.completionStatus === 'incomplete' ? previous.stage : 'results',
        unlockedThrough: handoff.completionStatus === 'incomplete' ? previous.unlockedThrough : 'results',
      };
    });
    void recordCollection(current.participantId, [{ kind: 'run', record: { ...run, generation: current.generation } }]);
  }), []);

  useEffect(() => () => {
    finishToken.current += 1;
  }, []);

  useEffect(() => {
    const current = sessionRef.current;
    const context = logRef.current;
    if (!current || !context) return;
    const open = current.openCapture;
    if (open?.sampleId && open.round === current.round) {
      const key = `capture:${current.generation}:${current.sessionId}:${open.sampleId}`;
      if (!recoveredInterruptions.has(key)) {
        recoveredInterruptions.add(key);
        const detail = open.phase === 'countdown'
          ? 'Countdown stopped before recording started.'
          : 'Recording stopped before a sample was saved.';
        void recordCollection(current.participantId, [{
          kind: 'event',
          record: makeEvent(context, 'capture_cancelled', open.sampleId, null, detail),
        }]);
      }
      setSession((previous) => (previous?.openCapture ? { ...previous, openCapture: null } : previous));
    }
    const training = current.trainingRun;
    if (training?.revisionId && training.round === current.round && current.protocolState?.trainingStatus !== 'success' && !isTrainingInFlight(modelScope(current), current.condition)) {
      const key = `train:${current.generation}:${current.sessionId}:${training.revisionId}`;
      if (!recoveredInterruptions.has(key)) {
        recoveredInterruptions.add(key);
        void recordCollection(current.participantId, [{
          kind: 'training',
          record: {
            revisionId: training.revisionId,
            sessionId: context.sessionId,
            participantId: context.participantId,
            generation: context.generation,
            condition: context.condition,
            round: training.round,
            sampleIds: training.sampleIds,
            classifier: 'knn',
            settings: context.settings,
            startedAt: training.startedAt,
            finishedAt: Date.now(),
            status: 'failure',
            error: 'Training stopped before the model was ready.',
          },
        }]);
      }
      setTraining(false);
      setSession((previous) => (previous?.trainingRun ? { ...previous, trainingRun: null } : previous));
    }
  }, [session?.sessionId, session?.generation]);

  useEffect(() => {
    if (!session) return undefined;
    const timer = window.setTimeout(() => {
      const current = sessionRef.current;
      const context = logRef.current;
      if (submissionOperation.current || !current || !context || current.stage === 'done') return;
      void recordCollection(current.participantId, [{
        kind: 'checkpoint',
        record: {
          sessionId: current.sessionId,
          condition: current.condition,
          generation: current.generation,
          round: current.round,
          stage: current.stage,
          unlockedThrough: current.unlockedThrough,
          modelRevisionId: current.modelRevisionId,
          trials: current.trials,
          pendingReplacements: current.pendingReplacements ?? [],
          openCapture: current.openCapture,
          trainingRun: current.trainingRun,
          updatedAt: Date.now(),
        },
      }]);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [session]);

  useEffect(() => {
    const send = () => {
      const current = sessionRef.current;
      if (submissionOperation.current || !serverVerifiedRef.current || !current || current.stage === 'done' || modeRef.current !== 'measured') return;
      const body = JSON.stringify({
        id: current.participantId,
        items: [{
          kind: 'checkpoint',
          record: {
            sessionId: current.sessionId,
            condition: current.condition,
            generation: current.generation,
            round: current.round,
            stage: current.stage,
            unlockedThrough: current.unlockedThrough,
            modelRevisionId: current.modelRevisionId,
            trials: current.trials,
            pendingReplacements: current.pendingReplacements ?? [],
            openCapture: current.openCapture,
            trainingRun: current.trainingRun,
            updatedAt: Date.now(),
          },
        }],
      });
      navigator.sendBeacon('/api/study/collection', new Blob([body], { type: 'application/json' }));
    };
    window.addEventListener('pagehide', send);
    return () => window.removeEventListener('pagehide', send);
  }, []);

  if (session) {
    logRef.current = {
      participantId: session.participantId,
      sessionId: session.sessionId,
      experimentId: session.experimentId,
      condition: session.condition,
      round: session.round,
      phase: session.stage,
      signalSource: signalMode,
      channelIndex,
      sampleRateHz: liveSampleRateHz,
      deviceName: liveDeviceName,
      generation: session.generation,
      settings: {
        segmentDurationMs,
        preTriggerWindowMs,
        countdownMs,
        activityThreshold,
        cooldownMs: RECORDER_COOLDOWN_MS,
        capturesMin,
        capturesMax,
        featureSetId: DEFAULT_FEATURE_SET_ID,
        classifier: 'knn',
      },
    };
  }

  if (!session) return null;
  if (!isPilotProtocol(session.protocolVersion) && !session.isTestParticipant) {
    return <main className="mx-auto max-w-2xl p-8 text-white"><h1 className="text-xl">Historical fixed-condition protocol</h1><p className="mt-4">These records have not been converted to a two-visit pilot or reinterpreted as 2-second examples. Ask the researcher to archive/export this historical session. New pilot assignments must be created explicitly; do not rename old condition IDs or merge their data.</p><button type="button" onClick={()=>navigate('/')}>Return to sign-in</button></main>;
  }
  // Do not reinterpret or migrate a saved movement to a different physical class.
  if (session.trials.some(trial => !DEFAULT_GESTURES.some(gesture => gesture.id === trial.gestureId))
    || session.runs.some(run => run.outcomes.some(outcome => !DEFAULT_GESTURES.some(gesture => gesture.id === outcome.expectedGestureId)))) {
    return <main className="mx-auto max-w-2xl p-8 text-white"><h1 className="text-xl">Historical gesture set</h1><p className="mt-4">This saved session uses an earlier gesture set. Its records have not been renamed or deleted. Ask the researcher to archive it and use a new participant session for Wrist up / Wrist down (palm down). Do not mix earlier examples with wrist examples.</p></main>;
  }

  const signalValue = calibratedSignalData[calibratedSignalData.length - 1]?.value ?? 0;
  const captureStatus: CaptureStatus = recoveryError
    ? { label: 'Error', detail: 'Raw context backup must recover before continuing.' }
    : liveConnectionStatus === 'error'
    ? { label: 'Error', detail: 'Check the connection message.' }
    : !isStreaming ? { label: 'Rest', detail: 'Connect your device to begin.' }
      : isRecording ? { label: 'Recording', detail: isRelax ? 'Keep your hand resting.' : `Keep doing ${gesture.name}.` }
        : countingDown ? { label: 'Movement', detail: 'Get ready for the recording.' }
          : selectedFull || roundComplete ? { label: 'Movement', detail: roundComplete ? 'Review your recorded examples.' : 'Choose the next movement.' }
            : !manualTrigger && !calibration ? { label: 'Rest', detail: 'Complete your resting setup.' }
              : !armed ? { label: 'Rest', detail: 'Follow the highlighted instruction.' }
                : recorderState !== 'idle' ? { label: 'Rest', detail: 'Rest your hand before the next recording.' }
                  : manualTrigger ? { label: 'Ready', detail: 'Press Capture when you are ready.' }
                    : thresholdReadiness === 'ready' ? { label: 'Ready', detail: `You can make ${gesture.name}.` }
                      : thresholdReadiness === 'movement' ? { label: 'Movement', detail: `Keep doing ${gesture.name}.` }
                        : { label: 'Rest', detail: 'Rest your hand until Ready appears.' };
  const condition: Assignment = session.condition;
  const trialIds = trials.map((trial) => trial.id);
  const modelReady = !recoveryError && !training && isModelReady(modelScope(session), condition, trialIds);
  if (stage === 'game' && modelReady && streamReady) {
    activeGameRef.current = {
      participantId: session.participantId, sessionId: session.sessionId, generation: session.generation,
      round: session.round, condition, modelRevisionId: session.modelRevisionId ?? revisionRef.current,
      source: signalMode, evidenceKind: inPractice ? 'practice' : session.isTestParticipant ? 'synthetic-test' : 'measured-live',
    };
  }
  const gamePredictionEngine = getConditionPredictionEngine(
    modelScope(session),
    condition,
    trialIds,
  );
  const predictGameWindow = (points: Array<{ time: number; raw: number }>) => {
    if (!gamePredictionEngine || points.length === 0) return null;
    const sample = buildInferenceSample(points, INFERENCE_WINDOW_MS);
    return sample ? gamePredictionEngine.predict(sample) : null;
  };
  const quotas = gestureQuotas(DEFAULT_GESTURES, trials, capturesMin, capturesMax);
  const missingQuotas = quotas.filter((row) => row.missing > 0);
  const cappedKept = quotas.reduce((sum, row) => sum + Math.min(row.kept, row.minimum), 0);
  const totalRequired = DEFAULT_GESTURES.length * capturesMin;
  const reachedIndex = flowIndex(session.unlockedThrough ?? stage);
  const renderTrial = (trial: StoredTrial) => {
    const quota = quotas.find((row) => row.gesture.id === trial.gestureId);
    return (
      <TrialCard
        key={trial.id}
        trial={trial}
        sampleIndex={sampleNumber(trials, trial.id)}
        kept={quota?.kept ?? 0}
        minimum={quota?.minimum ?? capturesMin}
        maximum={quota?.maximum ?? capturesMax}
        domain={waveDomain}
        onInspect={() => { setInspectedTrialId(trial.id); if (practiceArchive.current) void practiceArchive.current.enqueue(practiceArchive.current.record('reviewed', { referenceId: trial.id })); }}
        onDelete={() => deleteKeptTrial(trial.id)}
        deletingDisabled={training || datasetLocked}
      />
    );
  };

  const hasRunThisRound = session.runs.some((run) => run.round === session.round && run.condition === condition);
  const canVisit = (next: FlowStage) => {
    if (submissionOperation.current || recoveryBlocked.current || trainingOperation.current) return false;
    if (stage === 'done') return false;
    if (next === 'capture') return !datasetLocked;
    if (next === 'review') return trials.length > 0 || stage === 'review' || stage === 'game' || stage === 'results';
    if (next === 'game') return !briefPractice && serverVerified && roundComplete && modelReady && gameStreamRef.current.ready;
    return hasRunThisRound || (roundComplete && modelReady && reachedIndex >= flowIndex('game'));
  };

  const deleteKeptTrial = (trialId: string) => {
    if (submissionOperation.current || trainingOperation.current || lockOperation.current || sessionRef.current?.protocolState?.lock && modeRef.current !== 'rehearsal') return;
    const trial = session.trials.find((item) => item.id === trialId);
    if (!trial) return;
    setSession((current) => {
      if (!current) return current;
      return {
        ...current,
        protocolState: current.protocolState ? { ...current.protocolState, survey: null } : current.protocolState,
        trials: current.trials.filter((item) => item.id !== trialId),
        pendingReplacements: [
          ...(current.pendingReplacements ?? []),
          { round: current.round, gestureId: trial.gestureId, sampleId: trial.id },
        ],
      };
    });
    if (inspectedTrialId === trialId) setInspectedTrialId(null);
    const context = logRef.current;
    if (context) {
      void recordCollection(context.participantId, [{
        kind: 'event',
        record: makeEvent(context, 'sample_deleted', trial.id, null, ''),
      }]);
    }
    setNotice('Example removed. Return to Capture if that gesture is below the minimum.');
  };

  const confirmSurvey = async () => {
    if (submissionOperation.current || recoveryBlocked.current || trainingOperation.current || lockOperation.current || !roundComplete || !researcherPin || captureContextArchive.recorder.pendingWindowCount > 0) return;
    const origin = session;
    lockOperation.current = true; setSaving(true); setSaveError('');
    try {
      await captureContextArchive.drain();
      await whenCollectionSaved();
      if (recoveryBlocked.current) throw new Error(recoveryBlocked.current);
      if (sessionRef.current !== origin) throw new Error('Collection changed. Review the retained examples before confirmation.');
      const protocolState = await confirmCollectionSurvey(origin, researcherPin);
      setResearcherPin('');
      setMeasuredSession(current => current?.sessionId === origin.sessionId ? { ...current, protocolState } : current);
    } catch (cause) { setSaveError(cause instanceof Error ? cause.message : 'Survey confirmation failed.'); }
    finally { lockOperation.current = false; setSaving(false); }
  };

  const trainModel = async () => {
    if (submissionOperation.current || recoveryBlocked.current || sessionRef.current !== session || briefPractice) return;
    if (!serverVerified || !roundComplete || trainingOperation.current || lockOperation.current || isRecording || countingDown || openCapture.current || (!inPractice && isPilotProtocol(session.protocolVersion) && captureContextArchive.recorder.pendingWindowCount > 0)) return;
    if (!inPractice && isPilotProtocol(session.protocolVersion) && ((requiresCollectionSurvey(session.protocolVersion) && !session.protocolState?.survey) || practiceRequired || (datasetLocked && modelReady))) return;
    const origin = session;
    const archive = practiceArchive.current;
    const context = logRef.current;
    if (!context || (modeRef.current !== 'measured' && !archive)) return;
    const operation = { scope: archive?.scope ?? modelScope(origin), condition };
    trainingOperation.current = operation;
    const active = () => trainingOperation.current === operation;
    // Never choose a destination, dataset or model scope after an await.
    const updateOrigin = archive ? setRehearsal : setMeasuredSession;
    const collect = archive
      ? (items: Parameters<typeof recordMeasuredCollection>[1]) => archive.collect(items)
      : (items: Parameters<typeof recordMeasuredCollection>[1]) => recordMeasuredCollection(origin.participantId, items);
    const barrier = () => archive ? archive.barrier() : whenCollectionSaved();
    setTraining(true);
    setModelState((current) => (current ? { ...current, status: 'training', error: '' } : current));
    const startedAt = Date.now();
    const revisionId = (!archive && origin.protocolState?.lock?.revisionId) || collectionId('rev');
    const trainingAttemptId = collectionId('train-attempt');
    const restoringLockedModel = !archive && origin.protocolState?.trainingStatus === 'success';
    const sampleIds = trials.map((trial) => trial.id);
    updateOrigin((current) => (current ? { ...current, trainingRun: restoringLockedModel ? null : { revisionId, startedAt, round: origin.round, sampleIds } } : current));
    try {
      if (!archive) await captureContextArchive.drain();
      await barrier();
      if (!active()) return;
      if (recoveryBlocked.current) throw new Error(recoveryBlocked.current);
      if (!archive && isPilotProtocol(origin.protocolVersion)) {
        const protocolState = await lockOfficialDataset(origin, revisionId);
        if (!active()) return;
        updateOrigin(current => current ? { ...current, protocolState } : current);
      }
      const next = await trainConditionModel(operation.scope, condition, origin.trials, DEFAULT_GESTURES, segmentDurationMs);
      if (!active()) return;
      const success = next.status === 'ready';
      if (!restoringLockedModel) await collect([{
          kind: 'training',
          record: {
            trainingAttemptId,
            revisionId,
            sessionId: context.sessionId,
            participantId: context.participantId,
            generation: context.generation,
            condition,
            round: context.round,
            sampleIds,
            classifier: 'knn',
            settings: context.settings,
            startedAt,
            finishedAt: Date.now(),
            status: success ? 'success' : 'failure',
            error: success ? '' : next.error,
          },
      }]);
      await barrier();
      if (!active()) return;
      if (recoveryBlocked.current) throw new Error(recoveryBlocked.current);
      if (success) revisionRef.current = revisionId;
      updateOrigin((current) => (current ? {
        ...current,
        modelRevisionId: success ? revisionId : current.modelRevisionId,
        trainingRun: null,
      } : current));
      setModelState(next);
      setNotice(success ? 'Model ready for this condition.' : next.error || 'The model is not ready.');
    } catch (cause) {
      if (!active()) return;
      // Construction can have finished before a save failed. Such a model is
      // not playable without its archive; keep the immutable queue for Retry.
      markDatasetChanged(operation.scope, condition, []);
      setModelState(markDatasetChanged(operation.scope, condition, sampleIds));
      setNotice(cause instanceof Error ? cause.message : 'Training could not finish. Retry saving, then train again.');
      updateOrigin(current => current ? { ...current, trainingRun: null } : current);
    } finally {
      if (active()) {
        trainingOperation.current = null;
        setTraining(false);
      }
    }
  };

  const practiceGuide = inPractice && !practiceActive ? practiceGuidance({
    brief: briefPractice, stage: gameIntroduction ? 'game-introduction' : stage, condition: session.condition, streaming: isStreaming, calibrated: calibration !== null,
    introduced: captureIntroduced, firstSampleExplained, sampleCount: trials.length, selectedFull, roundComplete,
    gestureName: gesture.name, nextGesture: missingQuotas[0]?.gesture.name ?? 'the next gesture', relax: isRelax, manual: manualTrigger,
    recording: isRecording, countdown: countingDown, inspecting: inspectedTrialId !== null, training,
    missing: missingQuotas.length > 0, reviewed: practiceArchive.current?.saved.some(record => record.kind === 'reviewed' && trials.some(trial => trial.id === record.referenceId)) ?? false,
    removed: practiceArchive.current?.saved.some(record => record.kind === 'removed') ?? false, modelReady,
    saveError: !!practiceArchive.current?.error, introduce: () => setCaptureIntroduced(true), explainSample: () => setFirstSampleExplained(true),
  }) : null;

  const goTo = (next: FlowStage, startPracticeGame = false) => {
    if (!canVisit(next)) return;
    if (next === 'game' && modeRef.current === 'rehearsal') {
      const current = sessionRef.current;
      if (!current || trainingOperation.current || !current.modelRevisionId || !isModelReady(modelScope(current), current.condition, current.trials.map(trial => trial.id))) return;
      const scope = modelScope(current);
      const revision = current.modelRevisionId;
      if (startPracticeGame) {
        if (gameIntroduction?.scope !== scope || gameIntroduction.revision !== revision) return;
        setIntroducedGameRevision(`${scope}:${revision}`);
      } else if (introducedGameRevision !== `${scope}:${revision}`) {
        setGameIntroduction({ scope, revision });
        return;
      }
    }
    setGameIntroduction(null);
    setSession((current) => {
      if (!current || current.stage === 'done') return current;
      const reached = Math.max(flowIndex(current.unlockedThrough ?? current.stage), flowIndex(next));
      return { ...current, stage: next, unlockedThrough: FLOW[reached] };
    });
  };

  const toggleStream = async () => {
    if (submissionOperation.current) return;
    if (isStreaming) {
      if (signalMode === 'live') { setPauseConfirmation(true); return; }
      await stopStream();
      setNotice('Stream paused. Captures from this round are still here.');
      return;
    }
    if (recoveryBlocked.current) return;
    await startStreamForMode(signalMode);
    setNotice(manualTrigger ? 'Press Capture when the gesture begins.' : 'Perform the gesture when you are ready.');
  };

  const confirmStreamPause = async () => {
    if (pauseOperation.current || submissionOperation.current || !isStreaming) return;
    pauseOperation.current = true;
    setConfirmingPause(true);
    try {
      await stopStream();
      setNotice('Stream paused. Captures from this round are still here.');
      setPauseConfirmation(false);
    } finally {
      pauseOperation.current = false;
      setConfirmingPause(false);
    }
  };

  const redoRestSetup = () => {
    if (submissionOperation.current || recoveryBlocked.current || trainingOperation.current || isRecording || countingDown || saving) return;
    cancelOpenCapture('Recalibrating rest only.');
    setCalibrationState(null);
    setRecalibrating(true);
  };

  const skipPractice = async () => {
    const origin = measuredSession;
    const snapshot = sessionRef.current;
    const archive = practiceArchive.current;
    if (!origin || origin.protocolVersion !== 'between-subject-v2' || origin.trials.length || origin.protocolState?.lock
      || !inPractice || !calibration || !serverVerified || !researcherPin.trim() || saving || trainingOperation.current
      || lockOperation.current || practiceExitOperation.current || isRecording || countingDown || openCapture.current || recoveryBlocked.current) return;
    practiceExitOperation.current = true;
    const token = ++finishToken.current;
    setSaving(true); setSaveError('');
    try {
      await archive?.barrier();
      if (finishToken.current !== token) return;
      if (sessionRef.current !== snapshot) throw new Error('Practice changed while saving. Retry the researcher action.');
      const response = await skipGesturePractice(origin, researcherPin);
      if (finishToken.current !== token) return;
      // Verify the persisted disposition, not just a successful POST response.
      const joined = await joinStudy(origin.participantId);
      if (finishToken.current !== token) return;
      const verified = { ...origin, protocolState: joined.protocolState };
      if (sessionRef.current !== snapshot) throw new Error('Session changed while skipping practice. Rejoin to recover its saved status.');
      if (practiceDisposition({ ...origin, protocolState: response })?.status !== 'skipped'
        || practiceDisposition(verified)?.status !== 'skipped') throw new Error('Practice skip was not confirmed. Retry or rejoin.');
      practiceArchive.current = null;
      setMeasuredSession(verified); setRehearsal(null); setPracticeMode('measured');
      revisionRef.current = origin.modelRevisionId; openCapture.current = null;
      setInspectedTrialId(null); setGameIntroduction(null); setResearcherPin('');
      setNotice('Gesture practice skipped by researcher. Calibration is retained for this live source; measured examples are still required.');
    } catch (cause) { if (finishToken.current === token) setSaveError(cause instanceof Error ? cause.message : 'Practice skip could not save.'); }
    finally { practiceExitOperation.current = false; if (finishToken.current === token) setSaving(false); }
  };

  const finishRound = async () => {
    if (submissionOperation.current?.inFlight || submissionOperation.current?.phase === 'complete' || recoveryBlocked.current || !roundComplete || trainingOperation.current || practiceExitOperation.current) return;
    if (practiceArchive.current) {
      const archive = practiceArchive.current;
      const snapshot = session;
      practiceExitOperation.current = true;
      const token = ++finishToken.current;
      setSaving(true); setSaveError('');
      try {
        await archive.barrier();
        if (finishToken.current !== token) return;
        const latest = sessionRef.current;
        if (latest !== snapshot) throw new Error('Practice changed while saving. Review the current examples, then retry.');
        const reviewed = [...archive.saved].reverse().find(record => record.kind === 'reviewed' && snapshot.trials.some(trial => trial.id === record.referenceId));
        const removed = archive.saved.find(record => record.kind === 'removed');
        const game = [...snapshot.runs].reverse().find(run => run.modelRevisionId === snapshot.modelRevisionId && run.outcomes.some(item => item.result !== 'recording_failure'));
        const brief = archive.rest.flowVersion === 4;
        if (!reviewed || (!brief && (!removed || !game || !isModelReady(archive.scope, snapshot.condition, snapshot.trials.map(trial => trial.id))))) throw new Error(brief ? 'Inspect a retained example before measured collection.' : 'Inspect a retained sample, remove and replace an example, train, and finish an actual game before collection.');
        await archive.enqueue(archive.record('completed', { restId: archive.rest.id, sampleIds: snapshot.trials.map(trial => trial.id),
          reviewedId: reviewed.referenceId, ...(removed ? { removedId: removed.id } : {}),
          ...(!brief ? { trainingId: snapshot.modelRevisionId, gameId: game!.id } : {}) }));
        if (finishToken.current !== token) return;
        if (archive.pending.length || archive.error) throw new Error(archive.error || 'Practice completion is still waiting to save.');
        if (sessionRef.current !== snapshot) throw new Error('Practice changed while saving. Retry from Results.');
        if (snapshot.protocolVersion === 'between-subject-v2') {
          const joined = await joinStudy(snapshot.participantId);
          if (finishToken.current !== token) return;
          if (sessionRef.current !== snapshot) throw new Error('Practice changed while confirming completion. Retry from Results.');
          if (!measuredSession || practiceDisposition({ ...measuredSession, protocolState: joined.protocolState })?.status !== 'completed') throw new Error('Practice completion was not confirmed. Retry saving practice.');
          setMeasuredSession({ ...measuredSession, protocolState: joined.protocolState });
        }
        practiceArchive.current = null;
        setRehearsal(null); setPracticeMode('measured');
        revisionRef.current = measuredSession?.modelRevisionId ?? null;
        openCapture.current = null; setInspectedTrialId(null);
        setNotice('Practice saved. Now collect the measured examples using the same controls.');
      } catch (cause) { if (finishToken.current === token) setSaveError(cause instanceof Error ? cause.message : 'Practice could not finish.'); }
      finally { practiceExitOperation.current = false; if (finishToken.current === token) setSaving(false); }
      return;
    }
    if (!serverVerifiedRef.current || isRecording || countingDown || openCapture.current || stage !== 'results') return;
    const token = ++finishToken.current;
    let operation = submissionOperation.current;
    if (!operation) {
      const snapshot = structuredClone(session);
      const freeze = (value: unknown): void => {
        if (!value || typeof value !== 'object' || Object.isFrozen(value)) return;
        Object.values(value).forEach(freeze);
        Object.freeze(value);
      };
      freeze(snapshot);
      operation = { snapshot, inFlight: false, rawSealed: false, phase: 'draining' };
      submissionOperation.current = operation;
    }
    operation.inFlight = true;
    const { snapshot } = operation;
    setSaving(true);
    setSaveError('');
    try {
      if (operation.phase === 'draining') {
        // Drain any send already in flight, then seal synchronously. Points
        // arriving during that drain are included in the final flush, not lost
        // by replacing/disabling the raw recovery owner.
        await captureContextArchive.drain();
        operation.rawSealed = true;
        await captureContextArchive.flush('interrupted');
        await captureContextArchive.drain();
      }
      await whenCollectionSaved();
      if (finishToken.current !== token) return;
      if (recoveryBlocked.current) throw new Error(recoveryBlocked.current);
      operation.phase = 'posting';
      const result = await saveRound(snapshot.participantId, snapshot.round, snapshot.trials, snapshot);
      if (finishToken.current !== token) return;
      if (result.status === 'completed' && snapshot.repeatRoundsVersion === 1) {
        await stopStream();
        const joined = await joinStudy(snapshot.participantId);
        if (finishToken.current !== token) return;
        if (joined.status !== 'completed' || joined.participantId !== snapshot.participantId
          || joined.experimentId !== snapshot.experimentId || joined.generation !== snapshot.generation
          || joined.condition !== snapshot.condition || joined.round !== snapshot.round
          || joined.sessionId !== snapshot.sessionId) throw new Error('Submitted round could not be confirmed by rejoin.');
        const completed = pickSession(joined, snapshot);
        persistRoundSession(completed);
        operation.phase = 'complete';
        setMeasuredSession(completed);
        return;
      }
      operation.phase = 'complete';
          if (result.status === 'completed') {
            setMeasuredSession({
              ...snapshot,
              status: 'completed',
              stage: 'done',
              trials: [],
              pendingReplacements: [],
              openCapture: null,
              trainingRun: null,
            });
          } else {
            // This visit is ACKed; only the new visit may start producers.
            submissionOperation.current = null;
            setMeasuredSession({
              ...snapshot,
              status: 'in_progress',
              stage: 'capture',
              unlockedThrough: 'capture',
              round: result.round,
              visit: result.round,
              condition: result.condition ?? snapshot.condition,
              manualTrigger: (result.condition ?? snapshot.condition) === 'button',
              sessionId: collectionId('sess'),
              protocolState: null,
              modelRevisionId: null,
              trials: [],
              pendingReplacements: [],
              openCapture: null,
              trainingRun: null,
            });
            if (snapshot.protocolVersion === 'within-subject-v1') {
              setPracticeMode('setup');
              setCalibrationState(null);
              await stopStream();
            }
            setNotice('Visit saved. Use this same participant ID for the next visit; new calibration and Practice are required.');
          }

    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : 'Visit could not save.';
      if (operation.phase === 'posting' || operation.phase === 'uncertain') {
        operation.phase = 'uncertain';
        setSaveError(`Submission may already be saved. Retry submission to send the exact same snapshot, or rejoin to confirm. ${detail}`);
      } else {
        setSaveError(`Submission is waiting for raw data acknowledgement. Retry saving before submitting. ${detail}`);
        reportRecoveryFailure(cause);
      }
      // An uncertain POST must never reopen mutable Results or producers.
    } finally {
      operation.inFlight = false;
      if (finishToken.current === token) setSaving(false);
    }
  };

  const startAnotherRound = async () => {
    if (nextRoundOperation.current || !repeatRoundAvailable(session) || recoveryBlocked.current) return;
    nextRoundOperation.current = true;
    setAdvancingRound(true);
    const token = ++finishToken.current;
    try {
      cancelTraining();
      await stopStream();
      await captureContextArchive.flush('interrupted');
      await captureContextArchive.drain();
      if (recoveryBlocked.current) throw new Error(recoveryBlocked.current);
      await advanceCompletedRound(session);
      if (finishToken.current !== token) return;
      onNextScope(); // Unmount every old hook, timer, model, calibration and continuation.
    } catch (cause) {
      if (finishToken.current === token) setSaveError(`Next round is not confirmed. Retry the saved source; do not clear browser storage. ${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      nextRoundOperation.current = false;
      if (finishToken.current === token) setAdvancingRound(false);
    }
  };

  const leave = async () => {
    if (submissionOperation.current && submissionOperation.current.phase !== 'complete') return;
    cancelTraining();
    try {
      await captureContextArchive.flush('interrupted');
      if (recoveryBlocked.current) return;
      if (isStreaming) await stopStream();
      navigate('/');
    } catch (cause) { reportRecoveryFailure(cause); }
  };

  return (
    <div className="min-h-screen bg-[#050812] text-slate-100">
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -left-32 top-20 h-96 w-96 rounded-full bg-cyan-400/[0.05] blur-3xl" />
        <div className="absolute inset-0 opacity-[0.025] [background-image:linear-gradient(rgba(255,255,255,.25)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,.25)_1px,transparent_1px)] [background-size:48px_48px]" />
      </div>

      <header className="sticky top-0 z-40 border-b border-white/20 bg-[#050812]/85 backdrop-blur-xl">
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
            <span className="rounded-full border border-cyan-300/15 bg-cyan-300/[0.06] px-3 py-2 text-[10px] font-medium uppercase tracking-[0.16em] text-cyan-100">
              {session.condition === 'button' ? 'Button' : 'Threshold'} · Round {session.round}{session.repeatRoundsVersion === 1 ? '' : `/${session.repetitions}`}
            </span>
            <span className="hidden items-center gap-2 rounded-full border border-white/20 px-3 py-2 text-xs text-slate-400 sm:flex">
              <span className={`h-2 w-2 rounded-full ${isStreaming ? 'bg-emerald-300' : 'bg-slate-600'}`} />
              {isStreaming ? (signalMode === 'live' ? liveDeviceName ?? 'Device live' : 'Mock live') : 'Stream idle'}
            </span>
            <button type="button" onClick={() => void leave()} className="rounded-xl border border-white/25 px-3 py-2 text-xs text-slate-400 hover:text-white">
              Leave
            </button>
          </div>
        </div>
      </header>

      {pauseConfirmation && <ParticipantDialog role="alertdialog" label="Confirm stream pause" title="Pause stream?"
        cancelLabel="Cancel" cancelDisabled={confirmingPause} onCancel={() => setPauseConfirmation(false)}
        action={{ label: 'Confirm', disabled: confirmingPause, onClick: () => void confirmStreamPause() }}>
        <p>This disconnects the Ganglion stream. Your saved captures and game progress will stay here.</p>
        <p>After reconnecting, redo resting setup before recording or resuming.</p>
      </ParticipantDialog>}
      {!pauseConfirmation && showRecoveryDialog && <ParticipantDialog label="Signal reconnection guidance"
        title={isStreaming ? 'Redo resting setup' : streamInterruptionReason === 'stopped' ? 'Stream paused' : 'Reconnect Ganglion'}
        onCancel={() => setDismissedRecoveryKey(recoveryDialogKey)}
        action={isStreaming ? { label: 'Redo resting setup', disabled: !!recoveryError || isRecording || countingDown || saving || training, onClick: () => {
          setDismissedRecoveryKey(recoveryDialogKey);
          if (stage === 'game') { setCalibrationState(null); setRecalibrating(true); }
          else redoRestSetup();
        } } : { label: streamInterruptionReason === 'stopped' ? 'Restart stream' : 'Reconnect Ganglion', disabled: !!recoveryError || saving || liveConnectionStatus === 'connecting', onClick: () => void toggleStream() }}>
        <p>{isStreaming ? 'Ganglion reconnected. Redo resting calibration before recording or resuming.' : streamInterruptionReason === 'stopped' ? 'Stream paused by you.' : 'Bluetooth connection lost.'}</p>
        <p>{isStreaming ? 'Rest your hand and complete the resting setup. No full restart is needed.' : 'Reconnect the Ganglion, then redo resting calibration. Your saved captures and game progress stay here.'}</p>
        {liveConnectionStatus === 'error' && <p>{liveConnectionMessage}</p>}
      </ParticipantDialog>}
      <main className="relative mx-auto max-w-6xl space-y-5 px-4 py-6 md:px-6">
        {!!recoveryError && <section role="alert" aria-label="Raw/context recovery blocked" className="rounded-2xl border border-rose-300/50 bg-rose-950/40 p-5">
          <h2 className="font-medium">Raw/context recovery blocked</h2>
          <p className="mt-2 text-sm">{recoveryError}</p>
          <p className="mt-2 text-sm">Collection and progression are paused. Keep this page open; do not reload or clear browser storage. Use only one active study tab.</p>
          <button type="button" disabled={retryingRecovery} onClick={() => void retryRawRecovery()} className="mt-3 rounded-xl border border-white/30 px-4 py-2 disabled:opacity-40">Retry raw/context recovery</button>
        </section>}
        {signalMode === 'mock' && <p role="status" aria-label="Simulated signal" className="rounded-xl border border-amber-300/40 bg-amber-300/10 px-4 py-3 text-sm text-amber-100">Simulated signal — test mode. This signal is generated by the computer and does not respond to your movements.</p>}
        {session.protocolVersion === 'between-subject-v2' && inPractice && !currentPractice && measuredSession?.trials.length === 0 && <details open aria-label="Researcher practice controls" className="mt-3"><summary>Researcher: skip gesture practice</summary>
            <p className="mt-2">Skip rehearsal captures, model and game only. Rest calibration and all measured collection, training and official activity requirements remain.</p>
            <input aria-label="Researcher PIN" type="password" autoComplete="off" value={researcherPin} onChange={event=>setResearcherPin(event.target.value)} className="m-2 rounded bg-slate-800 p-2" />
            <button type="button" disabled={!!recoveryError || !serverVerified || !calibration || !researcherPin.trim() || saving || training || isRecording || countingDown || datasetLocked} onClick={()=>void skipPractice()} className="rounded-xl border border-white/30 px-4 py-2 disabled:opacity-40">Skip gesture practice</button>
            <DismissibleNotice message={saveError} summary="Practice skip not saved" resetKey={saving} />
        </details>}

        {practiceActive && stage !== 'game' && <GuidedPractice
          key={`${session.participantId}:${session.experimentId}:${session.sessionId}:${session.generation}:${session.round}:${session.condition}:${recalibrating}`} streamEpoch={streamEpoch} recalibration={recalibrating}
          onCancel={recalibrating ? () => { setRecalibrating(false); setPracticeCue('auto'); } : undefined}
          session={session} points={recordingSignalData} streaming={isStreaming} source={signalMode} channel={channelIndex}
          settings={{ segmentDurationMs, preTriggerWindowMs, countdownMs, activityThreshold }}
          bluetoothAvailable={isBluetoothAvailable} connectionMessage={liveConnectionMessage}
          onSource={(mode) => { setSignalMode(mode); void selectSignalSourceMode(mode); }}
          onStream={() => void toggleStream()} onCue={setPracticeCue}
          renderSignal={(view) => <LivePanel signalData={signalData} recordingSignalData={recordingSignalData}
            isRecording={view.active} recordingStartTime={view.start} recordingProgress={view.progress}
            captureStatus={view.active ? { label: 'Recording', detail: 'Keep your hand resting.' } : captureStatus}
            showGuide={false} thresholdGuideValue={activityThreshold}
            segmentDurationMs={view.durationMs} overlay={view.overlay} />}
          onComplete={(rest) => {
            if (trainingOperation.current || !isStreaming || !rest.calibration) return;
            setCalibrationState({ scope: calibrationScope, epoch: streamEpoch, value: rest.calibration as FrozenCalibration });
            if (recalibrating) { setRecalibrating(false); return; }
            setCaptureIntroduced(false); setFirstSampleExplained(false); setGameIntroduction(null); setIntroducedGameRevision(null);
            practiceArchive.current = new PracticeArchive(rest, () => refreshArchive(value => value + 1));
            revisionRef.current = null; openCapture.current = null;
            setRehearsal(rehearsalSession(session)); setGestureId(DEFAULT_GESTURES[0].id); setPracticeMode('rehearsal');
          }} />}
        {practiceGuide && inspectedTrialId === null && <PracticeGuide step={practiceGuide} busy={isRecording || countingDown || training || saving} />}
        {inPractice && gameIntroduction && <section aria-label="Practice game introduction" className="rounded-3xl border border-cyan-300/40 bg-slate-900 p-6 text-white">
          <p className="text-sm uppercase tracking-wide text-cyan-200">Before the practice game</p>
          <h1 className="mt-2 text-2xl">Try your practice model, not a surprise task</h1>
          <ol className="mt-4 list-decimal space-y-3 pl-5 text-sm leading-6 text-slate-200">
            <li>Watch the on-screen gesture cue. It tells you which gesture to perform.</li>
            <li>Perform that gesture during the game’s response window. Predictions come from the practice model trained on your kept examples.</li>
            <li>A wrong or Unknown prediction is feedback about this attempt, not proof that you moved incorrectly. No example or result is supplied by this guide.</li>
            <li>After the game, read both game score and gesture recognition. They measure different things; you can review your examples before measured collection.</li>
          </ol>
          <p className="mt-4 text-sm text-slate-300">The game has not started. Choose Start practice game when you understand the task.</p>
          <div className="mt-5 flex flex-wrap gap-3">
            <button type="button" className="rounded-xl border border-white/30 px-5 py-3" onClick={() => setGameIntroduction(null)}>Back to review</button>
            <button data-practice-target="start-game" type="button" disabled={!modelReady || training || saving || gameIntroduction.revision !== session.modelRevisionId} className="rounded-xl bg-cyan-300 px-5 py-3 text-slate-950 disabled:opacity-40" onClick={() => goTo('game', true)}>Start practice game</button>
          </div>
        </section>}
        {inPractice && !gameIntroduction && <section aria-label="Practice objective" className="rounded-3xl border-2 border-cyan-300/50 bg-slate-900 p-5">
          <p className="text-sm font-semibold uppercase tracking-wider text-cyan-200">{briefPractice ? 'Practice — examples stay separate' : 'Practice — separate model and records'}</p>
          <p className="mt-2 text-sm text-slate-200">Keep your palm down. Wrist up means bend your wrist upward (extension); Wrist down means bend it downward (flexion). Practise three examples of each. Rest between movements; resting is setup, not a gesture class.</p>
          {practiceArchive.current && <p className="mt-2 text-xs text-slate-300">{practiceArchive.current.pending.length ? `${practiceArchive.current.pending.length} practice records waiting to save` : 'Practice records saved and read back'}</p>}
          <DismissibleNotice message={practiceArchive.current?.error ?? ''} summary="Practice save issue" />
          {!!practiceArchive.current?.pending.length && <button data-practice-target="practice-save-retry" type="button" className="mt-3 rounded-xl border border-white/30 px-4 py-2" onClick={() => void practiceArchive.current?.flush()}>Retry saving practice</button>}
        </section>}
        {!practiceActive && <StepMap stage={stage} round={session.round} repetitions={session.repeatRoundsVersion === 1 ? undefined : session.repetitions} reachedIndex={reachedIndex} canVisit={canVisit} onSelect={goTo} />}
        {!practiceSetup && stage === 'capture' && !inPractice && !(session.protocolVersion === 'between-subject-v2' && currentPractice) && <button type="button" data-practice-entry disabled={!!recoveryError || isRecording || countingDown || saving || training}
          onClick={() => { if (submissionOperation.current || recoveryBlocked.current || trainingOperation.current) return; cancelOpenCapture('Entering practice.'); setPracticeMode('setup'); }} className="rounded-xl border border-white/30 px-4 py-2.5 text-xs text-slate-200 disabled:opacity-40">Reopen guided practice</button>}

        {!practiceActive && stage === 'capture' && <section aria-label="Fixed rest calibration" className="rounded-xl border border-white/30 p-4 text-sm">
          <p role="status">{calibration ? 'Resting setup saved.' : 'Redo your resting setup before recording.'}</p>
          <button data-practice-target="recalibrate" type="button" disabled={!!recoveryError || isRecording || countingDown || saving || training} onClick={redoRestSetup} className="mt-3 rounded-xl border border-white/30 px-4 py-2 disabled:opacity-40">Redo resting setup</button>
          {session.isTestParticipant === true && <details className="mt-3 text-xs text-slate-400"><summary className="cursor-pointer">Rest setup details</summary>
          <p role="status">{calibration ? `Fixed rest boundary ${calibration.threshold.toPrecision(4)} envelope units · revision ${calibration.revision}. 300ms rest / 100ms activity holds. Graph: 0 to ${calibration.displayMax.toPrecision(4)}, clipped at the top; guide = fixed boundary.` : 'No live rest calibration. Threshold active captures are blocked. Reconnect if needed and explicitly recalibrate; saved samples, models and results are kept.'}</p>
          <p className="mt-2">Check fresh resting activity against the guide, then use comfortable movements in the existing Practice flow. These are detector checks, not physiological onset validation. If checks fail, ask the researcher and repeat rest; the boundary is never tuned from gestures.</p>
          </details>}
        </section>}

        {stage === 'done' && (
          <section className="rounded-[28px] border border-emerald-300/20 bg-emerald-300/10 p-8 text-center">
            <Check className="mx-auto h-8 w-8 text-emerald-200" />
            <h2 className="mt-4 text-2xl font-light text-white">Session complete</h2>
            <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-emerald-100/80">
              {session.protocolVersion === 'between-subject-v2' ? 'Your submitted activity is saved. Let the researcher know you have finished.' : session.protocolVersion === 'between-subject-v1' ? 'Your recording session is saved. Let the researcher know you have finished.' : <>All {session.repetitions} rounds are saved. You can close this page.</>}
            </p>
            <button type="button" onClick={() => void leave()} className="mt-5 rounded-xl border border-white/25 px-4 py-3">Next participant</button>
            {repeatRoundAvailable(session) && <button type="button" disabled={advancingRound || !!recoveryError || !serverVerified} onClick={() => void startAnotherRound()} className="mt-5 rounded-xl border border-white/25 px-4 py-3">{advancingRound ? 'Waiting for saved round acknowledgement' : 'Start next round'}</button>}
            <DismissibleNotice message={saveError} summary="Round transition not confirmed" resetKey={advancingRound} />
          </section>
        )}

        {!practiceActive && !gameIntroduction && stage === 'capture' && (
          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
            <div className="space-y-5">
              {opportunityTimedOut && <section role="status" className="rounded-2xl border border-amber-200/30 p-4 text-sm"><p>This opportunity ended without a saved recording (timeout, interruption, or delayed context). Rest before trying again. This does not establish whether a movement was performed.</p><button type="button" disabled={!!recoveryError || retryingRecovery} className="mt-3 rounded-xl bg-amber-100 px-4 py-2 text-slate-950" onClick={async () => { if (recoveryBlocked.current || retryingRecovery) return; const origin = sessionRef.current; setRetryingRecovery(true); try { captureContextArchive.recorder.cancelUncaptured(recorderAttempt.attemptId); await captureContextArchive.drain(); await whenCollectionSaved(); if (recoveryBlocked.current || sessionRef.current !== origin) return; setOpportunityRetry(value=>value+1); setOpportunityTimedOut(false); } catch (cause) { reportRecoveryFailure(cause); } finally { setRetryingRecovery(false); } }}>Retry opportunity</button></section>}
              <LivePanel
                signalData={calibratedSignalData}
                recordingSignalData={recordingSignalData}
                isRecording={isRecording}
                recordingStartTime={recordingStartTime}
                recordingProgress={recordingProgress}
                captureStatus={captureStatus}
                showGuide={calibration !== null}
                thresholdGuideValue={0.5}
                segmentDurationMs={segmentDurationMs}
                overlay={countingDown
                  ? { label: 'Get ready', text: String(Math.max(1, Math.ceil(countdownRemainingMs / 1000))) }
                  : manualTrigger && captureTimerOn
                    ? { label: 'Recording', text: `${Math.max(0, (segmentDurationMs - recordingProgress * segmentDurationMs) / 1000).toFixed(1)}s` }
                    : null}
              />
              <section aria-label="This round recordings" className="h-80 overflow-y-auto rounded-[24px] border border-white/20 bg-white/[0.025] p-4">
                <div className="flex items-center justify-between gap-3">
                  <h2 className="text-sm font-medium text-white">This round</h2>
                  <span className="text-xs tabular-nums text-slate-500">{trials.length} saved · {cappedKept}/{totalRequired} minimum</span>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {quotas.map((row) => (
                    <span key={row.gesture.id} className="rounded-full border border-white/25 px-3 py-1 text-[11px] text-slate-300">
                      {row.gesture.name} <span className="tabular-nums text-slate-100">{row.kept} kept · {row.minimum}–{row.maximum}</span>
                    </span>
                  ))}
                </div>
                {trials.length > 0 ? (
                  <div className="mt-4 grid gap-3 sm:grid-cols-2">
                    {trials.map((trial) => renderTrial(trial))}
                  </div>
                ) : (
                  <div className="mt-4 flex min-h-28 items-center justify-center rounded-2xl border border-dashed border-white/25 text-sm text-slate-500">
                    <div className="text-center"><CircleDot className="mx-auto mb-2 h-5 w-5 text-slate-700" />Captures will show up here</div>
                  </div>
                )}
              </section>
            </div>

            <aside className="space-y-4">
              <section className="rounded-[28px] border border-white/25 bg-slate-950/70 p-5">
                <div className="flex items-center justify-between text-[11px] text-slate-500">
                  <span>Minimum covered</span>
                  <span className="tabular-nums">{cappedKept}/{totalRequired}</span>
                </div>
                <div className="mt-3 h-1 overflow-hidden rounded-full bg-white/10">
                  <div className="h-full rounded-full bg-cyan-300" style={{ width: `${Math.min(100, (cappedKept / totalRequired) * 100)}%` }} />
                </div>

                <label className="mt-5 block text-[10px] font-medium uppercase tracking-[0.18em] text-slate-500">Gesture</label>
                <div data-practice-target="gesture" className="mt-2">
                  <DarkSelect
                    label="Gesture"
                    value={gestureId}
                    options={DEFAULT_GESTURES.map((item) => ({ value: item.id, label: item.name }))}
                    onChange={(value) => { if (!recoveryBlocked.current) setGestureId(value); }}
                  />
                </div>

                {session.isTestParticipant === true && <details className="mt-4 rounded-xl border border-white/20 p-3"><summary className="cursor-pointer text-sm text-slate-300">Researcher controls</summary><fieldset disabled={!!recoveryError || inPractice || saving || isRecording || countingDown} className="disabled:opacity-60"><div className="mt-4 grid grid-cols-2 gap-2">
                  <label className="block text-[10px] uppercase tracking-[0.14em] text-slate-500">
                    Window ms
                    <input
                      type="number"
                      min={200}
                      max={5000}
                      step={50}
                      value={segmentDurationMs}
                      onChange={(event) => {
                        const next = Number(event.target.value);
                        if (Number.isFinite(next)) setSegmentDurationMs(Math.min(5000, Math.max(200, next)));
                      }}
                      className="mt-1 w-full rounded-xl border border-white/25 bg-slate-950 px-2 py-2 text-sm text-slate-100"
                    />
                  </label>
                  <label className="block text-[10px] uppercase tracking-[0.14em] text-slate-500">
                    Pre-trigger
                    <input
                      type="number"
                      min={0}
                      max={2000}
                      step={25}
                      value={preTriggerWindowMs}
                      onChange={(event) => {
                        const next = Number(event.target.value);
                        if (Number.isFinite(next)) setPreTriggerWindowMs(Math.min(2000, Math.max(0, next)));
                      }}
                      className="mt-1 w-full rounded-xl border border-white/25 bg-slate-950 px-2 py-2 text-sm text-slate-100"
                    />
                  </label>
                  <div aria-label="Fixed envelope boundary" className="text-[10px] uppercase tracking-[0.14em] text-slate-500">
                    Rest boundary (envelope units)
                    <output className="mt-1 block text-sm text-slate-100">{calibration ? calibration.threshold.toPrecision(4) : 'Recalibration required'}</output>
                  </div>
                  <label className="block text-[10px] uppercase tracking-[0.14em] text-slate-500">
                    Countdown ms
                    <input
                      type="number"
                      min={0}
                      max={10000}
                      step={100}
                      value={countdownMs}
                      onChange={(event) => {
                        const next = Number(event.target.value);
                        if (Number.isFinite(next)) setCountdownMs(Math.min(10000, Math.max(0, next)));
                      }}
                      className="mt-1 w-full rounded-xl border border-white/25 bg-slate-950 px-2 py-2 text-sm text-slate-100"
                    />
                  </label>
                </div>
                <p className="mt-2 text-[11px] leading-4 text-slate-500">Window length, pre-trigger history, and the countdown are still being decided. Each saved sample keeps the values used.</p>

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
                      className={`rounded-xl border px-3 py-2 text-xs ${signalMode === mode ? 'border-cyan-300/30 bg-cyan-300/10 text-cyan-100' : 'border-white/25 text-slate-400'} disabled:opacity-30`}
                    >
                      {mode === 'mock' ? 'Mock' : 'Ganglion'}
                    </button>
                  ))}
                </div>
                {signalMode === 'live' && !calibration && (
                  <button
                    type="button"
                    onClick={freezeDisplayScale}
                    disabled={!isStreaming || isDisplayScaleFrozen}
                    className="mt-3 w-full rounded-xl border border-white/25 px-3 py-2 text-xs text-slate-300 disabled:cursor-default disabled:opacity-50"
                  >
                    {isDisplayScaleFrozen ? 'Display scale locked' : 'Lock display scale'}
                  </button>
                )}
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

                </fieldset></details>}
                <div data-practice-target="capture-method" className="mt-4 h-36 overflow-y-auto rounded-2xl border border-white/25 bg-white/[0.03] p-4">
                  <p className="text-xs font-medium text-cyan-100">
                    {captureStatus.label}
                  </p>
                  <p className="mt-2 text-xs leading-5 text-slate-400" hidden={inPractice}>
                    {isRelax ? 'Press Capture. Keep your hand resting until the timer finishes.' : manualTrigger ? `Press Capture. When you see Recording, make ${gesture.name}. Keep doing it until the timer finishes.` : `Rest your hand. Then make ${gesture.name}. Recording starts on its own.`}
                  </p>
                </div>

                {manualTrigger && (
                  <button
                    type="button"
                    data-practice-target="capture" onClick={pressCapture}
                    disabled={!armed || recorderState !== 'idle' || countingDown}
                    className="mt-4 flex w-full items-center justify-center gap-3 rounded-2xl border border-cyan-300/30 bg-cyan-300/10 px-5 py-5 text-sm font-medium text-cyan-50 disabled:cursor-not-allowed disabled:opacity-35"
                  >
                    <Hand className="h-5 w-5" /> {countingDown ? `Get ready ${Math.max(1, Math.ceil(countdownRemainingMs / 1000))}` : 'Capture'} <span className="rounded-md border border-white/25 px-2 py-1 text-[10px] text-cyan-100/70">Space</span>
                  </button>
                )}

                <button
                  type="button"
                  data-practice-target="stream" onClick={() => void toggleStream()}
                  disabled={liveConnectionStatus === 'connecting' || (!!recoveryError && !isStreaming)}
                  className={`mt-3 flex w-full items-center justify-center gap-2 rounded-2xl px-5 py-3.5 text-sm font-medium ${isStreaming ? 'border border-white/25 text-slate-300' : 'bg-cyan-300 text-slate-950'} disabled:opacity-50`}
                >
                  {isStreaming ? <><Pause className="h-4 w-4" /> Pause stream</> : <><Play className="h-4 w-4" /> {signalMode === 'live' ? 'Connect device' : 'Start mock stream'}</>}
                </button>
                <DismissibleNotice summary="Connection problem" message={liveConnectionStatus === 'error' ? liveConnectionMessage : ''} className="mt-3" />
                <button
                  type="button"
                  disabled={!!recoveryError || trials.length === 0}
                  data-practice-target="review" onClick={() => goTo('review')}
                  className="mt-3 flex w-full items-center justify-center gap-2 rounded-2xl border border-white/25 px-5 py-3 text-sm text-slate-200 disabled:cursor-not-allowed disabled:opacity-35"
                >
                  Review captures <ArrowRight className="h-4 w-4" />
                </button>
              </section>

              <details className="rounded-[24px] border border-white/20 p-5">
                <summary className="cursor-pointer text-sm text-slate-300">Show signal details</summary>
                <dl className="mt-4 grid grid-cols-2 gap-4 text-sm">
                  <div><dt className="text-[10px] uppercase tracking-[0.16em] text-slate-500">Activity</dt><dd className="mt-1 tabular-nums">{signalValue.toFixed(2)}</dd></div>
                  <div><dt className="text-[10px] uppercase tracking-[0.16em] text-slate-500">Capture</dt><dd className="mt-1 tabular-nums">{Math.round(recordingProgress * 100)}%</dd></div>
                  <div><dt className="text-[10px] uppercase tracking-[0.16em] text-slate-500">Sample rate</dt><dd className="mt-1">{liveSampleRateHz ? `${liveSampleRateHz} Hz` : signalMode === 'mock' && isStreaming ? '20 Hz' : '—'}</dd></div>
                  <div><dt className="text-[10px] uppercase tracking-[0.16em] text-slate-500">Saved</dt><dd className="mt-1 tabular-nums">{trials.length}</dd></div>
                </dl>
                <p className="mt-4 border-t border-white/20 pt-3 text-xs leading-5 text-slate-500">{notice}</p>
              </details>
            </aside>
          </div>
        )}

        {!practiceActive && !gameIntroduction && stage === 'review' && (
          <section className="space-y-4">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <p className="text-xs uppercase tracking-[0.18em] text-cyan-300/70">Review</p>
                <h2 className="mt-1 text-2xl font-light text-white">Captures from this round</h2>
              </div>
              <div className="flex flex-wrap gap-2">
                <button data-practice-target="back-capture" type="button" disabled={!!recoveryError || training || datasetLocked} onClick={() => goTo('capture')} className="rounded-xl border border-white/25 px-4 py-2.5 text-xs text-slate-300">Back to capture</button>
                {briefPractice && <button data-practice-target="begin-collection" type="button" disabled={!!recoveryError || !roundComplete || saving || training} onClick={() => void finishRound()} className="rounded-xl bg-cyan-300 px-4 py-2.5 text-xs font-medium text-slate-950 disabled:opacity-35">Begin collection</button>}
                {!briefPractice && <><button data-practice-target="train" type="button" disabled={!!recoveryError || !serverVerified || !roundComplete || training || (!inPractice && isPilotProtocol(session.protocolVersion) && captureContextArchive.recorder.pendingWindowCount > 0) || (!inPractice && isPilotProtocol(session.protocolVersion) && ((requiresCollectionSurvey(session.protocolVersion) && !session.protocolState?.survey) || practiceRequired || (datasetLocked && modelReady)))} onClick={() => void trainModel()} className="rounded-xl border border-white/25 px-4 py-2.5 text-xs text-slate-100 disabled:cursor-not-allowed disabled:opacity-35">
                  {modelState?.status === 'training' || training ? 'Training' : datasetLocked ? modelReady ? 'Official model locked' : 'Restore locked model' : modelState?.status === 'ready' ? 'Retrain' : 'Train model'}
                </button>
                <button data-practice-target="play" type="button" disabled={!roundComplete || !modelReady || !streamReady || !serverVerified} onClick={() => goTo('game')} className="flex items-center gap-2 rounded-xl bg-cyan-300 px-4 py-2.5 text-xs font-medium text-slate-950 disabled:cursor-not-allowed disabled:opacity-35">Play <ArrowRight className="h-3.5 w-3.5" /></button></>}
              </div>
            </div>
            {!inPractice && requiresCollectionSurvey(session.protocolVersion) && !datasetLocked && (
              <section aria-label="Collection survey checkpoint" className="rounded-2xl border border-amber-200/30 p-4 text-sm">
                <p>Complete the collection questionnaire now, before Train, game, or Results.</p>
                <p className="mt-2 text-xs">{session.protocolState?.survey ? 'External collection survey confirmed. Train will permanently lock these retained examples.' : 'Ask the researcher to confirm the external form is complete. This app does not submit or verify Qualtrics responses.'}</p>
                {!session.protocolState?.survey && <details className="mt-3"><summary>Researcher confirmation</summary>
                  <input aria-label="Researcher PIN" type="password" autoComplete="off" value={researcherPin} onChange={event=>setResearcherPin(event.target.value)} className="m-2 rounded bg-slate-800 p-2" />
                  <button type="button" disabled={!!recoveryError || saving || !roundComplete || !researcherPin || captureContextArchive.recorder.pendingWindowCount > 0} onClick={()=>void confirmSurvey()}>Confirm external collection survey completed</button>
                </details>}
                <DismissibleNotice message={saveError} summary="Checkpoint not saved" resetKey={saving} />
              </section>
            )}
            {datasetLocked && <p className="text-sm text-amber-100">Official dataset locked. Review is read-only; replay cannot add examples or retrain the official model.</p>}
            {modelState && <ModelStatusNote state={modelState} />}
            <div className="flex flex-wrap gap-2">
              {quotas.map((row) => (
                <span key={row.gesture.id} className="rounded-full border border-white/25 bg-white/[0.03] px-3 py-1.5 text-xs text-slate-200">
                  {row.gesture.name} <span className="tabular-nums">{row.kept} kept · {row.minimum}–{row.maximum}</span>
                </span>
              ))}
            </div>
            {missingQuotas.length > 0 && (
              <div className="rounded-2xl border border-amber-300/20 bg-amber-300/10 px-4 py-4 text-sm text-amber-50">
                <p className="font-medium">Missing examples</p>
                <ul className="mt-2 space-y-1">
                  {missingQuotas.map((row) => (
                    <li key={row.gesture.id}>
                      {row.gesture.name} needs {row.missing} more {row.missing === 1 ? 'example' : 'examples'} ({row.kept} kept, at least {row.minimum})
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
            tutorialPractice={!inPractice && currentPractice ? {
              status: currentPractice.status,
              scopeKey: `${session.participantId}:${session.sessionId}:${session.generation}:${session.round}:${condition}:tutorial-v8`,
            } : undefined}
            officialSequence={inPractice ? undefined : session.officialSequence}
            runKind={inPractice ? 'practice' : session.runs.some(r=>r.condition===condition && r.round===session.round && r.runKind==='official' && r.completionStatus==='complete') ? 'replay' : 'official'}
            streamReady={streamReady && !recoveryError}
            sourceEpoch={streamEpoch}
            subscribeSourceInterruptions={subscribeSourceInterruptions}
            recoveryReady={calibration !== null && !recoveryError}
            recoveryToken={calibration?.revision}
            recoveryControls={<div className="my-6 space-y-4">
              {!streamReady && <button type="button" disabled={!!recoveryError || liveConnectionStatus === 'connecting'} onClick={() => void toggleStream()}>Reconnect device</button>}
              {streamReady && !recalibrating && <button type="button" disabled={!!recoveryError} onClick={() => { setCalibrationState(null); setRecalibrating(true); }}>Redo resting setup</button>}
              {recalibrating && <GuidedPractice key={`game-rest:${calibrationScope}:${streamEpoch}`} recalibration streamEpoch={streamEpoch}
                session={session} points={recordingSignalData} streaming={isStreaming} source={signalMode} channel={channelIndex}
                settings={{ segmentDurationMs, preTriggerWindowMs, countdownMs, activityThreshold }}
                bluetoothAvailable={isBluetoothAvailable} connectionMessage={liveConnectionMessage}
                onSource={() => {}} onStream={() => void toggleStream()} onCue={setPracticeCue}
                renderSignal={() => null}
                onComplete={rest => {
                  if (!isStreaming || !rest.calibration || recoveryBlocked.current) return;
                  setCalibrationState({ scope: calibrationScope, epoch: streamEpoch, value: rest.calibration as FrozenCalibration });
                  setRecalibrating(false);
                }} />}
            </div>}
            testControls={session.isTestParticipant === true}
            practice={inPractice}
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
            obstacleCount={session.obstacleCount}
            startingLives={session.startingLives}
          />
        )}

        {!practiceActive && stage === 'game' && !modelReady && (
          <section className="overflow-hidden rounded-[28px] border border-dashed border-emerald-300/30 bg-slate-900/80">
            <div className="flex flex-wrap items-end justify-between gap-3 border-b border-white/20 p-5 md:p-6">
              <div>
                <p className="text-xs uppercase tracking-[0.18em] text-emerald-300/80">Play</p>
                <h2 className="mt-1 text-2xl font-light text-white">Review game</h2>
                <p className="mt-2 max-w-xl text-sm leading-6 text-slate-500">Testing requires a ready model and an active live stream. Reconnect before starting a new run.</p>
              </div>
              <div className="flex gap-2">
                <button type="button" onClick={() => goTo('review')} className="rounded-xl border border-white/25 px-4 py-2.5 text-xs text-slate-300">Back to review</button>
                <button type="button" disabled={!hasRunThisRound} onClick={() => goTo('results')} className="flex items-center gap-2 rounded-xl bg-cyan-300 px-4 py-2.5 text-xs font-medium text-slate-950 disabled:cursor-not-allowed disabled:opacity-35">Results <ArrowRight className="h-3.5 w-3.5" /></button>
              </div>
            </div>
            <div className="space-y-4 p-4 md:p-6">
              {modelState && <ModelStatusNote state={modelState} />}
              <p className="text-sm text-amber-100">Testing requires a ready model matching the kept examples and an active live stream. A disconnected run is not an official result.</p>
            </div>
          </section>
        )}

        {!practiceActive && !gameIntroduction && stage === 'results' && (
          <div data-practice-target="results"><ResultsPanel
            runs={session.runs}
            currentRun={session.runs
              .filter((run) => run.round === session.round && run.condition === condition)
              .sort((left, right) => right.recordedAt - left.recordedAt)[0] ?? null}
            gestures={DEFAULT_GESTURES}
            tryAgainEnabled={roundComplete && modelReady && streamReady}
            onTryAgain={() => goTo('game')}
            onReview={() => goTo('review')}
            onContinue={() => void finishRound()}
            datasetLocked={datasetLocked}
            continueEnabled={!recoveryError && roundComplete && (inPractice || !isPilotProtocol(session.protocolVersion) || session.runs.some(run => run.runKind === 'official' && run.completionStatus === 'complete' && run.round === session.round && run.condition === condition)) && (!inPractice || (modelReady && session.runs.some(run => run.modelRevisionId === session.modelRevisionId && run.outcomes.some(item => item.result !== 'recording_failure'))))}
            continueLabel={submissionOperation.current?.phase === 'uncertain' ? 'Retry submission' : inPractice ? 'Begin collection' : session.protocolVersion === 'between-subject-v2' || session.protocolVersion === 'between-subject-v1' ? 'Submit session' : session.round >= session.repetitions ? 'Finish session' : 'Continue'}
            saving={saving}
            saveError={saveError}
          /></div>
        )}
      </main>
      {inspectedTrialId && trials.some((trial) => trial.id === inspectedTrialId) && (
        <SampleGraphPanel
          guided={inPractice}
          trial={trials.find((trial) => trial.id === inspectedTrialId) ?? trials[0]}
          trials={trials.filter((trial) => trial.gestureId === trials.find((item) => item.id === inspectedTrialId)?.gestureId)}
          onClose={() => setInspectedTrialId(null)}
          onSelect={setInspectedTrialId}
        />
      )}
    </div>
  );
}
