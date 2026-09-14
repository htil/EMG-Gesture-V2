import type { FeatureSetId, Gesture, TrainingSessionData, TestingSessionData } from '../pipeline/types';
import { TESTING_SESSION_LIMITS, type TestingSessionSettings } from '../pipeline/testingSessionConfig';

export type Condition = 'A' | 'B';
export type Sequence = 'AB' | 'BA';
export interface StudyConfig {
  gestures: Gesture[];
  segmentDurationMs: number;
  threshold: number;
  featureSetId: FeatureSetId;
  sampleTarget: number;
  selectedChannelIndex: number;
  sourceMode: 'mock' | 'live';
  displayWindowMs: number;
  sensitivity: number;
  activityReference: { baseline: number; upper: number };
  testingSettings: TestingSessionSettings;
}
export interface StudyEvent {
  index: number;
  time: number;
  sessionId: string;
  participantId: string;
  sequence: Sequence;
  period: 1 | 2;
  condition: Condition;
  datasetVersion: number;
  type: string;
  detail: Record<string, unknown>;
}
export interface StudyPeriod {
  condition: Condition;
  datasetVersion: number;
  dataset: TrainingSessionData | null;
  modelDatasetVersion: number | null;
  testing: TestingSessionData[];
}
export interface StudySession {
  schemaVersion: 1;
  id: string;
  participantId: string;
  sequence: Sequence;
  period: 1 | 2;
  status: 'active' | 'complete';
  config: StudyConfig;
  periods: StudyPeriod[];
  events: StudyEvent[];
}
export const STORAGE_KEY = 'emg-formative-pilot-v1';
export const conditionName = (condition: Condition) => condition === 'A' ? 'Button Start' : 'Signal Start';

export function appendEvent(session: StudySession, type: string, detail: Record<string, unknown> = {}, time = Date.now(), eventPeriod = session.period): StudySession {
  const period = session.periods[eventPeriod - 1];
  return { ...session, events: [...session.events, {
    index: session.events.length + 1, time, sessionId: session.id,
    participantId: session.participantId, sequence: session.sequence,
    period: eventPeriod, condition: period.condition, datasetVersion: period.datasetVersion, type,
    detail: structuredClone(detail),
  }] };
}

export function recordStudyEvent(session: StudySession, type: string, detail: Record<string, unknown> = {}, time = Date.now(), eventPeriod = session.period): StudySession {
  const next = appendEvent(session, type, detail, time, eventPeriod);
  if (type === 'model_built') next.periods = next.periods.map((p, i) => i === eventPeriod - 1
    ? { ...p, modelDatasetVersion: p.datasetVersion } : p);
  if (type === 'testing_completed') next.periods = next.periods.map((p, i) => i === eventPeriod - 1
    ? { ...p, testing: [...p.testing, structuredClone(detail.session as TestingSessionData)] } : p);
  return next;
}

export function studyConfigurationIssue(participantId: string, sequence: string, config: StudyConfig): string | null {
  if (typeof participantId !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(participantId)) return 'Participant code: enter 1-32 letters, numbers, underscores or hyphens.';
  if (sequence !== 'AB' && sequence !== 'BA') return 'Order: select AB or BA.';
  if (config.sourceMode !== 'mock' && config.sourceMode !== 'live') return 'Signal Source: select Mock or Live.';
  if (config.gestures.length < 2 || config.gestures.some(g => !g.id || !g.name.trim()) ||
      new Set(config.gestures.map(g => g.id)).size !== config.gestures.length) return 'Gesture Classes: use at least two distinct, named gestures.';
  const inRange = (value: number, min: number, max: number) => Number.isFinite(value) && value >= min && value <= max;
  if (!Number.isInteger(config.sampleTarget) || !inRange(config.sampleTarget, 2, 50)) return 'Target Samples: use a whole number from 2 to 50 per gesture.';
  if (!inRange(config.segmentDurationMs, 400, 3000)) return 'Segment Duration: use 400-3000 ms.';
  if (!inRange(config.threshold, 0.2, 0.9)) return 'Threshold: use a value from 20 to 90%.';
  if (!inRange(config.displayWindowMs, 2000, 10000)) return 'Display Window: use 2-10 seconds.';
  if (!inRange(config.sensitivity, 0.5, 1.5)) return 'Activity Sensitivity: use 0.5-1.5.';
  if (!Number.isInteger(config.selectedChannelIndex) || !inRange(config.selectedChannelIndex, 0, 3)) return 'Ganglion Channel: select Channel 1-4.';
  if (config.featureSetId !== 'extended' && config.featureSetId !== 'educational') return 'Model Feature Set: select Extended or Educational.';
  if (!Number.isFinite(config.activityReference.baseline) || !Number.isFinite(config.activityReference.upper) ||
      config.activityReference.upper <= config.activityReference.baseline) return 'Signal preparation: a valid activity reference is required.';
  for (const key of Object.keys(TESTING_SESSION_LIMITS) as (keyof TestingSessionSettings)[]) {
    const { min, max } = TESTING_SESSION_LIMITS[key];
    if (!inRange(config.testingSettings[key], min, max)) return `Testing settings: ${key} must be ${min}-${max}.`;
  }
  if (!Number.isInteger(config.testingSettings.numberOfTrials)) return 'Testing settings: trial count must be a whole number.';
  if (config.testingSettings.trialPeriodMs < config.segmentDurationMs + 750) return 'Testing trial duration must allow capture plus 750 ms for cue and completion.';
  return null;
}

export interface StudyStartReadiness { isStreaming: boolean; isRecording: boolean; pointCount: number }

export function studyStartIssue(participantId: string, sequence: string, config: StudyConfig, readiness: StudyStartReadiness): string | null {
  const issue = studyConfigurationIssue(participantId, sequence, config);
  if (issue) return issue;
  if (readiness.isRecording) return 'Recording: finish the current practice capture, or click Stop Stream, before beginning.';
  if (config.sourceMode === 'live') {
    if (!readiness.isStreaming) return 'Live signal: click Start Stream and connect Ganglion before beginning.';
    if (!(readiness.pointCount > 6)) return 'Live signal: waiting for at least 7 decoded samples.';
  }
  return null;
}

export function createStudy(participantId: string, sequence: Sequence, config: StudyConfig): StudySession {
  const issue = studyConfigurationIssue(participantId, sequence, config);
  if (issue) throw new Error(issue);
  const session: StudySession = {
    schemaVersion: 1, id: crypto.randomUUID(), participantId, sequence, period: 1, status: 'active',
    config: structuredClone(config),
    periods: [...sequence].map(condition => ({ condition: condition as Condition, datasetVersion: 0,
      dataset: null, modelDatasetVersion: null, testing: [] })), events: [],
  };
  return appendEvent(appendEvent(session, 'session_started', { config }), 'period_started');
}

export function updateDataset(session: StudySession, dataset: TrainingSessionData): StudySession {
  const current = session.periods[session.period - 1];
  const previous = current.dataset?.gestureData.flatMap(g => g.samples) ?? [];
  const next = dataset.gestureData.flatMap(g => g.samples);
  if (previous.map(s => s.id).join('|') === next.map(s => s.id).join('|')) return session;
  const periods = session.periods.map((p, i) => i === session.period - 1 ? {
    ...p, dataset: structuredClone(dataset), datasetVersion: p.datasetVersion + 1, modelDatasetVersion: null,
  } : p);
  let updated = { ...session, periods };
  for (const sample of previous.filter(s => !next.some(n => n.id === s.id))) {
    updated = appendEvent(updated, 'sample_deleted', { sampleId: sample.id, gestureId: sample.gestureId, provenance: sample.provenance });
  }
  for (const sample of next.filter(s => !previous.some(p => p.id === s.id))) {
    updated = appendEvent(updated, 'sample_accepted', { sample });
  }
  return appendEvent(updated, 'dataset_changed', { sampleIds: next.map(s => s.id), modelInvalidated: true });
}

export function advancePeriod(session: StudySession): StudySession {
  const ended = appendEvent(session, 'period_completed');
  if (session.period === 2) return appendEvent({ ...ended, status: 'complete' }, 'session_completed');
  return appendEvent({ ...ended, period: 2 }, 'period_started', { datasetVersion: 0, modelCleared: true });
}

export function studyEventsCsv(session: StudySession) {
  const keys = ['index', 'time', 'sessionId', 'participantId', 'sequence', 'period', 'condition', 'datasetVersion', 'type', 'detail'];
  const quote = (v: unknown) => `"${String(v ?? '').replaceAll('"', '""')}"`;
  return [keys.join(','), ...session.events.map(event => keys.map(key =>
    quote(key === 'detail' ? JSON.stringify(event.detail) : event[key as keyof StudyEvent])).join(','))].join('\r\n');
}
