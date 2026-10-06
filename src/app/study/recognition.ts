import type { Gesture } from '../pipeline';
import type { GestureTestOutcome, StoredGameRun } from './gameHandoff';

export interface GestureBreakdown {
  gestureId: string;
  gestureName: string;
  correct: number;
  wrong: number;
  unknown: number;
}

export interface RecognitionSummary {
  correct: number;
  scoredCount: number;
  accuracyPercent: number | null;
  recordingFailures: number;
  breakdown: GestureBreakdown[];
}

export function summarizeRecognition(outcomes: GestureTestOutcome[], gestures: Gesture[]): RecognitionSummary {
  const recordingFailures = outcomes.filter((outcome) => outcome.result === 'recording_failure').length;
  const scored = outcomes.filter((outcome) => outcome.result !== 'recording_failure');
  const correct = scored.filter((outcome) => outcome.result === 'correct').length;
  return {
    correct,
    scoredCount: scored.length,
    accuracyPercent: scored.length === 0 ? null : Math.round((correct / scored.length) * 100),
    recordingFailures,
    breakdown: gestures.map((gesture) => {
      const attempts = scored.filter((outcome) => outcome.expectedGestureId === gesture.id);
      return {
        gestureId: gesture.id,
        gestureName: gesture.name,
        correct: attempts.filter((outcome) => outcome.result === 'correct').length,
        wrong: attempts.filter((outcome) => outcome.result === 'wrong').length,
        unknown: attempts.filter((outcome) => outcome.result === 'unknown').length,
      };
    }),
  };
}

export function previousComparableRun(runs: StoredGameRun[], current: StoredGameRun) {
  return runs
    .filter((run) => (
      run.id !== current.id
      && run.condition === current.condition
      && run.difficulty === current.difficulty
      && run.recordedAt < current.recordedAt
    ))
    .sort((left, right) => right.recordedAt - left.recordedAt)[0] ?? null;
}

export function formatScoreChange(current: number, previous: number | null) {
  if (previous === null) return null;
  const delta = current - previous;
  const sign = delta > 0 ? '+' : '';
  return `${sign}${delta}`;
}
