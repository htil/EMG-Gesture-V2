import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { Activity, ArrowRight } from 'lucide-react';
import { joinStudy, loadClientSession, saveClientSession, type ClientSession } from './api';

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
      const existing = loadClientSession();
      const session: ClientSession = existing
        && existing.participantId === joined.participantId
        && existing.round === joined.round
        && existing.status !== 'completed'
        ? { ...existing, ...joined, manualTrigger: Boolean(joined.manualTrigger) }
        : {
            participantId: joined.participantId,
            experimentId: joined.experimentId,
            experimentName: joined.experimentName,
            repetitions: joined.repetitions,
            capturesPerRound: joined.capturesPerRound,
            round: joined.round,
            manualTrigger: Boolean(joined.manualTrigger),
            status: 'in_progress',
            stage: 'capture',
            unlockedThrough: 'capture',
            trials: [],
          };
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
          {error && <p className="mt-3 text-sm text-rose-300">{error}</p>}
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
