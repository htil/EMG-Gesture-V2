import type {
  ClassSupportDebug,
  EmgFeatures,
  FeatureStats,
  Gesture,
  ModelClassDebugSummary,
  PredictionConfidenceStatus,
  PredictionDebug,
  TrainingSessionData,
} from './types';
import { getConfidenceStatus, getMatchStatus } from './confidence';
import { extractEmgFeatures } from './featureExtraction';
import { formatPredictionTimestamp } from './formatTimestamp';
import type { EmgSample, PredictionRecord } from './types';

export type FeatureVector = number[];

interface NormalizationStats {
  means: FeatureVector;
  stdDevs: FeatureVector;
}

interface KnnTrainingSample {
  label: string;
  vector: FeatureVector;
  sourceSample: EmgSample;
}

interface BuiltKnnModel {
  gestures: Gesture[];
  trainingSamples: KnnTrainingSample[];
  normalization: NormalizationStats;
  featureKeys: string[];
  classDebugSummary: ModelClassDebugSummary[];
  isReady: boolean;
}

export interface PredictionEngineResult {
  predictedGestureId: string;
  predictedGestureName: string;
  confidence: number;
  confidenceStatus: PredictionConfidenceStatus;
  emgSample: EmgSample;
  debug?: PredictionDebug;
}

const KNN_K = 3;
const MIN_LABELS = 2;
const FEATURE_KEYS: Array<keyof EmgFeatures> = [
  'rms',
  'mav',
  'std',
  'peak',
  'waveformLength',
  'zeroCrossings',
  'slopeSignChanges',
  'willisonAmplitude',
  'hjorthMobility',
  'hjorthComplexity',
];
const MIN_SUPPORT_THRESHOLD = 0.56;
const MIN_SUPPORT_MARGIN = 0.1;
const MAX_NEAREST_DISTANCE = 5.2;

function featureVectorFromEmgFeatures(features: EmgFeatures): FeatureVector {
  return FEATURE_KEYS.map((key) => features[key]);
}

function computeNormalizationStats(vectors: FeatureVector[]): NormalizationStats {
  const means = vectors[0].map((_, index) => (
    vectors.reduce((sum, vector) => sum + vector[index], 0) / Math.max(vectors.length, 1)
  ));

  const stdDevs = vectors[0].map((_, index) => {
    const variance = vectors.reduce((sum, vector) => {
      const delta = vector[index] - means[index];
      return sum + delta * delta;
    }, 0) / Math.max(vectors.length, 1);

    return Math.max(Math.sqrt(variance), 1e-6);
  });

  return { means, stdDevs };
}

function normalizeVector(vector: FeatureVector, normalization: NormalizationStats): FeatureVector {
  return vector.map((value, index) => (
    (value - normalization.means[index]) / normalization.stdDevs[index]
  ));
}

function euclideanDistance(left: FeatureVector, right: FeatureVector) {
  return Math.sqrt(
    left.reduce((sum, value, index) => sum + (value - right[index]) ** 2, 0)
  );
}

function computeFeatureStats(values: number[]): FeatureStats {
  if (values.length === 0) {
    return { min: 0, mean: 0, max: 0 };
  }

  return {
    min: Number(Math.min(...values).toFixed(4)),
    mean: Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(4)),
    max: Number(Math.max(...values).toFixed(4)),
  };
}

function buildClassDebugSummary(trainingSession: TrainingSessionData): ModelClassDebugSummary[] {
  return trainingSession.gestureData.map((entry) => {
    const features = entry.samples.map((sample) => sample.features ?? extractEmgFeatures(sample.data));
    const featureStats = Object.fromEntries(
      FEATURE_KEYS.map((key) => [
        key,
        computeFeatureStats(features.map((feature) => feature[key])),
      ]),
    ) as Record<string, FeatureStats>;

    return {
      gestureId: entry.gesture.id,
      gestureName: entry.gesture.name,
      sampleCount: entry.samples.length,
      featureStats,
    };
  });
}

function buildKnnModel(trainingSession: TrainingSessionData): BuiltKnnModel {
  const collectedSamples = trainingSession.gestureData.flatMap((entry) => entry.samples);
  const labelsWithSamples = new Set(collectedSamples.map((sample) => sample.gestureId));
  const classDebugSummary = buildClassDebugSummary(trainingSession);

  if (collectedSamples.length === 0 || labelsWithSamples.size < MIN_LABELS) {
    return {
      gestures: trainingSession.gestures,
      trainingSamples: [],
      normalization: {
        means: Array(FEATURE_KEYS.length).fill(0),
        stdDevs: Array(FEATURE_KEYS.length).fill(1),
      },
      featureKeys: FEATURE_KEYS,
      classDebugSummary,
      isReady: false,
    };
  }

  const featureVectors = collectedSamples.map((sample) => (
    featureVectorFromEmgFeatures(sample.features ?? extractEmgFeatures(sample.data))
  ));
  const normalization = computeNormalizationStats(featureVectors);
  const trainingSamples = collectedSamples.map((sample, index) => ({
    label: sample.gestureId,
    vector: normalizeVector(featureVectors[index], normalization),
    sourceSample: sample,
  }));

  return {
    gestures: trainingSession.gestures,
    trainingSamples,
    normalization,
    featureKeys: FEATURE_KEYS,
    classDebugSummary,
    isReady: true,
  };
}

function predictKnn(model: BuiltKnnModel, values: number[]) {
  if (!model.isReady || model.trainingSamples.length === 0) {
    return null;
  }

  const liveFeatures = extractEmgFeatures(values);
  const liveVector = normalizeVector(
    featureVectorFromEmgFeatures(liveFeatures),
    model.normalization,
  );

  const nearestNeighbors = [...model.trainingSamples]
    .map((sample) => ({
      ...sample,
      distance: euclideanDistance(sample.vector, liveVector),
    }))
    .sort((left, right) => left.distance - right.distance)
    .slice(0, Math.max(1, Math.min(KNN_K, model.trainingSamples.length)));

  const weightedVotes = new Map<string, number>();
  nearestNeighbors.forEach((sample) => {
    const weight = 1 / Math.max(sample.distance, 1e-6);
    weightedVotes.set(sample.label, (weightedVotes.get(sample.label) ?? 0) + weight);
  });

  const sortedVotes = [...weightedVotes.entries()].sort((left, right) => right[1] - left[1]);
  const [winningGestureId, winningVotes] = sortedVotes[0] ?? [];
  if (!winningGestureId || !winningVotes) {
    return null;
  }

  const totalVotes = sortedVotes.reduce((sum, [, value]) => sum + value, 0);
  const winningSupport = winningVotes / Math.max(totalVotes, 1);
  const runnerUpVotes = sortedVotes[1]?.[1] ?? 0;
  const supportMargin = winningSupport - runnerUpVotes / Math.max(totalVotes, 1);
  const nearestDistance = nearestNeighbors[0]?.distance ?? Number.POSITIVE_INFINITY;
  const isUnknown =
    winningSupport < MIN_SUPPORT_THRESHOLD ||
    supportMargin < MIN_SUPPORT_MARGIN ||
    nearestDistance > MAX_NEAREST_DISTANCE;
  const predictedGesture = isUnknown
    ? null
    : model.gestures.find((gesture) => gesture.id === winningGestureId) ?? model.gestures[0];
  const confidenceBase =
    winningSupport * 0.6 +
    Math.max(0, supportMargin) * 0.3 +
    Math.max(0, 1 - nearestDistance / MAX_NEAREST_DISTANCE) * 0.1;
  const confidence = Number(Math.max(0, Math.min(99, confidenceBase * 100)).toFixed(1));
  const classSupports: ClassSupportDebug[] = sortedVotes.map(([gestureId, votes]) => ({
    gestureId,
    gestureName: model.gestures.find((gesture) => gesture.id === gestureId)?.name ?? gestureId,
    support: Number(((votes / Math.max(totalVotes, 1)) * 100).toFixed(1)),
  }));
  const neighborWeightTotal = nearestNeighbors.reduce((sum, sample) => sum + 1 / Math.max(sample.distance, 1e-6), 0);
  const debug: PredictionDebug = {
    features: liveFeatures,
    normalizedVector: liveVector.map((value) => Number(value.toFixed(4))),
    nearestNeighbors: nearestNeighbors.map((sample) => {
      const weight = 1 / Math.max(sample.distance, 1e-6);
      return {
        gestureId: sample.label,
        gestureName: model.gestures.find((gesture) => gesture.id === sample.label)?.name ?? sample.label,
        distance: Number(sample.distance.toFixed(4)),
        support: Number(((weight / Math.max(neighborWeightTotal, 1e-6)) * 100).toFixed(1)),
      };
    }),
    classSupports,
    supportMargin: Number((supportMargin * 100).toFixed(1)),
    nearestDistance: Number(nearestDistance.toFixed(4)),
    status: isUnknown ? 'unknown' : 'accepted',
  };

  return {
    gesture: predictedGesture,
    confidence,
    debug,
  };
}

function fallbackPrediction(trainingSession: TrainingSessionData, emgSample: EmgSample): PredictionEngineResult {
  const gestureWithMostSamples = [...trainingSession.gestureData].sort(
    (left, right) => right.samples.length - left.samples.length,
  )[0]?.gesture ?? trainingSession.gestures[0];
  const predictedGesture = gestureWithMostSamples;
  const confidence = 55;

  return {
    predictedGestureId: predictedGesture.id,
    predictedGestureName: predictedGesture.name,
    confidence,
    confidenceStatus: getConfidenceStatus(confidence) as PredictionConfidenceStatus,
    emgSample,
    debug: {
      features: emgSample.features ?? extractEmgFeatures(emgSample.data),
      normalizedVector: [],
      nearestNeighbors: [],
      classSupports: [],
      supportMargin: 0,
      nearestDistance: Number.POSITIVE_INFINITY,
      status: 'unknown',
    },
  };
}

export function createPredictionEngine(trainingSession: TrainingSessionData) {
  const model = buildKnnModel(trainingSession);

  return {
    getModelDebugSummary() {
      return {
        featureKeys: model.featureKeys,
        classDebugSummary: model.classDebugSummary,
        isReady: model.isReady,
        trainingSampleCount: model.trainingSamples.length,
      };
    },
    predict(emgSample: EmgSample): PredictionEngineResult {
      const prediction = predictKnn(model, emgSample.data);

      if (!prediction) {
        return fallbackPrediction(trainingSession, emgSample);
      }

      const { gesture, confidence, debug } = prediction;
      if (!gesture) {
        return {
          emgSample,
          predictedGestureId: 'unknown',
          predictedGestureName: 'Unknown',
          confidence,
          confidenceStatus: getConfidenceStatus(confidence) as PredictionConfidenceStatus,
          debug,
        };
      }

      return {
        emgSample,
        predictedGestureId: gesture.id,
        predictedGestureName: gesture.name,
        confidence,
        confidenceStatus: getConfidenceStatus(confidence) as PredictionConfidenceStatus,
        debug,
      };
    },
  };
}

export function createPredictionRecord(
  result: PredictionEngineResult,
  expectedGesture: Gesture,
  id: number,
  index: number,
): PredictionRecord {
  return {
    id,
    index,
    timestamp: formatPredictionTimestamp(new Date()),
    expectedGestureId: expectedGesture.id,
    expectedGestureName: expectedGesture.name,
    predictedGestureId: result.predictedGestureId,
    predictedGestureName: result.predictedGestureName,
    confidence: result.confidence,
    matchStatus: getMatchStatus(expectedGesture.id, result.predictedGestureId),
    confidenceStatus: result.confidenceStatus,
    emgSample: result.emgSample,
    debug: result.debug,
  };
}

export function calculateOverallConfidence(predictions: PredictionRecord[]): number {
  if (predictions.length === 0) {
    return 0;
  }

  const total = predictions.reduce((sum, prediction) => sum + prediction.confidence, 0);
  return Number((total / predictions.length).toFixed(1));
}
