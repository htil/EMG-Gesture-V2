export type ParticipantStatus = 'assigned' | 'in_progress' | 'completed';
export type ExperimentStatus = 'active' | 'closed';
export type Assignment = 'button' | 'threshold';
export type StudyStage = 'capture' | 'review' | 'game' | 'compare' | 'done';
export type FlowStage = Exclude<StudyStage, 'done'>;

export interface Experiment {
  id: string;
  name: string;
  repetitions: number;
  capturesPerRound: number;
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

export interface ClientSession {
  participantId: string;
  experimentId: string;
  experimentName: string;
  repetitions: number;
  capturesPerRound: number;
  round: number;
  manualTrigger: boolean;
  status: ParticipantStatus;
  stage: StudyStage;
  unlockedThrough: FlowStage;
  trials: StoredTrial[];
}

const SESSION_KEY = 'emg-study-session';
const PIN_KEY = 'emg-admin-pin';

export function loadClientSession(): ClientSession | null {
  const raw = sessionStorage.getItem(SESSION_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ClientSession;
  } catch {
    return null;
  }
}

export function saveClientSession(session: ClientSession) {
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

export function clearClientSession() {
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
  return request<Omit<ClientSession, 'stage' | 'trials' | 'manualTrigger'> & { manualTrigger?: boolean }>('/api/study/join', {
    method: 'POST',
    body: JSON.stringify({ id }),
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

export function createExperiment(pin: string, input: { name: string; repetitions: number; capturesPerRound: number; notes: string }) {
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
  capturesPerRound: number;
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
  return request<{ participants: Participant[]; rounds: RoundLog[] }>(
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
