import React, { createContext, useCallback, useContext, useRef, useState } from 'react';
import { advancePeriod, recordStudyEvent, conditionName, createStudy, STORAGE_KEY, studyEventsCsv, updateDataset,
  studyStartIssue, type StudyStartReadiness, type Sequence, type StudyConfig, type StudySession } from './studySession';
import type { TrainingSessionData } from '../pipeline/types';

function download(content: string, filename: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a');
  link.href = url; link.download = filename; link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
interface StudyContextValue {
  session: StudySession | null;
  blocked: boolean;
  begin: (participant: string, sequence: Sequence, config: StudyConfig) => void;
  log: (type: string, detail?: Record<string, unknown>, time?: number) => void;
  dataset: (data: TrainingSessionData) => void;
}
const StudyContext = createContext<StudyContextValue | null>(null);
export const useStudy = () => useContext(StudyContext)!;

export function StudyProvider({ children }: { children: React.ReactElement }) {
  const [session, setSession] = useState<StudySession | null>(null);
  const sessionRef = useRef(session);
  const [error, setError] = useState('');
  const [recovery, setRecovery] = useState<string | null>(() => {
    try { return localStorage.getItem(STORAGE_KEY); } catch { return null; }
  });
  const [epoch, setEpoch] = useState(0);
  const persist = useCallback((next: StudySession) => {
    sessionRef.current = next;
    setSession(next);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); setError(''); }
    catch { setError('Local backup failed. Recording is paused. Export the study before continuing.'); }
  }, []);
  const log = useCallback((type: string, detail: Record<string, unknown> = {}, time?: number) => {
    const s = sessionRef.current;
    if (!s || s.id !== session?.id) return;
    const next = recordStudyEvent(s, type, detail, time, session.period);
    persist(next);
  }, [persist, session?.id, session?.period]);
  const begin = useCallback((participant: string, sequence: Sequence, config: StudyConfig) => {
    persist(createStudy(participant, sequence, config));
  }, [persist]);
  const dataset = useCallback((data: TrainingSessionData) => {
    const s = sessionRef.current;
    if (!s || s.id !== session?.id || s.period !== session.period) return;
    const next = updateDataset(s, data);
    if (next !== s) persist(next);
  }, [persist, session?.id, session?.period]);
  const exportStudy = (format: 'json' | 'csv') => {
    log('study_exported', { format });
    const s = sessionRef.current!;
    download(format === 'json' ? JSON.stringify(s, null, 2) : studyEventsCsv(s),
      `emg_study_${s.participantId}_${s.id}.${format}`, format === 'json' ? 'application/json' : 'text/csv');
  };
  const advance = () => {
    if (!window.confirm(session?.period === 1
      ? 'End this period and clear the working dataset, model, recorder and Testing history? The study archive will retain this period.'
      : 'Finish this study session? Export the study archive afterward.')) return;
    persist(advancePeriod(sessionRef.current!));
  };
  const reset = () => {
    if (!window.confirm('Start a new session? Export the previous archive first. This clears the local backup.')) return;
    try { localStorage.removeItem(STORAGE_KEY); } catch { setError('Could not clear local backup.'); return; }
    sessionRef.current = null; setSession(null); setRecovery(null); setError(''); setEpoch(n => n + 1);
  };
  return <StudyContext.Provider value={{ session, blocked: !!error || !!recovery || session?.status === 'complete', begin, log, dataset }}>
    {(session || recovery || error) && <section className="border-b border-white/10 bg-slate-900 px-4 py-3 text-sm text-white" aria-label="Study session">
      {session && <div className="flex flex-wrap items-center gap-3">
        <span>{session.participantId} | {session.sequence} | Period {session.period}/2 | {conditionName(session.periods[session.period - 1].condition)} | {session.config.sourceMode === 'mock' ? 'Developer dry run' : 'Live pilot'}</span>
        <button className="rounded border border-white/20 px-3 py-1" onClick={() => exportStudy('json')}>Export Study JSON</button>
        <button className="rounded border border-white/20 px-3 py-1" onClick={() => exportStudy('csv')}>Export Events CSV</button>
        {session.status === 'active' && <button className="rounded border border-white/20 px-3 py-1" onClick={advance}>{session.period === 1 ? 'End Period / Next Condition' : 'Finish Study'}</button>}
        {session.status === 'complete' && <button onClick={reset}>New Session</button>}
      </div>}
      {recovery && <div className="flex flex-wrap items-center gap-3">
        <span>A previous study backup was found. Export it before starting over; interrupted sessions are not silently resumed.</span>
        <button onClick={() => download(recovery, `emg_study_recovered_${Date.now()}.json`, 'application/json')}>Export Recovered Study</button>
        <button onClick={reset}>Start Fresh</button>
      </div>}
      {error && <p role="alert" className="text-amber-300">{error}</p>}
    </section>}
    {!recovery && session?.status !== 'complete' && React.cloneElement(children, {
      key: `${epoch}:${session?.id ?? 'development'}:${session?.period ?? 0}`,
    })}
  </StudyContext.Provider>;
}

export function StudySetup({ config, readiness }: { config: StudyConfig; readiness: StudyStartReadiness }) {
  const study = useStudy();
  const [participant, setParticipant] = useState('');
  const [sequence, setSequence] = useState<Sequence>('AB');
  const [error, setError] = useState('');
  const startIssue = studyStartIssue(participant.trim(), sequence, config, readiness) ||
    (study.blocked ? 'Study backup: resolve the recovery or storage error before beginning.' : null);
  if (study.session) return <p className="text-sm text-white/70">Shared study settings are locked for both periods. Reconnect using Start Stream if needed.</p>;
  return <div className="space-y-3 border-b border-white/10 pb-4">
    <p className="text-sm text-white">Formative Pilot</p>
    <p className="text-xs text-white/60">Prepare gestures, source, threshold and duration first. Starting clears practice samples. Use a participant code, not a name.</p>
    <label className="block text-sm">Participant code <input aria-label="Participant code" className="w-full rounded border border-white/20 bg-slate-950 px-2 py-1" value={participant} onChange={e => setParticipant(e.target.value)} /></label>
    <label className="block text-sm">Order <select aria-label="Condition order" className="rounded bg-slate-950 p-1" value={sequence} onChange={e => setSequence(e.target.value as Sequence)}><option>AB</option><option>BA</option></select></label>
    <button disabled={!!startIssue} aria-describedby="study-start-reason" className="rounded border border-cyan-400/30 px-3 py-2 text-sm disabled:opacity-40" onClick={() => {
      if (startIssue) return;
      try { study.begin(participant.trim(), sequence, config); } catch (e) { setError((e as Error).message); }
    }}>Begin Pilot Session</button>
    <p id="study-start-reason" role="status" className="text-xs text-white/60">{startIssue ?? 'Ready to begin. Start Stream separately after session setup.'}</p>
    {error && <p role="alert" className="text-xs text-amber-300">{error}</p>}
  </div>;
}
