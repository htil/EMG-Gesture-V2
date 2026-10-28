import { useMemo, useState } from 'react';
import {
  Line,
  LineChart,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from 'recharts';
import type { DotProps } from 'recharts';
import { X } from 'lucide-react';
import type { StoredTrial } from './api';
import { displayEnvelopeWaveform } from './waveScale';

type ChartPoint = {
  time: number;
  value: number;
  displayTime: number;
  pointIndex: number;
};

const DOT_RADIUS = 4;
const HOVER_RADIUS = 6;

function formatValue(value: number) {
  if (Math.abs(value) >= 1000) return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (Math.abs(value) >= 1) return value.toFixed(2);
  return value.toFixed(4);
}

function csvForTrial(trial: StoredTrial) {
  const start = trial.points[0]?.time ?? 0;
  const lines = ['label,index,timeOffset,value'];
  trial.points.forEach((point, index) => {
    const timeOffset = Number((point.time - start).toFixed(3));
    lines.push(`${trial.gestureName},${index},${timeOffset},${point.value}`);
  });
  return lines.join('\n');
}

function WaveformDot({
  cx,
  cy,
  payload,
  hoveredIndex,
  onHover,
}: DotProps & {
  payload?: ChartPoint;
  hoveredIndex: number | null;
  onHover: (point: ChartPoint | null, position?: { x: number; y: number }) => void;
}) {
  if (cx === undefined || cy === undefined || !payload) return null;
  const hovered = hoveredIndex === payload.pointIndex;
  return (
    <g
      onMouseEnter={() => onHover(payload, { x: cx, y: cy })}
      onMouseLeave={() => onHover(null)}
      onFocus={() => onHover(payload, { x: cx, y: cy })}
      onBlur={() => onHover(null)}
      tabIndex={0}
      role="graphics-symbol"
      aria-label={`Time ${payload.displayTime.toFixed(3)} seconds, value ${formatValue(payload.value)}`}
    >
      <circle
        cx={cx}
        cy={cy}
        r={hovered ? HOVER_RADIUS : DOT_RADIUS}
        fill="#22d3ee"
        stroke="#0f172a"
        strokeWidth={1.5}
        className="cursor-pointer"
      />
    </g>
  );
}

export default function SampleGraphPanel({
  trial,
  trials,
  onClose,
  onSelect,
}: {
  trial: StoredTrial;
  trials: StoredTrial[];
  onClose: () => void;
  onSelect: (sampleId: string) => void;
}) {
  const [hovered, setHovered] = useState<ChartPoint | null>(null);
  const [tooltip, setTooltip] = useState<{ x: number; y: number } | null>(null);
  const [copied, setCopied] = useState(false);
  const ordered = useMemo(
    () => [...trials].sort((left, right) => left.capturedAt - right.capturedAt || left.id.localeCompare(right.id)),
    [trials],
  );
  const csv = useMemo(() => csvForTrial(trial), [trial]);
  const rows = useMemo(() => {
    const start = trial.points[0]?.time ?? 0;
    return trial.points.map((point, index) => ({
      index,
      timeOffset: Number((point.time - start).toFixed(3)),
      value: point.value,
    }));
  }, [trial]);
  const chartData = useMemo<ChartPoint[]>(() => {
    const start = trial.points[0]?.time ?? 0;
    return trial.points.map((point, pointIndex) => ({
      ...point,
      displayTime: (point.time - start) / 1000,
      pointIndex,
    }));
  }, [trial]);
  const extremes = useMemo(() => {
    let minIndex = 0;
    let maxIndex = 0;
    trial.points.forEach((point, index) => {
      if (point.value < trial.points[minIndex].value) minIndex = index;
      if (point.value > trial.points[maxIndex].value) maxIndex = index;
    });
    return { minIndex, maxIndex };
  }, [trial]);
  // Reuse the sample preview's display transform. Archives and CSV stay raw.
  const activityData = useMemo(() => displayEnvelopeWaveform(trial.points).map((point) => ({
    time: (point.time - (trial.points[0]?.time ?? 0)) / 1000,
    value: point.value,
  })), [trial]);

  const copyCsv = async () => {
    try {
      await navigator.clipboard.writeText(csv);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const downloadCsv = () => {
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${trial.gestureName}-sample.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-950/50">
      <button type="button" className="absolute inset-0 cursor-default" aria-label="Close sample graph" onClick={onClose} />
      <aside className="relative flex h-full w-full max-w-xl flex-col border-l border-white/10 bg-slate-900 text-white shadow-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-white/10 px-5 py-4">
          <div>
            <p className="text-[10px] uppercase tracking-[0.18em] text-cyan-300/80">Saved sample</p>
            <h2 className="mt-1 text-lg font-medium text-white">{trial.gestureName}</h2>
            <p className="mt-1 text-sm leading-6 text-white/70">This shows the activity recorded during your movement. A higher line means more activity, not a better movement.</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-white/60 hover:bg-white/10 hover:text-white" aria-label="Close sample graph">
            <X className="h-4 w-4" />
          </button>
        </div>

        {ordered.length > 1 && (
          <div className="flex gap-2 overflow-x-auto border-b border-white/10 px-5 py-3">
            {ordered.map((item, index) => (
              <button
                key={item.id}
                type="button"
                onClick={() => onSelect(item.id)}
                className={`shrink-0 rounded-full border px-3 py-1 text-xs ${item.id === trial.id ? 'border-cyan-300/40 bg-cyan-300/10 text-cyan-100' : 'border-white/10 text-white/60'}`}
              >
                Sample {index + 1}
              </button>
            ))}
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <section aria-label="Saved movement activity">
            <h3 className="text-sm font-medium text-cyan-100">Your recorded activity</h3>
            <p className="mt-1 text-xs text-white/55">Smoothed activity · display only</p>
            <div className="mt-3 h-64 rounded-2xl border border-white/10 bg-slate-950/50 p-2">
              {!activityData.length ? <p className="flex h-full items-center justify-center text-sm text-white/50">No waveform data</p> : (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={activityData} margin={{ top: 16, right: 12, left: 0, bottom: 16 }}>
                    <XAxis dataKey="time" type="number" domain={[0, 'dataMax']} stroke="rgba(255,255,255,0.35)" tick={{ fill: 'rgba(255,255,255,0.55)', fontSize: 11 }} tickFormatter={(value: number) => `${value.toFixed(1)}s`} />
                    <YAxis domain={[0, 'auto']} stroke="rgba(255,255,255,0.35)" tick={{ fill: 'rgba(255,255,255,0.55)', fontSize: 11 }} width={48} tickFormatter={(value: number) => formatValue(value)} />
                    <Line type="linear" dataKey="value" stroke="#22d3ee" strokeWidth={2.5} dot={false} isAnimationActive={false} />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </div>
            <p className="mt-2 text-xs text-white/55">Time since this recording began, in seconds.</p>
          </section>
          <details className="mt-5 rounded-2xl border border-white/10 p-3">
            <summary className="cursor-pointer text-sm text-white/65">Researcher details: raw signal and data</summary>
            <p className="my-3 text-xs leading-5 text-white/55">Original signed samples are unchanged. This raw trace is different from the smoothed activity view above. CSV values and time offsets (milliseconds) are original data.</p>
          <div className="relative h-56 rounded-2xl border border-white/10 bg-slate-950/50 p-2">
            {chartData.length === 0 ? (
              <p className="flex h-full items-center justify-center text-sm text-white/50">No waveform data</p>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData} margin={{ top: 16, right: 12, left: 0, bottom: 16 }}>
                  <XAxis
                    dataKey="displayTime"
                    type="number"
                    stroke="rgba(255,255,255,0.35)"
                    tick={{ fill: 'rgba(255,255,255,0.55)', fontSize: 11 }}
                    tickFormatter={(value: number) => `${value.toFixed(1)}s`}
                  />
                  <YAxis
                    stroke="rgba(255,255,255,0.35)"
                    tick={{ fill: 'rgba(255,255,255,0.55)', fontSize: 11 }}
                    width={48}
                    tickFormatter={(value: number) => formatValue(value)}
                  />
                  <Line
                    type="linear"
                    dataKey="value"
                    stroke="#22d3ee"
                    strokeWidth={1.5}
                    isAnimationActive={false}
                    dot={(props) => (
                      <WaveformDot
                        {...props}
                        hoveredIndex={hovered?.pointIndex ?? null}
                        onHover={(point, position) => {
                          setHovered(point);
                          setTooltip(position ?? null);
                        }}
                      />
                    )}
                  />
                </LineChart>
              </ResponsiveContainer>
            )}
            {hovered && tooltip && (
              <div
                className="pointer-events-none absolute z-10 rounded-md border border-white/15 bg-slate-950/95 px-2.5 py-1.5 text-xs shadow-lg"
                style={{ left: Math.min(tooltip.x + 10, 280), top: Math.max(8, tooltip.y - 48) }}
              >
                {(hovered.pointIndex === extremes.minIndex || hovered.pointIndex === extremes.maxIndex) && (
                  <div className="mb-0.5 font-medium">
                    {hovered.pointIndex === extremes.minIndex && <span className="text-cyan-200">min </span>}
                    {hovered.pointIndex === extremes.maxIndex && <span className="text-amber-200">max</span>}
                  </div>
                )}
                <div className="font-medium text-cyan-300">{formatValue(hovered.value)}</div>
                <div className="text-white/60">Time: {hovered.displayTime.toFixed(3)} s</div>
              </div>
            )}
          </div>

          <div className="mt-4 flex items-center justify-between gap-3">
            <h3 className="text-sm font-medium text-white">CSV</h3>
            <div className="flex gap-2">
              <button type="button" onClick={() => void copyCsv()} className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-white/80">
                {copied ? 'Copied' : 'Copy'}
              </button>
              <button type="button" onClick={downloadCsv} className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-white/80">
                Download
              </button>
            </div>
          </div>
          <pre className="mt-2 max-h-28 overflow-auto rounded-xl border border-white/10 bg-black/30 p-3 text-[11px] leading-5 text-cyan-100/90">{csv}</pre>

          <div className="mt-4 overflow-hidden rounded-xl border border-white/10">
            <table className="w-full border-collapse text-left text-sm">
              <thead className="bg-slate-950/80 text-[11px] uppercase tracking-wider text-white/50">
                <tr>
                  <th className="px-3 py-2 font-medium">label</th>
                  <th className="px-3 py-2 font-medium">index</th>
                  <th className="px-3 py-2 font-medium">timeOffset</th>
                  <th className="px-3 py-2 font-medium">value</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.index} className="border-t border-white/10 odd:bg-white/[0.02]">
                    <td className="px-3 py-1.5 text-white/80">{trial.gestureName}</td>
                    <td className="px-3 py-1.5 font-mono text-xs text-white/55">{row.index}</td>
                    <td className="px-3 py-1.5 font-mono text-xs text-white/55">{row.timeOffset}</td>
                    <td className="px-3 py-1.5 font-mono text-xs text-cyan-300/90">{formatValue(row.value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length === 0 && <p className="px-3 py-4 text-sm text-white/50">No rows for this sample.</p>}
          </div>
          </details>
        </div>
      </aside>
    </div>
  );
}
