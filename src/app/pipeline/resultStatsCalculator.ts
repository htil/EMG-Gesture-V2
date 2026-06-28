import { formatSessionLabel } from './formatTimestamp';
import type { Gesture, PredictionRecord, ResultStats, TestingSessionData } from './types';

function buildGestureStats(
  gestures: Gesture[],
  predictions: PredictionRecord[],
): ResultStats['gestureStats'] {
  return gestures.map((gesture) => {
    const gesturePredictions = predictions.filter(
      (prediction) => prediction.predictedGestureId === gesture.id,
    );
    const predictionCount = gesturePredictions.length;
    const averageConfidence =
      predictionCount === 0
        ? 0
        : Number(
            (
              gesturePredictions.reduce((sum, prediction) => sum + prediction.confidence, 0) /
              predictionCount
            ).toFixed(1),
          );

    return {
      gesture,
      predictionCount,
      averageConfidence,
    };
  });
}

export function calculateResultStats(session: TestingSessionData): ResultStats {
  const predictions = session.predictions;
  const gestureStats = buildGestureStats(session.gestures, predictions);
  const mostPredicted = [...gestureStats].sort(
    (left, right) => right.predictionCount - left.predictionCount,
  )[0];

  return {
    totalPredictions: predictions.length,
    overallConfidence: session.overallConfidence,
    mostPredictedGesture: mostPredicted?.gesture.name ?? '—',
    lowConfidenceCount: predictions.filter((prediction) => prediction.confidenceStatus === 'low')
      .length,
    gestureStats,
    predictionCountsByGesture: gestureStats.map((entry) => ({
      gesture: entry.gesture.name,
      gestureId: entry.gesture.id,
      count: entry.predictionCount,
    })),
    lastTenPredictions: [...predictions].slice(-10).reverse(),
    sessionLabel: formatSessionLabel(session.completedAt || session.startedAt),
  };
}
