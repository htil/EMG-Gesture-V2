import { useCallback, useEffect, useMemo, useState } from 'react';
import { CaptureContextRecorder, type CaptureContextRecord } from './captureContext';
import { ActiveContextRecovery, recoveryDestinationKey } from './activeContextRecovery';
import type { ClientSession } from './api';
import { collectionId, recordCollection, retryCollectionSave, whenCollectionSaved } from './collection';

/** Tracks every opportunity, including failed windows without a retained sample. */
class ScopedArchiveRecorder extends CaptureContextRecorder {
  private outstanding = new Set<string>();
  private captured = new Set<string>();
  override beginAttempt(attempt: Parameters<CaptureContextRecorder['beginAttempt']>[0]) {
    const id = super.beginAttempt(attempt);
    this.outstanding.add(attempt.attemptId);
    return id;
  }
  override capture(...args: Parameters<CaptureContextRecorder['capture']>) {
    super.capture(...args);
    this.captured.add(args[0]);
  }
  cancelUncaptured(attemptId: string) {
    if (!this.hasAttempt(attemptId) || this.captured.has(attemptId)) return false;
    this.interruptAttempt(attemptId, 'capture_cancelled');
    return true;
  }
  override drainCompleted() {
    const records = super.drainCompleted();
    records.forEach(record => { this.outstanding.delete(record.attempt.attemptId); this.captured.delete(record.attempt.attemptId); });
    return records;
  }
  get pendingWindowCount() { return this.outstanding.size; }
}

/** Owns recorder, checkpoint and immutable destination together. Single active study tab. */
export function useCoreCaptureContextArchive(
  session: Pick<ClientSession, 'participantId' | 'sessionId' | 'condition' | 'generation' | 'round'> | null,
  enabled: boolean,
  source: 'mock' | 'live',
  sourceEpoch: number,
  channel: number,
  points: readonly import('../useSignalSource').SignalPoint[],
  subscribeRawPoints?: (listener: (point: import('../useSignalSource').SignalPoint) => void, includePending?: boolean) => () => void,
  subscribeSourceInterruptions?: (listener: (reason: string) => void) => () => void,
) {
  const destinationKey = JSON.stringify([session?.participantId, session?.sessionId, session?.condition, session?.generation, session?.round, enabled]);
  // A stream boundary ends attempts, not the destination's recovery ownership.
  // Replacing that owner can abandon newer RAM-only evidence during storage failure.
  const destination = useMemo(() => session ? { participantId: session.participantId, sessionId: session.sessionId, condition: session.condition, generation: session.generation, round: session.round } : null, [destinationKey]);
  const recorder = useMemo(() => new ScopedArchiveRecorder({ participantId: destination?.participantId ?? 'inactive', sessionId: destination?.sessionId ?? 'inactive', condition: destination?.condition ?? 'button', source, sourceEpoch, channel }), [destinationKey]);
  const holder = useMemo(() => ({ current: null as ActiveContextRecovery | null, error: '' }), [recorder]);
  const [recoveryError, setRecoveryError] = useState('');
  const report = useCallback((error: unknown) => setRecoveryError(error instanceof Error ? error.message : String(error)), []);
  const drain = useCallback(() => {
    if (!enabled || !destination) return Promise.resolve();
    if (holder.error) return Promise.reject(new Error(holder.error));
    return holder.current?.drain() ?? Promise.resolve();
  }, [holder, destination, enabled]);
  const flush = useCallback((reason = 'interrupted') => { recorder.flush(reason); return drain(); }, [recorder, drain]);
  useEffect(() => {
    if (!enabled || !destination) return;
    setRecoveryError('');
    try {
      // Owner discovery is tab-scoped: a new unrelated tab never adopts another person's raw journal.
      const ownerKey = 'emg-context-recovery-owner';
      let owner = sessionStorage.getItem(ownerKey);
      if (!owner) { owner = collectionId('tab'); sessionStorage.setItem(ownerKey, owner); }
      const recovery = new ActiveContextRecovery({
        storage: localStorage,
        key: `emg-context-recovery:${owner}:${recoveryDestinationKey(destination)}`,
        destination, recorder,
        send: records => recordCollection(destination.participantId, records.map(context => ({ kind: 'context' as const, record: { sessionId: destination.sessionId, generation: destination.generation, round: destination.round, condition: destination.condition, context } }))),
        saved: whenCollectionSaved,
        queued: () => {
          // Read the existing durable queue, not its resolved (non-ACK) enqueue promise.
          const queue = JSON.parse(localStorage.getItem('emg-collection-queue') ?? '[]') as Array<{ participantId: string; item: { kind: string; record: { sessionId: string; generation: number; round: number; condition: string; context: CaptureContextRecord } } }>;
          if (!Array.isArray(queue)) throw new Error('Malformed collection backup; raw checkpoint preserved');
          return queue.filter(q => q.participantId === destination.participantId && q.item.kind === 'context' && q.item.record.sessionId === destination.sessionId && q.item.record.generation === destination.generation && q.item.record.round === destination.round && q.item.record.condition === destination.condition).map(q => q.item.record.context);
        },
        onError: setRecoveryError,
      });
      holder.current = recovery;
      recovery.start();
      void recovery.drain().catch(report);
      // Points only dirty RAM. Best-effort 250ms cadence, never a per-200Hz storage write.
      const timer = window.setInterval?.(() => { recovery.checkpoint(); void recovery.drain().catch(report); }, 250);
      return () => {
        if (timer !== undefined) window.clearInterval?.(timer);
        recorder.flush('scope_changed');
        void recovery.drain().catch(report);
        recovery.stop(); // Old asynchronous ACKs must not overwrite a new source owner's journal.
      };
    } catch (error) {
      holder.error = `Raw/context recovery unavailable: ${error instanceof Error ? error.message : String(error)}. Do not reload.`;
      recorder.beforeAttempt = () => { throw new Error(holder.error); };
      setRecoveryError(holder.error);
    }
  }, [enabled, destination, recorder, holder, report]);
  useEffect(() => {
    recorder.setScope({ participantId: destination?.participantId ?? 'inactive', sessionId: destination?.sessionId ?? 'inactive', condition: destination?.condition ?? 'button', source, sourceEpoch, channel });
    void drain().catch(report);
  }, [recorder, destination, source, sourceEpoch, channel, drain, report]);
  useEffect(() => {
    if (!enabled || !subscribeRawPoints) return;
    // Seed this owner's rendered prefix, then the source's pending prefix,
    // before any newer raw callback. Later React clones deduplicate by identity.
    points.forEach(point => recorder.push(point));
    return subscribeRawPoints(point => { recorder.push(point); void drain().catch(report); }, true);
  }, [enabled, recorder, drain, report, subscribeRawPoints]);
  useEffect(() => {
    if (!enabled || !subscribeSourceInterruptions) return;
    return subscribeSourceInterruptions(reason => { void flush(reason).catch(report); });
  }, [enabled, flush, report, subscribeSourceInterruptions]);
  useEffect(() => {
    if (!enabled) return;
    const beforeUnload = () => { void flush('interrupted').catch(report); };
    window.addEventListener?.('pagehide', beforeUnload);
    return () => window.removeEventListener?.('pagehide', beforeUnload);
  }, [enabled, flush, report]);
  useEffect(() => { void drain().catch(report); }, [points, drain, report]);
  const retryRecovery = useCallback(async () => {
    if (!holder.current) throw new Error(holder.error || 'Recovery storage has not initialized');
    await holder.current.retry();
    await retryCollectionSave(); // Matching durable records still need a real network retry.
  }, [holder]);
  // Parent UI must display recoveryError and block further collection while nonempty.
  return { recorder, drain, flush, recoveryError, retryRecovery };
}
