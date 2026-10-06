import { createPredictionEngine, type Gesture } from '../pipeline';
import { DEFAULT_FEATURE_SET_ID } from '../pipeline/featureExtraction';
import type { Assignment } from './api';

export type ModelStatus = 'incomplete' | 'training' | 'ready' | 'error' | 'outdated';

export interface TrainableTrial {
  id: string;
  gestureId: string;
  gestureName: string;
  capturedAt: number;
  points: Array<{ time: number; value: number }>;
  metrics: { durationMs: number };
}

export interface ConditionModelState {
  condition: Assignment;
  datasetTrialIds: string[];
  trainedTrialIds: string[];
  status: ModelStatus;
  error: string;
  trainedAt: number | null;
}

const engines = new Map<string, ReturnType<typeof createPredictionEngine>>();
const trainTokens = new Map<string, number>();
const trainingInFlight = new Map<string, number>();

function storageKey(scopeId: string, condition: Assignment) {
  return `emg-condition-model:${scopeId}:${condition}`;
}

function fingerprint(ids: string[]) {
  return [...ids].sort().join('|');
}

function emptyState(condition: Assignment): ConditionModelState {
  return {
    condition,
    datasetTrialIds: [],
    trainedTrialIds: [],
    status: 'incomplete',
    error: '',
    trainedAt: null,
  };
}

export function readModelState(scopeId: string, condition: Assignment): ConditionModelState {
  const raw = sessionStorage.getItem(storageKey(scopeId, condition));
  if (!raw) return emptyState(condition);
  try {
    const parsed = JSON.parse(raw) as ConditionModelState;
    if (!parsed || parsed.condition !== condition || !Array.isArray(parsed.datasetTrialIds)) return emptyState(condition);
    return {
      condition,
      datasetTrialIds: parsed.datasetTrialIds.map(String),
      trainedTrialIds: Array.isArray(parsed.trainedTrialIds) ? parsed.trainedTrialIds.map(String) : [],
      status: parsed.status ?? 'incomplete',
      error: typeof parsed.error === 'string' ? parsed.error : '',
      trainedAt: typeof parsed.trainedAt === 'number' ? parsed.trainedAt : null,
    };
  } catch {
    return emptyState(condition);
  }
}

function writeModelState(scopeId: string, condition: Assignment, state: ConditionModelState) {
  sessionStorage.setItem(storageKey(scopeId, condition), JSON.stringify({ ...state, condition }));
  return { ...state, condition };
}

function sameState(left: ConditionModelState, right: ConditionModelState) {
  return left.status === right.status
    && left.error === right.error
    && fingerprint(left.datasetTrialIds) === fingerprint(right.datasetTrialIds)
    && fingerprint(left.trainedTrialIds) === fingerprint(right.trainedTrialIds);
}

export function markDatasetChanged(scopeId: string, condition: Assignment, trialIds: string[]): ConditionModelState {
  const current = readModelState(scopeId, condition);
  const key = storageKey(scopeId, condition);
  const datasetSame = fingerprint(trialIds) === fingerprint(current.datasetTrialIds);
  const trainedSame = current.trainedTrialIds.length > 0
    && fingerprint(trialIds) === fingerprint(current.trainedTrialIds);

  if (!datasetSame) {
    trainTokens.set(key, (trainTokens.get(key) ?? 0) + 1);
    engines.delete(key);
  }

  const trainingStillRunning = trainingInFlight.get(key) === trainTokens.get(key);
  if (current.status === 'training' && datasetSame && trainingStillRunning) return current;
  if (current.status === 'training' && datasetSame) {
    engines.delete(key);
    return writeModelState(scopeId, condition, {
      ...current,
      status: current.trainedTrialIds.length > 0 ? 'outdated' : 'error',
      error: 'Training stopped before the model was ready.',
    });
  }
  if (current.status === 'error' && datasetSame) return current;

  let next: ConditionModelState;
  if (trainedSame && engines.has(key)) {
    next = {
      ...current,
      condition,
      datasetTrialIds: [...trialIds],
      status: 'ready',
      error: '',
    };
  } else if (current.trainedTrialIds.length > 0) {
    engines.delete(key);
    next = {
      ...current,
      condition,
      datasetTrialIds: [...trialIds],
      status: 'outdated',
      error: trainedSame ? 'Train again before testing.' : '',
    };
  } else {
    next = {
      ...current,
      condition,
      datasetTrialIds: [...trialIds],
      status: current.status === 'error' ? 'error' : 'incomplete',
      error: current.status === 'error' ? current.error : '',
    };
  }

  if (sameState(current, next)) return current;
  return writeModelState(scopeId, condition, next);
}

export function isModelReady(scopeId: string, condition: Assignment, trialIds: string[]) {
  const state = readModelState(scopeId, condition);
  const key = storageKey(scopeId, condition);
  return state.status === 'ready'
    && fingerprint(state.datasetTrialIds) === fingerprint(trialIds)
    && fingerprint(state.trainedTrialIds) === fingerprint(trialIds)
    && engines.has(key);
}

function toTrainingSession(trials: TrainableTrial[], gestures: Gesture[]) {
  return {
    id: `condition-${Date.now()}`,
    createdAt: Date.now(),
    gestures,
    featureSetId: DEFAULT_FEATURE_SET_ID,
    segmentDurationMs: 1200,
    gestureData: gestures.map((gesture) => ({
      gesture,
      targetSampleCount: trials.filter((trial) => trial.gestureId === gesture.id).length,
      samples: trials
        .filter((trial) => trial.gestureId === gesture.id)
        .map((trial) => ({
          id: trial.id,
          gestureId: trial.gestureId,
          gestureName: trial.gestureName,
          timestamp: trial.capturedAt,
          data: trial.points.map((point) => point.value),
          duration: trial.metrics.durationMs,
        })),
    })),
  };
}

export async function trainConditionModel(
  scopeId: string,
  condition: Assignment,
  trials: TrainableTrial[],
  gestures: Gesture[],
): Promise<ConditionModelState> {
  const key = storageKey(scopeId, condition);
  const token = (trainTokens.get(key) ?? 0) + 1;
  trainTokens.set(key, token);
  trainingInFlight.set(key, token);
  const trialIds = trials.map((trial) => trial.id);
  const previous = readModelState(scopeId, condition);
  writeModelState(scopeId, condition, {
    ...previous,
    condition,
    datasetTrialIds: trialIds,
    status: 'training',
    error: '',
  });

  try {
    await new Promise((resolve) => {
      window.setTimeout(resolve, 250);
    });
    if (trainTokens.get(key) !== token) return readModelState(scopeId, condition);

    const engine = createPredictionEngine(toTrainingSession(trials, gestures));
    if (trainTokens.get(key) !== token) return readModelState(scopeId, condition);
    if (!engine.getModelDebugSummary().isReady) {
      engines.delete(key);
      return writeModelState(scopeId, condition, {
        condition,
        datasetTrialIds: trialIds,
        trainedTrialIds: [],
        status: 'error',
        error: 'The model needs kept examples from at least two gestures.',
        trainedAt: null,
      });
    }
    engines.set(key, engine);
    return writeModelState(scopeId, condition, {
      condition,
      datasetTrialIds: trialIds,
      trainedTrialIds: trialIds,
      status: 'ready',
      error: '',
      trainedAt: Date.now(),
    });
  } catch (error) {
    if (trainTokens.get(key) !== token) return readModelState(scopeId, condition);
    engines.delete(key);
    return writeModelState(scopeId, condition, {
      condition,
      datasetTrialIds: trialIds,
      trainedTrialIds: [],
      status: 'error',
      error: error instanceof Error ? error.message : 'The model could not be trained.',
      trainedAt: null,
    });
  } finally {
    if (trainingInFlight.get(key) === token) trainingInFlight.delete(key);
  }
}
