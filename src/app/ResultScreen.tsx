import React, { useMemo } from "react";

import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";
import { Activity, RefreshCw, TrendingUp, AlertTriangle, Hand, Target } from "lucide-react";
import {
  buildGestureColorMap,
  calculateResultStats,
  getGestureBarColor,
  type TestingSessionData,
} from "./pipeline";

function ConfidenceBadge({ value, status }: { value: number; status: "high" | "low" }) {
  const isLow = status === "low";
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-semibold ${
        isLow
          ? "bg-yellow-500/15 text-yellow-400 border border-yellow-500/25"
          : "bg-cyan-500/15 text-cyan-400 border border-cyan-500/25"
      }`}
    >
      {isLow && <AlertTriangle className="w-3 h-3" />}
      {value.toFixed(1)}%
    </span>
  );
}

function GesturePill({
  label,
  colorMap,
  gestureId,
}: {
  label: string;
  colorMap: ReturnType<typeof buildGestureColorMap>;
  gestureId: string;
}) {
  const color = colorMap[gestureId]?.ring ?? "#00d4ff";
  return (
    <span
      className="inline-block px-2 py-0.5 rounded border text-xs font-medium"
      style={{
        color,
        background: `${color}1a`,
        borderColor: `${color}33`,
      }}
    >
      {label}
    </span>
  );
}

const CustomTooltip = ({ active, payload, label }: any) => {
  if (active && payload && payload.length) {
    return (
      <div className="bg-[#0d1b2e] border border-cyan-500/20 rounded-lg px-3 py-2 text-sm shadow-xl">
        <p className="text-[#5a8fa8] mb-0.5">{label}</p>
        <p className="text-white font-semibold">{payload[0].value} predictions</p>
      </div>
    );
  }
  return null;
};

const ColoredBar = (props: any) => {
  const { x, y, width, height, fill } = props;
  return <rect x={x} y={y} width={width} height={height} rx={4} fill={fill ?? "#00d4ff"} fillOpacity={0.85} />;
};

export default function ResultScreen({
  testingSession,
  onRetrain,
  onTestAgain,
}: {
  testingSession: TestingSessionData;
  onRetrain?: () => void;
  onTestAgain?: () => void;
}) {
  const stats = useMemo(() => calculateResultStats(testingSession), [testingSession]);
  const colorMap = useMemo(
    () => buildGestureColorMap(testingSession.gestures),
    [testingSession.gestures],
  );
  const chartData = stats.predictionCountsByGesture.map((entry) => ({
    gesture: entry.gesture,
    gestureId: entry.gestureId,
    count: entry.count,
    fill: getGestureBarColor(entry.gestureId, testingSession.gestures),
  }));

  return (
    <div className="min-h-screen w-full bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 px-4 py-6 md:px-8 md:py-8">
      <div className="flex items-center justify-between mb-8">
        <div className="flex items-center gap-2">
          <Activity className="w-4 h-4 text-cyan-400" />
          <h1 className="text-cyan-400 text-lg font-semibold tracking-wide">
            Results
          </h1>
        </div>
        <span className="text-xs text-white/50 border border-white/10 rounded px-2 py-1">
          Session: {stats.sessionLabel}
        </span>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <MetricCard
          icon={<Target className="w-4 h-4" />}
          label="Total Predictions"
          value={stats.totalPredictions.toLocaleString()}
          accent="cyan"
        />
        <MetricCard
          icon={<TrendingUp className="w-4 h-4" />}
          label="Avg. Confidence"
          value={`${stats.overallConfidence}%`}
          accent="cyan"
        />
        <MetricCard
          icon={<Hand className="w-4 h-4" />}
          label="Most Common"
          value={stats.mostPredictedGesture}
          valueSmall
          accent="cyan"
        />
        <MetricCard
          icon={<AlertTriangle className="w-4 h-4" />}
          label="Low Confidence"
          value={String(stats.lowConfidenceCount)}
          accent="yellow"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4 mb-6">
        <div className="lg:col-span-2 bg-white/5 border border-white/10 rounded-xl p-5">
          <div className="mb-4">
            <h2 className="text-white/90 text-sm font-semibold">Prediction Counts by Gesture</h2>
            <p className="text-white/45 text-xs mt-0.5">
              Distribution across all {stats.totalPredictions} predictions
            </p>
          </div>

          <div
            className={`grid gap-2 mb-4 ${
              stats.gestureStats.length <= 3
                ? "grid-cols-3"
                : stats.gestureStats.length === 4
                  ? "grid-cols-2"
                  : "grid-cols-3"
            }`}
          >
            {stats.gestureStats.map((entry) => {
              const scheme = colorMap[entry.gesture.id];
              return (
                <div
                  key={entry.gesture.id}
                  className="rounded-lg border border-white/10 bg-white/5 px-2.5 py-2 text-center"
                  style={scheme ? { borderColor: `${scheme.ring}33` } : undefined}
                >
                  <p className="text-white/45 text-[10px] leading-tight mb-1 truncate">
                    {entry.gesture.name}
                  </p>
                  <p className="text-sm font-semibold" style={{ color: scheme?.ring ?? "#00d4ff" }}>
                    {entry.averageConfidence}%
                  </p>
                  <p className="text-white/45 text-[10px]">avg conf.</p>
                </div>
              );
            })}
          </div>

          <ResponsiveContainer width="100%" height={160}>
            <BarChart data={chartData} barCategoryGap="35%">
              <XAxis
                dataKey="gesture"
                tick={{ fill: "#5a8fa8", fontSize: 11 }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                tick={{ fill: "#5a8fa8", fontSize: 11 }}
                axisLine={false}
                tickLine={false}
                width={32}
              />
              <Tooltip content={<CustomTooltip />} cursor={{ fill: "rgba(0,212,255,0.05)" }} />
              <Bar dataKey="count" shape={<ColoredBar />} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="lg:col-span-3 bg-white/5 border border-white/10 rounded-xl p-5">
          <div className="mb-4">
            <h2 className="text-white/90 text-sm font-semibold">Last 10 Predictions</h2>
            <p className="text-white/45 text-xs mt-0.5">Most recent classification outputs</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/10">
                  <th className="text-left text-xs font-medium text-white/50 pb-2 pr-4">#</th>
                  <th className="text-left text-xs font-medium text-white/50 pb-2 pr-4">Timestamp</th>
                  <th className="text-left text-xs font-medium text-white/50 pb-2 pr-4">Prediction</th>
                  <th className="text-right text-xs font-medium text-white/50 pb-2">Confidence</th>
                </tr>
              </thead>
              <tbody>
                {stats.lastTenPredictions.map((row, i) => (
                  <tr
                    key={row.id}
                    className="border-b border-white/5 hover:bg-white/5 transition-colors"
                  >
                    <td className="py-2.5 pr-4 text-white/50 text-xs">{i + 1}</td>
                    <td className="py-2.5 pr-4 text-white/50 text-xs tabular-nums">
                      {row.timestamp}
                    </td>
                    <td className="py-2.5 pr-4">
                      <GesturePill
                        label={row.predictedGestureName}
                        gestureId={row.predictedGestureId}
                        colorMap={colorMap}
                      />
                    </td>
                    <td className="py-2.5 text-right">
                      <ConfidenceBadge value={row.confidence} status={row.confidenceStatus} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div className="flex flex-col sm:flex-row items-center justify-center gap-4 pt-2">
        <button
          onClick={() => onTestAgain?.()}
          className="w-full sm:w-auto flex items-center justify-center gap-2.5 px-8 py-3 rounded-lg border border-cyan-400/30 bg-cyan-400/10 text-cyan-400 font-semibold text-sm hover:bg-cyan-400/15 active:scale-95 transition-all shadow-[0_0_20px_rgba(0,212,255,0.25)]"
        >
          <Activity className="w-4 h-4" />
          Test Again
        </button>
        <button
          onClick={() => onRetrain?.()}
          className="w-full sm:w-auto flex items-center justify-center gap-2.5 px-8 py-3 rounded-lg bg-white/5 text-white/80 font-semibold text-sm border border-white/10 hover:bg-white/10 hover:text-white active:scale-95 transition-all"
        >
          <RefreshCw className="w-4 h-4 text-white/50" />
          Retrain Model
        </button>
      </div>

    </div>
  );
}

function MetricCard({
  icon,
  label,
  value,
  valueSmall,
  accent,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  valueSmall?: boolean;
  accent: "cyan" | "yellow";
}) {
  const accentClass = accent === "cyan" ? "text-cyan-400" : "text-yellow-400";
  const iconBg = accent === "cyan" ? "bg-cyan-500/10 border-cyan-500/20 text-cyan-400" : "bg-yellow-500/10 border-yellow-500/20 text-yellow-400";

  return (
    <div className="bg-white/5 border border-white/10 rounded-xl p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="text-white/50 text-xs">{label}</span>
        <div className={`flex items-center justify-center w-7 h-7 rounded-md border ${iconBg}`}>
          {icon}
        </div>
      </div>
      <span className={`font-bold leading-none ${valueSmall ? "text-xl" : "text-3xl"} ${accentClass}`}>
        {value}
      </span>
    </div>
  );
}
