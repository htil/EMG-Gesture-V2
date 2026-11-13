export interface ContextScope {
  participantId: string; sessionId: string; condition: 'button' | 'threshold';
  source: 'live' | 'mock'; sourceEpoch: number; channel: number;
}
export interface AttemptMetadata { attemptId: string; gestureId: string; cueAt: number; retryOf?: string }
export interface RawContextInput { time: number; raw: number; consumptionId?: number }
export interface ContextPoint { time: number; raw: number; consumptionId: number }
export interface CaptureContextRecord {
  schemaVersion: 1; contextId: string; scope: ContextScope; attempt: AttemptMetadata;
  sampleId: string | null; status: 'captured' | 'failed' | 'timeout' | 'interrupted';
  disposition: 'retained' | 'deleted' | 'rejected';
  center: { startAt: number; endAt: number; startIndex: number; endIndexExclusive: number; startConsumptionId: number } | null;
  window: { startAt: number; endAt: number; preMs: number; postMs: number };
  points: ContextPoint[]; complete: boolean; reasons: string[];
}
interface Pending {
  record: CaptureContextRecord; anchor: number | null; end: number | null;
  targetStart: number; targetEnd: number | null; finished: boolean; reasons: string[]; availableStart: number | null; discardedThrough: number | null;
}
const PRE_MS = 5000, POST_MS = 5000;
export const LABELED_CENTER_MS = 2000;
/** Passive source-order recorder. Timestamps remain original host/SDK timestamps. */
export class CaptureContextRecorder {
  private scope: ContextScope;
  private ring: ContextPoint[] = [];
  private pending = new Map<string, Pending>();
  private completed: CaptureContextRecord[] = [];
  // Ownership-lifetime tombstones: draining/ACK and source resets never reopen a cue.
  private usedAttempts = new Set<string>();
  private cancelledAttempts = new Set<string>();
  canTriggerAttempt(id: string) {
    const pending = this.pending.get(id);
    return !this.usedAttempts.has(id) || !!pending && !pending.finished && pending.anchor === null;
  }
  hasUsedAttempt(id: string) { return this.usedAttempts.has(id); }
  isAttemptCancelled(id: string) { return this.cancelledAttempts.has(id); }
  private seen = new WeakSet<object>();
  private explicitIds = new Set<number>();
  private nextId = 0;
  private lastTime: number | null = null;
  private coverageStart: number | null = null;
  private discardedThrough: number | null = null;
  private identities = new WeakMap<object, number>();
  onChange?: (kind: 'point' | 'boundary') => void;
  beforeAttempt?: () => void;
  constructor(scope: ContextScope, private limits = { maxAttemptPoints: 12000 }) { this.scope = { ...scope }; }
  setScope(scope: ContextScope) {
    if (JSON.stringify(scope) === JSON.stringify(this.scope)) return;
    this.flush('scope_changed'); this.scope = { ...scope };
    this.explicitIds.clear(); this.seen = new WeakSet(); this.identities = new WeakMap();
  }
  push(point: RawContextInput): number | null {
    if (this.seen.has(point)) return this.identities.get(point) ?? null;
    if (point.consumptionId !== undefined && this.explicitIds.has(point.consumptionId)) return point.consumptionId;
    this.seen.add(point);
    if (!Number.isFinite(point.time) || !Number.isFinite(point.raw)) { this.flush('invalid_sample'); return null; }
    if (this.lastTime !== null && (point.time < this.lastTime || point.time - this.lastTime > 500)) {
      this.flush(point.time < this.lastTime ? 'source_backwards' : 'source_gap');
    }
    // Before an anchor exists only rolling future-eligible history is needed.
    // Keep the same binding slack as the ring; never trim anchored or terminal
    // windows, whose immutable evidence must still fail closed at the limit.
    const idleCutoff = point.time - (PRE_MS + LABELED_CENTER_MS + POST_MS);
    for (const pending of this.pending.values()) {
      if (this.scope.condition !== 'button' || pending.anchor !== null || pending.finished) continue;
      const first = pending.record.points.findIndex(p => p.time >= idleCutoff);
      const count = first < 0 ? pending.record.points.length : first;
      if (count) {
        const removed = pending.record.points.splice(0, count);
        pending.discardedThrough = removed[removed.length - 1].time;
      }
    }
    if ([...this.pending.values()].some(p => p.record.points.length >= this.limits.maxAttemptPoints)) this.flush('interrupted');
    const id = point.consumptionId ?? this.nextId++;
    if (point.consumptionId !== undefined) this.explicitIds.add(id);
    this.nextId = Math.max(this.nextId, id + 1);
    this.identities.set(point, id);
    const saved = { time: point.time, raw: point.raw, consumptionId: id };
    this.lastTime = point.time;
    this.coverageStart ??= point.time;
    this.ring.push(saved);
    // Retain bounded binding slack: raw acquisition precedes React triggering.
    // Export still crops to exactly the requested 5 | 2 | 5 window.
    const cutoff = point.time - (PRE_MS + LABELED_CENTER_MS + POST_MS);
    const removed = this.ring.filter(p => p.time < cutoff);
    if (removed.length) this.discardedThrough = removed[removed.length - 1].time;
    this.ring = this.ring.filter(p => p.time >= cutoff);
    if (this.ring.length > this.limits.maxAttemptPoints) {
      const dropped = this.ring.splice(0, this.ring.length - this.limits.maxAttemptPoints);
      this.discardedThrough = dropped[dropped.length - 1].time;
    }
    for (const pending of this.pending.values()) {
      pending.availableStart ??= point.time;
      pending.record.points.push({ ...saved });
    }
    const completedBefore = this.completed.length;
    this.finalizeReady();
    this.onChange?.(this.completed.length > completedBefore ? 'boundary' : 'point');
    return id;
  }
  beginAttempt(attempt: AttemptMetadata): string {
    this.beforeAttempt?.();
    if (this.usedAttempts.has(attempt.attemptId)) throw new Error('Attempt ID already used');
    if (this.pending.size + this.completed.length >= 8) throw new Error('Context recovery backlog: save existing attempts before starting another');
    const record: CaptureContextRecord = {
      schemaVersion: 1, contextId: attempt.attemptId, scope: { ...this.scope }, attempt: { ...attempt }, sampleId: null,
      status: 'interrupted', disposition: 'retained', center: null,
      window: { startAt: attempt.cueAt - PRE_MS, endAt: attempt.cueAt, preMs: PRE_MS, postMs: POST_MS },
      points: this.ring.map(p => ({ ...p })), complete: false, reasons: [],
    };
    this.usedAttempts.add(attempt.attemptId);
    this.pending.set(attempt.attemptId, { record, anchor: null, end: null, targetStart: attempt.cueAt - PRE_MS, targetEnd: null, finished: false, reasons: [], availableStart: this.coverageStart, discardedThrough: this.discardedThrough });
    this.onChange?.('boundary');
    return attempt.attemptId;
  }
  capture(attemptId: string, point: RawContextInput, durationMs = LABELED_CENTER_MS) {
    const pending = this.requireAttempt(attemptId);
    if (pending.finished) throw new Error('Attempt already ended');
    const id = this.identities.get(point) ?? point.consumptionId;
    if (id === undefined || !pending.record.points.some(p => p.consumptionId === id)) throw new Error('Capture anchor must be consumed first');
    if (!Number.isFinite(durationMs) || durationMs <= 0) throw new Error('Invalid center duration');
    if (pending.anchor !== null) throw new Error('Attempt already captured');
    pending.anchor = id; pending.end = point.time + durationMs;
    pending.targetStart = point.time - PRE_MS; pending.targetEnd = pending.end + POST_MS;
    pending.record.center = { startAt: point.time, endAt: pending.end, startIndex: 0, endIndexExclusive: 0, startConsumptionId: id };
    this.onChange?.('boundary');
  }
  finishCapture(attemptId: string, sampleId?: string) {
    const pending = this.requireAttempt(attemptId);
    if (pending.anchor === null) throw new Error('No captured center');
    pending.record.sampleId = sampleId ?? null; pending.record.status = 'captured'; pending.finished = true;
    this.finalizeReady();
    this.onChange?.('boundary');
  }
  endAttempt(attemptId: string, reason: 'failed' | 'timeout', endedAt: number) {
    const pending = this.requireAttempt(attemptId);
    if (!Number.isFinite(endedAt) || endedAt < pending.record.attempt.cueAt) throw new Error('Invalid attempt end');
    pending.record.status = reason; this.cancelledAttempts.add(attemptId); pending.finished = true; pending.targetEnd = endedAt + POST_MS;
    this.finalizeReady();
    this.onChange?.('boundary');
  }
  canCapture(point: RawContextInput) {
    const id = this.identities.get(point) ?? point.consumptionId;
    return id !== undefined && (this.ring.some(p => p.consumptionId === id) || [...this.pending.values()].some(a => a.record.points.some(p => p.consumptionId === id)));
  }
  hasAttempt(attemptId: string) { return this.pending.has(attemptId); }
  bindSample(attemptId: string, sampleId: string) { this.requireAttempt(attemptId).record.sampleId = sampleId; this.onChange?.('boundary'); }
  interruptAttempt(attemptId: string, reason = 'interrupted') {
    const pending = this.pending.get(attemptId);
    if (!pending) return;
    pending.reasons.push(reason); pending.record.status = 'interrupted';
    this.finalize(pending); this.pending.delete(attemptId);
    this.onChange?.('boundary');
  }
  /** Detached terminal evidence only: a checkpoint never resumes an old acquisition. */
  recoverySnapshot(): CaptureContextRecord[] {
    const copy = new CaptureContextRecorder(this.scope);
    copy.pending = structuredClone(this.pending);
    copy.lastTime = this.lastTime;
    copy.flush('interrupted');
    return [...structuredClone(this.completed), ...copy.drainCompleted()];
  }
  peekCompleted(): CaptureContextRecord[] { return structuredClone(this.completed); }
  drainCompleted(): CaptureContextRecord[] { return this.completed.splice(0); }
  flush(reason = 'interrupted') {
    for (const pending of this.pending.values()) {
      pending.reasons.push(reason);
      if (!pending.finished) pending.record.status = 'interrupted';
      this.finalize(pending);
    }
    this.pending.clear(); this.ring = []; this.lastTime = null; this.coverageStart = null; this.discardedThrough = null;
    this.onChange?.('boundary');
    // Keep consumption identity across gaps/interruptions: React can replay
    // raw-acquired points later. Only a scope change may reset that identity.
  }
  private requireAttempt(id: string) { const p = this.pending.get(id); if (!p) throw new Error('Unknown attempt'); return p; }
  private finalizeReady() {
    for (const [id, pending] of this.pending) {
      if (pending.finished && pending.targetEnd !== null && this.lastTime !== null && this.lastTime >= pending.targetEnd) {
        this.finalize(pending); this.pending.delete(id);
      }
    }
  }
  private finalize(pending: Pending) {
    const r = pending.record, end = pending.targetEnd ?? (this.lastTime ?? r.attempt.cueAt) + POST_MS;
    r.window = { startAt: pending.targetStart, endAt: end, preMs: PRE_MS, postMs: POST_MS };
    r.points = r.points.filter(p => p.time >= pending.targetStart && p.time < end);
    if (r.center) {
      const start = r.points.findIndex(p => p.consumptionId === pending.anchor);
      r.center.startIndex = start < 0 ? r.points.length : start;
      const stop = r.points.findIndex((p, i) => i >= r.center!.startIndex && p.time >= r.center!.endAt);
      r.center.endIndexExclusive = stop < 0 ? r.points.length : stop;
      if (start < 0 || (this.lastTime ?? -Infinity) < r.center.endAt) pending.reasons.push('incomplete_center');
    }
    if (pending.availableStart === null || pending.availableStart > pending.targetStart || (pending.discardedThrough !== null && pending.discardedThrough >= pending.targetStart)) pending.reasons.push('incomplete_pre');
    if (pending.targetEnd === null || (this.lastTime ?? -Infinity) < pending.targetEnd) pending.reasons.push('incomplete_post');
    r.reasons = [...new Set(pending.reasons)]; r.complete = r.reasons.length === 0;
    if (r.status !== 'captured') this.cancelledAttempts.add(r.contextId);
    this.completed.push(structuredClone(r));
  }
}
/** In-memory retry queue; callers may persist snapshots in their scoped backup. */
export class ContextPersistenceQueue {
  private records: CaptureContextRecord[];
  private inFlight: Promise<void> | null = null;
  constructor(private persist: (records: CaptureContextRecord[]) => Promise<unknown>, initial: CaptureContextRecord[] = []) {
    this.records = structuredClone(initial);
  }
  get pendingCount() { return this.records.length; }
  snapshot() { return structuredClone(this.records); }
  enqueue(records: CaptureContextRecord[]) {
    for (const record of records) {
      const existing = this.records.find(r => r.contextId === record.contextId);
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(record)) throw new Error('Conflicting queued context');
      } else this.records.push(structuredClone(record));
    }
  }
  flush(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    if (!this.records.length) return Promise.resolve();
    this.inFlight = (async () => {
      while (this.records.length) {
        const batch = this.snapshot();
        // The adapter must reject unless the ENTIRE batch is acknowledged.
        await this.persist(batch);
        this.records.splice(0, batch.length);
      }
    })().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }
}
/** Only the explicit center is eligible for existing training adapters. */
export function centerWaveform(record: CaptureContextRecord): { time: number; value: number }[] {
  if (!record.center || record.status !== 'captured' || record.disposition !== 'retained' || record.reasons.includes('incomplete_center')) return [];
  return record.points.slice(record.center.startIndex, record.center.endIndexExclusive).map(p => ({ time: p.time, value: p.raw }));
}
