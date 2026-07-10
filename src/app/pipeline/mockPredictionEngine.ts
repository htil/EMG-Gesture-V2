// Mock prediction engine for testing

import { getConfidenceStatus, getMatchStatus } from './confidence';
import { formatPredictionTimestamp } from './formatTimestamp';
import { generateMockEmgSample } from './mockEmgGenerator';
import type { EmgSample, Gesture, PredictionRecord, TrainingSessionData } from './types';

export interface MockPredictionResult {
  record: Omit<PredictionRecord, 'id' | 'index' | 'timestamp'>;
  emgSample: EmgSample;
}

function averageTrainingQuality(trainingSession: TrainingSessionData, gestureId: string): number {
  const gestureTraining = trainingSession.gestureData.find(
    (entry) => entry.gesture.id === gestureId,
  );
  if (!gestureTraining || gestureTraining.samples.length === 0) {
    return 0.5;
  }

  const qualityScore = gestureTraining.samples.reduce((sum, sample) => {
    if (sample.quality === 'good') return sum + 1;
    if (sample.quality === 'weak') return sum + 0.75;
    if (sample.quality === 'noisy') return sum + 0.6;
    return sum + 0.85;
  }, 0);

  const coverage = Math.min(1, gestureTraining.samples.length / gestureTraining.targetSampleCount);
  return (qualityScore / gestureTraining.samples.length) * 0.7 + coverage * 0.3;
}

function pickMismatchGesture(gestures: Gesture[], expectedGestureId: string): Gesture {
  const alternatives = gestures.filter((gesture) => gesture.id !== expectedGestureId);
  return alternatives[Math.floor(Math.random() * alternatives.length)] ?? gestures[0];
}

function buildConfidence(
  trainingSession: TrainingSessionData,
  expectedGestureId: string,
  predictedGestureId: string,
): number {
  const expectedQuality = averageTrainingQuality(trainingSession, expectedGestureId);
  const predictedQuality = averageTrainingQuality(trainingSession, predictedGestureId);
  const isMatch = expectedGestureId === predictedGestureId;

  const base = isMatch ? 88 + expectedQuality * 10 : 68 + predictedQuality * 8;
  const jitter = Math.random() * 8 - 4;
  return Number(Math.max(62, Math.min(99, base + jitter)).toFixed(1));
}

export function createMockPredictionEngine(trainingSession: TrainingSessionData) {
  return {
    predict(expectedGesture: Gesture, _predictionIndex: number): MockPredictionResult {
      const emgSample = generateMockEmgSample(
        expectedGesture.id,
        expectedGesture.name,
        trainingSession.segmentDurationMs,
      );

      const matchProbability = 0.72 + averageTrainingQuality(trainingSession, expectedGesture.id) * 0.2;
      const shouldMatch = Math.random() < matchProbability;
      const predictedGesture = shouldMatch
        ? expectedGesture
        : pickMismatchGesture(trainingSession.gestures, expectedGesture.id);

      const confidence = buildConfidence(
        trainingSession,
        expectedGesture.id,
        predictedGesture.id,
      );

      const matchStatus = getMatchStatus(expectedGesture.id, predictedGesture.id);
      const confidenceStatus = getConfidenceStatus(confidence);

      return {
        emgSample,
        record: {
          expectedGestureId: expectedGesture.id,
          expectedGestureName: expectedGesture.name,
          predictedGestureId: predictedGesture.id,
          predictedGestureName: predictedGesture.name,
          confidence,
          matchStatus,
          confidenceStatus,
          emgSample,
        },
      };
    },
  };
}

export function createPredictionRecord(
  result: MockPredictionResult,
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
