import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import {
  Check,
  ClipboardCopy,
  Download,
  FlaskConical,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import {
  clearAdminPin,
  createExperiment,
  deleteExperiment,
  deleteParticipant,
  downloadRoster,
  generateParticipants,
  listExperiments,
  listParticipants,
  loadAdminPin,
  resetParticipant,
  saveAdminPin,
  signInAdmin,
  updateExperiment,
  updateParticipant,
  type Assignment,
  type Experiment,
  type Participant,
  type RoundLog,
} from '../study/api';

const STATUS_LABEL = {
  assigned: 'Not started',
  in_progress: 'In progress',
  completed: 'Finished',
} as const;

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block text-xs text-slate-400">
      {label}
      <div className="mt-2">{children}</div>
    </label>
  );
}

const inputClass = 'w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2.5 text-sm text-slate-100 outline-none focus:border-amber-200/40';

export default function AdminApp() {
  const [pin, setPin] = useState(loadAdminPin);
  const [authed, setAuthed] = useState(false);
  const [authError, setAuthError] = useState('');
  const [experiments, setExperiments] = useState<Experiment[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [rounds, setRounds] = useState<RoundLog[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [draftName, setDraftName] = useState('');
  const [draftNotes, setDraftNotes] = useState('');
  const [draftRepetitions, setDraftRepetitions] = useState(3);
  const [draftCaptures, setDraftCaptures] = useState(3);
  const [newName, setNewName] = useState('');
  const [generateCount, setGenerateCount] = useState(8);
  const [assignment, setAssignment] = useState<'balanced' | Assignment>('balanced');
  const [busy, setBusy] = useState(false);

  const selected = experiments.find((experiment) => experiment.id === selectedId) ?? null;

  const refreshExperiments = async (activePin: string, preferId?: string) => {
    const payload = await listExperiments(activePin);
    setExperiments(payload.experiments);
    setSelectedId((current) => preferId || current || payload.experiments[0]?.id || null);
  };

  const refreshParticipants = async (activePin: string, experimentId: string) => {
    const payload = await listParticipants(activePin, experimentId);
    setParticipants(payload.participants);
    setRounds(payload.rounds);
  };

  useEffect(() => {
    const stored = loadAdminPin();
    if (!stored) return;
    listExperiments(stored)
      .then((payload) => {
        setAuthed(true);
        setExperiments(payload.experiments);
        setSelectedId(payload.experiments[0]?.id ?? null);
      })
      .catch(() => {
        clearAdminPin();
        setPin('');
      });
  }, []);

  useEffect(() => {
    if (!selected) return;
    setDraftName(selected.name);
    setDraftNotes(selected.notes);
    setDraftRepetitions(selected.repetitions);
    setDraftCaptures(selected.capturesPerRound);
  }, [selected]);

  useEffect(() => {
    if (!authed || !selectedId) return;
    refreshParticipants(pin, selectedId).catch((loadError: Error) => setError(loadError.message));
  }, [authed, pin, selectedId]);

  const balance = useMemo(() => {
    const button = participants.filter((participant) => participant.condition === 'button').length;
    const threshold = participants.filter((participant) => participant.condition === 'threshold').length;
    return { button, threshold };
  }, [participants]);

  const signIn = async (event: FormEvent) => {
    event.preventDefault();
    setAuthError('');
    try {
      await signInAdmin(pin);
      saveAdminPin(pin);
      setAuthed(true);
      await refreshExperiments(pin);
    } catch (signInError) {
      setAuthError(signInError instanceof Error ? signInError.message : 'Could not sign in.');
    }
  };

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : 'That change could not be saved.');
    } finally {
      setBusy(false);
    }
  };

  const copyText = async (value: string) => {
    await navigator.clipboard.writeText(value);
    setNotice('Copied.');
  };

  if (!authed) {
    return (
      <div className="min-h-screen bg-[#07060b] text-slate-100">
        <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-5">
          <div className="mb-6 flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-amber-200/10 text-amber-200">
              <FlaskConical className="h-5 w-5" />
            </div>
            <div>
              <p className="text-sm font-medium text-white">Study desk</p>
              <p className="text-xs text-slate-500">Organizer sign-in</p>
            </div>
          </div>
          <form onSubmit={(event) => void signIn(event)} className="rounded-[28px] border border-white/10 bg-slate-950/80 p-6">
            <Field label="Admin pin">
              <input type="password" value={pin} onChange={(event) => setPin(event.target.value)} className={inputClass} autoFocus />
            </Field>
            {authError && <p className="mt-3 text-sm text-rose-300">{authError}</p>}
            <button type="submit" className="mt-5 w-full rounded-2xl bg-amber-200 px-4 py-3 text-sm font-medium text-slate-950">Enter desk</button>
          </form>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#07060b] text-slate-100">
      <header className="border-b border-white/8 bg-[#07060b]/90 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-4 md:px-6">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-amber-200/10 text-amber-200">
              <FlaskConical className="h-4 w-4" />
            </div>
            <div>
              <p className="text-sm font-medium text-white">Study desk</p>
              <p className="text-[11px] text-slate-500">IDs, assignment, and round progress</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              clearAdminPin();
              setAuthed(false);
              setPin('');
            }}
            className="rounded-xl border border-white/10 px-3 py-2 text-xs text-slate-400"
          >
            Sign out
          </button>
        </div>
      </header>

      <main className="mx-auto grid max-w-7xl gap-5 px-4 py-6 lg:grid-cols-[280px_minmax(0,1fr)] md:px-6">
        <aside className="space-y-4">
          <section className="rounded-3xl border border-white/10 bg-white/[0.03] p-4">
            <p className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Experiments</p>
            <div className="mt-3 space-y-2">
              {experiments.map((experiment) => (
                <button
                  key={experiment.id}
                  type="button"
                  onClick={() => setSelectedId(experiment.id)}
                  className={`w-full rounded-2xl border px-3 py-3 text-left ${selectedId === experiment.id ? 'border-amber-200/30 bg-amber-200/10' : 'border-white/8 hover:bg-white/[0.03]'}`}
                >
                  <span className="block text-sm text-white">{experiment.name}</span>
                  <span className="mt-1 block text-[11px] text-slate-500">
                    {experiment.participantCount} IDs · {experiment.status === 'active' ? 'Open' : 'Closed'}
                  </span>
                </button>
              ))}
              {experiments.length === 0 && <p className="text-sm text-slate-500">No experiments yet.</p>}
            </div>
          </section>

          <form
            className="rounded-3xl border border-white/10 p-4"
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                const created = await createExperiment(pin, {
                  name: newName,
                  repetitions: 3,
                  capturesPerRound: 3,
                  notes: '',
                });
                setNewName('');
                await refreshExperiments(pin, created.id);
                setNotice('Experiment created.');
              });
            }}
          >
            <Field label="New experiment">
              <input value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="Neutral session name" className={inputClass} />
            </Field>
            <button type="submit" disabled={busy || !newName.trim()} className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl bg-white px-3 py-2.5 text-xs font-medium text-slate-950 disabled:opacity-40">
              <Plus className="h-3.5 w-3.5" /> Create
            </button>
          </form>
        </aside>

        {selected && (
          <section className="space-y-5">
            <div className="rounded-[28px] border border-white/10 bg-slate-950/60 p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-mono text-[11px] text-slate-500">{selected.id}</p>
                  <h1 className="mt-1 text-2xl font-light text-white">{selected.name}</h1>
                  <p className="mt-2 max-w-xl text-sm leading-6 text-slate-500">
                    Participants only see this name and their ID. The button or threshold assignment stays on this desk.
                  </p>
                </div>
                <div className="flex gap-2">
                  <button type="button" onClick={() => void run(() => downloadRoster(pin, selected.id))} className="flex items-center gap-2 rounded-xl border border-white/10 px-3 py-2 text-xs text-slate-300">
                    <Download className="h-3.5 w-3.5" /> Export CSV
                  </button>
                  <button
                    type="button"
                    onClick={() => void run(async () => {
                      await deleteExperiment(pin, selected.id);
                      setSelectedId(null);
                      setParticipants([]);
                      await refreshExperiments(pin);
                    })}
                    className="rounded-xl border border-rose-300/20 px-3 py-2 text-xs text-rose-200"
                  >
                    Delete
                  </button>
                </div>
              </div>

              <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                <Field label="Name">
                  <input value={draftName} onChange={(event) => setDraftName(event.target.value)} className={inputClass} />
                </Field>
                <Field label="Loop count (n)">
                  <input type="number" min={1} max={30} value={draftRepetitions} onChange={(event) => setDraftRepetitions(Number(event.target.value))} className={inputClass} />
                </Field>
                <Field label="Captures per round">
                  <input type="number" min={1} max={20} value={draftCaptures} onChange={(event) => setDraftCaptures(Number(event.target.value))} className={inputClass} />
                </Field>
                <Field label="Session access">
                  <select value={selected.status} onChange={(event) => void run(async () => {
                    await updateExperiment(pin, selected.id, { status: event.target.value as Experiment['status'] });
                    await refreshExperiments(pin, selected.id);
                  })} className={inputClass}>
                    <option value="active">Open for IDs</option>
                    <option value="closed">Closed</option>
                  </select>
                </Field>
              </div>
              <Field label="Notes">
                <textarea value={draftNotes} onChange={(event) => setDraftNotes(event.target.value)} rows={2} className={inputClass} />
              </Field>
              <button
                type="button"
                disabled={busy}
                onClick={() => void run(async () => {
                  await updateExperiment(pin, selected.id, {
                    name: draftName,
                    notes: draftNotes,
                    ...(draftRepetitions !== selected.repetitions ? { repetitions: draftRepetitions } : {}),
                    ...(draftCaptures !== selected.capturesPerRound ? { capturesPerRound: draftCaptures } : {}),
                  });
                  await refreshExperiments(pin, selected.id);
                  setNotice('Experiment saved.');
                })}
                className="mt-4 rounded-xl bg-amber-200 px-4 py-2.5 text-xs font-medium text-slate-950 disabled:opacity-40"
              >
                Save experiment
              </button>
            </div>

            <div className="grid gap-3 sm:grid-cols-4">
              {[
                ['IDs', participants.length],
                ['Button', balance.button],
                ['Threshold', balance.threshold],
                ['Finished', participants.filter((participant) => participant.status === 'completed').length],
              ].map(([label, value]) => (
                <div key={String(label)} className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
                  <p className="text-[10px] uppercase tracking-[0.16em] text-slate-500">{label}</p>
                  <p className="mt-2 text-2xl tabular-nums text-white">{value}</p>
                </div>
              ))}
            </div>

            <section className="rounded-[28px] border border-white/10 p-5">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                  <h2 className="text-sm font-medium text-white">Hand out IDs</h2>
                  <p className="mt-1 text-xs text-slate-500">Balanced assignment splits the batch as evenly as possible, then shuffles the order.</p>
                </div>
                <button
                  type="button"
                  onClick={() => void copyText(participants.map((participant) => participant.id).join('\n'))}
                  className="flex items-center gap-2 text-xs text-amber-100"
                >
                  <ClipboardCopy className="h-3.5 w-3.5" /> Copy all IDs
                </button>
              </div>
              <div className="mt-4 flex flex-wrap items-end gap-3">
                <Field label="How many">
                  <input type="number" min={1} max={200} value={generateCount} onChange={(event) => setGenerateCount(Number(event.target.value))} className={`${inputClass} w-28`} />
                </Field>
                <Field label="Assignment">
                  <select value={assignment} onChange={(event) => setAssignment(event.target.value as typeof assignment)} className={`${inputClass} w-44`}>
                    <option value="balanced">Balanced</option>
                    <option value="button">Button only</option>
                    <option value="threshold">Threshold only</option>
                  </select>
                </Field>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void run(async () => {
                    const created = await generateParticipants(pin, { experimentId: selected.id, count: generateCount, assignment });
                    await refreshExperiments(pin, selected.id);
                    await refreshParticipants(pin, selected.id);
                    setNotice(`Created ${created.participants.length} IDs.`);
                  })}
                  className="rounded-xl bg-white px-4 py-2.5 text-xs font-medium text-slate-950 disabled:opacity-40"
                >
                  Generate IDs
                </button>
              </div>

              <div className="mt-5 overflow-x-auto">
                <table className="w-full min-w-[720px] text-left text-sm">
                  <thead className="text-[10px] uppercase tracking-[0.16em] text-slate-500">
                    <tr>
                      <th className="pb-3 font-medium">ID</th>
                      <th className="pb-3 font-medium">Assignment</th>
                      <th className="pb-3 font-medium">Status</th>
                      <th className="pb-3 font-medium">Round</th>
                      <th className="pb-3 font-medium">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {participants.map((participant) => (
                      <tr key={participant.id} className="border-t border-white/8">
                        <td className="py-3 font-mono tracking-wider text-white">{participant.id}</td>
                        <td className="py-3">
                          <select
                            value={participant.condition}
                            disabled={participant.status !== 'assigned' || busy}
                            onChange={(event) => void run(async () => {
                              await updateParticipant(pin, participant.id, event.target.value as Assignment);
                              await refreshParticipants(pin, selected.id);
                              await refreshExperiments(pin, selected.id);
                            })}
                            className="rounded-lg border border-white/10 bg-black/30 px-2 py-1.5 text-xs capitalize text-slate-200 disabled:opacity-60"
                          >
                            <option value="button">Button</option>
                            <option value="threshold">Threshold</option>
                          </select>
                        </td>
                        <td className="py-3 text-slate-300">{STATUS_LABEL[participant.status]}</td>
                        <td className="py-3 tabular-nums text-slate-300">
                          {participant.status === 'completed' ? `${selected.repetitions} / ${selected.repetitions}` : `${participant.currentRound} / ${selected.repetitions}`}
                        </td>
                        <td className="py-3">
                          <div className="flex gap-1">
                            <button type="button" aria-label={`Copy ${participant.id}`} onClick={() => void copyText(participant.id)} className="rounded-lg p-2 text-slate-400 hover:bg-white/5 hover:text-white">
                              <ClipboardCopy className="h-3.5 w-3.5" />
                            </button>
                            <button type="button" aria-label={`Reset ${participant.id}`} onClick={() => void run(async () => {
                              await resetParticipant(pin, participant.id);
                              await refreshParticipants(pin, selected.id);
                              await refreshExperiments(pin, selected.id);
                            })} className="rounded-lg p-2 text-slate-400 hover:bg-white/5 hover:text-white">
                              <RefreshCw className="h-3.5 w-3.5" />
                            </button>
                            <button type="button" aria-label={`Remove ${participant.id}`} onClick={() => void run(async () => {
                              await deleteParticipant(pin, participant.id);
                              await refreshParticipants(pin, selected.id);
                              await refreshExperiments(pin, selected.id);
                            })} className="rounded-lg p-2 text-slate-500 hover:bg-rose-400/10 hover:text-rose-200">
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {participants.length === 0 && <p className="py-8 text-sm text-slate-500">Generate IDs to give to participants.</p>}
              </div>
            </section>

            <section className="rounded-[28px] border border-white/10 p-5">
              <h2 className="text-sm font-medium text-white">Completed rounds</h2>
              <div className="mt-4 space-y-2">
                {rounds.slice().reverse().slice(0, 12).map((round) => (
                  <div key={`${round.participantId}-${round.round}-${round.completedAt}`} className="flex items-center justify-between rounded-xl bg-white/[0.03] px-3 py-2 text-xs text-slate-400">
                    <span className="font-mono text-slate-200">{round.participantId}</span>
                    <span>Round {round.round}</span>
                    <span>{round.usableCount}/{round.trialCount} usable</span>
                    <Check className="h-3.5 w-3.5 text-emerald-300" />
                  </div>
                ))}
                {rounds.length === 0 && <p className="text-sm text-slate-500">Rounds appear here after a participant finishes Compare.</p>}
              </div>
            </section>

            {error && <p className="text-sm text-rose-300">{error}</p>}
            {notice && <p className="text-sm text-emerald-200">{notice}</p>}
          </section>
        )}
      </main>
    </div>
  );
}
