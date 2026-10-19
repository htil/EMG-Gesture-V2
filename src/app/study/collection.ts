import type {
  Assignment,
  FlowStage,
  OpenCapture,
  PendingReplacement,
  StoredTrial,
  StudyStage,
  TrainingRun,
} from './api';
import type { StoredGameRun } from './gameHandoff';

export type CollectionEventType =
  | 'capture_started'
  | 'capture_completed'
  | 'capture_cancelled'
  | 'capture_error'
  | 'sample_deleted'
  | 'sample_replaced';

export interface RecordingSettings {
  segmentDurationMs: number;
  preTriggerWindowMs: number;
  activityThreshold: number;
  cooldownMs: number;
  countdownMs: number;
  capturesMin: number;
  capturesMax: number;
  featureSetId: string;
  classifier: 'knn';
}

export interface CollectionContext {
  participantId: string;
  sessionId: string;
  experimentId: string;
  condition: Assignment;
  round: number;
  phase: StudyStage;
  signalSource: 'mock' | 'live';
  channelIndex: number;
  sampleRateHz: number | null;
  deviceName: string | null;
  generation: number;
  settings: RecordingSettings;
}

export interface CollectionEvent {
  eventId: string;
  sessionId: string;
  participantId: string;
  condition: Assignment;
  round: number;
  phase: StudyStage;
  type: CollectionEventType;
  at: number;
  generation: number;
  sampleId: string | null;
  replacementSampleId: string | null;
  detail: string;
}

export interface SampleRecord {
  sampleId: string;
  sessionId: string;
  participantId: string;
  experimentId: string;
  condition: Assignment;
  round: number;
  phase: StudyStage;
  gestureId: string;
  gestureLabel: string;
  capturedAt: number;
  recordingStartedAt: number;
  recordingEndedAt: number;
  triggeredAt: number;
  preTriggerPointCount: number;
  pointCount: number;
  points: Array<{ time: number; value: number }>;
  signalSource: 'mock' | 'live';
  channelIndex: number;
  sampleRateHz: number | null;
  settings: RecordingSettings;
}

export interface TrainingRevision {
  revisionId: string;
  sessionId: string;
  participantId: string;
  condition: Assignment;
  round: number;
  sampleIds: string[];
  classifier: 'knn';
  settings: RecordingSettings;
  startedAt: number;
  finishedAt: number;
  status: 'success' | 'failure';
  error: string;
  generation: number;
}

export interface SessionCheckpoint {
  sessionId: string;
  generation: number;
  round: number;
  stage: StudyStage;
  unlockedThrough: FlowStage;
  modelRevisionId: string | null;
  trials: StoredTrial[];
  pendingReplacements: PendingReplacement[];
  openCapture: OpenCapture | null;
  trainingRun: TrainingRun | null;
  updatedAt: number;
}

export type CollectionItem =
  | { kind: 'meta'; record: CollectionContext }
  | { kind: 'sample'; record: SampleRecord }
  | { kind: 'event'; record: CollectionEvent }
  | { kind: 'training'; record: TrainingRevision }
  | { kind: 'run'; record: StoredGameRun }
  | { kind: 'checkpoint'; record: SessionCheckpoint };

export interface CollectionStatus {
  error: string;
  pending: number;
}

interface QueuedItem {
  participantId: string;
  item: CollectionItem;
}

const QUEUE_KEY = 'emg-collection-queue';
const waiters: Array<() => void> = [];
let failureCount = 0;
let alertActive = false;
let retryTimer = 0;

export function collectionId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function makeEvent(
  context: CollectionContext,
  type: CollectionEventType,
  sampleId: string | null,
  replacementSampleId: string | null,
  detail: string,
): CollectionEvent {
  return {
    eventId: collectionId('event'),
    sessionId: context.sessionId,
    participantId: context.participantId,
    condition: context.condition,
    round: context.round,
    phase: context.phase,
    type,
    at: Date.now(),
    generation: context.generation,
    sampleId,
    replacementSampleId,
    detail,
  };
}

let queue: QueuedItem[] = loadQueue();
let saveError = '';
let flushing = false;
const listeners = new Set<(status: CollectionStatus) => void>();

function readStoredQueue() {
  try {
    const raw = localStorage.getItem(QUEUE_KEY) ?? sessionStorage.getItem(QUEUE_KEY);
    if (raw && !localStorage.getItem(QUEUE_KEY)) localStorage.setItem(QUEUE_KEY, raw);
    const parsed = raw ? JSON.parse(raw) as QueuedItem[] : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function loadQueue(): QueuedItem[] {
  return readStoredQueue();
}

function persistQueue() {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
  } catch {
    saveError = saveError || 'Study data is waiting to save, but this browser could not keep the backup copy.';
  }
}

function status(): CollectionStatus {
  return { error: saveError, pending: queue.length };
}

function notify() {
  const next = status();
  listeners.forEach((listener) => listener(next));
}

export function subscribeCollectionStatus(listener: (status: CollectionStatus) => void) {
  listener(status());
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

async function postCollection(participantId: string, items: CollectionItem[]) {
  const response = await fetch('/api/study/collection', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: participantId, items }),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) as { error?: string } : {};
  if (!response.ok) throw new Error(payload.error || 'Study data could not be saved.');
}

function releaseWaiters() {
  if (queue.length > 0 || saveError) return;
  const pending = waiters.splice(0);
  pending.forEach((resolve) => resolve());
}

async function postSaveAlert(participantId: string, generation: number, active: boolean) {
  await fetch('/api/study/save-alert', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: participantId,
      generation,
      active,
      pending: queue.length,
      at: new Date().toISOString(),
      message: 'Study data is still not saving.',
    }),
  });
}

function generationOf(item: CollectionItem) {
  const record = item.record as { generation?: number };
  return typeof record.generation === 'number' ? record.generation : 1;
}

function scheduleRetry() {
  window.clearTimeout(retryTimer);
  const delay = Math.min(15000, 1000 * (2 ** Math.min(failureCount, 4)));
  retryTimer = window.setTimeout(() => {
    retryTimer = 0;
    void flush();
  }, delay);
}

async function flush() {
  if (flushing || queue.length === 0) {
    releaseWaiters();
    return;
  }
  flushing = true;
  const participantId = queue[0].participantId;
  let count = 0;
  while (count < queue.length && queue[count].participantId === participantId) count += 1;
  const batch = queue.slice(0, count).map((entry) => entry.item);
  const generation = generationOf(batch[0]);
  try {
    await postCollection(participantId, batch);
    queue.splice(0, count);
    saveError = '';
    failureCount = 0;
    persistQueue();
    notify();
    if (alertActive) {
      alertActive = false;
      void postSaveAlert(participantId, generation, false).catch(() => {
        alertActive = true;
      });
    }
  } catch (error) {
    saveError = error instanceof Error ? error.message : 'Study data could not be saved.';
    failureCount += 1;
    persistQueue();
    notify();
    if (failureCount >= 3) {
      alertActive = true;
      void postSaveAlert(participantId, generation, true).catch(() => undefined);
    }
    scheduleRetry();
  } finally {
    flushing = false;
  }
  if (!saveError && queue.length > 0) void flush();
  releaseWaiters();
}

export function whenCollectionSaved() {
  if (queue.length === 0 && !saveError) return Promise.resolve();
  return new Promise<void>((resolve) => {
    waiters.push(resolve);
    if (!flushing) {
      window.clearTimeout(retryTimer);
      retryTimer = 0;
      void flush();
    }
  });
}

export function recordCollection(participantId: string, items: CollectionItem[]) {
  if (items.length === 0) return Promise.resolve();
  queue.push(...items.map((item) => ({ participantId, item })));
  saveError = '';
  persistQueue();
  notify();
  return flush();
}

export function retryCollectionSave() {
  saveError = '';
  failureCount = 0;
  notify();
  return flush();
}

if (queue.length > 0) void flush();
