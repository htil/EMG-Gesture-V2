import DismissibleNotice from './DismissibleNotice';
import PracticeGuide from './PracticeGuide';
import { restCalibration } from './frozenCalibration.mjs';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ClientSession } from './api';
import type { SignalPoint, SignalSourceMode } from '../useSignalSource';
import { collectionId } from './collection';
import { PRACTICE_REST_MS, PRACTICE_MAX_GAP_MS, practicePointIssue } from './practice.mjs';
import { savePracticeRecord, type PracticeRecord, type PracticeSettings } from './practiceArchive';

export interface PracticeSignalView {
  active: boolean; start: number | null; progress: number; durationMs: number;
  overlay: { label: string; text: string } | null;
}
interface Props {
  session: ClientSession; points: SignalPoint[]; streaming: boolean; source: SignalSourceMode; channel: number;
  settings: PracticeSettings; bluetoothAvailable: boolean; connectionMessage: string;
  streamEpoch?: number; recalibration?: boolean; onCancel?: () => void;
  onSource: (source: SignalSourceMode) => void; onStream: () => void;
  onCue: (cue: 'rest' | 'auto') => void;
  renderSignal: (view: PracticeSignalView) => ReactNode;
  onComplete: (rest: PracticeRecord) => void;
}
const button = 'rounded-xl border border-cyan-300/50 bg-cyan-300 px-5 py-3 text-sm font-medium text-slate-950 disabled:opacity-40';

// Setup only: collection, review, training, game and Results are StudySession's
// actual mounted stages, not a parallel practice implementation.
export default function GuidedPractice(props: Props) {
  const { session, points, streaming, source, channel, settings, onCue } = props;
  const [step, setStep] = useState<'welcome' | 'explore' | 'rest'>(props.recalibration ? 'rest' : 'welcome');
  const [attemptId] = useState(() => collectionId('practice'));
  const [restRunning, setRestRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState<PracticeRecord | null>(null);
  const windowRef = useRef<{ after: number; points: PracticeRecord['points']; lastReceipt: number; seen: WeakSet<SignalPoint>; endAt?: number } | null>(null);
  const epoch = useRef(0);
  const mounted = useRef(true);
  const failRef = useRef<(message: string) => void>(() => {});
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; epoch.current++; onCue('auto'); };
  }, [onCue]);
  const fail = (message: string) => {
    windowRef.current = null; setRestRunning(false); onCue('auto'); setError(message);
  };
  failRef.current = fail;
  useEffect(() => {
    if (!streaming && windowRef.current) failRef.current('The stream stopped. Reconnect, then repeat the resting reference.');
  }, [streaming]);
  useEffect(() => {
    epoch.current++;
    if (windowRef.current) failRef.current('Stream scope changed. Repeat the resting reference.');
    setPending(null); setSaving(false);
  }, [streaming, source, channel, props.streamEpoch, session.participantId, session.sessionId, session.generation, session.round]);
  const save = async (record: PracticeRecord) => {
    const token = epoch.current;
    setPending(record); setSaving(true); setError('');
    try {
      const saved = await savePracticeRecord(record);
      if (!mounted.current || token !== epoch.current) return;
      if (!streaming) return;
      setPending(null); props.onComplete(saved);
    } catch (cause) {
      if (mounted.current && token === epoch.current) setError(cause instanceof Error ? cause.message : 'Practice could not be saved.');
    } finally {
      if (mounted.current && token === epoch.current) setSaving(false);
    }
  };
  useEffect(() => {
    const window = windowRef.current;
    if (!window) return;
    for (const point of points) {
      // Consume source object identity once, retaining distinct equal-time
      // samples including terminal ties delivered in separate render batches.
      if (window.seen.has(point)) continue;
      window.seen.add(point);
      if (![point.time, point.raw, point.activityEnvelope].every(Number.isFinite) || point.activityEnvelope < 0) {
        fail('The resting signal was interrupted. Check the connection, then retry the resting recording.'); return;
      }
      if (!window.points.length && point.time <= window.after) continue;
      const last = window.points[window.points.length - 1];
      if (last && point.time < last.time) { fail('The source timestamps moved backwards. Ask the researcher to check the connection.'); return; }
      // Close only on a strictly later timestamp so endpoint pairs survive.
      if (window.endAt !== undefined && point.time > window.endAt) {
        windowRef.current = null; setRestRunning(false); onCue('auto');
        const issue = practicePointIssue(window.points, PRACTICE_REST_MS);
        if (issue) { fail(issue); return; }
        const record: PracticeRecord = { id: collectionId('practice-rest'), attemptId, flowVersion: 2, kind: 'rest',
          participantId: session.participantId, experimentId: session.experimentId, sessionId: session.sessionId,
          generation: session.generation, condition: session.condition, round: session.round,
          signalSource: source, channelIndex: channel, createdAt: Date.now(), settings, points: window.points };
        try { record.calibration = restCalibration(record); } catch (cause) { fail(cause instanceof Error ? cause.message : 'Rest calibration failed.'); return; }
        void save(record);
        return;
      }
      if (last && point.time - last.time > PRACTICE_MAX_GAP_MS) { fail('The resting signal was interrupted. Check the connection, then retry the resting recording.'); return; }
      window.points.push({ time: point.time, value: point.raw, activityEnvelope: point.activityEnvelope });
      window.lastReceipt = Date.now();
      const duration = point.time - window.points[0].time;
      setProgress(Math.min(1, duration / PRACTICE_REST_MS));
      if (duration >= PRACTICE_REST_MS && window.endAt === undefined) window.endAt = point.time;
    }
  }, [points]);
  useEffect(() => {
    if (!restRunning) return;
    const timer = window.setInterval(() => {
      if (windowRef.current && Date.now() - windowRef.current.lastReceipt > 1000) failRef.current('No fresh signal arrived. Check the connection, then retry the resting recording.');
    }, 100);
    return () => window.clearInterval(timer);
  }, [restRunning]);
  const locked = restRunning || saving || pending !== null;
  const guide = step === 'welcome'
    ? { id: 'welcome', title: 'Let’s practise first', body: 'You’ll record a few movements, check them, and try them in the game. These practice examples do not count toward the study.', target: '[data-practice-target="begin"]' }
    : !streaming ? { id: 'connect', title: 'Start your signal', body: 'Press the highlighted button to connect. The graph will show your activity when the signal starts.', target: '[data-practice-target="stream"]' }
    : step === 'explore' ? { id: 'signal', title: 'Watch the blue line', body: 'Make the movement your researcher showed you. Watch how the blue line changes. Then rest your hand.', target: '[data-practice-target="signal"]', action: { label: 'I’m ready to rest', onClick: () => setStep('rest'), disabled: !streaming || locked } }
    : restRunning ? { id: 'rest-recording', title: 'Keep your hand comfortably resting', body: 'Keep your hand still and relaxed until the timer finishes. You can cancel if you need to.' }
    : saving ? { id: 'rest-saving', title: 'Saving your resting setup', body: 'Wait while we save the recording.' }
    : pending ? { id: 'rest-retry', title: 'Your resting setup has not saved yet', body: 'Press Retry saving practice to try saving it again.', target: '[data-practice-target="rest-retry"]' }
    : { id: 'rest', title: 'Rest your hand for 10 seconds', body: 'Press Begin resting recording. Keep your hand still and relaxed until the timer finishes.', target: '[data-practice-target="rest-start"]' };
  return <section aria-label="Practice preparation" className="space-y-5">
    <PracticeGuide step={guide} busy={restRunning || saving} />
    <div className="rounded-3xl border-2 border-cyan-300/50 bg-slate-900 p-6">
      <p className="text-sm font-semibold uppercase tracking-wider text-cyan-200">Practice · Preparation</p>
      <h1 className="mt-2 text-2xl text-white">{step === 'welcome' ? 'Learn the real collection flow' : step === 'explore' ? 'Watch your signal' : 'Resting reference'}</h1>
      {step === 'welcome' && <><button data-practice-target="begin" className={'mt-4 ' + button} onClick={() => setStep('explore')}>Begin practice</button></>}
      {step === 'rest' && <><p role="status" className="mt-3 text-cyan-100">{saving ? 'Saving resting reference…' : restRunning ? 'Keep your hand resting' : 'Ready when you are'}</p><progress aria-label="Resting recording progress" value={progress} max={1} className="mt-3 w-full" /><button data-practice-target="rest-start" disabled={!streaming || locked} className={'mt-4 ' + button} onClick={() => { setError(''); setProgress(0); windowRef.current = { after: Date.now(), points: [], lastReceipt: Date.now(), seen: new WeakSet(points) }; onCue('rest'); setRestRunning(true); }}>Begin resting recording</button>
      {restRunning && <button className="ml-3 underline" onClick={() => fail('Resting recording cancelled. Retry when ready.')}>Cancel recording</button>}</>}
      <DismissibleNotice message={error} summary="Practice issue" resetKey={saving} className="mt-4" />
      {pending && !saving && <button data-practice-target="rest-retry" className={'mt-3 ' + button} onClick={() => void save(pending)}>Retry saving practice</button>}
      {props.onCancel && <button className="mt-3 underline" disabled={saving} onClick={props.onCancel}>Back without changing calibration</button>}
      {session.isTestParticipant === true && <div className="mt-4 flex gap-3" aria-label="Test signal source">{(['mock', 'live'] as const).map(mode => <button key={mode} disabled={locked || (mode === 'live' && !props.bluetoothAvailable)} className="rounded-xl border border-white/30 px-4 py-2 disabled:opacity-40" aria-pressed={source === mode} onClick={() => props.onSource(mode)}>{mode === 'mock' ? 'Mock' : 'Ganglion'}</button>)}</div>}
      <button data-practice-target="stream" disabled={locked} className="mt-4 rounded-xl border border-white/30 px-4 py-3 disabled:opacity-40" onClick={props.onStream}>{streaming ? 'Pause stream' : source === 'mock' ? 'Start mock stream' : 'Connect device'}</button>
      {source === 'live' && <p className="mt-2 text-sm text-slate-300">{props.connectionMessage}</p>}
    </div>
    {props.renderSignal({ active: restRunning, start: windowRef.current?.points[0]?.time ?? null, progress, durationMs: PRACTICE_REST_MS, overlay: restRunning ? { label: 'Preparation · resting reference', text: 'Keep resting' } : null })}
  </section>;
}
