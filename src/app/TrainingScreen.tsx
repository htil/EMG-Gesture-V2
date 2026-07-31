import React from 'react';

import { useState, useEffect, useRef, useCallback, useMemo, memo } from 'react';
import {
  AreaChart,
  Area,
  Line,
  LineChart,
  XAxis,
  YAxis,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
} from 'recharts';
import type { DotProps } from 'recharts';
import { motion, AnimatePresence } from 'motion/react';
import {
  X,
  Settings2,
  RotateCcw,
  Trash2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Brain,
  CircleHelp,
} from 'lucide-react';
import * as dfd from 'danfojs';
import { useSignalSource, type SignalSourceMode } from './useSignalSource';
import { useGestureRecorder } from './useGestureRecorder';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger
} from './components/ui/sheet';
import ResultScreen from './ResultScreen';
import TestingScreen from './TestingScreen';
import {
  DEFAULT_GESTURES,
  DEFAULT_TESTING_SESSION_SETTINGS,
  buildTrainingSession,
  createGesture,
  extractEmgFeatures,
  getChannelMockSignalValue,
  type Gesture,
  type TestingSessionData,
  type TestingSessionSettings,
  type TrainingSessionData,
} from './pipeline';

type AppScreen = 'training' | 'testing' | 'results';

type FeedbackState = 'ready' | 'recording' | 'good' | 'weak' | 'noisy' | 'short';
type SampleQuality = 'good' | 'weak' | 'noisy';
type SampleStatus = 'empty' | 'collected' | 'flagged' | 'rejected';
type WaveformPoint = { time: number; value: number };

interface Sample {
  id: number;
  status: SampleStatus;
  timestamp?: number;
  waveformData?: WaveformPoint[];
  quality?: SampleQuality;
}

interface GestureData {
  samples: Sample[];
}

interface ExportSample {
  id: string;
  label: string;
  timestamp: number;
  data: number[];
  duration: number;
}

interface DatasetPreviewSample {
  id: string;
  gestureId: string;
  sampleNumber: number;
  timestamp: number;
  durationSeconds: number;
  dataPoints: WaveformPoint[];
}

interface RawDataRow {
  label: string;
  index: number;
  timeOffset: number;
  value: number;
}

interface RawDataView {
  sample: DatasetPreviewSample;
  label: string;
}

type ChartPoint = WaveformPoint & {
  displayTime: number;
  pointIndex: number;
};

type SignalSourceLabel = Record<SignalSourceMode, string>;

const DEFAULT_SEGMENT_DURATION_MS = 1200;
const MIN_SEGMENT_POINTS = 6;
const DEFAULT_DISPLAY_WINDOW_MS = 3000;
const DEFAULT_ACTIVITY_DISPLAY_SENSITIVITY = 1.0;
const RECORDED_SAMPLE_STATUSES: SampleStatus[] = ['collected', 'flagged', 'rejected'];
const WAVEFORM_DOT_RADIUS = 4;
const WAVEFORM_HOVERED_DOT_RADIUS = 6;
const WAVEFORM_TOOLTIP_DOT_GAP = 2;

function formatRecordedTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatDurationSeconds(durationSeconds: number): string {
  return `${durationSeconds.toFixed(1)} seconds`;
}

function formatWaveformValue(value: number): string {
  if (Math.abs(value) >= 1000) {
    return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }

  if (Math.abs(value) >= 1) {
    return value.toFixed(2);
  }

  return value.toFixed(4);
}

function formatDisplayTimeSeconds(seconds: number): string {
  return `${seconds.toFixed(3)} s`;
}

interface FeatureRow {
  name: string;
  value: string;
}

const NOT_CALCULATED = '**';

/** Placeholder copy per feature — replace individually later. */
const FEATURE_MORE_INFO: Record<string, string> = {
  Min: 'Info here',
  Max: 'Info here',
  Range: 'Info here',
  'Average Signal Strength': 'Info here',
  RMS: 'Info here',
  MAV: 'Info here',
  'Standard Deviation': 'Info here',
  Peak: 'Info here',
  'Waveform Length': 'Info here',
  'Zero Crossings': 'Info here',
  'Slope Sign Changes': 'Info here',
  'Willison Amplitude': 'Info here',
  'Hjorth Mobility': 'Info here',
  'Hjorth Complexity': 'Info here',
};

function formatFeatureValue(value: number, integer = false): string {
  if (!Number.isFinite(value)) {
    return NOT_CALCULATED;
  }
  return integer ? String(Math.round(value)) : formatWaveformValue(value);
}

function buildFeatureRows(sample: DatasetPreviewSample): FeatureRow[] {
  const values = sample.dataPoints.map((point) => point.value);
  const features = extractEmgFeatures(values);
  const { minIndex, maxIndex } = computeMinMaxIndices(sample.dataPoints);
  const min = minIndex >= 0 ? sample.dataPoints[minIndex].value : null;
  const max = maxIndex >= 0 ? sample.dataPoints[maxIndex].value : null;

  return [
    { name: 'Min', value: min === null ? NOT_CALCULATED : formatWaveformValue(min) },
    { name: 'Max', value: max === null ? NOT_CALCULATED : formatWaveformValue(max) },
    { name: 'Range', value: NOT_CALCULATED },
    { name: 'Average Signal Strength', value: NOT_CALCULATED },
    { name: 'RMS', value: formatFeatureValue(features.rms) },
    { name: 'MAV', value: formatFeatureValue(features.mav) },
    { name: 'Standard Deviation', value: formatFeatureValue(features.std) },
    { name: 'Peak', value: formatFeatureValue(features.peak) },
    { name: 'Waveform Length', value: formatFeatureValue(features.waveformLength) },
    { name: 'Zero Crossings', value: formatFeatureValue(features.zeroCrossings, true) },
    { name: 'Slope Sign Changes', value: formatFeatureValue(features.slopeSignChanges, true) },
    { name: 'Willison Amplitude', value: formatFeatureValue(features.willisonAmplitude, true) },
    { name: 'Hjorth Mobility', value: formatFeatureValue(features.hjorthMobility) },
    { name: 'Hjorth Complexity', value: formatFeatureValue(features.hjorthComplexity) },
  ];
}

function buildRawDataRows(sample: DatasetPreviewSample, label: string): RawDataRow[] {
  const points = sample.dataPoints;
  if (points.length === 0) {
    return [];
  }

  const durationMs = sample.durationSeconds * 1000;
  const stepMs =
    points.length > 1 ? durationMs / Math.max(points.length - 1, 1) : 0;

  return points.map((point, index) => ({
    label,
    index,
    timeOffset: Number((index * stepMs).toFixed(3)),
    value: point.value,
  }));
}

function computeMinMaxIndices(dataPoints: WaveformPoint[]) {
  if (dataPoints.length === 0) {
    return { minIndex: -1, maxIndex: -1 };
  }

  let minIndex = 0;
  let maxIndex = 0;

  for (let index = 1; index < dataPoints.length; index += 1) {
    if (dataPoints[index].value < dataPoints[minIndex].value) {
      minIndex = index;
    }
    if (dataPoints[index].value > dataPoints[maxIndex].value) {
      maxIndex = index;
    }
  }

  return { minIndex, maxIndex };
}

function capturedSamplesToPreviewSamples(
  gestureId: string,
  samples: Sample[],
  segmentDurationMs: number,
): DatasetPreviewSample[] {
  return samples
    .filter(
      (sample) =>
        sample.status !== 'empty' &&
        sample.waveformData !== undefined &&
        sample.waveformData.length > 0,
    )
    .map((sample) => {
      const waveformData = sample.waveformData!;
      const firstPointTime = waveformData[0]?.time ?? sample.timestamp ?? Date.now();
      const lastPointTime = waveformData[waveformData.length - 1]?.time ?? firstPointTime;
      const timestamp = sample.timestamp ?? firstPointTime;
      const durationMs =
        waveformData.length > 1
          ? Math.max(0, lastPointTime - firstPointTime)
          : segmentDurationMs;

      return {
        id: `${gestureId}-${sample.id}-${timestamp}`,
        gestureId,
        sampleNumber: sample.id + 1,
        timestamp,
        durationSeconds: durationMs / 1000,
        dataPoints: waveformData,
      };
    });
}

function WaveformDot({
  cx,
  cy,
  payload,
  hoveredPointIndex,
  onPointHover,
}: DotProps & {
  payload?: ChartPoint;
  hoveredPointIndex: number | null;
  onPointHover: (point: ChartPoint | null, position?: { x: number; y: number }) => void;
}) {
  if (cx === undefined || cy === undefined || !payload) {
    return null;
  }

  const point = payload;
  const isHovered = hoveredPointIndex === point.pointIndex;

  return (
    <g
      onMouseEnter={() => onPointHover(point, { x: cx, y: cy })}
      onMouseLeave={() => onPointHover(null)}
      onFocus={() => onPointHover(point, { x: cx, y: cy })}
      onBlur={() => onPointHover(null)}
      tabIndex={0}
      role="graphics-symbol"
      aria-label={`Time ${formatDisplayTimeSeconds(point.displayTime)}, value ${formatWaveformValue(point.value)}`}
    >
      <circle
        cx={cx}
        cy={cy}
        r={isHovered ? WAVEFORM_HOVERED_DOT_RADIUS : WAVEFORM_DOT_RADIUS}
        fill="#22d3ee"
        stroke="#0f172a"
        strokeWidth={1.5}
        className="cursor-pointer"
      />
    </g>
  );
}

const SampleWaveform = memo(function SampleWaveform({
  dataPoints,
}: {
  dataPoints: WaveformPoint[];
}) {
  const [hoveredPoint, setHoveredPoint] = useState<ChartPoint | null>(null);
  const [tooltipPosition, setTooltipPosition] = useState<{ x: number; y: number } | null>(null);

  const chartData = useMemo<ChartPoint[]>(() => {
    if (dataPoints.length === 0) {
      return [];
    }

    const startTime = dataPoints[0].time;
    return dataPoints.map((point, pointIndex) => ({
      ...point,
      displayTime: (point.time - startTime) / 1000,
      pointIndex,
    }));
  }, [dataPoints]);

  const minMax = useMemo(() => computeMinMaxIndices(dataPoints), [dataPoints]);

  const handlePointHover = (point: ChartPoint | null, position?: { x: number; y: number }) => {
    setHoveredPoint(point);
    setTooltipPosition(position ?? null);
  };

  if (chartData.length === 0) {
    return (
      <div className="flex h-40 items-center justify-center rounded-lg border border-white/10 bg-slate-950/40 text-sm text-white/45">
        No waveform data
      </div>
    );
  }

  return (
    <div className="relative h-44 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={chartData} margin={{ top: 12, right: 48, left: 4, bottom: 20 }}>
          <XAxis
            dataKey="displayTime"
            type="number"
            stroke="rgba(255,255,255,0.35)"
            tick={{ fill: 'rgba(255,255,255,0.55)', fontSize: 11 }}
            tickLine={false}
            axisLine={{ stroke: 'rgba(255,255,255,0.15)' }}
            tickFormatter={(value: number) => `${value.toFixed(1)}s`}
            label={{
              value: 'Time',
              position: 'insideBottom',
              offset: -6,
              fill: 'rgba(255,255,255,0.6)',
              fontSize: 12,
            }}
          />
          <YAxis
            stroke="rgba(255,255,255,0.35)"
            tick={{ fill: 'rgba(255,255,255,0.55)', fontSize: 11 }}
            tickLine={false}
            axisLine={{ stroke: 'rgba(255,255,255,0.15)' }}
            width={44}
            tickFormatter={(value: number) => formatWaveformValue(value)}
          />
          <Line
            type="linear"
            dataKey="value"
            stroke="#22d3ee"
            strokeWidth={1.5}
            dot={(props) => (
              <WaveformDot
                {...props}
                hoveredPointIndex={hoveredPoint?.pointIndex ?? null}
                onPointHover={handlePointHover}
              />
            )}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>

      {hoveredPoint && tooltipPosition && (
        <div
          className="pointer-events-none absolute z-10 rounded-md border border-white/15 bg-slate-950/95 px-2.5 py-1.5 text-xs text-white shadow-lg"
          style={{
            left: tooltipPosition.x + WAVEFORM_HOVERED_DOT_RADIUS + WAVEFORM_TOOLTIP_DOT_GAP,
            top: tooltipPosition.y - WAVEFORM_HOVERED_DOT_RADIUS - WAVEFORM_TOOLTIP_DOT_GAP,
            transform: 'translateY(-100%)',
          }}
        >
          {(hoveredPoint.pointIndex === minMax.minIndex ||
            hoveredPoint.pointIndex === minMax.maxIndex) && (
            <div className="mb-0.5 flex gap-1.5 font-bold">
              {hoveredPoint.pointIndex === minMax.minIndex && (
                <span className="text-cyan-200">min</span>
              )}
              {hoveredPoint.pointIndex === minMax.maxIndex && (
                <span className="text-amber-200">max</span>
              )}
            </div>
          )}
          <div className="font-medium text-cyan-300">
            {formatWaveformValue(hoveredPoint.value)}
          </div>
          <div className="text-white/60">
            Time: {formatDisplayTimeSeconds(hoveredPoint.displayTime)}
          </div>
        </div>
      )}
    </div>
  );
});

const DatasetSampleCard = memo(function DatasetSampleCard({
  sample,
  onViewRawData,
}: {
  sample: DatasetPreviewSample;
  onViewRawData: (sample: DatasetPreviewSample) => void;
}) {
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => onViewRawData(sample)}
        className="absolute right-full top-1/2 z-10 flex h-1/2 w-3 -translate-y-1/2 items-center justify-center rounded-l-md rounded-r-none border border-r-0 border-white/10 bg-white/[0.12] text-white/50 transition-[width,colors] duration-200 ease-out hover:w-6 hover:bg-white/20 hover:text-white/85 focus-visible:w-6 focus-visible:bg-white/20 focus-visible:text-white/85 focus-visible:outline-none"
        aria-label="View raw data"
        title="View raw data"
      >
        <svg
          viewBox="0 0 10 28"
          className="h-4 w-2"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          aria-hidden="true"
        >
          <path
            d="M8 2 L2 14 L8 26"
            stroke="currentColor"
            strokeWidth="1.25"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      <article className="rounded-xl border border-white/10 bg-white/5 p-4">
        <div className="mb-3 flex flex-col gap-1">
          <h3 className="text-sm font-medium text-white/90">Sample {sample.sampleNumber}</h3>
          <p className="text-xs text-white/55">
            Recorded: {formatRecordedTimestamp(sample.timestamp)}
          </p>
          <p className="text-xs text-white/55">
            Duration: {formatDurationSeconds(sample.durationSeconds)}
          </p>
        </div>
        <SampleWaveform dataPoints={sample.dataPoints} />
      </article>
    </div>
  );
});

function RawDataSidebarPanel({
  sample,
  label,
  onClose,
  onExpandFeatures,
  showExpandButton,
}: {
  sample: DatasetPreviewSample;
  label: string;
  onClose: () => void;
  onExpandFeatures: () => void;
  showExpandButton: boolean;
}) {
  const rows = useMemo(() => buildRawDataRows(sample, label), [sample, label]);

  return (
    <motion.aside
      initial={{ x: '100%' }}
      animate={{ x: 0 }}
      exit={{ x: '100%' }}
      transition={{ type: 'tween', duration: 0.35, ease: [0.32, 0.72, 0, 1] }}
      className="absolute inset-0 flex h-full min-h-0 w-full flex-col border-r border-white/10 bg-slate-900 text-white"
      aria-label="Raw Data"
      data-raw-data-sidebar=""
    >
      <AnimatePresence>
        {showExpandButton && (
          <motion.button
            type="button"
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: 12, opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            whileHover={{ width: 24 }}
            whileFocus={{ width: 24 }}
            transition={{ type: 'tween', duration: 0.2, ease: [0.32, 0.72, 0, 1] }}
            onClick={onExpandFeatures}
            className="absolute right-full top-1/4 z-10 flex h-24 -translate-y-1/2 items-center justify-center overflow-hidden rounded-l-md rounded-r-none border border-r-0 border-white/10 bg-white/[0.12] text-white/50 transition-colors duration-200 ease-out hover:bg-white/20 hover:text-white/85 focus-visible:bg-white/20 focus-visible:text-white/85 focus-visible:outline-none"
            aria-label="View features"
            title="View features"
          >
            <svg
              viewBox="0 0 10 28"
              className="h-4 w-2 shrink-0"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
              aria-hidden="true"
            >
              <path
                d="M8 2 L2 14 L8 26"
                stroke="currentColor"
                strokeWidth="1.25"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </motion.button>
        )}
      </AnimatePresence>
      <div className="flex shrink-0 items-start justify-between gap-3 border-b border-white/10 px-4 py-4">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-white">Raw Data</h2>
          <p className="mt-1 text-sm text-white/50">
            Sample {sample.sampleNumber} · {label}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-xs p-1 text-white/60 opacity-70 transition-opacity hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30"
          aria-label="Close raw data"
          title="Close raw data"
        >
          <X className="size-4" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {rows.length === 0 ? (
          <p className="px-4 py-6 text-sm text-white/55">No raw data available for this sample.</p>
        ) : (
          <table className="w-full border-collapse text-left text-sm">
            <thead className="sticky top-0 z-10 bg-slate-950/95 backdrop-blur-sm">
              <tr className="border-b border-white/15">
                {(['label', 'index', 'timeOffset', 'value'] as const).map((column) => (
                  <th
                    key={column}
                    className="border-r border-white/10 px-3 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-white/55 last:border-r-0"
                  >
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={`${row.label}-${row.index}`}
                  className="border-b border-white/10 odd:bg-white/[0.02] even:bg-transparent hover:bg-cyan-400/[0.04]"
                >
                  <td className="border-r border-white/10 px-3 py-1.5 text-white/80 last:border-r-0">
                    {row.label}
                  </td>
                  <td className="border-r border-white/10 px-3 py-1.5 font-mono text-xs tabular-nums text-white/55 last:border-r-0">
                    {row.index}
                  </td>
                  <td className="border-r border-white/10 px-3 py-1.5 font-mono text-xs tabular-nums text-white/55 last:border-r-0">
                    {row.timeOffset}
                  </td>
                  <td className="border-r border-white/10 px-3 py-1.5 font-mono text-xs tabular-nums text-cyan-300/90 last:border-r-0">
                    {formatWaveformValue(row.value)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </motion.aside>
  );
}

function RawDataSidebar({
  view,
  onClose,
  onExitComplete,
  onExpandFeatures,
  showExpandButton,
}: {
  view: RawDataView | null;
  onClose: () => void;
  onExitComplete?: () => void;
  onExpandFeatures: () => void;
  showExpandButton: boolean;
}) {
  return (
    <AnimatePresence mode="sync" onExitComplete={onExitComplete}>
      {view && (
        <RawDataSidebarPanel
          key={view.sample.id}
          sample={view.sample}
          label={view.label}
          onClose={onClose}
          onExpandFeatures={onExpandFeatures}
          showExpandButton={showExpandButton}
        />
      )}
    </AnimatePresence>
  );
}

function FeaturesSidebarPanel({
  sample,
  label,
  onClose,
  onOpenMoreInfo,
}: {
  sample: DatasetPreviewSample;
  label: string;
  onClose: () => void;
  onOpenMoreInfo: (featureName: string) => void;
}) {
  const rows = useMemo(() => buildFeatureRows(sample), [sample]);

  return (
    <motion.aside
      initial={{ x: '100%' }}
      animate={{ x: 0 }}
      exit={{ x: '100%' }}
      transition={{ type: 'tween', duration: 0.25, ease: [0.32, 0.72, 0, 1] }}
      className="pointer-events-auto absolute inset-x-0 top-0 z-10 flex h-1/2 min-h-0 w-full flex-col border-b border-r border-white/10 bg-slate-900 text-white"
      aria-label="Features"
    >
      <div className="flex shrink-0 items-start justify-between gap-3 border-b border-white/10 px-4 py-4">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-white">Features</h2>
          <p className="mt-1 text-sm text-white/50">
            Sample {sample.sampleNumber} · {label}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-xs p-1 text-white/60 opacity-70 transition-opacity hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30"
          aria-label="Close features"
          title="Close features"
        >
          <X className="size-4" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <table className="w-full border-collapse text-left text-sm">
          <thead className="sticky top-0 z-10 bg-slate-950/95 backdrop-blur-sm">
            <tr className="border-b border-white/15">
              <th className="border-r border-white/10 px-3 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-white/55">
                Feature
              </th>
              <th className="px-3 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-white/55">
                Value
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.name}
                className="border-b border-white/10 odd:bg-white/[0.02] even:bg-transparent hover:bg-cyan-400/[0.04]"
              >
                <td className="border-r border-white/10 px-3 py-2 text-white/80">
                  <div className="flex items-center gap-2">
                    <span>{row.name}</span>
                    <button
                      type="button"
                      onClick={() => onOpenMoreInfo(row.name)}
                      className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-white/20 bg-white/5 text-white/55 transition-colors hover:border-white/35 hover:bg-white/10 hover:text-white/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30"
                      aria-label={`More info about ${row.name}`}
                      title="More info"
                    >
                      <CircleHelp className="h-3 w-3" aria-hidden="true" />
                    </button>
                  </div>
                </td>
                <td
                  className={`px-3 py-2 font-mono text-xs tabular-nums ${
                    row.value === NOT_CALCULATED ? 'text-white/35' : 'text-cyan-300/90'
                  }`}
                >
                  {row.value}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </motion.aside>
  );
}

function FeaturesSidebar({
  view,
  onClose,
  onExitComplete,
  onOpenMoreInfo,
}: {
  view: RawDataView | null;
  onClose: () => void;
  onExitComplete?: () => void;
  onOpenMoreInfo: (featureName: string) => void;
}) {
  return (
    <AnimatePresence mode="sync" onExitComplete={onExitComplete}>
      {view && (
        <FeaturesSidebarPanel
          key={view.sample.id}
          sample={view.sample}
          label={view.label}
          onClose={onClose}
          onOpenMoreInfo={onOpenMoreInfo}
        />
      )}
    </AnimatePresence>
  );
}

function MoreInfoSidebarPanel({
  featureName,
  onClose,
}: {
  featureName: string;
  onClose: () => void;
}) {
  const description = FEATURE_MORE_INFO[featureName] ?? 'Info here';

  return (
    <motion.aside
      initial={{ y: '-100%' }}
      animate={{ y: 0 }}
      exit={{ y: '-100%' }}
      transition={{ type: 'tween', duration: 0.28, ease: [0.32, 0.72, 0, 1] }}
      className="pointer-events-auto absolute inset-x-0 bottom-0 z-[5] flex h-1/2 min-h-0 w-full flex-col border-r border-white/10 bg-slate-900 text-white"
      aria-label="More Information"
    >
      <div className="flex shrink-0 items-start justify-between gap-3 border-b border-white/10 px-4 py-4">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-white">More Information</h2>
          <p className="mt-1 text-sm text-white/50">{featureName}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-xs p-1 text-white/60 opacity-70 transition-opacity hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30"
          aria-label="Close more information"
          title="Close more information"
        >
          <X className="size-4" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4">
        <p className="text-sm leading-relaxed text-white/75">{description}</p>
      </div>
    </motion.aside>
  );
}

function MoreInfoSidebar({
  featureName,
  onClose,
  onExitComplete,
}: {
  featureName: string | null;
  onClose: () => void;
  onExitComplete?: () => void;
}) {
  return (
    <AnimatePresence mode="sync" onExitComplete={onExitComplete}>
      {featureName && (
        <MoreInfoSidebarPanel
          key={featureName}
          featureName={featureName}
          onClose={onClose}
        />
      )}
    </AnimatePresence>
  );
}

function DatasetGestureNavigator({
  gestures,
  selectedGestureId,
  onSelectGestureId,
}: {
  gestures: Gesture[];
  selectedGestureId: string | null;
  onSelectGestureId: (gestureId: string) => void;
}) {
  if (gestures.length === 0) {
    return (
      <div className="rounded-lg border border-white/10 bg-slate-950/40 px-4 py-3 text-sm text-white/55">
        No gestures configured yet.
      </div>
    );
  }

  const currentIndex = Math.max(
    0,
    gestures.findIndex((gesture) => gesture.id === selectedGestureId),
  );
  const currentGesture = gestures[currentIndex] ?? gestures[0];

  const goToPrevious = () => {
    const nextIndex = currentIndex === 0 ? gestures.length - 1 : currentIndex - 1;
    onSelectGestureId(gestures[nextIndex].id);
  };

  const goToNext = () => {
    const nextIndex = currentIndex === gestures.length - 1 ? 0 : currentIndex + 1;
    onSelectGestureId(gestures[nextIndex].id);
  };

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={goToPrevious}
        className="flex items-center justify-center rounded-lg border border-white/10 bg-white/5 p-2 text-white/60 transition-colors hover:bg-white/10 hover:text-white"
        aria-label="Previous gesture"
        title="Previous gesture"
      >
        <ChevronLeft className="h-4 w-4" />
      </button>

      <div className="flex-1 rounded-lg border border-white/10 bg-slate-950/40 px-3 py-2 text-center">
        <p className="text-sm font-medium text-white/90">{currentGesture.name}</p>
      </div>

      <button
        type="button"
        onClick={goToNext}
        className="flex items-center justify-center rounded-lg border border-white/10 bg-white/5 p-2 text-white/60 transition-colors hover:bg-white/10 hover:text-white"
        aria-label="Next gesture"
        title="Next gesture"
      >
        <ChevronRight className="h-4 w-4" />
      </button>
    </div>
  );
}

function DatasetPreviewPanel({
  gestures,
  samplesByGestureId,
  initialGestureId,
  onViewRawData,
}: {
  gestures: Gesture[];
  samplesByGestureId: Record<string, DatasetPreviewSample[]>;
  initialGestureId: string | null;
  onViewRawData: (view: RawDataView | null) => void;
}) {
  const [selectedGestureId, setSelectedGestureId] = useState<string | null>(
    initialGestureId ?? gestures[0]?.id ?? null,
  );

  useEffect(() => {
    if (initialGestureId) {
      setSelectedGestureId(initialGestureId);
    }
  }, [initialGestureId]);

  useEffect(() => {
    if (gestures.length === 0) {
      setSelectedGestureId(null);
      return;
    }

    const isCurrentGestureAvailable = selectedGestureId
      ? gestures.some((gesture) => gesture.id === selectedGestureId)
      : false;

    if (!isCurrentGestureAvailable) {
      const fallbackGestureId =
        initialGestureId && gestures.some((gesture) => gesture.id === initialGestureId)
          ? initialGestureId
          : gestures[0].id;
      setSelectedGestureId(fallbackGestureId);
    }
  }, [gestures, initialGestureId, selectedGestureId]);

  const samples = useMemo(
    () => (selectedGestureId ? samplesByGestureId[selectedGestureId] ?? [] : []),
    [samplesByGestureId, selectedGestureId],
  );

  const selectedGestureName = useMemo(
    () => gestures.find((gesture) => gesture.id === selectedGestureId)?.name ?? '',
    [gestures, selectedGestureId],
  );

  const handleSelectGestureId = (gestureId: string) => {
    setSelectedGestureId(gestureId);
    onViewRawData(null);
  };

  const handleViewRawData = (sample: DatasetPreviewSample) => {
    onViewRawData({ sample, label: selectedGestureName });
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 space-y-4 border-b border-white/10 px-4 pb-4">
        <DatasetGestureNavigator
          gestures={gestures}
          selectedGestureId={selectedGestureId}
          onSelectGestureId={handleSelectGestureId}
        />
      </div>

      {/* Extra left padding leaves room for the extract button to double in width on hover. */}
      <div className="min-h-0 flex-1 overflow-y-auto py-4 pl-8 pr-4">
        {gestures.length === 0 ? (
          <p className="text-sm text-white/55">Add gestures to begin collecting training samples.</p>
        ) : samples.length === 0 ? (
          <p className="text-sm text-white/55">No samples recorded for this gesture yet.</p>
        ) : (
          <div className="flex flex-col gap-4">
            {samples.map((sample) => (
              <DatasetSampleCard
                key={sample.id}
                sample={sample}
                onViewRawData={handleViewRawData}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default function TrainingScreen() {
  const [feedbackState, setFeedbackState] = useState<FeedbackState>('ready');
  const [threshold, setThreshold] = useState(0.6);
  const [segmentDurationMs, setSegmentDurationMs] = useState(DEFAULT_SEGMENT_DURATION_MS);
  const [displayWindowMs, setDisplayWindowMs] = useState(DEFAULT_DISPLAY_WINDOW_MS);
  const [activityDisplaySensitivity, setActivityDisplaySensitivity] = useState(DEFAULT_ACTIVITY_DISPLAY_SENSITIVITY);
  const [selectedChannelIndex, setSelectedChannelIndex] = useState(0);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isDatasetPreviewOpen, setIsDatasetPreviewOpen] = useState(false);
  const [rawDataView, setRawDataView] = useState<RawDataView | null>(null);
  const [isRawDataSlotOpen, setIsRawDataSlotOpen] = useState(false);
  const rawDataViewRef = useRef<RawDataView | null>(null);
  const [isFeaturesOpen, setIsFeaturesOpen] = useState(false);
  const [isFeaturesSlotOpen, setIsFeaturesSlotOpen] = useState(false);
  const [moreInfoFeature, setMoreInfoFeature] = useState<string | null>(null);
  const moreInfoFeatureRef = useRef<string | null>(null);
  const pendingCloseRawAfterFeaturesRef = useRef(false);
  const pendingCloseSheetAfterRawRef = useRef(false);
  const pendingCloseFeaturesAfterMoreInfoRef = useRef(false);
  const pendingRawDataViewRef = useRef<RawDataView | null>(null);
  const isClosingDatasetPreviewRef = useRef(false);
  const [minRequired, setMinRequired] = useState(8);
  const [sampleTarget, setSampleTarget] = useState(12);
  const [targetSamplesInputValue, setTargetSamplesInputValue] = useState('12');
  const [segmentDurationInputValue, setSegmentDurationInputValue] = useState(String(DEFAULT_SEGMENT_DURATION_MS));
  const [displayWindowInputValue, setDisplayWindowInputValue] = useState((DEFAULT_DISPLAY_WINDOW_MS / 1000).toFixed(1));
  const [activityDisplaySensitivityInputValue, setActivityDisplaySensitivityInputValue] = useState(
    DEFAULT_ACTIVITY_DISPLAY_SENSITIVITY.toFixed(1)
  );
  const [selectedSampleId, setSelectedSampleId] = useState<number | null>(null);
  const [gestures, setGestures] = useState<Gesture[]>(DEFAULT_GESTURES);
  const [currentGestureId, setCurrentGestureId] = useState<string>(DEFAULT_GESTURES[0].id);
  const [datasetPreviewGestureId, setDatasetPreviewGestureId] = useState<string>(DEFAULT_GESTURES[0].id);
  const [newGestureName, setNewGestureName] = useState('');
  const [isGestureDropdownOpen, setIsGestureDropdownOpen] = useState(false);
  const [showGestureChangeMessage, setShowGestureChangeMessage] = useState(false);
  const [showRawSignal, setShowRawSignal] = useState(false);
  const [activeScreen, setActiveScreen] = useState<AppScreen>('training');
  const [trainingSession, setTrainingSession] = useState<TrainingSessionData | null>(null);
  const [testingSession, setTestingSession] = useState<TestingSessionData | null>(null);
  const [testingSettings, setTestingSettings] = useState<TestingSessionSettings>(
    DEFAULT_TESTING_SESSION_SETTINGS,
  );
  const previewPanelRef = useRef<HTMLDivElement>(null);
  const gestureDropdownRef = useRef<HTMLDivElement>(null);

  rawDataViewRef.current = rawDataView;
  moreInfoFeatureRef.current = moreInfoFeature;

  const featuresView = isFeaturesOpen ? rawDataView : null;
  const featuresViewRef = useRef<RawDataView | null>(null);
  featuresViewRef.current = featuresView;

  const beginCloseFeatures = useCallback(() => {
    pendingRawDataViewRef.current = null;
    if (moreInfoFeature !== null) {
      pendingCloseFeaturesAfterMoreInfoRef.current = true;
      setMoreInfoFeature(null);
      return;
    }
    setIsFeaturesOpen(false);
  }, [moreInfoFeature]);

  const closeMoreInfo = useCallback(() => {
    pendingCloseFeaturesAfterMoreInfoRef.current = false;
    pendingRawDataViewRef.current = null;
    setMoreInfoFeature(null);
  }, []);

  const openMoreInfo = useCallback((featureName: string) => {
    pendingCloseFeaturesAfterMoreInfoRef.current = false;
    setMoreInfoFeature(featureName);
  }, []);

  const showRawDataForSample = useCallback(
    (view: RawDataView) => {
      // Let More Information retract first; the swap runs on its exit.
      if (moreInfoFeature !== null) {
        pendingRawDataViewRef.current = view;
        setMoreInfoFeature(null);
        return;
      }
      setIsRawDataSlotOpen(true);
      setRawDataView(view);
    },
    [moreInfoFeature],
  );

  const closeFeatures = useCallback(() => {
    pendingCloseRawAfterFeaturesRef.current = false;
    pendingCloseSheetAfterRawRef.current = false;
    isClosingDatasetPreviewRef.current = false;
    beginCloseFeatures();
  }, [beginCloseFeatures]);

  const openFeatures = useCallback(() => {
    pendingCloseRawAfterFeaturesRef.current = false;
    pendingCloseSheetAfterRawRef.current = false;
    pendingCloseFeaturesAfterMoreInfoRef.current = false;
    isClosingDatasetPreviewRef.current = false;
    setMoreInfoFeature(null);
    setIsFeaturesOpen(true);
    setIsFeaturesSlotOpen(true);
  }, []);

  const closeRawData = useCallback(() => {
    if (isClosingDatasetPreviewRef.current) {
      return;
    }
    pendingCloseSheetAfterRawRef.current = false;
    if (isFeaturesOpen || isFeaturesSlotOpen) {
      pendingCloseRawAfterFeaturesRef.current = true;
      beginCloseFeatures();
      return;
    }
    setRawDataView(null);
  }, [isFeaturesOpen, isFeaturesSlotOpen, beginCloseFeatures]);

  const beginCloseDatasetPreview = useCallback(() => {
    if (isClosingDatasetPreviewRef.current) {
      return;
    }
    isClosingDatasetPreviewRef.current = true;

    if (isFeaturesOpen || isFeaturesSlotOpen || moreInfoFeature !== null) {
      pendingCloseRawAfterFeaturesRef.current = true;
      pendingCloseSheetAfterRawRef.current = true;
      beginCloseFeatures();
      return;
    }

    if (rawDataView !== null || isRawDataSlotOpen) {
      pendingCloseSheetAfterRawRef.current = true;
      setRawDataView(null);
      return;
    }

    isClosingDatasetPreviewRef.current = false;
    pendingCloseRawAfterFeaturesRef.current = false;
    pendingCloseSheetAfterRawRef.current = false;
    pendingCloseFeaturesAfterMoreInfoRef.current = false;
    setIsDatasetPreviewOpen(false);
  }, [isFeaturesOpen, isFeaturesSlotOpen, moreInfoFeature, rawDataView, isRawDataSlotOpen, beginCloseFeatures]);

  const generateMockSignalValue = useCallback(() => {
    const cycleDurationMs = Math.max(segmentDurationMs, 1);
    const progress = (Date.now() % cycleDurationMs) / cycleDurationMs;

    switch (feedbackState) {
      case 'recording':
      case 'good':
        return getChannelMockSignalValue(selectedChannelIndex, progress, 'active');
      case 'weak':
        return getChannelMockSignalValue(selectedChannelIndex, progress, 'weak');
      case 'noisy':
        return getChannelMockSignalValue(selectedChannelIndex, progress, 'noisy');
      case 'short':
        return getChannelMockSignalValue(selectedChannelIndex, progress, 'short');
      default:
        return getChannelMockSignalValue(selectedChannelIndex, progress, 'idle');
    }
  }, [feedbackState, segmentDurationMs, selectedChannelIndex]);

  const {
    signalData,
    recordingSignalData,
    signalSourceMode,
    isStreaming,
    selectSignalSourceMode,
    startStream,
    startStreamForMode,
    stopStream,
    liveConnectionStatus,
    liveConnectionMessage,
    liveDeviceName,
    livePacketCount,
    liveDisplayScale,
    liveSampleRateHz,
    isBluetoothAvailable
  } = useSignalSource(
    generateMockSignalValue,
    displayWindowMs,
    selectedChannelIndex,
    activityDisplaySensitivity
  );

  const {
    recorderState,
    isRecording,
    recordingStartTime,
    recordingProgress,
    currentCapturedSegment,
    completedSegment,
    acknowledgeCompletedSegment,
    diagnostics: recorderDiagnostics,
  } = useGestureRecorder({
    signalPoints: recordingSignalData,
    threshold,
    segmentDurationMs,
    isStreaming,
    resetKey: `${signalSourceMode}:${selectedChannelIndex}`,
    minSegmentPoints: MIN_SEGMENT_POINTS,
    cooldownMs: signalSourceMode === 'mock' ? 50 : undefined,
    hysteresisRatio: signalSourceMode === 'mock' ? 1 : undefined,
  });
  
  const isRecordedSampleStatus = (status: SampleStatus) => RECORDED_SAMPLE_STATUSES.includes(status);

  const createEmptySamples = (totalCount: number = 12): Sample[] =>
    Array.from({ length: totalCount }, (_, i) => ({
      id: i,
      status: 'empty' as const,
    }));

  const initializeGestureData = (gestureList: Gesture[]): Record<string, GestureData> =>
    Object.fromEntries(gestureList.map((gesture) => [gesture.id, { samples: createEmptySamples() }]));

  const [gestureData, setGestureData] = useState<Record<string, GestureData>>(() =>
    initializeGestureData(DEFAULT_GESTURES),
  );

  const currentGesture = gestures.find((gesture) => gesture.id === currentGestureId) ?? gestures[0];
  const currentSamples = gestureData[currentGesture?.id ?? '']?.samples ?? [];
  const [hoveredSample, setHoveredSample] = useState<number | null>(null);
  const [highlightSegment, setHighlightSegment] = useState<'good' | 'bad' | null>(null);

  const samplesCollected = currentSamples.filter((sample) => isRecordedSampleStatus(sample.status)).length;
  const samplesPerGesture = gestures.map((gesture) => ({
    gesture: gesture.name,
    gestureId: gesture.id,
    count: gestureData[gesture.id]?.samples.filter((sample) => isRecordedSampleStatus(sample.status)).length ?? 0,
  }));
  const totalSamplesCollected = samplesPerGesture.reduce((sum, entry) => sum + entry.count, 0);
  const isAllSamplesCollected = gestures.every(
    (gesture) => gestureData[gesture.id]?.samples.every((sample) => sample.status !== 'empty') ?? false,
  );

  const trainingSamplesByGestureId = useMemo(
    () =>
      Object.fromEntries(
        gestures.map((gesture) => [
          gesture.id,
          capturedSamplesToPreviewSamples(
            gesture.id,
            gestureData[gesture.id]?.samples ?? [],
            segmentDurationMs,
          ),
        ]),
      ),
    [gestures, gestureData, segmentDurationMs],
  );

  useEffect(() => {
    setTargetSamplesInputValue(String(sampleTarget));
  }, [sampleTarget]);

  useEffect(() => {
    setSegmentDurationInputValue(String(segmentDurationMs));
  }, [segmentDurationMs]);

  useEffect(() => {
    setDisplayWindowInputValue((displayWindowMs / 1000).toFixed(1));
  }, [displayWindowMs]);

  useEffect(() => {
    setActivityDisplaySensitivityInputValue(activityDisplaySensitivity.toFixed(1));
  }, [activityDisplaySensitivity]);

  // Simulate state changes for demonstration
  useEffect(() => {
    if (signalSourceMode !== 'mock' || !isStreaming || isRecording) {
      return;
    }

    const stateSequence: FeedbackState[] = ['ready', 'recording', 'good', 'ready', 'weak', 'ready', 'noisy', 'ready'];
    let currentIndex = 0;

    const stateInterval = setInterval(() => {
      currentIndex = (currentIndex + 1) % stateSequence.length;
      const newState = stateSequence[currentIndex];
      setFeedbackState(newState);
      
      // Simulate segment highlights
      if (newState === 'good') {
        setHighlightSegment('good');
        setTimeout(() => setHighlightSegment(null), 800);
      } else if (newState === 'weak' || newState === 'noisy') {
        setHighlightSegment('bad');
        setTimeout(() => setHighlightSegment(null), 800);
      }
    }, 3000);

    return () => clearInterval(stateInterval);
  }, [isRecording, isStreaming, signalSourceMode]);

  useEffect(() => {
    if (signalSourceMode === 'mock') {
      return;
    }

    if (recorderState === 'recording') {
      setFeedbackState('recording');
      setHighlightSegment('good');
      return;
    }

    if (recorderState === 'cooldown') {
      return;
    }

    setFeedbackState('ready');
    setHighlightSegment(null);
  }, [recorderState, signalSourceMode]);

  useEffect(() => {
    if (!isRecording) {
      return;
    }

    setFeedbackState('recording');
    setHighlightSegment('good');
  }, [isRecording]);

  useEffect(() => {
    if (!completedSegment) {
      return;
    }

    const waveformData = completedSegment.points;
    if (waveformData.length < MIN_SEGMENT_POINTS) {
      setFeedbackState('short');
      setHighlightSegment(null);
      acknowledgeCompletedSegment();
      return;
    }

    const peak = waveformData.reduce((max, samplePoint) => Math.max(max, samplePoint.value), 0);
    const quality: SampleQuality = peak >= threshold + 0.08 ? 'good' : 'weak';

    setGestureData((prev) => {
      const gesture = prev[currentGestureId];
      if (!gesture) {
        return prev;
      }
      const targetIndex = gesture.samples.findIndex((sample) => sample.status === 'empty');

      if (targetIndex === -1) {
        return prev;
      }

      return {
        ...prev,
        [currentGestureId]: {
          samples: gesture.samples.map((sample, index) =>
            index === targetIndex
              ? {
                  ...sample,
                  status: 'collected',
                  timestamp: completedSegment.completedAt,
                  waveformData,
                  quality,
                }
              : sample
          ),
        },
      };
    });

    setFeedbackState(quality);
    setHighlightSegment(quality === 'good' ? 'good' : 'bad');
    setTimeout(() => setHighlightSegment(null), 800);
    acknowledgeCompletedSegment();
  }, [acknowledgeCompletedSegment, completedSegment, currentGestureId, threshold]);

  // Close preview when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (selectedSampleId !== null && 
          previewPanelRef.current && 
          !previewPanelRef.current.contains(event.target as Node)) {
        // Check if click is not on a sample slot
        const target = event.target as HTMLElement;
        if (!target.closest('[data-sample-slot]')) {
          setSelectedSampleId(null);
        }
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [selectedSampleId]);

  // Close gesture dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (isGestureDropdownOpen && 
          gestureDropdownRef.current && 
          !gestureDropdownRef.current.contains(event.target as Node)) {
        setIsGestureDropdownOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isGestureDropdownOpen]);

  const handleRemoveSample = (sampleId: number) => {
    setGestureData(prev => ({
      ...prev,
      [currentGestureId]: {
        samples: prev[currentGestureId]?.samples.map(s =>
          s.id === sampleId ? { ...s, status: 'empty', timestamp: undefined, waveformData: undefined, quality: undefined } : s
        )
      }
    }));
    setSelectedSampleId(null);
  };

  const handleRedoLast = () => {
    const lastCollectedIndex = currentSamples.map((s, i) => isRecordedSampleStatus(s.status) ? i : -1)
      .filter(i => i !== -1)
      .pop();
    
    if (lastCollectedIndex !== undefined) {
      handleRemoveSample(lastCollectedIndex);
    }
  };

  const handleClearDataset = () => {
    const confirmed = window.confirm('Clear all recorded samples across every gesture? This cannot be undone.');
    if (!confirmed) {
      return;
    }

    setGestureData(prev => {
      const nextGestureData = { ...prev };

      for (const gesture of gestures) {
        nextGestureData[gesture.id] = {
          samples: prev[gesture.id]?.samples.map((sample) => ({
            id: sample.id,
            status: 'empty' as const
          }))
        };
      }

      return nextGestureData;
    });

    setSelectedSampleId(null);
  };

  const handleThresholdChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setThreshold(parseFloat(e.target.value));
  };

  const applyTargetSampleValue = (nextValue: number) => {
    const clampedValue = Math.max(1, Math.min(50, nextValue));
    setSampleTarget(clampedValue);
    setMinRequired(clampedValue);

    setGestureData(prev => {
      const nextGestureData = { ...prev };

      for (const gesture of gestures) {
        const existingSamples = prev[gesture.id]?.samples ?? createEmptySamples();

        if (clampedValue > existingSamples.length) {
          nextGestureData[gesture.id] = {
            samples: [
              ...existingSamples,
              ...Array.from({ length: clampedValue - existingSamples.length }, (_, i) => ({
                id: existingSamples.length + i,
                status: 'empty' as const
              }))
            ]
          };
          continue;
        }

        if (clampedValue < existingSamples.length) {
          nextGestureData[gesture.id] = {
            samples: existingSamples.slice(0, clampedValue)
          };
          continue;
        }

        nextGestureData[gesture.id] = prev[gesture.id] ?? { samples: createEmptySamples() };
      }

      return nextGestureData;
    });
  };

  const handleTargetSampleChange = (delta: number) => {
    applyTargetSampleValue(sampleTarget + delta);
  };

  const handleTargetSampleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setTargetSamplesInputValue(e.target.value);
  };

  const commitTargetSamplesInputValue = () => {
    const parsedValue = Number.parseInt(targetSamplesInputValue, 10);
    if (targetSamplesInputValue.trim() === '' || Number.isNaN(parsedValue)) {
      setTargetSamplesInputValue(String(sampleTarget));
      return;
    }

    applyTargetSampleValue(parsedValue);
  };

  const applySegmentDurationValue = (nextValue: number) => {
    setSegmentDurationMs(Math.max(400, Math.min(3000, nextValue)));
  };

  const handleSegmentDurationChange = (delta: number) => {
    applySegmentDurationValue(segmentDurationMs + delta);
  };

  const handleSegmentDurationInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSegmentDurationInputValue(e.target.value);
  };

  const commitSegmentDurationInputValue = () => {
    const parsedValue = Number.parseInt(segmentDurationInputValue, 10);
    if (segmentDurationInputValue.trim() === '' || Number.isNaN(parsedValue)) {
      setSegmentDurationInputValue(String(segmentDurationMs));
      return;
    }

    applySegmentDurationValue(parsedValue);
  };

  const applyDisplayWindowValue = (nextValueMs: number) => {
    const clampedValue = Math.max(2000, Math.min(10000, nextValueMs));
    setDisplayWindowMs(Math.round(clampedValue / 100) * 100);
  };

  const handleDisplayWindowChange = (deltaSeconds: number) => {
    applyDisplayWindowValue(displayWindowMs + deltaSeconds * 1000);
  };

  const handleDisplayWindowInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setDisplayWindowInputValue(e.target.value);
  };

  const commitDisplayWindowInputValue = () => {
    const parsedValue = Number.parseFloat(displayWindowInputValue);
    if (displayWindowInputValue.trim() === '' || Number.isNaN(parsedValue)) {
      setDisplayWindowInputValue((displayWindowMs / 1000).toFixed(1));
      return;
    }

    applyDisplayWindowValue(parsedValue * 1000);
  };

  const applyActivityDisplaySensitivityValue = (nextValue: number) => {
    const clampedValue = Math.max(0.5, Math.min(1.5, nextValue));
    setActivityDisplaySensitivity(Math.round(clampedValue * 10) / 10);
  };

  const handleActivityDisplaySensitivityChange = (delta: number) => {
    applyActivityDisplaySensitivityValue(activityDisplaySensitivity + delta);
  };

  const handleActivityDisplaySensitivityInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setActivityDisplaySensitivityInputValue(e.target.value);
  };

  const commitActivityDisplaySensitivityInputValue = () => {
    const parsedValue = Number.parseFloat(activityDisplaySensitivityInputValue);
    if (activityDisplaySensitivityInputValue.trim() === '' || Number.isNaN(parsedValue)) {
      setActivityDisplaySensitivityInputValue(activityDisplaySensitivity.toFixed(1));
      return;
    }

    applyActivityDisplaySensitivityValue(parsedValue);
  };

  const handleNumericInputKeyDown = (
    e: React.KeyboardEvent<HTMLInputElement>,
    commitValue: () => void
  ) => {
    if (e.key !== 'Enter') {
      return;
    }

    commitValue();
    e.currentTarget.blur();
  };

  const handleSignalSourceChange = (mode: SignalSourceMode) => {
    void selectSignalSourceMode(mode);
  };

  const handleMainStreamToggle = () => {
    if (liveConnectionStatus === 'connecting') {
      return;
    }

    if (isStreaming) {
      void stopStream();
      return;
    }

    void startStream();
  };

  const getFeedbackConfig = () => {
    switch (feedbackState) {
      case 'ready':
        return {
          text: 'Start',
          color: 'text-cyan-400',
          bgColor: 'bg-cyan-400/10',
          borderColor: 'border-cyan-400/30',
          instruction: 'Pinch and hold above the line'
        };
      case 'recording':
        return {
          text: 'Recording',
          color: 'text-blue-400',
          bgColor: 'bg-blue-400/10',
          borderColor: 'border-blue-400/30',
          instruction: 'Keep the signal steady'
        };
      case 'good':
        return {
          text: 'Good Sample',
          color: 'text-emerald-400',
          bgColor: 'bg-emerald-400/10',
          borderColor: 'border-emerald-400/30',
          instruction: 'Well done! Continue...'
        };
      case 'weak':
        return {
          text: 'Too Weak',
          color: 'text-amber-400',
          bgColor: 'bg-amber-400/10',
          borderColor: 'border-amber-400/30',
          instruction: 'Use stronger activation'
        };
      case 'noisy':
        return {
          text: 'Too Noisy',
          color: 'text-orange-400',
          bgColor: 'bg-orange-400/10',
          borderColor: 'border-orange-400/30',
          instruction: 'Relax and try again'
        };
      case 'short':
        return {
          text: 'Too Short',
          color: 'text-red-400',
          bgColor: 'bg-red-400/10',
          borderColor: 'border-red-400/30',
          instruction: 'Hold the gesture longer'
        };
    }
  };
  
  const getSampleQualityConfig = (quality?: SampleQuality) => {
    switch (quality) {
      case 'good':
        return {
          text: 'Good Sample',
          color: 'text-emerald-400',
          borderColor: 'border-emerald-400/40',
          shadowColor: 'shadow-emerald-400/20',
          gradientStart: '#10b981',
          gradientEnd: '#059669'
        };
      case 'weak':
        return {
          text: 'Too Weak',
          color: 'text-amber-400',
          borderColor: 'border-amber-400/40',
          shadowColor: 'shadow-amber-400/20',
          gradientStart: '#f59e0b',
          gradientEnd: '#d97706'
        };
      case 'noisy':
        return {
          text: 'Too Noisy',
          color: 'text-orange-400',
          borderColor: 'border-orange-400/40',
          shadowColor: 'shadow-orange-400/20',
          gradientStart: '#fb923c',
          gradientEnd: '#ea580c'
        };
      default:
        return {
          text: 'Unknown',
          color: 'text-white/60',
          borderColor: 'border-white/20',
          shadowColor: 'shadow-white/10',
          gradientStart: '#22d3ee',
          gradientEnd: '#06b6d4'
        };
    }
  };

  const feedback = getFeedbackConfig();
  const latestRecordingSignal = recordingSignalData[recordingSignalData.length - 1];
  const latestDisplaySignal = signalData[signalData.length - 1];
  const latestSignal = latestRecordingSignal ?? latestDisplaySignal;
  const recordingSecondsRemaining = Math.max(
    0,
    (segmentDurationMs - Math.round(recordingProgress * segmentDurationMs)) / 1000
  );
  const progressCircleRadius = 26;
  const progressCircleCircumference = 2 * Math.PI * progressCircleRadius;
  const progressCircleOffset = progressCircleCircumference * (1 - recordingProgress);
  const chartWindowEnd = Math.max(
    signalData[signalData.length - 1]?.time ?? 0,
    recordingSignalData[recordingSignalData.length - 1]?.time ?? 0,
    Date.now()
  );
  const chartWindowStart = chartWindowEnd - displayWindowMs;
  const activityChartData = signalData.filter((point) => point.time >= chartWindowStart);
  const rawChartData = recordingSignalData.filter((point) => point.time >= chartWindowStart);
  const activeSegmentEnd = recordingStartTime !== null
    ? Math.min(recordingStartTime + segmentDurationMs, chartWindowEnd)
    : null;
  const rawValues = rawChartData.map((point) => point.raw);
  const rawMin = rawValues.length > 0 ? Math.min(...rawValues) : -1;
  const rawMax = rawValues.length > 0 ? Math.max(...rawValues) : 1;
  const rawRange = Math.max(rawMax - rawMin, 0.0001);
  const rawDomain: [number, number] = [
    rawMin - rawRange * 0.15,
    rawMax + rawRange * 0.15,
  ];
  const chartWindowSeconds = displayWindowMs / 1000;
  const activityTickCount = 4;
  const activityTimeTicks = Array.from({ length: activityTickCount }, (_, index) => {
    const ratio = index / (activityTickCount - 1);
    const secondsFromNow = chartWindowSeconds * (1 - ratio);
    return {
      key: index,
      left: `${ratio * 100}%`,
      label: index === activityTickCount - 1 ? 'now' : `-${secondsFromNow.toFixed(secondsFromNow >= 2 ? 0 : 1)}s`,
    };
  });
  const segmentLabelLeft = recordingStartTime !== null
    ? Math.max(0, Math.min(84, ((recordingStartTime - chartWindowStart) / displayWindowMs) * 100))
    : null;
  // Determine graph glow based on signal crossing threshold
  const isAboveThreshold = signalSourceMode === 'live'
    ? (latestSignal?.normalizedActivity ?? 0) > threshold
    : (latestSignal?.value ?? 0) > threshold;
  const signalSourceLabels: SignalSourceLabel = {
    mock: 'Mock',
    live: 'Connect Ganglion'
  };
  const liveStatusText =
    !isStreaming && liveConnectionStatus !== 'connecting' && liveConnectionStatus !== 'error'
      ? `${signalSourceMode === 'live' ? 'Live' : 'Mock'}: Idle`
      : liveConnectionStatus === 'streaming'
      ? `Ganglion: Streaming${liveDeviceName ? ` (${liveDeviceName})` : ''}`
      : liveConnectionStatus === 'connected'
      ? `Ganglion: Connected${liveDeviceName ? ` (${liveDeviceName})` : ''}`
      : liveConnectionStatus === 'connecting'
      ? 'Ganglion: Connecting'
      : liveConnectionStatus === 'error'
      ? `Ganglion: ${liveConnectionMessage}`
      : 'Ganglion: Disconnected';
  const selectedChannelLabel = `Channel ${selectedChannelIndex + 1}`;
  const mainStreamControlLabel =
    liveConnectionStatus === 'connecting'
      ? 'Connecting...'
      : isStreaming
      ? signalSourceMode === 'live'
        ? 'Stop Live'
        : 'Pause'
      : signalSourceMode === 'live'
      ? 'Connect'
      : 'Start';
  const sourceModeLabel = signalSourceMode === 'live' ? 'Live Training' : 'Mock Training';
  const sourceModeDescription =
    signalSourceMode === 'live'
      ? liveDeviceName
        ? `Ganglion ready: ${liveDeviceName}`
        : 'Use Ganglion for real EMG sample collection'
      : 'Use synthetic signal for development and UI checks';
  const connectionStatusLabel =
    !isStreaming && liveConnectionStatus !== 'connecting' && liveConnectionStatus !== 'error'
      ? 'Idle'
      : 
    liveConnectionStatus === 'streaming' || liveConnectionStatus === 'connected'
      ? 'Connected'
      : liveConnectionStatus === 'connecting'
      ? 'Connecting...'
      : liveConnectionStatus === 'error'
      ? 'Error'
      : 'Disconnected';
  const statusDotClass =
    liveConnectionStatus === 'streaming' || liveConnectionStatus === 'connected'
      ? 'bg-emerald-400 shadow-[0_0_12px_rgba(52,211,153,0.35)]'
      : liveConnectionStatus === 'connecting'
      ? 'bg-amber-400 shadow-[0_0_10px_rgba(251,191,36,0.25)]'
      : 'bg-white/25';

  const buildExportSamplesByLabel = (): Record<string, ExportSample[]> => {
    const exportedSamples: Record<string, ExportSample[]> = {};

    for (const gesture of gestures) {
      exportedSamples[gesture.name] = (gestureData[gesture.id]?.samples ?? [])
        .filter((sample) => isRecordedSampleStatus(sample.status) && sample.waveformData && sample.waveformData.length > 0)
        .map((sample) => {
          const waveformData = sample.waveformData ?? [];
          const firstPointTime = waveformData[0]?.time ?? sample.timestamp ?? Date.now();
          const lastPointTime = waveformData[waveformData.length - 1]?.time ?? firstPointTime;
          const timestamp = sample.timestamp ?? firstPointTime;
          const duration = waveformData.length > 1
            ? Math.max(0, lastPointTime - firstPointTime)
            : segmentDurationMs;

          return {
            id: `${gesture.id}-${sample.id}-${timestamp}`,
            label: gesture.name,
            timestamp,
            data: waveformData.map((point) => point.value),
            duration
          };
        });
    }

    return exportedSamples;
  };

  const handleStartTesting = () => {
    const session = buildTrainingSession({
      gestures,
      gestureSamples: Object.fromEntries(
        gestures.map((gesture) => [gesture.id, gestureData[gesture.id]?.samples ?? []]),
      ),
      sampleTarget,
      segmentDurationMs,
    });
    setTrainingSession(session);
    setTestingSession(null);
    setActiveScreen('testing');
  };

  const handleAddGesture = () => {
    const trimmedName = newGestureName.trim();
    if (!trimmedName) {
      return;
    }

    const duplicate = gestures.some(
      (gesture) => gesture.name.toLowerCase() === trimmedName.toLowerCase(),
    );
    if (duplicate) {
      return;
    }

    const nextGesture = createGesture(trimmedName);
    setGestures((prev) => [...prev, nextGesture]);
    setGestureData((prev) => ({
      ...prev,
      [nextGesture.id]: { samples: createEmptySamples(sampleTarget) },
    }));
    setNewGestureName('');
  };

  const handleRemoveGesture = (gestureId: string) => {
    if (gestures.length <= 1) {
      return;
    }

    const hasRecordedSamples = (gestureData[gestureId]?.samples ?? []).some((sample) =>
      isRecordedSampleStatus(sample.status),
    );
    if (hasRecordedSamples) {
      return;
    }

    const nextGestures = gestures.filter((gesture) => gesture.id !== gestureId);
    setGestures(nextGestures);
    setGestureData((prev) => {
      const next = { ...prev };
      delete next[gestureId];
      return next;
    });

    if (currentGestureId === gestureId) {
      setCurrentGestureId(nextGestures[0]?.id ?? '');
      setSelectedSampleId(null);
    }
  };

  const downloadBlob = (content: BlobPart, fileName: string, mimeType: string) => {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.click();
    URL.revokeObjectURL(url);
  };

  const handleExportJson = () => {
    const exportTimestamp = Date.now();
    const samplesByLabel = buildExportSamplesByLabel();
    const payload = {
      exportedAt: exportTimestamp,
      samplesByLabel
    };

    downloadBlob(
      JSON.stringify(payload, null, 2),
      `emg_dataset_${exportTimestamp}.json`,
      'application/json'
    );
  };

  const handleExportCsv = async () => {
    const exportTimestamp = Date.now();
    const samplesByLabel = buildExportSamplesByLabel();
    const allSamples = Object.values(samplesByLabel).flat();

    const metadataRows = allSamples.map((sample) => ({
      sampleId: sample.id,
      label: sample.label,
      timestamp: sample.timestamp,
      duration: sample.duration,
      sampleLength: sample.data.length
    }));

    const timeseriesRows = allSamples.flatMap((sample) => {
      const stepMs = sample.data.length > 1
        ? sample.duration / Math.max(sample.data.length - 1, 1)
        : 0;

      return sample.data.map((value, index) => ({
        sampleId: sample.id,
        label: sample.label,
        index,
        timeOffset: Number((index * stepMs).toFixed(3)),
        value
      }));
    });

    const metadataFrame = new dfd.DataFrame(metadataRows);
    const timeseriesFrame = new dfd.DataFrame(timeseriesRows);
    const metadataCsv = await Promise.resolve(dfd.toCSV(metadataFrame, { download: false })) as string;
    const timeseriesCsv = await Promise.resolve(dfd.toCSV(timeseriesFrame, { download: false })) as string;

    downloadBlob(metadataCsv, `emg_dataset_${exportTimestamp}_metadata.csv`, 'text/csv;charset=utf-8;');
    downloadBlob(timeseriesCsv, `emg_dataset_${exportTimestamp}_timeseries.csv`, 'text/csv;charset=utf-8;');
  };

  if (activeScreen === 'testing' && trainingSession) {
    return (
      <TestingScreen
        trainingSession={trainingSession}
        recordingSignalData={recordingSignalData}
        signalSourceMode={signalSourceMode}
        isStreaming={isStreaming}
        startStreamForMode={startStreamForMode}
        liveConnectionStatus={liveConnectionStatus}
        liveConnectionMessage={liveConnectionMessage}
        liveDeviceName={liveDeviceName}
        selectedChannelIndex={selectedChannelIndex}
        isBluetoothAvailable={isBluetoothAvailable}
        onSessionComplete={setTestingSession}
        onShowResults={() => setActiveScreen('results')}
        onExit={() => setActiveScreen('training')}
        settings={testingSettings}
        onSettingsChange={setTestingSettings}
      />
    );
  }

  if (activeScreen === 'results' && testingSession) {
    return (
      <ResultScreen
        testingSession={testingSession}
        onRetrain={() => setActiveScreen('training')}
        onTestAgain={() => setActiveScreen('testing')}
      />
    );
  }

  return (
    <div className="size-full bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 flex items-center justify-center p-8">
      <div className="w-full max-w-5xl flex flex-col gap-8">
        {/* 1. Objective Header */}
        <div className="flex items-end justify-between">
          <div className="flex flex-col gap-2">
            <div className="flex items-baseline gap-3">
              <h1 className="text-3xl font-light text-white/90">
                Perform Gesture:
              </h1>
              
              {/* Gesture Selector */}
              <div className="relative" ref={gestureDropdownRef}>
                <button
                  onClick={() => setIsGestureDropdownOpen(!isGestureDropdownOpen)}
                  className="flex items-center gap-2 px-4 py-1.5 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg transition-colors group"
                >
                  <span className="text-2xl font-medium text-white">{currentGesture?.name}</span>
                  <ChevronDown className={`w-5 h-5 text-white/60 transition-transform ${isGestureDropdownOpen ? 'rotate-180' : ''}`} />
                </button>
                
                <AnimatePresence>
                  {isGestureDropdownOpen && (
                    <motion.div
                      initial={{ opacity: 0, y: -8, scale: 0.95 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: -8, scale: 0.95 }}
                      transition={{ duration: 0.15 }}
                      className="absolute top-full mt-2 left-0 min-w-[140px] bg-slate-800/95 backdrop-blur-sm border border-white/10 rounded-lg shadow-2xl overflow-hidden z-10"
                    >
                      {gestures.map((gesture) => (
                        <button
                          key={gesture.id}
                          onClick={() => {
                            if (gesture.id !== currentGestureId) {
                              setCurrentGestureId(gesture.id);
                              setSelectedSampleId(null);
                              setShowGestureChangeMessage(true);
                              setTimeout(() => setShowGestureChangeMessage(false), 2000);
                            }
                            setIsGestureDropdownOpen(false);
                          }}
                          className={`w-full px-4 py-2.5 text-left text-sm transition-colors ${
                            gesture.id === currentGestureId
                              ? 'bg-cyan-400/10 text-cyan-400'
                              : 'text-white/70 hover:bg-white/10 hover:text-white'
                          }`}
                        >
                          {gesture.name}
                        </button>
                      ))}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
              
              {/* Gesture Change Message */}
              <AnimatePresence>
                {showGestureChangeMessage && (
                  <motion.div
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -10 }}
                    transition={{ duration: 0.2 }}
                    className="px-3 py-1 bg-cyan-400/10 border border-cyan-400/30 rounded-lg text-sm text-cyan-400"
                  >
                    Now training: {currentGesture?.name}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
            
            <div className="flex flex-col gap-1">
              <p className="text-lg text-white/50">
                Minimum required: {minRequired}
              </p>
              <p className="text-lg text-emerald-400/80">
                Collected: {samplesCollected}
              </p>
            </div>
          </div>
          
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                setDatasetPreviewGestureId(currentGestureId);
                setIsDatasetPreviewOpen(true);
              }}
              className={`flex items-center justify-center rounded-lg border p-2 transition-colors ${
                isDatasetPreviewOpen
                  ? 'border-cyan-400/30 bg-cyan-400/10 text-cyan-300'
                  : 'border-white/10 bg-white/5 text-white/60 hover:bg-white/10 hover:text-white'
              }`}
              title="Open dataset preview"
              aria-label="Open dataset preview"
              aria-pressed={isDatasetPreviewOpen}
            >
              <Brain className="h-4 w-4" />
            </button>

            <Sheet open={isSettingsOpen} onOpenChange={setIsSettingsOpen}>
            <SheetTrigger asChild>
              <button
                className="flex items-center justify-center rounded-lg border border-white/10 bg-white/5 p-2 text-white/60 transition-colors hover:bg-white/10 hover:text-white"
                title="Open settings"
              >
                <Settings2 className="w-4 h-4" />
              </button>
            </SheetTrigger>
            <SheetContent side="right" className="border-white/10 bg-slate-900 text-white sm:max-w-md">
              <SheetHeader className="border-b border-white/10 pb-4">
                <SheetTitle className="text-white">Session Settings</SheetTitle>
                <SheetDescription className="text-white/50">
                  Adjust capture behavior without changing the training screen.
                </SheetDescription>
              </SheetHeader>

              <div className="flex flex-col gap-6 overflow-y-auto px-4 pb-6">
                <div className="flex flex-col gap-3 rounded-xl border border-white/10 bg-white/5 p-4">
                  <div>
                    <p className="text-sm font-medium text-white/90">Signal Source</p>
                    <p className="text-xs text-white/45">Switch between local mock data and the Ganglion connection.</p>
                  </div>
                  <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-slate-950/50 p-1">
                    <button
                      onClick={() => handleSignalSourceChange('mock')}
                      className={`flex-1 px-3 py-1.5 text-sm rounded-md transition-colors ${
                        signalSourceMode === 'mock'
                          ? 'bg-cyan-400/15 text-cyan-300'
                          : 'text-white/60 hover:text-white hover:bg-white/5'
                      }`}
                      title="Use mock signal source"
                    >
                      {signalSourceLabels.mock}
                    </button>
                    <button
                      onClick={() => handleSignalSourceChange('live')}
                      className={`flex-1 px-3 py-1.5 text-sm rounded-md transition-colors ${
                        signalSourceMode === 'live'
                          ? 'bg-cyan-400/15 text-cyan-300'
                          : 'text-white/60 hover:text-white hover:bg-white/5'
                      }`}
                      title="Use OpenBCI Ganglion over browser Bluetooth"
                    >
                      {signalSourceLabels.live}
                    </button>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void startStream()}
                      disabled={isStreaming || liveConnectionStatus === 'connecting'}
                      className="flex-1 rounded-lg border border-cyan-400/20 bg-cyan-400/10 px-3 py-2 text-sm text-cyan-200 transition-colors hover:bg-cyan-400/15 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {liveConnectionStatus === 'connecting' ? 'Connecting...' : 'Start Stream'}
                    </button>
                    <button
                      type="button"
                      onClick={() => void stopStream()}
                      disabled={!isStreaming && liveConnectionStatus !== 'connecting'}
                      className="flex-1 rounded-lg border border-white/10 bg-slate-950/50 px-3 py-2 text-sm text-white/75 transition-colors hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      Stop Stream
                    </button>
                  </div>
                  <div className="space-y-1 text-xs text-white/45">
                    <div>{signalSourceMode === 'live' ? liveStatusText : isStreaming ? 'Mock: Running' : 'Mock: Idle'}</div>
                    <div>
                      {signalSourceMode === 'live'
                        ? `Samples: ${livePacketCount}`
                        : isStreaming
                        ? 'Mock stream running'
                        : `Browser BLE: ${isBluetoothAvailable ? 'Available' : 'Unavailable'}`}
                    </div>
                    <div>
                      {signalSourceMode === 'live'
                        ? `${selectedChannelLabel} | Display ${(latestDisplaySignal?.value ?? 0).toFixed(2)}`
                        : `Value ${(latestSignal?.value ?? 0).toFixed(2)}`}
                    </div>
                  </div>
                </div>

                <div className="flex flex-col gap-3 rounded-xl border border-white/10 bg-white/5 p-4">
                  <div className="flex items-center gap-2">
                    <span className={`h-2.5 w-2.5 rounded-full ${statusDotClass}`} />
                    <p className="text-sm font-medium text-white/90">Connection Status</p>
                  </div>
                  <div className="grid grid-cols-2 gap-3 text-xs text-white/55">
                    <div className="rounded-lg border border-white/10 bg-slate-950/40 px-3 py-2">
                      <div className="text-white/40">Signal Mode</div>
                      <div className="mt-1 text-sm text-white/85">{signalSourceMode === 'live' ? 'Live' : 'Mock'}</div>
                    </div>
                    <div className="rounded-lg border border-white/10 bg-slate-950/40 px-3 py-2">
                      <div className="text-white/40">Status</div>
                      <div className="mt-1 text-sm text-white/85">{connectionStatusLabel}</div>
                    </div>
                    <div className="rounded-lg border border-white/10 bg-slate-950/40 px-3 py-2">
                      <div className="text-white/40">Ganglion Channel</div>
                      <div className="mt-1 text-sm text-white/85">{selectedChannelLabel}</div>
                    </div>
                    <div className="rounded-lg border border-white/10 bg-slate-950/40 px-3 py-2">
                      <div className="text-white/40">Device</div>
                      <div className="mt-1 text-sm text-white/85">
                        {signalSourceMode === 'live' ? (liveDeviceName ?? 'Not connected') : 'Mock source'}
                      </div>
                    </div>
                  </div>
                  {liveConnectionStatus === 'error' && (
                    <p className="text-xs text-amber-300/85">{liveConnectionMessage}</p>
                  )}
                </div>

                <div className="flex flex-col gap-3 rounded-xl border border-white/10 bg-white/5 p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="text-sm font-medium text-white/90">Ganglion Channel</p>
                      <p className="text-xs text-white/45">Select which decoded Ganglion channel drives live capture and display.</p>
                    </div>
                    <span className="text-sm text-white/75">{selectedChannelIndex + 1}</span>
                  </div>
                  <div className="grid grid-cols-4 gap-2">
                    {[0, 1, 2, 3].map((channelIndex) => (
                      <button
                        key={channelIndex}
                        type="button"
                        onClick={() => setSelectedChannelIndex(channelIndex)}
                        className={`rounded-lg border px-3 py-2 text-sm transition-colors ${
                          selectedChannelIndex === channelIndex
                            ? 'border-cyan-400/30 bg-cyan-400/15 text-cyan-300'
                            : 'border-white/10 bg-slate-950/50 text-white/70 hover:bg-white/10 hover:text-white'
                        }`}
                      >
                        {channelIndex + 1}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="flex flex-col gap-3 rounded-xl border border-white/10 bg-white/5 p-4">
                  <div>
                    <p className="text-sm font-medium text-white/90">Gesture Classes</p>
                    <p className="text-xs text-white/45">Add or remove gestures used for training and testing.</p>
                  </div>
                  <div className="flex flex-col gap-2">
                    {gestures.map((gesture) => {
                      const recordedCount =
                        gestureData[gesture.id]?.samples.filter((sample) =>
                          isRecordedSampleStatus(sample.status),
                        ).length ?? 0;
                      const canRemove = gestures.length > 1 && recordedCount === 0;

                      return (
                        <div
                          key={gesture.id}
                          className="flex items-center justify-between rounded-lg border border-white/10 bg-slate-950/40 px-3 py-2"
                        >
                          <span className="text-sm text-white/85">{gesture.name}</span>
                          <button
                            type="button"
                            onClick={() => handleRemoveGesture(gesture.id)}
                            disabled={!canRemove}
                            className="rounded-md border border-white/10 px-2 py-1 text-xs text-white/60 transition-colors hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            Remove
                          </button>
                        </div>
                      );
                    })}
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={newGestureName}
                      onChange={(event) => setNewGestureName(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          handleAddGesture();
                        }
                      }}
                      placeholder="New gesture name"
                      className="flex-1 rounded-lg border border-white/10 bg-slate-950/50 px-3 py-2 text-sm text-white/80"
                    />
                    <button
                      type="button"
                      onClick={handleAddGesture}
                      className="rounded-lg border border-cyan-400/30 bg-cyan-400/10 px-3 py-2 text-sm text-cyan-300 transition-colors hover:bg-cyan-400/15"
                    >
                      Add
                    </button>
                  </div>
                </div>

                <div className="flex flex-col gap-3 rounded-xl border border-white/10 bg-white/5 p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="text-sm font-medium text-white/90">Threshold</p>
                      <p className="text-xs text-white/45">Set the signal level that starts a recording.</p>
                    </div>
                    <span className="text-sm text-white/75">{(threshold * 100).toFixed(0)}%</span>
                  </div>
                  <input
                    type="range"
                    min="0.2"
                    max="0.9"
                    step="0.05"
                    value={threshold}
                    onChange={handleThresholdChange}
                    className="w-full accent-amber-500"
                  />
                </div>

                <div className="flex flex-col gap-3 rounded-xl border border-white/10 bg-white/5 p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="text-sm font-medium text-white/90">Target Samples</p>
                      <p className="text-xs text-white/45">Set how many samples to collect for the current gesture.</p>
                    </div>
                    <span className="text-sm text-white/75">{sampleTarget}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => handleTargetSampleChange(-1)}
                      className="rounded-lg border border-white/10 bg-slate-950/50 px-3 py-2 text-white/70 transition-colors hover:bg-white/10 hover:text-white"
                    >
                      -
                    </button>
                    <input
                      type="number"
                      min={1}
                      max={50}
                      step={1}
                      value={targetSamplesInputValue}
                      onChange={handleTargetSampleInputChange}
                      onBlur={commitTargetSamplesInputValue}
                      onKeyDown={(e) => handleNumericInputKeyDown(e, commitTargetSamplesInputValue)}
                      className="flex-1 rounded-lg border border-white/10 bg-slate-950/50 px-3 py-2 text-center text-sm text-white/80 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                    />
                    <button
                      onClick={() => handleTargetSampleChange(1)}
                      className="rounded-lg border border-white/10 bg-slate-950/50 px-3 py-2 text-white/70 transition-colors hover:bg-white/10 hover:text-white"
                    >
                      +
                    </button>
                  </div>
                </div>

                <div className="flex flex-col gap-3 rounded-xl border border-white/10 bg-white/5 p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="text-sm font-medium text-white/90">Segment Duration</p>
                      <p className="text-xs text-white/45">Fixed capture length after threshold crossing.</p>
                    </div>
                    <span className="text-sm text-white/75">{segmentDurationMs} ms ({(segmentDurationMs / 1000).toFixed(1)} s)</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => handleSegmentDurationChange(-100)}
                      className="rounded-lg border border-white/10 bg-slate-950/50 px-3 py-2 text-white/70 transition-colors hover:bg-white/10 hover:text-white"
                    >
                      -
                    </button>
                    <input
                      type="number"
                      min={400}
                      max={3000}
                      step={100}
                      value={segmentDurationInputValue}
                      onChange={handleSegmentDurationInputChange}
                      onBlur={commitSegmentDurationInputValue}
                      onKeyDown={(e) => handleNumericInputKeyDown(e, commitSegmentDurationInputValue)}
                      className="flex-1 rounded-lg border border-white/10 bg-slate-950/50 px-3 py-2 text-center text-sm text-white/80 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                    />
                    <button
                      onClick={() => handleSegmentDurationChange(100)}
                      className="rounded-lg border border-white/10 bg-slate-950/50 px-3 py-2 text-white/70 transition-colors hover:bg-white/10 hover:text-white"
                    >
                      +
                    </button>
                  </div>
                </div>

                <div className="flex flex-col gap-3 rounded-xl border border-white/10 bg-white/5 p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="text-sm font-medium text-white/90">Display Window</p>
                      <p className="text-xs text-white/45">Set how many seconds are visible in both live charts.</p>
                    </div>
                    <span className="text-sm text-white/75">{(displayWindowMs / 1000).toFixed(1)} s</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => handleDisplayWindowChange(-0.5)}
                      className="rounded-lg border border-white/10 bg-slate-950/50 px-3 py-2 text-white/70 transition-colors hover:bg-white/10 hover:text-white"
                    >
                      -
                    </button>
                    <input
                      type="number"
                      min={2}
                      max={10}
                      step={0.5}
                      value={displayWindowInputValue}
                      onChange={handleDisplayWindowInputChange}
                      onBlur={commitDisplayWindowInputValue}
                      onKeyDown={(e) => handleNumericInputKeyDown(e, commitDisplayWindowInputValue)}
                      className="flex-1 rounded-lg border border-white/10 bg-slate-950/50 px-3 py-2 text-center text-sm text-white/80 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                    />
                    <button
                      onClick={() => handleDisplayWindowChange(0.5)}
                      className="rounded-lg border border-white/10 bg-slate-950/50 px-3 py-2 text-white/70 transition-colors hover:bg-white/10 hover:text-white"
                    >
                      +
                    </button>
                  </div>
                </div>

                <div className="flex flex-col gap-3 rounded-xl border border-white/10 bg-white/5 p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="text-sm font-medium text-white/90">Activity Display Sensitivity</p>
                      <p className="text-xs text-white/45">Lower values add headroom. Higher values make weaker signals easier to see.</p>
                    </div>
                    <span className="text-sm text-white/75">{activityDisplaySensitivity.toFixed(1)}x</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => handleActivityDisplaySensitivityChange(-0.1)}
                      className="rounded-lg border border-white/10 bg-slate-950/50 px-3 py-2 text-white/70 transition-colors hover:bg-white/10 hover:text-white"
                    >
                      -
                    </button>
                    <input
                      type="number"
                      min={0.5}
                      max={1.5}
                      step={0.1}
                      value={activityDisplaySensitivityInputValue}
                      onChange={handleActivityDisplaySensitivityInputChange}
                      onBlur={commitActivityDisplaySensitivityInputValue}
                      onKeyDown={(e) => handleNumericInputKeyDown(e, commitActivityDisplaySensitivityInputValue)}
                      className="flex-1 rounded-lg border border-white/10 bg-slate-950/50 px-3 py-2 text-center text-sm text-white/80 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                    />
                    <button
                      onClick={() => handleActivityDisplaySensitivityChange(0.1)}
                      className="rounded-lg border border-white/10 bg-slate-950/50 px-3 py-2 text-white/70 transition-colors hover:bg-white/10 hover:text-white"
                    >
                      +
                    </button>
                  </div>
                </div>

                <details className="rounded-xl border border-white/10 bg-white/5 p-4">
                  <summary className="cursor-pointer list-none text-sm font-medium text-white/90">
                    Live Diagnostics
                  </summary>
                  <div className="mt-3 grid grid-cols-2 gap-3 text-xs text-white/55">
                    <div className="rounded-lg border border-white/10 bg-slate-950/40 px-3 py-2">
                      <div className="text-white/40">Channel</div>
                      <div className="mt-1 text-sm text-white/85">{selectedChannelLabel}</div>
                    </div>
                    <div className="rounded-lg border border-white/10 bg-slate-950/40 px-3 py-2">
                      <div className="text-white/40">Sample Rate</div>
                      <div className="mt-1 text-sm text-white/85">{liveSampleRateHz.toFixed(0)} Hz</div>
                    </div>
                    <div className="rounded-lg border border-white/10 bg-slate-950/40 px-3 py-2">
                      <div className="text-white/40">Raw</div>
                      <div className="mt-1 text-sm text-white/85">{(latestRecordingSignal?.raw ?? 0).toFixed(6)}</div>
                    </div>
                    <div className="rounded-lg border border-white/10 bg-slate-950/40 px-3 py-2">
                      <div className="text-white/40">Activity Envelope</div>
                      <div className="mt-1 text-sm text-white/85">{(latestRecordingSignal?.activityEnvelope ?? 0).toFixed(3)}</div>
                    </div>
                    <div className="rounded-lg border border-white/10 bg-slate-950/40 px-3 py-2">
                      <div className="text-white/40">Normalized Activity</div>
                      <div className="mt-1 text-sm text-white/85">{(latestDisplaySignal?.value ?? 0).toFixed(3)}</div>
                    </div>
                    <div className="rounded-lg border border-white/10 bg-slate-950/40 px-3 py-2">
                      <div className="text-white/40">Active Reference</div>
                      <div className="mt-1 text-sm text-white/85">{liveDisplayScale.toFixed(3)}</div>
                    </div>
                    <div className="rounded-lg border border-white/10 bg-slate-950/40 px-3 py-2">
                      <div className="text-white/40">Recorder State</div>
                      <div className="mt-1 text-sm text-white/85">{recorderState.toUpperCase()}</div>
                    </div>
                    <div className="rounded-lg border border-white/10 bg-slate-950/40 px-3 py-2">
                      <div className="text-white/40">Trigger Threshold</div>
                      <div className="mt-1 text-sm text-white/85">{recorderDiagnostics.threshold.toFixed(2)}</div>
                    </div>
                    <div className="rounded-lg border border-white/10 bg-slate-950/40 px-3 py-2">
                      <div className="text-white/40">Crossing Detected</div>
                      <div className="mt-1 text-sm text-white/85">{recorderDiagnostics.thresholdCrossingDetected ? 'Yes' : 'No'}</div>
                    </div>
                    <div className="rounded-lg border border-white/10 bg-slate-950/40 px-3 py-2">
                      <div className="text-white/40">Captured Raw Points</div>
                      <div className="mt-1 text-sm text-white/85">{recorderDiagnostics.capturedRawPointCount}</div>
                    </div>
                    <div className="rounded-lg border border-white/10 bg-slate-950/40 px-3 py-2">
                      <div className="text-white/40">Capture Elapsed</div>
                      <div className="mt-1 text-sm text-white/85">{recorderDiagnostics.elapsedCaptureDurationMs.toFixed(0)} ms</div>
                    </div>
                    <div className="rounded-lg border border-white/10 bg-slate-950/40 px-3 py-2">
                      <div className="text-white/40">Pre-trigger Points</div>
                      <div className="mt-1 text-sm text-white/85">{recorderDiagnostics.preTriggerPointCount}</div>
                    </div>
                  </div>
                </details>

                <div className="flex flex-col gap-3 rounded-xl border border-white/10 bg-white/5 p-4">
                  <div>
                    <p className="text-sm font-medium text-white/90">Dataset Summary</p>
                    <p className="text-xs text-white/45">Quick overview of collected samples and current session settings.</p>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="rounded-lg border border-white/10 bg-slate-950/40 px-3 py-2">
                      <div className="text-[11px] text-white/40">Total Samples</div>
                      <div className="mt-1 text-lg text-white/90">{totalSamplesCollected}</div>
                    </div>
                    <div className="rounded-lg border border-white/10 bg-slate-950/40 px-3 py-2">
                      <div className="text-[11px] text-white/40">{currentGesture?.name} Samples</div>
                      <div className="mt-1 text-lg text-white/90">{samplesCollected}</div>
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    {samplesPerGesture.map(({ gesture, count }) => (
                      <div
                        key={gesture}
                        className="rounded-lg border border-white/10 bg-slate-950/40 px-3 py-2 text-center"
                      >
                        <div className="text-[11px] text-white/40">{gesture}</div>
                        <div className="mt-1 text-sm text-white/85">{count}</div>
                      </div>
                    ))}
                  </div>
                  <div className="grid grid-cols-2 gap-3 text-xs text-white/55">
                    <div className="rounded-lg border border-white/10 bg-slate-950/40 px-3 py-2">
                      <div className="text-white/40">Segment Duration</div>
                      <div className="mt-1 text-sm text-white/85">{(segmentDurationMs / 1000).toFixed(1)} s</div>
                    </div>
                    <div className="rounded-lg border border-white/10 bg-slate-950/40 px-3 py-2">
                      <div className="text-white/40">Display Window</div>
                      <div className="mt-1 text-sm text-white/85">{(displayWindowMs / 1000).toFixed(1)} s</div>
                    </div>
                  </div>
                </div>

                <div className="flex flex-col gap-3 rounded-xl border border-white/10 bg-white/5 p-4">
                  <div>
                    <p className="text-sm font-medium text-white/90">Export Dataset</p>
                    <p className="text-xs text-white/45">Download the current recorded samples as JSON or CSV.</p>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={handleExportJson}
                      className="flex-1 rounded-lg border border-white/10 bg-slate-950/50 px-3 py-2 text-sm text-white/80 transition-colors hover:bg-white/10 hover:text-white"
                    >
                      Export JSON
                    </button>
                    <button
                      onClick={() => void handleExportCsv()}
                      className="flex-1 rounded-lg border border-white/10 bg-slate-950/50 px-3 py-2 text-sm text-white/80 transition-colors hover:bg-white/10 hover:text-white"
                    >
                      Export CSV
                    </button>
                  </div>
                </div>

                <div className="flex flex-col gap-3 rounded-xl border border-white/10 bg-white/5 p-4">
                  <div>
                    <p className="text-sm font-medium text-white/90">Clear Dataset</p>
                    <p className="text-xs text-white/45">Remove all recorded samples for demos, resets, or a fresh study session.</p>
                  </div>
                  <button
                    type="button"
                    onClick={handleClearDataset}
                    className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300 transition-colors hover:bg-red-500/20 hover:text-red-200"
                  >
                    Clear Dataset
                  </button>
                </div>
              </div>
            </SheetContent>
          </Sheet>

          <Sheet
            open={isDatasetPreviewOpen}
            onOpenChange={(open) => {
              if (open) {
                isClosingDatasetPreviewRef.current = false;
                pendingCloseRawAfterFeaturesRef.current = false;
                pendingCloseSheetAfterRawRef.current = false;
                pendingCloseFeaturesAfterMoreInfoRef.current = false;
                pendingRawDataViewRef.current = null;
                setMoreInfoFeature(null);
                setIsDatasetPreviewOpen(true);
                return;
              }
              beginCloseDatasetPreview();
            }}
          >
            <SheetContent
              side="right"
              className={`gap-0 border-white/10 bg-transparent p-0 text-white/60 shadow-2xl ${
                isFeaturesSlotOpen
                  ? 'w-screen sm:max-w-none'
                  : isRawDataSlotOpen
                    ? 'w-[calc(min(36rem,100vw)+((100vw-min(36rem,100vw))/2))] sm:max-w-none'
                    : 'w-full sm:max-w-xl'
              }`}
            >
              <div className="flex h-full min-h-0 w-full flex-row">
                {/* Fixed-width slots: sidebar panels are absolutely stacked inside so switching
                    samples never changes row width and the panels to the right stay put. Overflow
                    stays visible so each panel's edge button can protrude past its slot; sliding
                    panels are hidden by the opaque panel painting above them. */}
                {/* `isolate` keeps the Features/More Info z-order local to this slot so the
                    whole slot still paints behind the Raw Data panel while sliding. */}
                <div
                  className={`relative isolate h-full min-h-0 shrink-0 pointer-events-none ${
                    isFeaturesSlotOpen ? 'w-[calc((100vw-min(36rem,100vw))/2)]' : 'w-0'
                  }`}
                >
                  <MoreInfoSidebar
                    featureName={moreInfoFeature}
                    onClose={closeMoreInfo}
                    onExitComplete={() => {
                      if (moreInfoFeatureRef.current) {
                        return;
                      }
                      if (pendingCloseFeaturesAfterMoreInfoRef.current) {
                        pendingCloseFeaturesAfterMoreInfoRef.current = false;
                        pendingRawDataViewRef.current = null;
                        setIsFeaturesOpen(false);
                        return;
                      }
                      if (pendingRawDataViewRef.current) {
                        const nextView = pendingRawDataViewRef.current;
                        pendingRawDataViewRef.current = null;
                        setIsRawDataSlotOpen(true);
                        setRawDataView(nextView);
                      }
                    }}
                  />
                  <FeaturesSidebar
                    view={featuresView}
                    onClose={closeFeatures}
                    onOpenMoreInfo={openMoreInfo}
                    onExitComplete={() => {
                      if (!featuresViewRef.current) {
                        setMoreInfoFeature(null);
                        setIsFeaturesSlotOpen(false);
                        if (pendingCloseRawAfterFeaturesRef.current) {
                          pendingCloseRawAfterFeaturesRef.current = false;
                          setRawDataView(null);
                        }
                      }
                    }}
                  />
                </div>
                <div
                  className={`relative h-full min-h-0 shrink-0 ${
                    isRawDataSlotOpen ? 'w-[calc((100vw-min(36rem,100vw))/2)]' : 'w-0'
                  }`}
                >
                  <RawDataSidebar
                    view={rawDataView}
                    onClose={closeRawData}
                    onExpandFeatures={openFeatures}
                    showExpandButton={!isFeaturesOpen && !isFeaturesSlotOpen}
                    onExitComplete={() => {
                      if (!rawDataViewRef.current) {
                        setIsRawDataSlotOpen(false);
                        if (pendingCloseSheetAfterRawRef.current) {
                          pendingCloseSheetAfterRawRef.current = false;
                          isClosingDatasetPreviewRef.current = false;
                          setIsDatasetPreviewOpen(false);
                        }
                      }
                    }}
                  />
                </div>
                <div
                  className={`relative flex h-full min-h-0 flex-col border-l border-white/10 bg-slate-900 text-white ${
                    isRawDataSlotOpen ? 'w-[min(36rem,100vw)] shrink-0' : 'w-full'
                  }`}
                >
                  <SheetHeader className="shrink-0 border-b border-white/10 pb-4">
                    <SheetTitle className="text-white">Dataset Preview</SheetTitle>
                    <SheetDescription className="text-white/50">
                      Review recorded samples and waveforms for each gesture.
                    </SheetDescription>
                  </SheetHeader>
                  <div className="min-h-0 flex-1 overflow-hidden pb-6">
                    <DatasetPreviewPanel
                      gestures={gestures}
                      samplesByGestureId={trainingSamplesByGestureId}
                      initialGestureId={datasetPreviewGestureId}
                      onViewRawData={(view) => {
                        if (view) {
                          showRawDataForSample(view);
                        } else {
                          closeRawData();
                        }
                      }}
                    />
                  </div>
                </div>
              </div>
            </SheetContent>
          </Sheet>
          </div>
        </div>

        {/* 2. Main Signal Visualization */}
        <div className={`bg-slate-900/50 rounded-2xl border transition-all duration-300 p-6 shadow-2xl backdrop-blur-sm ${
          highlightSegment === 'good' 
            ? 'border-emerald-400/40 shadow-emerald-400/20' 
            : highlightSegment === 'bad'
            ? 'border-amber-400/40 shadow-amber-400/20'
            : isAboveThreshold
            ? 'border-cyan-400/30 shadow-cyan-400/10'
            : 'border-white/5'
        }`}>
          <div className="mb-3 flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-white/90">Activity / Envelope</p>
              <p className="text-xs text-white/45">Smoothed activity signal used for thresholding and segmentation.</p>
            </div>
            <button
              type="button"
              onClick={() => setShowRawSignal((prev) => !prev)}
              className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-slate-950/40 px-3 py-2 text-xs text-white/75 transition-colors hover:bg-white/10 hover:text-white"
            >
              <span>{showRawSignal ? 'Hide Raw Signal' : 'Show Raw Signal'}</span>
              <ChevronDown className={`h-3.5 w-3.5 transition-transform ${showRawSignal ? 'rotate-180' : ''}`} />
            </button>
          </div>
          <div className="h-80 relative">
            <div className="pointer-events-none absolute left-3 top-2 z-10 rounded-md bg-slate-950/45 px-2 py-1 text-[11px] text-white/55 backdrop-blur-sm">
              Window: {chartWindowSeconds.toFixed(1)} s
            </div>
            {recordingStartTime !== null && activeSegmentEnd !== null && segmentLabelLeft !== null && (
              <div
                className="pointer-events-none absolute top-10 z-10 rounded-md bg-cyan-400/10 px-2 py-1 text-[11px] text-cyan-200/85 backdrop-blur-sm"
                style={{ left: `${segmentLabelLeft}%` }}
              >
                Segment: {(segmentDurationMs / 1000).toFixed(1)} s
              </div>
            )}
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={activityChartData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                <defs>
                  <linearGradient id="mainSignalGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={highlightSegment === 'good' ? '#10b981' : highlightSegment === 'bad' ? '#f59e0b' : '#22d3ee'} stopOpacity={0.4} />
                    <stop offset="95%" stopColor={highlightSegment === 'good' ? '#059669' : highlightSegment === 'bad' ? '#d97706' : '#06b6d4'} stopOpacity={0.05} />
                  </linearGradient>
                </defs>
                <XAxis 
                  dataKey="time"
                  type="number"
                  domain={[chartWindowStart, chartWindowEnd]}
                  hide 
                />
                <YAxis 
                  domain={[0, 1]}
                  hide
                />
                {recordingStartTime !== null && activeSegmentEnd !== null && (
                  <ReferenceArea
                    x1={recordingStartTime}
                    x2={activeSegmentEnd}
                    fill="#22d3ee"
                    fillOpacity={0.08}
                    ifOverflow="extendDomain"
                  />
                )}
                {/* Threshold line */}
                <ReferenceLine 
                  key="main-threshold"
                  y={threshold} 
                  stroke="#f59e0b" 
                  strokeWidth={2}
                  strokeDasharray="8 4"
                  opacity={0.6}
                />
                {/* Baseline */}
                <ReferenceLine 
                  key="main-baseline"
                  y={0}
                  stroke="#ffffff" 
                  strokeWidth={1}
                  opacity={0.2}
                />
                <Area
                  type="monotone"
                  dataKey="value"
                  stroke={highlightSegment === 'good' ? '#10b981' : highlightSegment === 'bad' ? '#f59e0b' : '#22d3ee'}
                  strokeWidth={2}
                  fill="url(#mainSignalGradient)"
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
            <div className="pointer-events-none absolute inset-x-4 bottom-2 z-10 flex items-end justify-between">
              {activityTimeTicks.map((tick) => (
                <div
                  key={tick.key}
                  className={`flex flex-col items-center ${tick.key === activityTickCount - 1 ? 'items-end' : tick.key === 0 ? 'items-start' : ''}`}
                  style={{ width: tick.key === 0 || tick.key === activityTickCount - 1 ? 'auto' : undefined }}
                >
                  <div className="mb-1 h-2 w-px bg-white/12" />
                  <span className="text-[10px] text-white/45">{tick.label}</span>
                </div>
              ))}
            </div>
          </div>
          {showRawSignal && (
            <div className="mt-4 border-t border-white/10 pt-4">
              <div className="mb-2">
                <p className="text-xs font-medium text-white/80">Raw Signal</p>
                <p className="text-[11px] text-white/45">Unchanged trace for signal quality and timing checks.</p>
              </div>
              <div className="h-28">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={rawChartData} margin={{ top: 6, right: 10, left: -20, bottom: 0 }}>
                    <defs>
                      <linearGradient id="rawSignalGradient" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#cbd5e1" stopOpacity={0.2} />
                        <stop offset="95%" stopColor="#475569" stopOpacity={0.03} />
                      </linearGradient>
                    </defs>
                    <XAxis
                      dataKey="time"
                      type="number"
                      domain={[chartWindowStart, chartWindowEnd]}
                      hide
                    />
                    <YAxis domain={rawDomain} hide />
                    <ReferenceLine
                      y={0}
                      stroke="#ffffff"
                      strokeWidth={1}
                      opacity={0.16}
                    />
                    <Area
                      type="monotone"
                      dataKey="raw"
                      stroke="#cbd5e1"
                      strokeWidth={1.5}
                      fill="url(#rawSignalGradient)"
                      isAnimationActive={false}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}
        </div>

        {/* 3. Capture Feedback */}
        <AnimatePresence mode="wait">
          <motion.div
            key={feedbackState}
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 10 }}
            transition={{ duration: 0.3 }}
            className="flex flex-col gap-3 items-center"
          >
            <div className="flex flex-col items-center gap-3">
              <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-slate-900/50 px-3 py-2 backdrop-blur-sm">
                <button
                  type="button"
                  onClick={() => handleSignalSourceChange('mock')}
                  disabled={signalSourceMode === 'mock'}
                  className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-default ${
                    signalSourceMode === 'mock'
                      ? 'border-cyan-400/30 bg-cyan-400/10 text-cyan-300'
                      : 'border-white/10 bg-transparent text-white/65 hover:bg-white/10 hover:text-white'
                  }`}
                >
                  Mock Data
                </button>
                <button
                  type="button"
                  onClick={() => handleSignalSourceChange('live')}
                  disabled={!isBluetoothAvailable || signalSourceMode === 'live'}
                  className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                    signalSourceMode === 'live'
                      ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300'
                      : 'border-white/10 bg-transparent text-white/65 hover:bg-white/10 hover:text-white'
                  }`}
                >
                  Live Ganglion
                </button>
                <div className="ml-1 flex items-center gap-2 text-xs text-white/55">
                  <span className={`h-2 w-2 rounded-full ${statusDotClass}`} />
                  <span>{connectionStatusLabel}</span>
                </div>
              </div>
              <div className="text-center">
                <p className="text-sm font-medium text-white/85">{sourceModeLabel}</p>
                <p className="text-xs text-white/45">{sourceModeDescription}</p>
              </div>
            </div>
            <div className="flex items-center gap-4">
              <button
                type="button"
                onClick={handleMainStreamToggle}
                disabled={liveConnectionStatus === 'connecting'}
                className={`px-8 py-4 rounded-xl border ${feedback.borderColor} ${feedback.bgColor} backdrop-blur-sm transition-colors disabled:cursor-not-allowed disabled:opacity-70 hover:bg-white/10`}
              >
                <p className={`text-2xl font-medium ${feedback.color}`}>
                  {mainStreamControlLabel}
                </p>
              </button>
              <div className="flex h-20 w-20 items-center justify-center rounded-xl border border-white/10 bg-slate-900/50 backdrop-blur-sm">
                <div
                  className={`relative flex h-16 w-16 items-center justify-center rounded-full border bg-slate-900/60 transition-opacity ${
                    isRecording
                      ? 'border-cyan-400/20 opacity-100'
                      : 'border-white/10 opacity-35'
                  }`}
                >
                  <svg className="absolute inset-0 -rotate-90" viewBox="0 0 64 64">
                    <circle
                      cx="32"
                      cy="32"
                      r={progressCircleRadius}
                      fill="none"
                      stroke="rgba(255,255,255,0.12)"
                      strokeWidth="4"
                    />
                    <circle
                      cx="32"
                      cy="32"
                      r={progressCircleRadius}
                      fill="none"
                      stroke={isRecording ? '#22d3ee' : 'rgba(255,255,255,0.18)'}
                      strokeWidth="4"
                      strokeLinecap="round"
                      strokeDasharray={progressCircleCircumference}
                      strokeDashoffset={isRecording ? progressCircleOffset : progressCircleCircumference}
                    />
                  </svg>
                  <div className="relative text-center">
                    <div className={`text-xs font-medium ${isRecording ? 'text-cyan-300' : 'text-white/45'}`}>
                      {isRecording ? `${Math.ceil(recordingSecondsRemaining * 10) / 10}s` : '--'}
                    </div>
                    <div className="text-[10px] text-white/50">
                      {isRecording ? `${Math.round(recordingProgress * 100)}%` : 'idle'}
                    </div>
                  </div>
                </div>
              </div>
              {isAllSamplesCollected && (
                <button
                  type="button"
                  onClick={handleStartTesting}
                  className="px-8 py-4 rounded-xl border border-cyan-400/30 bg-cyan-400/10 backdrop-blur-sm transition-colors hover:bg-cyan-400/15"
                >
                  <p className="text-2xl font-medium text-cyan-400">Test</p>
                </button>
              )}
            </div>
            <p className="text-lg text-white/60 font-light">
              {feedback.instruction}
            </p>
          </motion.div>
        </AnimatePresence>

        {/* 4. Interactive Sample Slots */}
        <div className="flex flex-col gap-4">
          {/* Sample Preview Panel - appears above sample row */}
          <AnimatePresence>
            {selectedSampleId !== null && currentSamples[selectedSampleId] && isRecordedSampleStatus(currentSamples[selectedSampleId].status) && (
              <motion.div
                ref={previewPanelRef}
                initial={{ opacity: 0, y: 10, scale: 0.95 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 10, scale: 0.95 }}
                transition={{ duration: 0.2 }}
                className={`bg-slate-900/80 rounded-xl border ${getSampleQualityConfig(currentSamples[selectedSampleId].quality).borderColor} ${getSampleQualityConfig(currentSamples[selectedSampleId].quality).shadowColor} shadow-xl backdrop-blur-sm p-4`}
              >
                <div className="flex items-start justify-between mb-3">
                  <div>
                    <h3 className="text-sm font-medium text-white/90">Sample #{selectedSampleId + 1}</h3>
                    <p className={`text-xs ${getSampleQualityConfig(currentSamples[selectedSampleId].quality).color} mt-0.5`}>
                      {getSampleQualityConfig(currentSamples[selectedSampleId].quality).text}
                    </p>
                  </div>
                  <button
                    onClick={() => setSelectedSampleId(null)}
                    className="p-1 rounded hover:bg-white/10 transition-colors"
                    title="Close preview"
                  >
                    <X className="w-4 h-4 text-white/60" />
                  </button>
                </div>
                
                {/* Mini waveform preview */}
                <div className="h-24 mb-3">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={currentSamples[selectedSampleId].waveformData} margin={{ top: 5, right: 5, left: -25, bottom: 0 }}>
                      <defs>
                        <linearGradient id={`previewGradient-${selectedSampleId}`} x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor={getSampleQualityConfig(currentSamples[selectedSampleId].quality).gradientStart} stopOpacity={0.4} />
                          <stop offset="95%" stopColor={getSampleQualityConfig(currentSamples[selectedSampleId].quality).gradientEnd} stopOpacity={0.05} />
                        </linearGradient>
                      </defs>
                      <XAxis dataKey="time" hide />
                      <YAxis domain={[0, 1]} hide />
                      <ReferenceLine 
                        y={threshold} 
                        stroke="#f59e0b" 
                        strokeWidth={1}
                        strokeDasharray="4 2"
                        opacity={0.5}
                      />
                      <Area
                        type="monotone"
                        dataKey="value"
                        stroke={getSampleQualityConfig(currentSamples[selectedSampleId].quality).gradientStart}
                        strokeWidth={1.5}
                        fill={`url(#previewGradient-${selectedSampleId})`}
                        isAnimationActive={false}
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
                
                {/* Action buttons */}
                <div className="flex gap-2">
                  <button
                    onClick={() => handleRemoveSample(selectedSampleId)}
                    className="flex-1 flex items-center justify-center gap-2 px-3 py-2 bg-red-500/20 hover:bg-red-500/30 border border-red-500/30 rounded-lg transition-colors text-red-400 text-sm"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    Delete Sample
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
          
          {/* Sample slots row */}
          <div className="flex gap-2 justify-center flex-wrap">
            {currentSamples.map((sample) => (
              <motion.div
                key={sample.id}
                data-sample-slot
                initial={{ scale: 0.8, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ delay: sample.id * 0.03 }}
                onMouseEnter={() => isRecordedSampleStatus(sample.status) && setHoveredSample(sample.id)}
                onMouseLeave={() => setHoveredSample(null)}
                onClick={() => isRecordedSampleStatus(sample.status) && setSelectedSampleId(selectedSampleId === sample.id ? null : sample.id)}
                className="relative group"
              >
                <button
                  disabled={sample.status === 'empty'}
                  className={`h-3 w-12 rounded-full transition-all duration-300 ${
                    isRecordedSampleStatus(sample.status)
                      ? `${
                          sample.quality === 'weak' 
                            ? 'bg-amber-400 shadow-lg shadow-amber-400/30'
                            : sample.quality === 'noisy'
                            ? 'bg-orange-400 shadow-lg shadow-orange-400/30'
                            : 'bg-emerald-400 shadow-lg shadow-emerald-400/30'
                        } cursor-pointer hover:brightness-110`
                      : 'bg-white/10 cursor-default'
                  } ${selectedSampleId === sample.id ? 'ring-2 ring-white/50 brightness-125' : ''} ${hoveredSample === sample.id && selectedSampleId !== sample.id ? 'ring-2 ring-white/30' : ''}`}
                />
              </motion.div>
            ))}
          </div>
          
          {/* Redo Last Sample button */}
          <div className="flex justify-center">
            <button
              onClick={handleRedoLast}
              disabled={samplesCollected === 0}
              className="flex items-center gap-2 px-4 py-2 bg-white/5 hover:bg-white/10 disabled:bg-white/5 disabled:opacity-40 border border-white/10 rounded-lg transition-colors text-white/70 disabled:text-white/40 text-sm"
            >
              <RotateCcw className="w-4 h-4" />
              Redo Last Sample
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
