import type { StoredGameRun } from './gameHandoff';

export type ParticipantStatus = 'assigned' | 'in_progress' | 'completed';
export type ExperimentStatus = 'active' | 'closed';
export type Assignment = 'button' | 'threshold';
export type StudyStage = 'capture' | 'review' | 'game' | 'results' | 'done';
export type FlowStage = Exclude<StudyStage, 'done'>;

export const DEFAULT_OBSTACLE_COUNT = 20;
export const DEFAULT_STARTING_LIVES = 3;
export const MAX_OBSTACLE_COUNT = 200;
export const MAX_STARTING_LIVES = 10;

export function clampStudyCount(value: unknown, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

export interface Experiment {
  id: string;
  name: string;
  repetitions: number;
  capturesMin: number;
  capturesMax: number;
  capturesPerRound: number;
  obstacleCount: number;
  startingLives: number;
  status: ExperimentStatus;
  notes: string;
  createdAt: string;
  participantCount: number;
  buttonCount: number;
  thresholdCount: number;
  completedCount: number;
  inProgressCount: number;
}

export interface Participant {
  id: string;
  experimentId: string;
  condition: Assignment;
  status: ParticipantStatus;
  currentRound: number;
  roundsCompleted: number;
  createdAt: string;
}

export interface RoundLog {
  participantId: string;
  round: number;
  trialCount: number;
  savedCount: number;
  usableCount: number;
  completedAt: string;
}

export interface StoredTrial {
  id: string;
  gestureId: string;
  gestureName: string;
  pairIndex: number;
  capturedAt: number;
  triggeredAt: number;
  completedAt: number;
  preTriggerPointCount: number;
  points: Array<{ time: number; value: number }>;
  quality: 'usable' | 'review';
  metrics: {
    rms: number;
    peak: number;
    range: number;
    durationMs: number;
  };
}

export interface PendingReplacement {
  round: number;
  gestureId: string;
  sampleId: string;
}

export interface OpenCapture {
  sampleId: string;
  gestureId: string;
  gestureName: string;
  round: number;
  phase: 'countdown' | 'recording';
}

export interface TrainingRun {
  revisionId: string;
  startedAt: number;
  round: number;
  sampleIds: string[];
}

export interface RestoredSession {
  sessionId: string;
  round: number;
  stage: StudyStage;
  unlockedThrough: FlowStage;
  trials: StoredTrial[];
  pendingReplacements: PendingReplacement[];
  openCapture: OpenCapture | null;
  trainingRun: TrainingRun | null;
  modelRevisionId: string | null;
  runs: StoredGameRun[];
  updatedAt: number;
  generation: number;
}

export interface SaveAlert {
  participantId: string;
  message: string;
  pending: number;
  at: string;
}

export interface ClientSession {
  participantId: string;
  experimentId: string;
  experimentName: string;
  sessionId: string;
  generation: number;
  updatedAt: number;
  repetitions: number;
  capturesMin: number;
  capturesMax: number;
  capturesPerRound: number;
  obstacleCount: number;
  startingLives: number;
  round: number;
  modelRevisionId: string | null;
  condition: Assignment;
  manualTrigger: boolean;
  status: ParticipantStatus;
  stage: StudyStage;
  unlockedThrough: FlowStage;
  trials: StoredTrial[];
  runs: StoredGameRun[];
  pendingReplacements: PendingReplacement[];
  openCapture: OpenCapture | null;
  trainingRun: TrainingRun | null;
}

const SESSION_KEY = 'emg-study-session';
const PIN_KEY = 'emg-admin-pin';

function readSessionRaw() {
  try {
    const stored = localStorage.getItem(SESSION_KEY) ?? sessionStorage.getItem(SESSION_KEY);
    if (stored && !localStorage.getItem(SESSION_KEY)) localStorage.setItem(SESSION_KEY, stored);
    return stored;
  } catch {
    return null;
  }
}

export function loadClientSession(): ClientSession | null {
  const raw = readSessionRaw();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ClientSession> & {
      stage?: string;
      unlockedThrough?: string;
    };
    const rawStage = String(parsed.stage ?? '');
    const rawUnlocked = String(parsed.unlockedThrough ?? '');
    const stage = rawStage === 'compare' ? 'results' : rawStage;
    const unlockedThrough = rawUnlocked === 'compare' ? 'results' : rawUnlocked;
    const capturesMax = typeof parsed.capturesMax === 'number'
      ? parsed.capturesMax
      : (typeof parsed.capturesPerRound === 'number' ? parsed.capturesPerRound : 1);
    const capturesMin = typeof parsed.capturesMin === 'number' ? parsed.capturesMin : capturesMax;
    const obstacleCount = clampStudyCount(parsed.obstacleCount, DEFAULT_OBSTACLE_COUNT, 1, MAX_OBSTACLE_COUNT);
    const startingLives = clampStudyCount(parsed.startingLives, DEFAULT_STARTING_LIVES, 1, MAX_STARTING_LIVES);
    if (stage !== 'capture' && stage !== 'review' && stage !== 'game' && stage !== 'results' && stage !== 'done') return null;
    if (unlockedThrough !== 'capture' && unlockedThrough !== 'review' && unlockedThrough !== 'game' && unlockedThrough !== 'results') return null;
    return {
      participantId: String(parsed.participantId ?? ''),
      experimentId: String(parsed.experimentId ?? ''),
      experimentName: String(parsed.experimentName ?? ''),
      sessionId: parsed.sessionId || `sess-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      generation: typeof parsed.generation === 'number' ? parsed.generation : 1,
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0,
      repetitions: Number(parsed.repetitions) || 1,
      capturesMin,
      capturesMax,
      capturesPerRound: capturesMax,
      obstacleCount,
      startingLives,
      round: Number(parsed.round) || 1,
      modelRevisionId: typeof parsed.modelRevisionId === 'string' ? parsed.modelRevisionId : null,
      condition: parsed.condition === 'button' || parsed.condition === 'threshold'
        ? parsed.condition
        : parsed.manualTrigger ? 'button' : 'threshold',
      manualTrigger: Boolean(parsed.manualTrigger),
      status: parsed.status === 'completed' || parsed.status === 'assigned' ? parsed.status : 'in_progress',
      stage,
      unlockedThrough,
      trials: Array.isArray(parsed.trials) ? parsed.trials : [],
      runs: Array.isArray(parsed.runs) ? parsed.runs : [],
      pendingReplacements: Array.isArray(parsed.pendingReplacements) ? parsed.pendingReplacements : [],
      openCapture: parsed.openCapture ?? null,
      trainingRun: parsed.trainingRun ?? null,
    };
  } catch {
    return null;
  }
}

export function saveClientSession(session: ClientSession) {
  const stamped = { ...session, updatedAt: Date.now() };
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(stamped));
  } catch {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(stamped));
  }
}

export function clearClientSession() {
  localStorage.removeItem(SESSION_KEY);
  sessionStorage.removeItem(SESSION_KEY);
}

export function loadAdminPin() {
  return sessionStorage.getItem(PIN_KEY) ?? '';
}

export function saveAdminPin(pin: string) {
  sessionStorage.setItem(PIN_KEY, pin);
}

export function clearAdminPin() {
  sessionStorage.removeItem(PIN_KEY);
}

async function request<T>(path: string, init?: RequestInit, pin?: string): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body) headers.set('Content-Type', 'application/json');
  if (pin) headers.set('x-admin-pin', pin);
  const response = await fetch(path, { ...init, headers });
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  const payload = text ? JSON.parse(text) as { error?: string } : {};
  if (!response.ok) throw new Error(payload.error || 'The study desk could not complete that request.');
  return payload as T;
}

export function joinStudy(id: string) {
  return request<Omit<ClientSession, 'stage' | 'trials' | 'manualTrigger' | 'unlockedThrough' | 'pendingReplacements' | 'openCapture' | 'trainingRun' | 'updatedAt'> & {
    manualTrigger?: boolean;
    runs?: StoredGameRun[];
    restored?: RestoredSession | null;
  }>('/api/study/join', {
    method: 'POST',
    body: JSON.stringify({ id }),
  });
}

export function saveGameRun(id: string, run: StoredGameRun) {
  return request<{ ok: boolean }>('/api/study/runs', {
    method: 'POST',
    body: JSON.stringify({ id, run }),
  });
}

export function saveRound(id: string, round: number, trials: StoredTrial[]) {
  return request<{ status: ParticipantStatus; round: number; repetitions: number }>('/api/study/progress', {
    method: 'POST',
    body: JSON.stringify({ id, round, trials }),
  });
}

export function signInAdmin(pin: string) {
  return request<{ ok: boolean }>('/api/study/auth', {
    method: 'POST',
    body: JSON.stringify({ pin }),
  });
}

export function listExperiments(pin: string) {
  return request<{ experiments: Experiment[] }>('/api/study/experiments', undefined, pin);
}

export function createExperiment(pin: string, input: {
  name: string;
  repetitions: number;
  capturesMin: number;
  capturesMax: number;
  obstacleCount?: number;
  startingLives?: number;
  notes: string;
}) {
  return request<Experiment>('/api/study/experiments', {
    method: 'POST',
    body: JSON.stringify(input),
  }, pin);
}

export function updateExperiment(pin: string, id: string, patch: Partial<{
  name: string;
  notes: string;
  status: ExperimentStatus;
  repetitions: number;
  capturesMin: number;
  capturesMax: number;
  obstacleCount: number;
  startingLives: number;
}>) {
  return request<Experiment>(`/api/study/experiments/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  }, pin);
}

export function deleteExperiment(pin: string, id: string) {
  return request<{ ok: boolean }>(`/api/study/experiments/${encodeURIComponent(id)}`, { method: 'DELETE' }, pin);
}

export function listParticipants(pin: string, experimentId: string) {
  return request<{ participants: Participant[]; rounds: RoundLog[]; saveAlerts?: SaveAlert[] }>(
    `/api/study/participants?experimentId=${encodeURIComponent(experimentId)}`,
    undefined,
    pin,
  );
}

export function generateParticipants(pin: string, input: { experimentId: string; count: number; assignment: 'balanced' | Assignment }) {
  return request<{ participants: Participant[] }>('/api/study/participants/generate', {
    method: 'POST',
    body: JSON.stringify(input),
  }, pin);
}

export function updateParticipant(pin: string, id: string, condition: Assignment) {
  return request<Participant>(`/api/study/participants/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ condition }),
  }, pin);
}

export function resetParticipant(pin: string, id: string) {
  return request<Participant>(`/api/study/participants/${encodeURIComponent(id)}/reset`, { method: 'POST' }, pin);
}

export function deleteParticipant(pin: string, id: string) {
  return request<{ ok: boolean }>(`/api/study/participants/${encodeURIComponent(id)}`, { method: 'DELETE' }, pin);
}

export async function downloadRoster(pin: string, experimentId: string) {
  const response = await fetch(`/api/study/export/${encodeURIComponent(experimentId)}`, {
    headers: { 'x-admin-pin': pin },
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: 'Could not export the roster.' }));
    throw new Error(payload.error || 'Could not export the roster.');
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${experimentId}-participants.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export async function downloadStudyData(pin: string, experimentId: string) {
  const response = await fetch(`/api/study/export/${encodeURIComponent(experimentId)}/collection`, {
    headers: { 'x-admin-pin': pin },
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: 'Could not export the study data.' }));
    throw new Error(payload.error || 'Could not export the study data.');
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${experimentId}-study-data.zip`;
  anchor.click();
  URL.revokeObjectURL(url);
}
