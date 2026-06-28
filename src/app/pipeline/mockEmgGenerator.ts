import type { EmgSample } from './types';

function hashGestureId(gestureId: string): number {
  let hash = 0;
  for (let i = 0; i < gestureId.length; i += 1) {
    hash = (hash * 31 + gestureId.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function gestureSignalProfile(gestureId: string) {
  const hash = hashGestureId(gestureId);
  return {
    baseAmplitude: 0.45 + (hash % 30) / 100,
    frequency: 0.008 + (hash % 12) / 1000,
    noise: 0.04 + (hash % 8) / 100,
    phase: (hash % 360) * (Math.PI / 180),
  };
}

export function generateMockEmgSample(
  gestureId: string,
  gestureName: string,
  durationMs: number,
  pointCount = 40,
): EmgSample {
  const profile = gestureSignalProfile(gestureId);
  const startTime = Date.now();
  const data: number[] = [];

  for (let index = 0; index < pointCount; index += 1) {
    const progress = index / Math.max(pointCount - 1, 1);
    const envelope = Math.sin(progress * Math.PI);
    const oscillation = Math.sin(progress * Math.PI * 6 + profile.phase);
    const noise = (Math.random() - 0.5) * profile.noise;
    const value = Math.max(
      0,
      Math.min(1, profile.baseAmplitude * envelope + oscillation * 0.08 + noise),
    );
    data.push(Number(value.toFixed(4)));
  }

  return {
    id: `${gestureId}-${startTime}`,
    gestureId,
    gestureName,
    timestamp: startTime,
    data,
    duration: durationMs,
    quality: 'good',
  };
}
