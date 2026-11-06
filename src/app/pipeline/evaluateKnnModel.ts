import { createPredictionEngine } from './knnModel';
import type {
  EmgSample,
  ModelEvaluationConfusionEntry,
  ModelEvaluationGestureStats,
  ModelEvaluationSummary,
  TrainingSessionData,
} from './types';

const UNKNOWN_GESTURE_ID = 'unknown';
const UNKNOWN_GESTURE_NAME = 'Unknown';

function round(value: number, digits: number = 1) {
  return Number(value.toFixed(digits));
}

function buildTrainingSessionWithoutSample(
  trainingSession: TrainingSessionData,
  heldOutGestureId: string,
  heldOutSample: EmgSample,
): TrainingSessionData {
  return {
    ...trainingSession,
    gestureData: trainingSession.gestureData.map((entry) => ({
      ...entry,
      samples: entry.gesture.id === heldOutGestureId
        ? entry.samples.filter((sample) => sample !== heldOutSample)
        : entry.samples,
    })),
  };
}

export function evaluateKnnModel(trainingSession: TrainingSessionData): ModelEvaluationSummary {
  const confusionCounts = new Map<string, number>();
  const gestureStatsMap = new Map<string, {
    gestureId: string;
    gestureName: string;
    totalSamples: number;
    evaluatedSamples: number;
    correctPredictions: number;
    unknownPredictions: number;
    confidenceTotal: number;
  }>();

  let totalSamples = 0;
  let evaluatedSamples = 0;
  let skippedSamples = 0;
  let correctPredictions = 0;
  let unknownPredictions = 0;
  let confidenceTotal = 0;

  trainingSession.gestureData.forEach((entry) => {
    gestureStatsMap.set(entry.gesture.id, {
      gestureId: entry.gesture.id,
      gestureName: entry.gesture.name,
      totalSamples: entry.samples.length,
      evaluatedSamples: 0,
      correctPredictions: 0,
      unknownPredictions: 0,
      confidenceTotal: 0,
    });

    entry.samples.forEach((sample) => {
      totalSamples += 1;

      const reducedTrainingSession = buildTrainingSessionWithoutSample(
        trainingSession,
        entry.gesture.id,
        sample,
      );
      const predictionEngine = createPredictionEngine(reducedTrainingSession);
      const modelDebugSummary = predictionEngine.getModelDebugSummary();

      if (!modelDebugSummary.isReady) {
        skippedSamples += 1;
        return;
      }

      const result = predictionEngine.predict(sample);
      const predictedGestureId = result.predictedGestureId;
      const predictedGestureName = result.predictedGestureName;
      const isCorrect = predictedGestureId === entry.gesture.id;
      const isUnknown = predictedGestureId === UNKNOWN_GESTURE_ID;

      evaluatedSamples += 1;
      confidenceTotal += result.confidence;

      const gestureStats = gestureStatsMap.get(entry.gesture.id);
      if (gestureStats) {
        gestureStats.evaluatedSamples += 1;
        gestureStats.confidenceTotal += result.confidence;
        if (isCorrect) {
          gestureStats.correctPredictions += 1;
        }
        if (isUnknown) {
          gestureStats.unknownPredictions += 1;
        }
      }

      if (isCorrect) {
        correctPredictions += 1;
      }

      if (isUnknown) {
        unknownPredictions += 1;
      }

      const confusionKey = [
        entry.gesture.id,
        entry.gesture.name,
        predictedGestureId,
        predictedGestureName,
      ].join('::');
      confusionCounts.set(confusionKey, (confusionCounts.get(confusionKey) ?? 0) + 1);
    });
  });

  const incorrectPredictions = Math.max(0, evaluatedSamples - correctPredictions);
  const gestureStats: ModelEvaluationGestureStats[] = [...gestureStatsMap.values()]
    .map((stats) => ({
      gestureId: stats.gestureId,
      gestureName: stats.gestureName,
      totalSamples: stats.totalSamples,
      evaluatedSamples: stats.evaluatedSamples,
      correctPredictions: stats.correctPredictions,
      unknownPredictions: stats.unknownPredictions,
      accuracy: stats.evaluatedSamples > 0
        ? round((stats.correctPredictions / stats.evaluatedSamples) * 100)
        : 0,
      unknownRate: stats.evaluatedSamples > 0
        ? round((stats.unknownPredictions / stats.evaluatedSamples) * 100)
        : 0,
      averageConfidence: stats.evaluatedSamples > 0
        ? round(stats.confidenceTotal / stats.evaluatedSamples)
        : 0,
    }))
    .sort((left, right) => left.gestureName.localeCompare(right.gestureName));

  const confusionMatrix: ModelEvaluationConfusionEntry[] = [...confusionCounts.entries()]
    .map(([key, count]) => {
      const [expectedGestureId, expectedGestureName, predictedGestureId, predictedGestureName] = key.split('::');
      return {
        expectedGestureId,
        expectedGestureName,
        predictedGestureId: predictedGestureId ?? UNKNOWN_GESTURE_ID,
        predictedGestureName: predictedGestureName ?? UNKNOWN_GESTURE_NAME,
        count,
      };
    })
    .sort((left, right) => {
      if (left.expectedGestureName === right.expectedGestureName) {
        return left.predictedGestureName.localeCompare(right.predictedGestureName);
      }
      return left.expectedGestureName.localeCompare(right.expectedGestureName);
    });

  return {
    method: 'leave-one-out',
    featureSetId: trainingSession.featureSetId,
    totalSamples,
    evaluatedSamples,
    skippedSamples,
    correctPredictions,
    incorrectPredictions,
    unknownPredictions,
    accuracy: evaluatedSamples > 0 ? round((correctPredictions / evaluatedSamples) * 100) : 0,
    unknownRate: evaluatedSamples > 0 ? round((unknownPredictions / evaluatedSamples) * 100) : 0,
    averageConfidence: evaluatedSamples > 0 ? round(confidenceTotal / evaluatedSamples) : 0,
    gestureStats,
    confusionMatrix,
  };
}
