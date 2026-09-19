import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  ArrowRight,
  BarChart3,
  Check,
  ChevronDown,
  CircleDot,
  Download,
  FlaskConical,
  Hand,
  Pause,
  Play,
  Radio,
  RotateCcw,
  Settings2,
  Sparkles,
  Trash2,
  Waves,
  Zap,
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

import { DEFAULT_GESTURES, getChannelMockSignalValue } from './pipeline';
import { useGestureRecorder, type CaptureTriggerMode } from './useGestureRecorder';
import { useSignalSource, type SignalPoint, type SignalSourceMode } from './useSignalSource';
import StudyFlowCanvas from './StudyFlowCanvas';

type FlowStage = 'capture' | 'review' | 'compare';
type TrialQuality = 'usable' | 'review';

interface CapturedTrial {
  id: string;
  gestureId: string;
  gestureName: string;
  method: CaptureTriggerMode;
  pairIndex: number;
  capturedAt: number;
  triggeredAt: number;
  completedAt: number;
  preTriggerPointCount: number;
  points: Array<{ time: number; value: number }>;
  quality: TrialQuality;
  metrics: {
    rms: number;
    peak: number;
    range: number;
    durationMs: number;
  };
}

const DISPLAY_WINDOW_MS = 5000;
const DEFAULT_SEGMENT_DURATION_MS = 1200;
const METHOD_META: Record<CaptureTriggerMode, {
  label: string;
  shortLabel: string;
  description: string;
  accent: string;
  soft: string;
  border: string;
}> = {
  threshold: {
    label: 'Threshold triggered',
    shortLabel: 'Threshold',
    description: 'Capture begins when activity crosses the calibrated line.',
    accent: 'text-cyan-300',
    soft: 'bg-cyan-400/10',
    border: 'border-cyan-400/30',
  },
  button: {
    label: 'Button triggered',
    shortLabel: 'Button',
    description: 'Capture begins from the participant button or Space key.',
    accent: 'text-violet-300',
    soft: 'bg-violet-400/10',
    border: 'border-violet-400/30',
  },
};

const FLOW_STAGES: Array<{
  id: FlowStage;
  eyebrow: string;
  label: string;
  description: string;
}> = [
  { id: 'capture', eyebrow: '01', label: 'Capture', description: 'Run matched trials' },
  { id: 'review', eyebrow: '02', label: 'Review', description: 'Inspect paired signals' },
  { id: 'compare', eyebrow: '03', label: 'Compare', description: 'Evaluate methods' },
];

function calculateMetrics(points: Array<{ time: number; value: number }>) {
  if (points.length === 0) {
    return { rms: 0, peak: 0, range: 0, durationMs: 0 };
  }
  const values = points.map((point) => point.value);
  const rms = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length);
  const peak = Math.max(...values.map((value) => Math.abs(value)));
  const range = Math.max(...values) - Math.min(...values);
  return {
    rms,
    peak,
    range,
    durationMs: Math.max(0, points[points.length - 1].time - points[0].time),
  };
}

function formatSignalValue(value: number) {
  if (Math.abs(value) >= 100) return value.toFixed(0);
  if (Math.abs(value) >= 1) return value.toFixed(2);
  return value.toFixed(4);
}

function normalizeWaveform(trial: CapturedTrial) {
  const triggerOffset = trial.points[trial.preTriggerPointCount]?.time ?? trial.triggeredAt;
  return trial.points.map((point) => ({
    time: Math.round(point.time - triggerOffset),
    value: point.value,
  }));
}

function MiniWaveform({ trial, height = 112 }: { trial: CapturedTrial; height?: number }) {
  const data = useMemo(() => normalizeWaveform(trial), [trial]);
  const color = trial.method === 'threshold' ? '#22d3ee' : '#a78bfa';

  return (
    <div style={{ height }} className="w-full" aria-label={`${trial.gestureName} ${trial.method} waveform`}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 4, bottom: 4, left: 4 }}>
          <ReferenceLine x={0} stroke={color} strokeDasharray="3 3" opacity={0.55} />
          <Line
            type="monotone"
            dataKey="value"
            stroke={color}
            strokeWidth={1.8}
            dot={false}
            isAnimationActive={false}
          />
          <XAxis dataKey="time" type="number" domain={['dataMin', 'dataMax']} hide />
          <YAxis domain={['auto', 'auto']} hide />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function Metric({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="min-w-0">
      <p className="text-[10px] font-medium uppercase tracking-[0.18em] text-slate-500">{label}</p>
      <p className="mt-1 truncate text-lg font-medium tabular-nums text-slate-100">{value}</p>
      {detail && <p className="mt-0.5 text-[11px] text-slate-500">{detail}</p>}
    </div>
  );
}

function StatusDot({ active }: { active: boolean }) {
  return (
    <span className="relative flex h-2.5 w-2.5">
      {active && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-300 opacity-40" />}
      <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${active ? 'bg-emerald-300' : 'bg-slate-600'}`} />
    </span>
  );
}

function LiveSignalPanel({
  signalData,
  recordingSignalData,
  threshold,
  isRecording,
  recordingStartTime,
  segmentDurationMs,
  currentMethod,
}: {
  signalData: SignalPoint[];
  recordingSignalData: SignalPoint[];
  threshold: number;
  isRecording: boolean;
  recordingStartTime: number | null;
  segmentDurationMs: number;
  currentMethod: CaptureTriggerMode;
}) {
  const chartEnd = signalData[signalData.length - 1]?.time ?? Date.now();
  const chartStart = chartEnd - DISPLAY_WINDOW_MS;
  const activityData = signalData.filter((point) => point.time >= chartStart);
  const rawData = recordingSignalData.filter((point) => point.time >= chartStart);
  const accent = currentMethod === 'threshold' ? '#22d3ee' : '#a78bfa';

  return (
    <section className="overflow-hidden rounded-[28px] border border-white/10 bg-slate-950/55 shadow-[0_32px_100px_rgba(0,0,0,0.28)] backdrop-blur-xl">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/8 px-5 py-4 md:px-6">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-cyan-400/10 text-cyan-300">
            <Waves className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-sm font-medium text-white">Live activity</h2>
            <p className="text-xs text-slate-500">Normalized envelope · rolling 5 second window</p>
          </div>
        </div>
        <div className="flex items-center gap-2 text-xs text-slate-400">
          <span className={`rounded-full border px-3 py-1.5 ${METHOD_META[currentMethod].soft} ${METHOD_META[currentMethod].border} ${METHOD_META[currentMethod].accent}`}>
            {METHOD_META[currentMethod].shortLabel} armed
          </span>
          {isRecording && (
            <span className="flex items-center gap-2 rounded-full bg-rose-400/10 px-3 py-1.5 text-rose-300">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-rose-300" /> Recording
            </span>
          )}
        </div>
      </div>

      <div className="relative h-[330px] px-2 pt-3 md:px-4">
        <div className="pointer-events-none absolute left-7 top-6 z-10 flex items-center gap-4 text-[10px] uppercase tracking-[0.16em] text-slate-500">
          <span>Activity</span>
          <span className="flex items-center gap-1.5 text-amber-300/80"><span className="w-4 border-t border-dashed border-amber-300" /> Trigger {threshold.toFixed(2)}</span>
        </div>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={activityData} margin={{ top: 24, right: 16, left: 0, bottom: 16 }}>
            <defs>
              <linearGradient id="flowActivityGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={accent} stopOpacity={0.38} />
                <stop offset="70%" stopColor={accent} stopOpacity={0.06} />
                <stop offset="100%" stopColor={accent} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} stroke="rgba(148,163,184,0.08)" />
            <XAxis dataKey="time" type="number" domain={[chartStart, chartEnd]} hide />
            <YAxis domain={[0, 1]} hide />
            <ReferenceLine y={threshold} stroke="#fbbf24" strokeDasharray="6 6" opacity={0.75} />
            {recordingStartTime !== null && (
              <ReferenceArea
                x1={recordingStartTime}
                x2={recordingStartTime + segmentDurationMs}
                fill={accent}
                fillOpacity={0.1}
              />
            )}
            <Area
              type="monotone"
              dataKey="normalizedActivity"
              stroke={accent}
              strokeWidth={2.5}
              fill="url(#flowActivityGradient)"
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-x-7 bottom-4 flex justify-between text-[10px] tabular-nums text-slate-600">
          <span>−5s</span><span>−4s</span><span>−3s</span><span>−2s</span><span>−1s</span><span>now</span>
        </div>
      </div>

      <div className="border-t border-white/8 bg-slate-950/35 px-5 pb-4 pt-3 md:px-6">
        <div className="mb-2 flex items-center justify-between">
          <div>
            <p className="text-xs font-medium text-slate-300">Raw signal</p>
            <p className="text-[11px] text-slate-600">Unmodified channel data for timing and quality inspection</p>
          </div>
          <span className="font-mono text-[11px] text-slate-500">
            {rawData.length ? formatSignalValue(rawData[rawData.length - 1].raw) : '—'}
          </span>
        </div>
        <div className="h-28">
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

function SampleCard({
  trial,
  selected,
  onSelect,
  onDelete,
}: {
  trial: CapturedTrial;
  selected?: boolean;
  onSelect?: () => void;
  onDelete?: () => void;
}) {
  const meta = METHOD_META[trial.method];
  return (
    <article
      className={`group overflow-hidden rounded-2xl border bg-slate-950/45 transition-all ${
        selected ? `${meta.border} shadow-[0_0_40px_rgba(34,211,238,0.08)]` : 'border-white/8 hover:border-white/15'
      }`}
    >
      <button type="button" onClick={onSelect} className="w-full px-4 pt-4 text-left">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <span className={`h-2 w-2 rounded-full ${trial.method === 'threshold' ? 'bg-cyan-300' : 'bg-violet-300'}`} />
              <span className={`text-xs font-medium ${meta.accent}`}>{meta.shortLabel}</span>
              <span className="text-xs text-slate-600">Pair {trial.pairIndex}</span>
            </div>
            <p className="mt-1 text-sm font-medium text-slate-100">{trial.gestureName}</p>
          </div>
          <span className={`rounded-full px-2 py-1 text-[10px] uppercase tracking-wider ${
            trial.quality === 'usable' ? 'bg-emerald-400/10 text-emerald-300' : 'bg-amber-400/10 text-amber-300'
          }`}>
            {trial.quality}
          </span>
        </div>
        <MiniWaveform trial={trial} />
      </button>
      <div className="flex items-center justify-between border-t border-white/6 px-4 py-2.5">
        <span className="text-[11px] tabular-nums text-slate-500">{trial.metrics.durationMs.toFixed(0)} ms · {trial.points.length} pts</span>
        {onDelete && (
          <button type="button" onClick={onDelete} className="rounded-lg p-1.5 text-slate-600 transition hover:bg-rose-400/10 hover:text-rose-300" aria-label="Delete trial">
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </article>
  );
}

function MethodComparison({ trials }: { trials: CapturedTrial[] }) {
  const stats = useMemo(() => {
    const build = (method: CaptureTriggerMode) => {
      const methodTrials = trials.filter((trial) => trial.method === method);
      const average = (key: keyof CapturedTrial['metrics']) => methodTrials.length
        ? methodTrials.reduce((sum, trial) => sum + trial.metrics[key], 0) / methodTrials.length
        : 0;
      return {
        count: methodTrials.length,
        usable: methodTrials.filter((trial) => trial.quality === 'usable').length,
        rms: average('rms'),
        peak: average('peak'),
        range: average('range'),
        duration: average('durationMs'),
      };
    };
    return { threshold: build('threshold'), button: build('button') };
  }, [trials]);

  const comparisonRows = [
    { label: 'Captured trials', threshold: stats.threshold.count, button: stats.button.count, format: (value: number) => String(value) },
    { label: 'Usable samples', threshold: stats.threshold.usable, button: stats.button.usable, format: (value: number) => String(value) },
    { label: 'Average RMS', threshold: stats.threshold.rms, button: stats.button.rms, format: formatSignalValue },
    { label: 'Average peak', threshold: stats.threshold.peak, button: stats.button.peak, format: formatSignalValue },
    { label: 'Average range', threshold: stats.threshold.range, button: stats.button.range, format: formatSignalValue },
    { label: 'Window duration', threshold: stats.threshold.duration, button: stats.button.duration, format: (value: number) => `${value.toFixed(0)} ms` },
  ];

  return (
    <div className="grid gap-5 lg:grid-cols-[1.1fr_0.9fr]">
      <section className="rounded-[28px] border border-white/10 bg-slate-950/50 p-5 md:p-7">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-medium uppercase tracking-[0.2em] text-cyan-300/70">Method comparison</p>
            <h2 className="mt-2 text-2xl font-light text-white">Same signal. Different trigger.</h2>
            <p className="mt-2 max-w-xl text-sm leading-6 text-slate-500">Every value below comes from identical capture windows and preprocessing. Differences reflect the trigger strategy, not a different recording path.</p>
          </div>
          <BarChart3 className="h-6 w-6 shrink-0 text-slate-600" />
        </div>

        <div className="mt-7 overflow-hidden rounded-2xl border border-white/8">
          <div className="grid grid-cols-[1fr_0.7fr_0.7fr] bg-white/[0.035] px-4 py-3 text-xs font-medium text-slate-500">
            <span>Measure</span>
            <span className="text-right text-cyan-300">Threshold</span>
            <span className="text-right text-violet-300">Button</span>
          </div>
          {comparisonRows.map((row) => (
            <div key={row.label} className="grid grid-cols-[1fr_0.7fr_0.7fr] border-t border-white/6 px-4 py-3.5 text-sm">
              <span className="text-slate-400">{row.label}</span>
              <span className="text-right font-mono text-slate-100">{row.format(row.threshold)}</span>
              <span className="text-right font-mono text-slate-100">{row.format(row.button)}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-[28px] border border-white/10 bg-gradient-to-br from-cyan-400/[0.07] via-slate-950/60 to-violet-400/[0.07] p-5 md:p-7">
        <p className="text-xs font-medium uppercase tracking-[0.2em] text-slate-500">Study readiness</p>
        <div className="mt-5 grid grid-cols-2 gap-4">
          <Metric label="Threshold trials" value={String(stats.threshold.count)} detail={`${stats.threshold.usable} usable`} />
          <Metric label="Button trials" value={String(stats.button.count)} detail={`${stats.button.usable} usable`} />
        </div>
        <div className="mt-7 border-t border-white/8 pt-5">
          <h3 className="text-sm font-medium text-white">Interpret with paired trials</h3>
          <p className="mt-2 text-sm leading-6 text-slate-500">Capture both methods for the same gesture and pair number. This keeps comparisons within the same task instead of mixing unmatched samples.</p>
        </div>
        <div className="mt-5 rounded-2xl bg-black/20 p-4 text-sm text-slate-400">
          {trials.length === 0
            ? 'Begin capturing to populate the comparison.'
            : stats.threshold.count === stats.button.count
              ? 'The dataset is balanced across both trigger methods.'
              : `Capture ${Math.abs(stats.threshold.count - stats.button.count)} more ${stats.threshold.count < stats.button.count ? 'threshold' : 'button'} trial${Math.abs(stats.threshold.count - stats.button.count) === 1 ? '' : 's'} to rebalance it.`}
        </div>
      </section>
    </div>
  );
}

export default function FlowBasedCaptureScreen() {
  const [stage, setStage] = useState<FlowStage>('capture');
  const [currentMethod, setCurrentMethod] = useState<CaptureTriggerMode>('threshold');
  const [threshold, setThreshold] = useState(0.6);
  const [segmentDurationMs, setSegmentDurationMs] = useState(DEFAULT_SEGMENT_DURATION_MS);
  const [selectedChannelIndex, setSelectedChannelIndex] = useState(0);
  const [currentGestureId, setCurrentGestureId] = useState(DEFAULT_GESTURES[0].id);
  const [trialsPerMethod, setTrialsPerMethod] = useState(3);
  const [trials, setTrials] = useState<CapturedTrial[]>([]);
  const [manualTriggerToken, setManualTriggerToken] = useState(0);
  const [selectedTrialId, setSelectedTrialId] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [notice, setNotice] = useState('Choose a source and start the stream.');
  const [methodConnections, setMethodConnections] = useState<Record<CaptureTriggerMode, boolean>>({ threshold: true, button: true });

  const currentGesture = DEFAULT_GESTURES.find((gesture) => gesture.id === currentGestureId) ?? DEFAULT_GESTURES[0];
  const generateMockSignalValue = useCallback(() => {
    const cycleMs = 4800;
    const cyclePosition = Date.now() % cycleMs;
    const state = cyclePosition > 1500 && cyclePosition < 3300 ? 'active' : 'idle';
    return getChannelMockSignalValue(selectedChannelIndex, cyclePosition / cycleMs, state);
  }, [selectedChannelIndex]);

  const {
    signalData,
    recordingSignalData,
    signalSourceMode,
    isStreaming,
    selectSignalSourceMode,
    startStream,
    stopStream,
    liveConnectionStatus,
    liveDeviceName,
    liveSampleRateHz,
    isBluetoothAvailable,
  } = useSignalSource(generateMockSignalValue, DISPLAY_WINDOW_MS, selectedChannelIndex, 1);

  const currentMethodCount = trials.filter((trial) => (
    trial.gestureId === currentGesture.id && trial.method === currentMethod
  )).length;
  const captureGoalReached = currentMethodCount >= trialsPerMethod;
  const isCaptureArmed = stage === 'capture' && isStreaming && !captureGoalReached && methodConnections[currentMethod];

  const {
    recorderState,
    isRecording,
    recordingStartTime,
    recordingProgress,
    completedSegment,
    acknowledgeCompletedSegment,
    diagnostics,
  } = useGestureRecorder({
    signalPoints: recordingSignalData,
    threshold,
    segmentDurationMs,
    isStreaming,
    resetKey: `${signalSourceMode}:${selectedChannelIndex}:${currentMethod}:${currentGestureId}`,
    triggerMode: currentMethod,
    manualTriggerToken,
    isArmed: isCaptureArmed,
    cooldownMs: 450,
  });

  useEffect(() => {
    if (!completedSegment) return;

    const metrics = calculateMetrics(completedSegment.points);
    const pairIndex = trials.filter((trial) => (
      trial.gestureId === currentGesture.id && trial.method === completedSegment.triggerMode
    )).length + 1;
    const trial: CapturedTrial = {
      id: `${currentGesture.id}-${completedSegment.triggerMode}-${Date.now()}`,
      gestureId: currentGesture.id,
      gestureName: currentGesture.name,
      method: completedSegment.triggerMode,
      pairIndex,
      capturedAt: Date.now(),
      triggeredAt: completedSegment.triggeredAt,
      completedAt: completedSegment.completedAt,
      preTriggerPointCount: completedSegment.preTriggerPointCount,
      points: completedSegment.points,
      quality: completedSegment.points.length >= 12 && metrics.durationMs >= segmentDurationMs * 0.85 ? 'usable' : 'review',
      metrics,
    };

    setTrials((previous) => [...previous, trial]);
    setSelectedTrialId(trial.id);
    setNotice(`${METHOD_META[trial.method].shortLabel} trial ${pairIndex} captured. Pair it with the other method.`);
    setCurrentMethod(trial.method === 'threshold' ? 'button' : 'threshold');
    acknowledgeCompletedSegment();
  }, [acknowledgeCompletedSegment, completedSegment, currentGesture, segmentDurationMs, trials]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches('input, select, textarea')) return;
      if (event.code === 'Space' && currentMethod === 'button' && isCaptureArmed && recorderState === 'idle') {
        event.preventDefault();
        setManualTriggerToken((token) => token + 1);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [currentMethod, isCaptureArmed, recorderState]);

  const selectedTrial = trials.find((trial) => trial.id === selectedTrialId) ?? trials[trials.length - 1] ?? null;
  const latestTrials = [...trials].slice(-4).reverse();
  const thresholdCount = trials.filter((trial) => trial.method === 'threshold').length;
  const buttonCount = trials.filter((trial) => trial.method === 'button').length;
  const totalGoal = DEFAULT_GESTURES.length * trialsPerMethod * 2;
  const progress = totalGoal > 0 ? Math.min(100, (trials.length / totalGoal) * 100) : 0;
  const signalValue = signalData[signalData.length - 1]?.normalizedActivity ?? 0;

  const changeSource = async (mode: SignalSourceMode) => {
    await selectSignalSourceMode(mode);
    setNotice(mode === 'mock' ? 'Mock source selected. Start the stream when ready.' : 'Ganglion selected. Connect when the device is ready.');
  };

  const toggleStream = async () => {
    if (isStreaming) {
      await stopStream();
      setNotice('Signal stream paused. Captures are safely retained.');
    } else {
      await startStream();
      setNotice(currentMethod === 'threshold' ? 'Threshold capture armed.' : 'Button capture ready. Press the trigger when the gesture begins.');
    }
  };

  const fireButtonTrigger = () => {
    if (!isCaptureArmed || recorderState !== 'idle') return;
    setManualTriggerToken((token) => token + 1);
    setNotice('Button event received. Capturing the shared recording window.');
  };

  const exportStudy = () => {
    const payload = {
      exportedAt: Date.now(),
      study: 'Threshold versus button-triggered biosignal capture',
      settings: { threshold, segmentDurationMs, selectedChannelIndex, trialsPerMethod },
      trials,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `capture-method-study-${Date.now()}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const deleteTrial = (trialId: string) => {
    setTrials((previous) => previous.filter((trial) => trial.id !== trialId));
    if (selectedTrialId === trialId) setSelectedTrialId(null);
  };

  const openFlowNode = (nextStage: FlowStage, method?: CaptureTriggerMode) => {
    if (method) setCurrentMethod(method);
    setStage(nextStage);
    window.requestAnimationFrame(() => document.getElementById('study-workspace')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };

  return (
    <div className="min-h-screen bg-[#050812] text-slate-100 selection:bg-cyan-300/30">
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -left-32 top-20 h-96 w-96 rounded-full bg-cyan-400/[0.055] blur-3xl" />
        <div className="absolute -right-32 top-1/3 h-[32rem] w-[32rem] rounded-full bg-violet-500/[0.05] blur-3xl" />
        <div className="absolute inset-0 opacity-[0.025] [background-image:linear-gradient(rgba(255,255,255,.25)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,.25)_1px,transparent_1px)] [background-size:48px_48px]" />
      </div>

      <header className="sticky top-0 z-40 border-b border-white/8 bg-[#050812]/85 backdrop-blur-xl">
        <div className="mx-auto flex max-w-[1500px] items-center justify-between gap-4 px-4 py-3 md:px-7">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-cyan-300/20 bg-cyan-300/10 text-cyan-300">
              <Activity className="h-5 w-5" />
            </div>
            <div>
              <p className="text-sm font-medium tracking-wide text-white">Signal Capture Study</p>
              <p className="hidden text-[11px] text-slate-500 sm:block">Threshold vs button · paired protocol</p>
            </div>
          </div>

          <nav className="hidden items-center gap-1 rounded-2xl border border-white/8 bg-white/[0.025] p-1 md:flex" aria-label="Study flow">
            {FLOW_STAGES.map((item, index) => {
              const active = stage === item.id;
              const available = item.id === 'capture' || trials.length > 0;
              return (
                <button
                  key={item.id}
                  type="button"
                  disabled={!available}
                  onClick={() => setStage(item.id)}
                  className={`flex items-center gap-3 rounded-xl px-4 py-2 text-left transition disabled:cursor-not-allowed disabled:opacity-35 ${active ? 'bg-white/8 text-white' : 'text-slate-500 hover:bg-white/5 hover:text-slate-300'}`}
                >
                  <span className={`flex h-6 w-6 items-center justify-center rounded-full text-[10px] ${active ? 'bg-cyan-300 text-slate-950' : 'border border-white/10'}`}>
                    {index < FLOW_STAGES.findIndex((flowStage) => flowStage.id === stage) ? <Check className="h-3.5 w-3.5" /> : item.eyebrow}
                  </span>
                  <span><span className="block text-xs font-medium">{item.label}</span><span className="block text-[10px] text-slate-600">{item.description}</span></span>
                </button>
              );
            })}
          </nav>

          <div className="flex items-center gap-2">
            <div className="hidden items-center gap-2 rounded-full border border-white/8 bg-white/[0.025] px-3 py-2 text-xs text-slate-400 sm:flex">
              <StatusDot active={isStreaming} />
              {isStreaming ? (signalSourceMode === 'live' ? liveDeviceName ?? 'Ganglion live' : 'Mock live') : 'Stream idle'}
            </div>
            <button type="button" onClick={() => setShowSettings((value) => !value)} className={`rounded-xl border p-2.5 transition ${showSettings ? 'border-cyan-300/30 bg-cyan-300/10 text-cyan-300' : 'border-white/8 bg-white/[0.025] text-slate-500 hover:text-white'}`} aria-label="Study settings">
              <Settings2 className="h-4 w-4" />
            </button>
          </div>
        </div>
      </header>

      <main className="relative mx-auto max-w-[1500px] px-4 py-5 md:px-7 md:py-7">
        {showSettings && (
          <section className="mb-5 grid gap-5 rounded-[24px] border border-white/10 bg-slate-950/80 p-5 shadow-2xl backdrop-blur-xl md:grid-cols-5">
            <label className="text-xs text-slate-400">Signal source
              <div className="mt-2 flex rounded-xl border border-white/8 bg-black/20 p-1">
                {(['mock', 'live'] as SignalSourceMode[]).map((mode) => (
                  <button key={mode} type="button" disabled={mode === 'live' && !isBluetoothAvailable} onClick={() => void changeSource(mode)} className={`flex-1 rounded-lg px-3 py-2 text-xs transition ${signalSourceMode === mode ? 'bg-white/10 text-white' : 'text-slate-500 hover:text-slate-300'} disabled:opacity-30`}>
                    {mode === 'mock' ? 'Mock' : 'Ganglion'}
                  </button>
                ))}
              </div>
            </label>
            <label className="text-xs text-slate-400">Threshold <span className="float-right font-mono text-amber-300">{threshold.toFixed(2)}</span>
              <input className="mt-3 w-full accent-amber-300" type="range" min="0.2" max="0.9" step="0.02" value={threshold} onChange={(event) => setThreshold(Number(event.target.value))} />
            </label>
            <label className="text-xs text-slate-400">Capture window
              <select value={segmentDurationMs} onChange={(event) => setSegmentDurationMs(Number(event.target.value))} className="mt-2 w-full rounded-xl border border-white/8 bg-black/20 px-3 py-2 text-sm text-slate-200 outline-none">
                <option value={800}>0.8 seconds</option><option value={1200}>1.2 seconds</option><option value={1600}>1.6 seconds</option><option value={2000}>2.0 seconds</option>
              </select>
            </label>
            <label className="text-xs text-slate-400">Signal channel
              <select value={selectedChannelIndex} onChange={(event) => setSelectedChannelIndex(Number(event.target.value))} className="mt-2 w-full rounded-xl border border-white/8 bg-black/20 px-3 py-2 text-sm text-slate-200 outline-none">
                <option value={0}>Channel 1</option><option value={1}>Channel 2</option><option value={2}>Channel 3</option><option value={3}>Channel 4</option>
              </select>
            </label>
            <label className="text-xs text-slate-400">Pairs per gesture
              <select value={trialsPerMethod} onChange={(event) => setTrialsPerMethod(Number(event.target.value))} className="mt-2 w-full rounded-xl border border-white/8 bg-black/20 px-3 py-2 text-sm text-slate-200 outline-none">
                <option value={1}>1 pair</option><option value={3}>3 pairs</option><option value={5}>5 pairs</option><option value={10}>10 pairs</option>
              </select>
            </label>
          </section>
        )}

        <div className="mb-5 flex items-center gap-2 overflow-x-auto md:hidden">
          {FLOW_STAGES.map((item) => (
            <button key={item.id} type="button" disabled={item.id !== 'capture' && trials.length === 0} onClick={() => setStage(item.id)} className={`whitespace-nowrap rounded-full border px-4 py-2 text-xs ${stage === item.id ? 'border-cyan-300/30 bg-cyan-300/10 text-cyan-300' : 'border-white/8 text-slate-500'} disabled:opacity-30`}>{item.label}</button>
          ))}
        </div>

        <StudyFlowCanvas
          signalData={signalData}
          rawData={recordingSignalData}
          isStreaming={isStreaming}
          isRecording={isRecording}
          threshold={threshold}
          gestureName={currentGesture.name}
          activeMethod={currentMethod}
          trials={trials}
          onOpenStage={openFlowNode}
          onButtonTrigger={fireButtonTrigger}
          onConnectivityChange={setMethodConnections}
          buttonTriggerEnabled={stage === 'capture' && isCaptureArmed && recorderState === 'idle' && currentMethod === 'button'}
        />

        <div id="study-workspace" className="mt-6 scroll-mt-28">
        {stage === 'capture' && (
          <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_330px]">
            <div className="min-w-0 space-y-5">
              <LiveSignalPanel
                signalData={signalData}
                recordingSignalData={recordingSignalData}
                threshold={threshold}
                isRecording={isRecording}
                recordingStartTime={recordingStartTime}
                segmentDurationMs={segmentDurationMs}
                currentMethod={currentMethod}
              />

              <section className="rounded-[24px] border border-white/8 bg-white/[0.025] p-4 md:p-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h2 className="text-sm font-medium text-white">Latest captured signals</h2>
                    <p className="mt-1 text-xs text-slate-500">Every capture remains visible while the live stream continues.</p>
                  </div>
                  {trials.length > 0 && <button type="button" onClick={() => setStage('review')} className="flex items-center gap-2 text-xs font-medium text-cyan-300 hover:text-cyan-200">Review all {trials.length} <ArrowRight className="h-3.5 w-3.5" /></button>}
                </div>
                {latestTrials.length ? (
                  <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                    {latestTrials.map((trial) => <SampleCard key={trial.id} trial={trial} selected={trial.id === selectedTrial?.id} onSelect={() => setSelectedTrialId(trial.id)} />)}
                  </div>
                ) : (
                  <div className="mt-4 flex min-h-36 items-center justify-center rounded-2xl border border-dashed border-white/10 bg-black/10 text-center">
                    <div><CircleDot className="mx-auto h-5 w-5 text-slate-700" /><p className="mt-2 text-sm text-slate-500">Captured waveforms will appear here</p></div>
                  </div>
                )}
              </section>
            </div>

            <aside className="space-y-5">
              <section className="overflow-hidden rounded-[28px] border border-white/10 bg-slate-950/65">
                <div className="border-b border-white/8 p-5">
                  <div className="flex items-center justify-between">
                    <p className="text-[10px] font-medium uppercase tracking-[0.2em] text-slate-500">Current protocol</p>
                    <span className="text-[11px] tabular-nums text-slate-600">{trials.length}/{totalGoal}</span>
                  </div>
                  <div className="mt-3 h-1 overflow-hidden rounded-full bg-white/6"><div className="h-full rounded-full bg-gradient-to-r from-cyan-300 to-violet-400 transition-all" style={{ width: `${progress}%` }} /></div>
                </div>

                <div className="p-5">
                  <label className="text-[10px] font-medium uppercase tracking-[0.2em] text-slate-500">Gesture</label>
                  <div className="relative mt-2">
                    <select value={currentGestureId} onChange={(event) => setCurrentGestureId(event.target.value)} className="w-full appearance-none rounded-2xl border border-white/10 bg-white/[0.035] px-4 py-3 text-lg font-light text-white outline-none focus:border-cyan-300/40">
                      {DEFAULT_GESTURES.map((gesture) => <option key={gesture.id} value={gesture.id}>{gesture.name}</option>)}
                    </select>
                    <ChevronDown className="pointer-events-none absolute right-4 top-4 h-4 w-4 text-slate-500" />
                  </div>

                  <div className="mt-5 grid grid-cols-2 gap-2">
                    {(['threshold', 'button'] as CaptureTriggerMode[]).map((method) => {
                      const active = currentMethod === method;
                      const meta = METHOD_META[method];
                      const count = trials.filter((trial) => trial.gestureId === currentGesture.id && trial.method === method).length;
                      return (
                        <button key={method} type="button" onClick={() => setCurrentMethod(method)} className={`rounded-2xl border p-3 text-left transition ${active ? `${meta.border} ${meta.soft}` : 'border-white/8 bg-white/[0.02] hover:bg-white/[0.04]'}`}>
                          <span className={`flex h-8 w-8 items-center justify-center rounded-xl ${meta.soft} ${meta.accent}`}>{method === 'threshold' ? <Zap className="h-4 w-4" /> : <Hand className="h-4 w-4" />}</span>
                          <span className={`mt-3 block text-xs font-medium ${active ? meta.accent : 'text-slate-300'}`}>{meta.shortLabel}</span>
                          <span className="mt-1 block text-[10px] text-slate-600">{count}/{trialsPerMethod} captured</span>
                        </button>
                      );
                    })}
                  </div>

                  <div className={`mt-5 rounded-2xl border p-4 ${METHOD_META[currentMethod].border} ${METHOD_META[currentMethod].soft}`}>
                    <div className="flex items-center gap-2">
                      <StatusDot active={isCaptureArmed && recorderState === 'idle'} />
                      <p className={`text-xs font-medium ${METHOD_META[currentMethod].accent}`}>
                        {!methodConnections[currentMethod] ? 'Signal disconnected' : !isStreaming ? 'Waiting for stream' : isRecording ? 'Recording window' : recorderState === 'cooldown' ? 'Resetting trigger' : captureGoalReached ? 'Method target complete' : 'Armed and ready'}
                      </p>
                    </div>
                    <p className="mt-2 text-xs leading-5 text-slate-400">{METHOD_META[currentMethod].description}</p>
                  </div>

                  {currentMethod === 'button' && (
                    <button type="button" onClick={fireButtonTrigger} disabled={!isCaptureArmed || recorderState !== 'idle'} className="mt-4 flex w-full items-center justify-center gap-3 rounded-2xl border border-violet-300/30 bg-violet-400/15 px-5 py-5 text-sm font-medium text-violet-200 shadow-[0_0_50px_rgba(167,139,250,0.1)] transition hover:bg-violet-400/20 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-35">
                      <Hand className="h-5 w-5" /> Capture now <span className="rounded-md border border-violet-200/15 bg-black/15 px-2 py-1 text-[10px] text-violet-200/60">Space</span>
                    </button>
                  )}

                  <button type="button" onClick={() => void toggleStream()} disabled={liveConnectionStatus === 'connecting'} className={`mt-4 flex w-full items-center justify-center gap-2 rounded-2xl px-5 py-3.5 text-sm font-medium transition ${isStreaming ? 'border border-white/10 bg-white/5 text-slate-300 hover:bg-white/10' : 'bg-cyan-300 text-slate-950 hover:bg-cyan-200'} disabled:opacity-50`}>
                    {isStreaming ? <><Pause className="h-4 w-4" /> Pause stream</> : <><Play className="h-4 w-4" /> {signalSourceMode === 'live' ? 'Connect Ganglion' : 'Start mock stream'}</>}
                  </button>
                </div>
              </section>

              <section className="rounded-[24px] border border-white/8 bg-white/[0.025] p-5">
                <div className="flex items-center justify-between"><p className="text-xs font-medium text-slate-300">Live context</p><Radio className="h-4 w-4 text-slate-600" /></div>
                <div className="mt-4 grid grid-cols-2 gap-x-5 gap-y-4">
                  <Metric label="Activity" value={signalValue.toFixed(2)} />
                  <Metric label="Capture" value={`${Math.round(recordingProgress * 100)}%`} />
                  <Metric label="Threshold" value={threshold.toFixed(2)} />
                  <Metric label="Sample rate" value={liveSampleRateHz ? `${liveSampleRateHz} Hz` : signalSourceMode === 'mock' && isStreaming ? '20 Hz' : '—'} />
                </div>
                <p className="mt-5 border-t border-white/6 pt-4 text-xs leading-5 text-slate-500">{notice}</p>
              </section>
            </aside>
          </div>
        )}

        {stage === 'review' && (
          <div className="space-y-5">
            <section className="flex flex-col gap-4 rounded-[28px] border border-white/10 bg-slate-950/50 p-5 md:flex-row md:items-end md:justify-between md:p-7">
              <div><p className="text-xs font-medium uppercase tracking-[0.2em] text-cyan-300/70">Captured evidence</p><h1 className="mt-2 text-3xl font-light text-white">Paired signal review</h1><p className="mt-2 text-sm text-slate-500">Compare trigger-aligned waveforms without losing the raw shape of each capture.</p></div>
              <div className="flex gap-2">
                <button type="button" onClick={() => setStage('capture')} className="rounded-xl border border-white/10 px-4 py-2.5 text-xs text-slate-300 hover:bg-white/5">Continue capture</button>
                <button type="button" onClick={() => setStage('compare')} className="flex items-center gap-2 rounded-xl bg-cyan-300 px-4 py-2.5 text-xs font-medium text-slate-950">Compare methods <ArrowRight className="h-3.5 w-3.5" /></button>
              </div>
            </section>

            <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-white/8 bg-white/[0.02] p-2">
              {DEFAULT_GESTURES.map((gesture) => {
                const count = trials.filter((trial) => trial.gestureId === gesture.id).length;
                return <button key={gesture.id} type="button" onClick={() => setCurrentGestureId(gesture.id)} className={`rounded-xl px-4 py-2 text-xs transition ${currentGestureId === gesture.id ? 'bg-white/10 text-white' : 'text-slate-500 hover:text-slate-300'}`}>{gesture.name} <span className="ml-1 text-slate-600">{count}</span></button>;
              })}
            </div>

            {Array.from({ length: trialsPerMethod }, (_, index) => index + 1).map((pairIndex) => {
              const thresholdTrial = trials.find((trial) => trial.gestureId === currentGestureId && trial.method === 'threshold' && trial.pairIndex === pairIndex);
              const buttonTrial = trials.find((trial) => trial.gestureId === currentGestureId && trial.method === 'button' && trial.pairIndex === pairIndex);
              if (!thresholdTrial && !buttonTrial) return null;
              return (
                <section key={pairIndex} className="rounded-[28px] border border-white/8 bg-white/[0.02] p-4 md:p-6">
                  <div className="mb-4 flex items-center justify-between"><div><p className="text-[10px] uppercase tracking-[0.2em] text-slate-600">{currentGesture.name}</p><h2 className="mt-1 text-sm font-medium text-white">Trial pair {pairIndex}</h2></div><span className={`rounded-full px-3 py-1 text-[10px] ${thresholdTrial && buttonTrial ? 'bg-emerald-400/10 text-emerald-300' : 'bg-amber-400/10 text-amber-300'}`}>{thresholdTrial && buttonTrial ? 'Complete pair' : 'Missing match'}</span></div>
                  <div className="grid gap-4 lg:grid-cols-2">
                    {thresholdTrial ? <SampleCard trial={thresholdTrial} selected={selectedTrialId === thresholdTrial.id} onSelect={() => setSelectedTrialId(thresholdTrial.id)} onDelete={() => deleteTrial(thresholdTrial.id)} /> : <div className="flex min-h-52 items-center justify-center rounded-2xl border border-dashed border-cyan-300/15 text-xs text-slate-600">Threshold capture missing</div>}
                    {buttonTrial ? <SampleCard trial={buttonTrial} selected={selectedTrialId === buttonTrial.id} onSelect={() => setSelectedTrialId(buttonTrial.id)} onDelete={() => deleteTrial(buttonTrial.id)} /> : <div className="flex min-h-52 items-center justify-center rounded-2xl border border-dashed border-violet-300/15 text-xs text-slate-600">Button capture missing</div>}
                  </div>
                </section>
              );
            })}
          </div>
        )}

        {stage === 'compare' && (
          <div className="space-y-5">
            <MethodComparison trials={trials} />
            <section className="rounded-[28px] border border-white/8 bg-white/[0.02] p-5 md:p-7">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div><h2 className="text-sm font-medium text-white">Study data</h2><p className="mt-1 text-xs text-slate-500">Export settings, trigger metadata, metrics, and every raw captured point.</p></div>
                <div className="flex gap-2"><button type="button" onClick={() => setStage('capture')} className="flex items-center gap-2 rounded-xl border border-white/10 px-4 py-2.5 text-xs text-slate-300"><RotateCcw className="h-3.5 w-3.5" /> Add trials</button><button type="button" onClick={exportStudy} className="flex items-center gap-2 rounded-xl bg-white px-4 py-2.5 text-xs font-medium text-slate-950"><Download className="h-3.5 w-3.5" /> Export JSON</button></div>
              </div>
              <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {DEFAULT_GESTURES.map((gesture) => {
                  const gestureTrials = trials.filter((trial) => trial.gestureId === gesture.id);
                  const thresholdTrials = gestureTrials.filter((trial) => trial.method === 'threshold');
                  const buttonTrials = gestureTrials.filter((trial) => trial.method === 'button');
                  return <div key={gesture.id} className="rounded-2xl border border-white/8 bg-black/10 p-4"><div className="flex items-center justify-between"><span className="text-sm font-medium text-slate-200">{gesture.name}</span><FlaskConical className="h-4 w-4 text-slate-600" /></div><div className="mt-4 flex items-center gap-3 text-xs"><span className="text-cyan-300">{thresholdTrials.length} threshold</span><span className="h-1 w-1 rounded-full bg-slate-700" /><span className="text-violet-300">{buttonTrials.length} button</span></div></div>;
                })}
              </div>
            </section>
          </div>
        )}
        </div>
      </main>

      <footer className="relative mx-auto flex max-w-[1500px] flex-wrap items-center justify-between gap-3 px-4 pb-7 pt-2 text-[11px] text-slate-700 md:px-7">
        <span className="flex items-center gap-2"><Sparkles className="h-3.5 w-3.5" /> Paired capture protocol</span>
        <span>{thresholdCount} threshold · {buttonCount} button · {trials.length} total</span>
      </footer>
    </div>
  );
}
