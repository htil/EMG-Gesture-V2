import type { EmgFeatures, Gesture, PredictionConfidenceStatus, TrainingSessionData } from './types';
import { getConfidenceStatus, getMatchStatus } from './confidence';
import { extractEmgFeatures } from './featureExtraction';
import { formatPredictionTimestamp } from './formatTimestamp';
import type { EmgSample, PredictionRecord } from './types';

export type FeatureVector = [number, number, number, number, number];

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
  isReady: boolean;
}

export interface PredictionEngineResult {
  record: Omit<PredictionRecord, 'id' | 'index' | 'timestamp'>;
  emgSample: EmgSample;
}

const KNN_K = 3;
const MIN_LABELS = 2;

function featureVectorFromEmgFeatures(features: EmgFeatures): FeatureVector {
  return [
    features.rms,
    features.mav,
    features.std,
    features.peak,
    features.waveformLength,
  ];
}

function computeNormalizationStats(vectors: FeatureVector[]): NormalizationStats {
  const means = vectors[0].map((_, index) => (
    vectors.reduce((sum, vector) => sum + vector[index], 0) / Math.max(vectors.length, 1)
  )) as FeatureVector;

  const stdDevs = vectors[0].map((_, index) => {
    const variance = vectors.reduce((sum, vector) => {
      const delta = vector[index] - means[index];
      return sum + delta * delta;
    }, 0) / Math.max(vectors.length, 1);

    return Math.max(Math.sqrt(variance), 1e-6);
  }) as FeatureVector;

  return { means, stdDevs };
}

function normalizeVector(vector: FeatureVector, normalization: NormalizationStats): FeatureVector {
  return vector.map((value, index) => (
    (value - normalization.means[index]) / normalization.stdDevs[index]
  )) as FeatureVector;
}

function euclideanDistance(left: FeatureVector, right: FeatureVector) {
  return Math.sqrt(
    left.reduce((sum, value, index) => sum + (value - right[index]) ** 2, 0)
  );
}

function buildKnnModel(trainingSession: TrainingSessionData): BuiltKnnModel {
  const collectedSamples = trainingSession.gestureData.flatMap((entry) => entry.samples);
  const labelsWithSamples = new Set(collectedSamples.map((sample) => sample.gestureId));

  if (collectedSamples.length === 0 || labelsWithSamples.size < MIN_LABELS) {
    return {
      gestures: trainingSession.gestures,
      trainingSamples: [],
      normalization: {
        means: [0, 0, 0, 0, 0],
        stdDevs: [1, 1, 1, 1, 1],
      },
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
  const confidence = Number(Math.max(0, Math.min(99, (winningVotes / Math.max(totalVotes, 1)) * 100)).toFixed(1));
  const predictedGesture = model.gestures.find((gesture) => gesture.id === winningGestureId) ?? model.gestures[0];

  return {
    gesture: predictedGesture,
    confidence,
  };
}

function fallbackPrediction(
  trainingSession: TrainingSessionData,
  expectedGesture: Gesture,
  emgSample: EmgSample,
) {
  const gestureWithMostSamples = [...trainingSession.gestureData].sort(
    (left, right) => right.samples.length - left.samples.length,
  )[0]?.gesture ?? expectedGesture;
  const predictedGesture = gestureWithMostSamples;
  const confidence = predictedGesture.id === expectedGesture.id ? 75 : 55;

  return {
    record: {
      expectedGestureId: expectedGesture.id,
      expectedGestureName: expectedGesture.name,
      predictedGestureId: predictedGesture.id,
      predictedGestureName: predictedGesture.name,
      confidence,
      matchStatus: getMatchStatus(expectedGesture.id, predictedGesture.id),
      confidenceStatus: getConfidenceStatus(confidence) as PredictionConfidenceStatus,
      emgSample,
    },
    emgSample,
  };
}

export function createPredictionEngine(trainingSession: TrainingSessionData) {
  const model = buildKnnModel(trainingSession);

  return {
    predict(expectedGesture: Gesture, emgSample: EmgSample): PredictionEngineResult {
      const prediction = predictKnn(model, emgSample.data);

      if (!prediction) {
        return fallbackPrediction(trainingSession, expectedGesture, emgSample);
      }

      const { gesture, confidence } = prediction;
      return {
        emgSample,
        record: {
          expectedGestureId: expectedGesture.id,
          expectedGestureName: expectedGesture.name,
          predictedGestureId: gesture.id,
          predictedGestureName: gesture.name,
          confidence,
          matchStatus: getMatchStatus(expectedGesture.id, gesture.id),
          confidenceStatus: getConfidenceStatus(confidence) as PredictionConfidenceStatus,
          emgSample,
        },
      };
    },
  };
}

export function createPredictionRecord(
  result: PredictionEngineResult,
  id: number,
  index: number,
): PredictionRecord {
  return {
    id,
    index,
    timestamp: formatPredictionTimestamp(new Date()),
    ...result.record,
  };
}

export function calculateOverallConfidence(predictions: PredictionRecord[]): number {
  if (predictions.length === 0) {
    return 0;
  }

  const total = predictions.reduce((sum, prediction) => sum + prediction.confidence, 0);
  return Number((total / predictions.length).toFixed(1));
}
