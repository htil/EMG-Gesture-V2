import type { EmgSample, Gesture, TrainingGestureData, TrainingSessionData } from './types';

export interface CapturedTrainingSample {
  id: number;
  status: 'empty' | 'collected' | 'flagged' | 'rejected';
  timestamp?: number;
  waveformData?: { time: number; value: number }[];
  quality?: 'good' | 'weak' | 'noisy';
}

export interface BuildTrainingSessionInput {
  gestures: Gesture[];
  gestureSamples: Record<string, CapturedTrainingSample[]>;
  sampleTarget: number;
  segmentDurationMs: number;
}

function toEmgSample(
  gesture: Gesture,
  sample: CapturedTrainingSample,
  segmentDurationMs: number,
): EmgSample | null {
  if (!sample.waveformData || sample.waveformData.length === 0) {
    return null;
  }

  const waveformData = sample.waveformData;
  const firstPointTime = waveformData[0]?.time ?? sample.timestamp ?? Date.now();
  const lastPointTime = waveformData[waveformData.length - 1]?.time ?? firstPointTime;
  const timestamp = sample.timestamp ?? firstPointTime;
  const duration =
    waveformData.length > 1
      ? Math.max(0, lastPointTime - firstPointTime)
      : segmentDurationMs;

  return {
    id: `${gesture.id}-${sample.id}-${timestamp}`,
    gestureId: gesture.id,
    gestureName: gesture.name,
    timestamp,
    data: waveformData.map((point) => point.value),
    duration,
    quality: sample.quality,
  };
}

export function buildTrainingSession(input: BuildTrainingSessionInput): TrainingSessionData {
  const gestureData: TrainingGestureData[] = input.gestures.map((gesture) => {
    const capturedSamples = input.gestureSamples[gesture.id] ?? [];
    const samples = capturedSamples
      .filter((sample) => sample.status !== 'empty')
      .map((sample) => toEmgSample(gesture, sample, input.segmentDurationMs))
      .filter((sample): sample is EmgSample => sample !== null);

    return {
      gesture,
      samples,
      targetSampleCount: input.sampleTarget,
    };
  });

  return {
    id: `training-${Date.now()}`,
    createdAt: Date.now(),
    gestures: input.gestures,
    gestureData,
    segmentDurationMs: input.segmentDurationMs,
  };
}
