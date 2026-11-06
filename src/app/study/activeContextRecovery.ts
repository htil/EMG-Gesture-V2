import { CaptureContextRecorder, type CaptureContextRecord } from './captureContext';

export interface RecoveryDestination {
  participantId: string; sessionId: string; condition: 'button' | 'threshold'; generation: number; round: number;
}
interface Journal {
  version: 1; destination: RecoveryDestination; active: CaptureContextRecord[]; sealed: CaptureContextRecord[];
}
interface Options {
  storage: Pick<Storage, 'getItem' | 'setItem'>;
  key: string; destination: RecoveryDestination; recorder: CaptureContextRecorder;
  send: (records: CaptureContextRecord[]) => Promise<unknown>;
  /** Must resolve only after the shared queue's entire batch ACK, NOT recordCollection(). */
  saved: () => Promise<void>;
  queued?: () => CaptureContextRecord[];
  onError?: (message: string) => void;
  maxBytes?: number;
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export function recoveryDestinationKey(d: RecoveryDestination) {
  return JSON.stringify([d.participantId, d.sessionId, d.condition, d.generation, d.round]);
}

const reasons = new Set(['incomplete_center','incomplete_pre','incomplete_post','interrupted','capture_cancelled','source_gap','source_backwards','invalid_sample','invalid_or_discontinuous_source','scope_changed','recorder_scope_changed','disconnected','stopped','unmounted','source_reset','source_or_channel_changed']);
function validateJournal(j: Journal, d: RecoveryDestination) {
  const check = (ok: unknown) => { if (!ok) throw new Error('Malformed context checkpoint; original backup preserved'); };
  const keys = (v: object, required: string[], optional: string[] = []) => {
    check(v && typeof v === 'object' && !Array.isArray(v));
    check(required.every(k => Object.prototype.hasOwnProperty.call(v, k)) && Object.keys(v).every(k => required.includes(k) || optional.includes(k)));
  };
  const finite = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
  const integer = (v: number) => Number.isSafeInteger(v) && v >= 0;
  const id = (v: unknown) => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9:_-]{0,159}$/.test(v);
  check(j && j.version === 1 && j.destination && recoveryDestinationKey(j.destination) === recoveryDestinationKey(d));
  check(Array.isArray(j.active) && Array.isArray(j.sealed) && j.active.length + j.sealed.length <= 128);
  keys(j, ['version','destination','active','sealed']);
  keys(j.destination, ['participantId','sessionId','condition','generation','round']);
  const ids = new Set<string>();
  for (const r of [...j.active, ...j.sealed]) {
    check(r && r.schemaVersion === 1 && id(r.contextId) && !ids.has(r.contextId)); ids.add(r.contextId);
    keys(r, ['schemaVersion','contextId','scope','attempt','sampleId','status','disposition','center','window','points','complete','reasons']);
    keys(r.scope, ['participantId','sessionId','condition','source','sourceEpoch','channel']);
    keys(r.attempt, ['attemptId','gestureId','cueAt'], ['retryOf']);
    keys(r.window, ['startAt','endAt','preMs','postMs']);
    check(r.scope && r.scope.participantId === d.participantId && r.scope.sessionId === d.sessionId && r.scope.condition === d.condition);
    check(['mock','live'].includes(r.scope.source) && integer(r.scope.sourceEpoch) && integer(r.scope.channel));
    check(r.attempt && r.attempt.attemptId === r.contextId && id(r.attempt.gestureId) && finite(r.attempt.cueAt) && (r.attempt.retryOf === undefined || id(r.attempt.retryOf)));
    check(r.sampleId === null || id(r.sampleId));
    check(['captured','failed','timeout','interrupted'].includes(r.status) && ['retained','deleted','rejected'].includes(r.disposition));
    check(r.window && finite(r.window.startAt) && finite(r.window.endAt) && r.window.startAt <= r.window.endAt && r.window.preMs === 5000 && r.window.postMs === 5000);
    check(Array.isArray(r.points) && r.points.length <= 12000 && Array.isArray(r.reasons) && r.reasons.every(v => reasons.has(v)) && r.complete === (r.reasons.length === 0));
    let time = -Infinity, consumptionId = -1;
    for (const p of r.points) {
      keys(p, ['time','raw','consumptionId']);
      check(p && finite(p.time) && finite(p.raw) && integer(p.consumptionId) && p.consumptionId > consumptionId && p.time >= time && (time === -Infinity || p.time - time <= 500) && p.time >= r.window.startAt && p.time < r.window.endAt);
      time = p.time; consumptionId = p.consumptionId;
    }
    if (r.complete) check(r.points.length > 0 && r.points[0].time - r.window.startAt <= 500 && r.window.endAt - r.points[r.points.length - 1].time <= 500);
    if (r.center) {
      const c = r.center;
      keys(c, ['startAt','endAt','startIndex','endIndexExclusive','startConsumptionId']);
      check(finite(c.startAt) && finite(c.endAt) && c.endAt - c.startAt === 2000 && integer(c.startIndex) && integer(c.endIndexExclusive) && c.startIndex <= c.endIndexExclusive && c.endIndexExclusive <= r.points.length && integer(c.startConsumptionId));
      const anchor = r.points.findIndex(p => p.consumptionId === c.startConsumptionId);
      check(anchor < 0 ? r.reasons.includes('incomplete_center') : anchor === c.startIndex && r.points[anchor].time === c.startAt);
      const end = r.points.findIndex((p,i) => i >= c.startIndex && p.time >= c.endAt);
      check(c.endIndexExclusive === (end < 0 ? r.points.length : end) && r.window.startAt === c.startAt - 5000);
      if (r.status === 'captured') check(r.window.endAt === c.endAt + 5000);
    } else check(r.center === null && r.status !== 'captured');
  }
}

/** Single-active-study-tab, same-tab reload journal. No old recorder is ever resumed. */
export class ActiveContextRecovery {
  private journal: Journal;
  private started = false;
  private dirty = false;
  private submitted = new Set<string>();
  private sending: Promise<void> | null = null;
  error = '';
  constructor(private options: Options) {
    this.journal = { version: 1, destination: { ...options.destination }, active: [], sealed: [] };
  }
  private fail(error: unknown) {
    this.error = `Raw/context recovery backup unavailable: ${error instanceof Error ? error.message : String(error)}. Evidence remains in memory or the last successful checkpoint; do not reload.`;
    this.options.onError?.(this.error);
  }
  start() {
    if (this.started) return;
    this.options.recorder.beforeAttempt = () => { if (this.error) throw new Error(this.error); };
    try {
      const raw = this.options.storage.getItem(this.options.key);
      if (raw) {
        const saved = JSON.parse(raw) as Journal;
        validateJournal(saved, this.options.destination);
        this.journal.sealed = [...saved.sealed, ...saved.active];
        // Seal exact recovered bytes BEFORE any upload. A second crash cannot change the payload.
        this.write();
      }
      this.started = true;
      this.options.recorder.onChange = kind => {
        this.dirty = true;
        if (kind === 'boundary') this.checkpoint();
      };
      this.dirty = true;
    } catch (error) { this.fail(error); }
  }
  private write() {
    const raw = JSON.stringify(this.journal);
    if (this.journal.active.length + this.journal.sealed.length > 128) throw new Error('Checkpoint attempt budget exhausted; save existing attempts before continuing');
    if (new TextEncoder().encode(raw).length > (this.options.maxBytes ?? 2_000_000)) throw new Error('Checkpoint byte budget exhausted; save existing attempts before continuing');
    this.options.storage.setItem(this.options.key, raw);
    // A failed write never removes the previous storage value.
    this.error = ''; this.options.onError?.('');
  }
  checkpoint() {
    if (!this.started || !this.dirty) return;
    try {
      const previous = JSON.stringify(this.journal);
      const completed = this.options.recorder.peekCompleted();
      for (const record of completed) {
        const existing = this.journal.sealed.find(r => r.contextId === record.contextId);
        if (existing && !same(existing, record)) throw new Error('Conflicting immutable context checkpoint');
        if (!existing) this.journal.sealed.push(record);
      }
      const sealed = new Set(this.journal.sealed.map(r => r.contextId));
      this.journal.active = this.options.recorder.recoverySnapshot().filter(r => !sealed.has(r.contextId));
      if (this.error || previous !== JSON.stringify(this.journal)) this.write();
      // Staging may leave RAM only after an exact sealed copy exists in storage.
      this.options.recorder.drainCompleted();
      this.dirty = false;
    } catch (error) { this.fail(error); }
  }
  stop() {
    this.started = false;
    this.options.recorder.onChange = undefined;
    this.options.recorder.beforeAttempt = undefined;
  }
  retry(): Promise<void> {
    if (!this.started) this.start();
    this.dirty = true;
    this.checkpoint();
    return this.drain();
  }
  drain(): Promise<void> {
    if (!this.started) return this.error ? Promise.reject(new Error(this.error)) : Promise.resolve();
    if (this.sending) return this.sending;
    if (this.error) return Promise.reject(new Error(this.error));
    const batch = this.journal.sealed.filter(r => !this.submitted.has(r.contextId));
    if (!batch.length) return Promise.resolve();
    this.sending = (async () => {
      const queued = this.options.queued?.() ?? [];
      const missing = batch.filter(record => {
        const existing = queued.find(r => r.contextId === record.contextId);
        if (existing && !same(existing, record)) throw new Error('Conflicting durable queued context; checkpoint preserved');
        return !existing;
      });
      if (missing.length) await this.options.send(structuredClone(missing));
      batch.forEach(r => this.submitted.add(r.contextId));
      // recordCollection catches network failures; only the real queue ACK barrier is safe.
      void this.options.saved().then(() => {
        if (!this.started) return; // A new source-scope owner may already own this journal.
        const ids = new Set(batch.map(r => r.contextId));
        this.journal.sealed = this.journal.sealed.filter(r => !ids.has(r.contextId));
        try { this.write(); } catch (error) { this.fail(error); }
      }).catch(error => this.fail(error));
    })().catch(error => { this.fail(error); throw error; }).finally(() => { this.sending = null; });
    return this.sending;
  }
}
