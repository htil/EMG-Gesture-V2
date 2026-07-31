import type { EmgSample } from './types';

export interface InferenceSignalPoint {
  time: number;
  raw: number;
}

export function buildInferenceSample(
  points: InferenceSignalPoint[],
  durationMs: number,
): EmgSample | null {
  if (points.length === 0) {
    return null;
  }

  const firstTime = points[0]?.time ?? Date.now();
  const lastTime = points[points.length - 1]?.time ?? firstTime;
  const timestamp = lastTime;
  const duration = Math.max(durationMs, lastTime - firstTime);

  return {
    id: `inference-${timestamp}`,
    gestureId: 'inference',
    gestureName: 'Inference',
    timestamp,
    data: points.map((point) => point.raw),
    duration,
  };
}
