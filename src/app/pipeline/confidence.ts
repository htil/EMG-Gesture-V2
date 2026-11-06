// Buckets confidence scores into high and low and determines if the prediction is a match or mismatch

import type { PredictionConfidenceStatus } from './types';

export const LOW_CONFIDENCE_THRESHOLD = 75;

export function getConfidenceStatus(confidence: number): PredictionConfidenceStatus {
  return confidence >= LOW_CONFIDENCE_THRESHOLD ? 'high' : 'low';
}

export function getMatchStatus(expectedId: string, predictedId: string): 'match' | 'mismatch' {
  return expectedId === predictedId ? 'match' : 'mismatch';
}
