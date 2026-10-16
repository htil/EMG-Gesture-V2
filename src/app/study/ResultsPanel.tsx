import { ArrowRight } from 'lucide-react';
import type { Gesture } from '../pipeline';
import { DEFAULT_DIFFICULTY, type StoredGameRun } from './gameHandoff';
import { formatScoreChange, previousComparableRun, summarizeRecognition } from './recognition';

export default function ResultsPanel({
  runs,
  currentRun,
  gestures,
  onTryAgain,
  tryAgainEnabled,
  onReview,
  onContinue,
  continueEnabled,
  continueLabel,
  saving,
  saveError,
}: {
  runs: StoredGameRun[];
  currentRun: StoredGameRun | null;
  gestures: Gesture[];
  onTryAgain: () => void;
  tryAgainEnabled: boolean;
  onReview: () => void;
  onContinue: () => void;
  continueEnabled: boolean;
  continueLabel: string;
  saving: boolean;
  saveError: string;
}) {
  const previous = currentRun ? previousComparableRun(runs, currentRun) : null;
  const summary = summarizeRecognition(currentRun?.outcomes ?? [], gestures);
  const change = currentRun ? formatScoreChange(currentRun.gameScore, previous ? previous.gameScore : null) : null;
  const difficulty = currentRun?.difficulty || previous?.difficulty || DEFAULT_DIFFICULTY;

  return (
    <section className="space-y-4">
      <div>
        <p className="text-xs uppercase tracking-[0.18em] text-cyan-300/70">Results</p>
        <h2 className="mt-1 text-2xl font-light text-white">This run</h2>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-400">
          The previous score is the last run at the same difficulty{difficulty === DEFAULT_DIFFICULTY ? '' : ` (${difficulty})`}.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
          <p className="text-[10px] uppercase tracking-[0.16em] text-slate-500">Game score</p>
          <p className="mt-2 text-3xl tabular-nums text-white">{currentRun ? currentRun.gameScore : '—'}</p>
        </div>
        <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
          <p className="text-[10px] uppercase tracking-[0.16em] text-slate-500">Previous score</p>
          <p className="mt-2 text-3xl tabular-nums text-white">{previous ? previous.gameScore : '—'}</p>
          {!previous && <p className="mt-1 text-xs text-slate-500">No earlier comparable run</p>}
        </div>
        <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
          <p className="text-[10px] uppercase tracking-[0.16em] text-slate-500">Change</p>
          <p className="mt-2 text-3xl tabular-nums text-white">{change ?? '—'}</p>
        </div>
      </div>

      <div className="rounded-2xl border border-white/10 bg-slate-950/50 p-5">
        <p className="text-[10px] uppercase tracking-[0.16em] text-slate-500">Recognition accuracy</p>
        <p className="mt-2 text-3xl tabular-nums text-white">
          {summary.accuracyPercent === null ? '—' : `${summary.accuracyPercent}%`}
        </p>
        <p className="mt-2 text-sm text-slate-200">
          {summary.scoredCount === 0
            ? 'No scored attempts yet.'
            : `${summary.correct} of ${summary.scoredCount} scored ${summary.scoredCount === 1 ? 'attempt was' : 'attempts were'} recognized.`}
        </p>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-400">
          Accuracy is the share of scored attempts where the model named the requested gesture. Unknown counts as unsuccessful. Recording failures are left out of this percentage.
        </p>
      </div>

      <div className="overflow-hidden rounded-2xl border border-white/10">
        <div className="grid grid-cols-4 bg-white/[0.03] px-4 py-3 text-[10px] uppercase tracking-[0.14em] text-slate-500">
          <span>Gesture</span>
          <span className="text-right">Correct</span>
          <span className="text-right">Wrong gesture</span>
          <span className="text-right">Unknown</span>
        </div>
        {summary.breakdown.map((row) => (
          <div key={row.gestureId} className="grid grid-cols-4 border-t border-white/8 px-4 py-3 text-sm">
            <span className="text-slate-100">{row.gestureName}</span>
            <span className="text-right tabular-nums text-slate-200">{row.correct}</span>
            <span className="text-right tabular-nums text-slate-200">{row.wrong}</span>
            <span className="text-right tabular-nums text-slate-200">{row.unknown}</span>
          </div>
        ))}
      </div>

      <p className="text-sm text-slate-400">
        {summary.recordingFailures === 0
          ? 'No recording failures in this run.'
          : `${summary.recordingFailures} recording ${summary.recordingFailures === 1 ? 'failure is' : 'failures are'} listed separately and not treated as wrong predictions.`}
      </p>

      {!currentRun && (
        <p className="text-sm text-slate-400">The game score and gesture attempts appear here after the play step reports a result.</p>
      )}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={!tryAgainEnabled}
          onClick={onTryAgain}
          className="rounded-xl border border-white/10 px-4 py-2.5 text-xs text-slate-100 disabled:cursor-not-allowed disabled:opacity-35"
        >
          Try Again
        </button>
        <button type="button" onClick={onReview} className="rounded-xl border border-white/10 px-4 py-2.5 text-xs text-slate-100">
          Review Samples / Retrain
        </button>
        <button
          type="button"
          disabled={saving || !continueEnabled}
          onClick={onContinue}
          className="flex items-center gap-2 rounded-xl bg-white px-4 py-2.5 text-xs font-medium text-slate-950 disabled:opacity-50"
        >
          {saving ? 'Saving round' : continueLabel}
          {!saving && <ArrowRight className="h-3.5 w-3.5" />}
        </button>
      </div>
      {!tryAgainEnabled && (
        <p className="text-xs text-amber-100">Try Again stays closed until this condition’s model is ready.</p>
      )}
      {!continueEnabled && (
        <p className="text-xs text-amber-100">Continue stays closed until every gesture has at least the minimum number of examples again.</p>
      )}
      <p className="text-xs leading-5 text-slate-500">When retries and retraining are allowed during the measured study is still open.</p>
      {saveError && <p className="text-sm text-rose-300">{saveError}</p>}
    </section>
  );
}
