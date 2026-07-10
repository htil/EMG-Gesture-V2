// Defines the data types for the pipeline

export interface Gesture {
  id: string;
  name: string;
}

export interface EmgSample {
  id: string;
  gestureId: string;
  gestureName: string;
  timestamp: number;
  data: number[];
  duration: number;
  quality?: 'good' | 'weak' | 'noisy';
}

export interface TrainingGestureData {
  gesture: Gesture;
  samples: EmgSample[];
  targetSampleCount: number;
}

export interface TrainingSessionData {
  id: string;
  createdAt: number;
  gestures: Gesture[];
  gestureData: TrainingGestureData[];
  segmentDurationMs: number;
}

export type PredictionMatchStatus = 'match' | 'mismatch';
export type PredictionConfidenceStatus = 'high' | 'low';

export interface PredictionRecord {
  id: number;
  index: number;
  timestamp: string;
  expectedGestureId: string;
  expectedGestureName: string;
  predictedGestureId: string;
  predictedGestureName: string;
  confidence: number;
  matchStatus: PredictionMatchStatus;
  confidenceStatus: PredictionConfidenceStatus;
  emgSample?: EmgSample;
}

export interface TestingSessionData {
  id: string;
  startedAt: number;
  completedAt: number;
  trainingSessionId: string;
  gestures: Gesture[];
  predictions: PredictionRecord[];
  overallConfidence: number;
  sessionDurationSeconds: number;
}

export interface GestureResultStats {
  gesture: Gesture;
  predictionCount: number;
  averageConfidence: number;
}

export interface ResultStats {
  totalPredictions: number;
  overallConfidence: number;
  mostPredictedGesture: string;
  lowConfidenceCount: number;
  gestureStats: GestureResultStats[];
  predictionCountsByGesture: { gesture: string; gestureId: string; count: number }[];
  lastTenPredictions: PredictionRecord[];
  sessionLabel: string;
}
