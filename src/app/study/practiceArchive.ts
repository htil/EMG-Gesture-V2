import type { CollectionItem } from './collection';
import { collectionId } from './collection';
import type { ClientSession } from './api';

export interface PracticeSettings { segmentDurationMs: number; preTriggerWindowMs: number; countdownMs: number; activityThreshold: number }
export interface PracticeRecord {
  id: string; attemptId: string; flowVersion: 2; kind: string; participantId: string; experimentId: string;
  sessionId: string; generation: number; condition: 'button' | 'threshold'; round: number;
  signalSource: 'mock' | 'live'; channelIndex: number; createdAt: number; settings: PracticeSettings;
  points: Array<{ time: number; value: number; activityEnvelope?: number }>;
  [key: string]: unknown;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key])).join(',') + '}';
  return JSON.stringify(value);
}
async function request(path: string, body?: unknown) {
  const response = await fetch('/api/study/practice' + path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || 'Practice could not be saved.');
  return payload;
}
export async function savePracticeRecord(record: PracticeRecord) {
  const ack = await request('', { id: record.participantId, record });
  if (ack.id !== record.id) throw new Error('Practice save was not acknowledged.');
  const read = await request('/' + encodeURIComponent(record.participantId));
  const saved = read.records.find((item: PracticeRecord) => item.id === record.id);
  // Compare every submitted field. The sanitizer may append diagnostics but
  // cannot silently change a waveform, identity, procedure or lineage.
  if (!saved || !Object.keys(record).every(key => canonical(saved[key]) === canonical(record[key]))) throw new Error('Practice read-back did not match. Retry saving.');
  return saved as PracticeRecord;
}
export function rehearsalSession(session: ClientSession): ClientSession {
  return { ...session, stage: 'capture', unlockedThrough: 'capture', capturesMin: 1, capturesMax: 1, capturesPerRound: 1,
    trials: [], runs: [], modelRevisionId: null, trainingRun: null, openCapture: null, pendingReplacements: [] };
}

// Private in-memory scope: never written to measured session/collection storage.
// Failed queue heads are retained verbatim; Retry does not fabricate success.
export class PracticeArchive {
  readonly scope: string;
  readonly saved: PracticeRecord[];
  readonly pending: PracticeRecord[] = [];
  error = '';
  private draining: Promise<void> | null = null;
  constructor(readonly rest: PracticeRecord, private changed: () => void) {
    this.scope = `practice:${rest.participantId}:${rest.generation}:${rest.attemptId}`;
    this.saved = [rest];
  }
  record(kind: string, extra: Record<string, unknown> = {}): PracticeRecord {
    const { calibration: _calibration, timing: _timing, ...restScope } = this.rest;
    return { ...restScope, id: collectionId('practice-record'), kind, points: [], createdAt: Date.now(), ...extra };
  }
  enqueue(record: PracticeRecord) {
    this.pending.push(record); this.changed();
    return this.flush();
  }
  flush(): Promise<void> {
    if (this.draining) return this.draining;
    if (!this.pending.length) return Promise.resolve();
    this.error = '';
    this.draining = (async () => {
      try {
        while (this.pending.length) {
          const record = this.pending[0];
          const saved = await savePracticeRecord(record);
          this.saved.push(saved); this.pending.shift(); this.changed();
        }
      } catch (error) {
        this.error = error instanceof Error ? error.message : 'Practice could not be saved.';
      } finally { this.draining = null; this.changed(); }
    })();
    return this.draining;
  }
  async barrier() {
    await this.flush();
    if (this.pending.length || this.error) throw new Error(this.error || 'Practice is still saving.');
  }
  collect(items: CollectionItem[]) {
    for (const item of items) {
      if (item.kind === 'sample') {
        const sample = item.record;
        void this.enqueue(this.record('capture', { id: sample.sampleId, restId: this.rest.id,
          gestureId: sample.gestureId, gestureName: sample.gestureLabel, points: sample.points,
          signalSource: sample.signalSource, channelIndex: sample.channelIndex,
          settings: { segmentDurationMs: sample.settings.segmentDurationMs, preTriggerWindowMs: sample.settings.preTriggerWindowMs,
            countdownMs: sample.settings.countdownMs, activityThreshold: sample.settings.activityThreshold },
          triggerMode: sample.gestureId === 'relax' ? 'button' : this.rest.condition,
          captureProcedure: sample.gestureId === 'relax' ? 'cued_rest' : this.rest.condition,
          triggeredAt: sample.triggeredAt, completedAt: sample.recordingEndedAt, preTriggerPointCount: sample.preTriggerPointCount,
          ...(sample.calibration !== undefined ? { calibration: sample.calibration, firstCrossingAt: sample.firstCrossingAt ?? null } : {}) }));
      } else if (item.kind === 'event') {
        const event = item.record;
        void this.enqueue(event.type === 'sample_deleted'
          ? this.record('removed', { referenceId: event.sampleId })
          : this.record('event', { id: event.eventId, type: event.type, sampleId: event.sampleId,
            replacementSampleId: event.replacementSampleId, detail: event.detail }));
      } else if (item.kind === 'training') {
        const training = item.record;
        void this.enqueue(this.record('training', { id: training.revisionId, sampleIds: training.sampleIds,
          classifier: training.classifier, status: training.status, startedAt: training.startedAt, finishedAt: training.finishedAt, error: training.error }));
      } else if (item.kind === 'run') {
        const run = item.record;
        // Snapshot the exact model input IDs, not a later edited dataset.
        const training = [...this.pending, ...this.saved].find(record => record.id === run.modelRevisionId);
        void this.enqueue(this.record('game', { id: run.id, trainingId: run.modelRevisionId, sampleIds: training?.sampleIds ?? [],
          gameScore: run.gameScore, difficulty: run.difficulty, outcomes: run.outcomes,
          obstacleSuccess: run.obstacleSuccess ?? null }));
      }
    }
    return this.flush();
  }
}
