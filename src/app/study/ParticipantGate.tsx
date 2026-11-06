import DismissibleNotice from './DismissibleNotice';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { Activity, ArrowRight } from 'lucide-react';
import {
  clampStudyCount,
  DEFAULT_OBSTACLE_COUNT,
  DEFAULT_STARTING_LIVES,
  joinStudy,
  loadClientSession,
  MAX_OBSTACLE_COUNT,
  MAX_STARTING_LIVES,
  saveClientSession,
  type ClientSession,
  type RestoredSession,
} from './api';

type JoinedSession = Awaited<ReturnType<typeof joinStudy>>;

function pickSession(joined: JoinedSession, existing: ClientSession | null): ClientSession {
  const condition = joined.condition === 'button' || joined.condition === 'threshold'
    ? joined.condition
    : joined.manualTrigger ? 'button' : 'threshold';
  const generation = joined.generation ?? 1;
  const capturesMax = joined.capturesMax ?? joined.capturesPerRound ?? 1;
  const capturesMin = joined.capturesMin ?? capturesMax;
  const restored: RestoredSession | null = joined.restored
    && joined.restored.generation === generation
    && joined.restored.round === joined.round
    ? joined.restored
    : null;
  const local = existing
    && existing.participantId === joined.participantId
    && existing.round === joined.round
    && (existing.generation ?? 1) === generation
    && existing.status !== 'completed'
    ? existing
    : null;
  const shared = {
    participantId: joined.participantId,
    isTestParticipant: joined.isTestParticipant === true,
    experimentId: joined.experimentId,
    experimentName: joined.experimentName,
    generation,
    repetitions: joined.repetitions,
    capturesMin,
    capturesMax,
    capturesPerRound: capturesMax,
    obstacleCount: clampStudyCount(joined.obstacleCount, DEFAULT_OBSTACLE_COUNT, 1, MAX_OBSTACLE_COUNT),
    startingLives: clampStudyCount(joined.startingLives, DEFAULT_STARTING_LIVES, 1, MAX_STARTING_LIVES),
    round: joined.round,
    condition,
    manualTrigger: Boolean(joined.manualTrigger),
    status: 'in_progress' as const,
  };
  const preferLocal = Boolean(local && (!restored || (local.updatedAt ?? 0) >= (restored.updatedAt ?? 0)));
  if (preferLocal && local) {
    return {
      ...shared,
      sessionId: local.sessionId,
      updatedAt: local.updatedAt ?? 0,
      modelRevisionId: local.modelRevisionId ?? null,
      stage: local.stage === 'done' ? 'capture' : local.stage,
      unlockedThrough: local.unlockedThrough,
      trials: local.trials ?? [],
      runs: local.runs?.length ? local.runs : restored?.runs ?? joined.runs ?? [],
      pendingReplacements: local.pendingReplacements ?? [],
      openCapture: local.openCapture ?? null,
      trainingRun: local.trainingRun ?? null,
    };
  }
  if (restored) {
    return {
      ...shared,
      sessionId: restored.sessionId,
      updatedAt: restored.updatedAt ?? 0,
      modelRevisionId: restored.modelRevisionId,
      stage: restored.stage === 'done' ? 'capture' : restored.stage,
      unlockedThrough: restored.unlockedThrough,
      trials: restored.trials ?? [],
      runs: restored.runs?.length ? restored.runs : joined.runs ?? [],
      pendingReplacements: restored.pendingReplacements ?? [],
      openCapture: restored.openCapture?.sampleId ? restored.openCapture : null,
      trainingRun: restored.trainingRun?.revisionId ? restored.trainingRun : null,
    };
  }
  return {
    ...shared,
    sessionId: `sess-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    updatedAt: Date.now(),
    modelRevisionId: null,
    stage: 'capture',
    unlockedThrough: 'capture',
    trials: [],
    runs: joined.runs ?? [],
    pendingReplacements: [],
    openCapture: null,
    trainingRun: null,
  };
}

export default function ParticipantGate() {
  const navigate = useNavigate();
  const [participantId, setParticipantId] = useState('');
  const [error, setError] = useState('');
  const [finished, setFinished] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const id = participantId.trim();
    if (!id) {
      setError('Enter the ID you were given.');
      return;
    }
    setBusy(true);
    setError('');
    setFinished(false);
    try {
      const joined = await joinStudy(id);
      if (joined.status === 'completed') {
        setFinished(true);
        return;
      }
      const session = pickSession(joined, loadClientSession());
      saveClientSession(session);
      navigate('/session');
    } catch (joinError) {
      setError(joinError instanceof Error ? joinError.message : 'That ID could not be opened.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#050812] text-slate-100">
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -left-24 top-16 h-80 w-80 rounded-full bg-cyan-400/10 blur-3xl" />
        <div className="absolute bottom-0 right-0 h-96 w-96 rounded-full bg-slate-700/20 blur-3xl" />
      </div>
      <main className="relative mx-auto flex min-h-screen max-w-lg flex-col justify-center px-5 py-16">
        <div className="mb-8 flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl border border-cyan-300/20 bg-cyan-300/10 text-cyan-300">
            <Activity className="h-5 w-5" />
          </div>
          <div>
            <p className="text-sm font-medium text-white">Signal session</p>
            <p className="text-xs text-slate-500">Enter the ID you were given</p>
          </div>
        </div>

        <form onSubmit={(event) => void submit(event)} className="rounded-[28px] border border-white/10 bg-slate-950/70 p-6 shadow-2xl backdrop-blur-xl">
          <label htmlFor="participant-id" className="text-xs font-medium uppercase tracking-[0.18em] text-slate-500">
            Participant ID
          </label>
          <input
            id="participant-id"
            value={participantId}
            autoFocus
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            onChange={(event) => setParticipantId(event.target.value.toUpperCase())}
            className="mt-3 w-full rounded-2xl border border-white/10 bg-black/30 px-4 py-4 font-mono text-2xl tracking-[0.18em] text-white outline-none placeholder:text-slate-700 focus:border-cyan-300/40"
            placeholder="••••••"
          />
          <DismissibleNotice message={error} summary="Participant access issue" resetKey={busy} className="mt-3" />
          {finished && (
            <p className="mt-3 text-sm leading-6 text-emerald-200">
              This session is already finished. You can close the page.
            </p>
          )}
          <button
            type="submit"
            disabled={busy}
            className="mt-5 flex w-full items-center justify-center gap-2 rounded-2xl bg-cyan-300 px-5 py-3.5 text-sm font-medium text-slate-950 transition hover:bg-cyan-200 disabled:opacity-50"
          >
            {busy ? 'Checking ID' : 'Continue'}
            {!busy && <ArrowRight className="h-4 w-4" />}
          </button>
        </form>
      </main>
    </div>
  );
}
