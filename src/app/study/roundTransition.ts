import { joinStudy, startNextRound, type ClientSession, type NextRoundSource } from './api';
import { pickSession } from './ParticipantGate';
import { collectionId, whenCollectionSaved } from './collection';

export const ROUND_INTENT_KEY = 'emg-next-round-intent-v1';
interface RoundIntent { version: 1; source: NextRoundSource; snapshot: ClientSession }
function durableWrite(key: string, value: unknown) {
  const raw = JSON.stringify(value);
  localStorage.setItem(key, raw);
  if (localStorage.getItem(key) !== raw) throw new Error('Browser durable storage did not confirm the round transition.');
}
export function pendingRoundIntent(): RoundIntent | null {
  const raw = localStorage.getItem(ROUND_INTENT_KEY);
  if (!raw) return null;
  const intent = JSON.parse(raw) as RoundIntent;
  const s = intent.source, c = intent.snapshot;
  if (intent.version !== 1 || !s || !c || !s.requestId || !s.finalizationReceiptDigest
    || s.id !== c.participantId || s.experimentId !== c.experimentId || s.generation !== c.generation
    || s.condition !== c.condition || s.fromRound !== c.round || s.fromSessionId !== c.sessionId
    || c.stage !== 'done' || c.status !== 'completed' || c.repeatRoundsVersion !== 1) {
    throw new Error('Saved next-round intent is invalid. Preserve browser storage and ask the researcher.');
  }
  return intent;
}
export function persistRoundSession(session: ClientSession) {
  durableWrite('emg-study-session', session);
}
export function repeatRoundAvailable(s: ClientSession) {
  return s.protocolVersion === 'between-subject-v2' && s.repeatRoundsVersion === 1
    && s.status === 'completed' && s.stage === 'done' && s.canStartNextRound === true
    && !!s.finalizationReceiptDigest && !!s.sessionId;
}
/** Caller must stop/fence producers and seal/drain the raw owner before calling. */
export async function advanceCompletedRound(snapshot: ClientSession): Promise<ClientSession> {
  let intent = pendingRoundIntent();
  if (intent && (intent.snapshot.participantId !== snapshot.participantId
    || intent.snapshot.sessionId !== snapshot.sessionId || intent.snapshot.round !== snapshot.round
    || intent.snapshot.experimentId !== snapshot.experimentId || intent.snapshot.generation !== snapshot.generation
    || intent.snapshot.condition !== snapshot.condition)) throw new Error('Another saved transition needs recovery before continuing.');
  if (!intent) {
    if (!repeatRoundAvailable(snapshot)) throw new Error('A successfully submitted completed round is required.');
    intent = {version: 1, snapshot: structuredClone(snapshot), source: {
      id: snapshot.participantId, experimentId: snapshot.experimentId, generation: snapshot.generation,
      condition: snapshot.condition, fromRound: snapshot.round, fromSessionId: snapshot.sessionId,
      requestId: collectionId('next-round'), finalizationReceiptDigest: snapshot.finalizationReceiptDigest!,
    }};
    // Immutable old evidence and request identity survive a lost response/reload.
    durableWrite(`emg-completed-round:${snapshot.participantId}:${snapshot.generation}:${snapshot.round}:${snapshot.sessionId}`, snapshot);
    durableWrite(ROUND_INTENT_KEY, intent);
  }
  await whenCollectionSaved(); // Enqueue resolution is NOT a durable ACK.
  // Queue initialization supports old browsers by tolerating read failures.
  // A visit transition cannot: inspect the durable backup without changing it.
  const durableQueue = JSON.parse(localStorage.getItem('emg-collection-queue')
    ?? sessionStorage.getItem('emg-collection-queue') ?? '[]') as unknown;
  if (!Array.isArray(durableQueue) || durableQueue.length !== 0) {
    throw new Error('The durable collection backup is not empty and acknowledged. Preserve it and retry saving.');
  }
  const s = intent.source;
  const receipt = await startNextRound(s);
  if (receipt.repeatRoundsVersion !== 1 || receipt.participantId !== s.id || receipt.experimentId !== s.experimentId
    || receipt.generation !== s.generation || receipt.condition !== s.condition
    || receipt.fromRound !== s.fromRound || receipt.fromSessionId !== s.fromSessionId
    || receipt.round !== s.fromRound + 1 || !receipt.sessionId || receipt.sessionId === s.fromSessionId
    || receipt.status !== 'in_progress') throw new Error('Next-round receipt scope mismatch. Preserve the pending retry.');
  const joined = await joinStudy(s.id);
  if (joined.repeatRoundsVersion !== 1 || joined.protocolVersion !== 'between-subject-v2'
    || joined.participantId !== s.id || joined.experimentId !== s.experimentId || joined.generation !== s.generation
    || joined.condition !== s.condition || joined.round !== receipt.round || joined.sessionId !== receipt.sessionId
    || joined.status !== 'in_progress' || !joined.restored || joined.restored.sessionId !== receipt.sessionId
    || joined.restored.generation !== s.generation || joined.restored.round !== receipt.round
    || joined.protocolState?.sessionId !== receipt.sessionId || joined.protocolState?.generation !== s.generation
    || joined.protocolState?.condition !== s.condition || joined.protocolState?.visit !== receipt.round) {
    throw new Error('Authoritative rejoin does not match the next round. Preserve the pending retry.');
  }
  const next = pickSession(joined, null); // Never merge the old local scope.
  if (next.stage !== 'capture' || next.unlockedThrough !== 'capture' || next.modelRevisionId !== null
    || next.trials.length || next.runs.length || next.pendingReplacements.length || next.openCapture || next.trainingRun
    || next.protocolState?.practice || next.protocolState?.survey || next.protocolState?.lock
    || next.protocolState?.trainingStatus) {
    throw new Error('The next round is not a clean new scope. Preserve the pending source and ask the researcher to rejoin.');
  }
  persistRoundSession(next); // No sessionStorage fallback for a transition.
  localStorage.removeItem(ROUND_INTENT_KEY);
  if (localStorage.getItem(ROUND_INTENT_KEY) !== null) throw new Error('Could not clear the saved transition. Retry before continuing.');
  return next;
}
