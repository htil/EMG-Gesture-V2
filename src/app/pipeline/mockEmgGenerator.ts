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

function channelSignalValue(channelIndex: number, phase: number) {
  switch (channelIndex) {
    case 1:
      return Math.sin(phase * 0.7) * 0.65 + Math.sin(phase * 1.6) * 0.35;
    case 2:
      return (2 / Math.PI) * Math.asin(Math.sin(phase * 1.15));
    case 3:
      return 2 * (((phase * 0.22) % 1)) - 1;
    default:
      return Math.sin(phase);
  }
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

export function generateChannelMockEmgSample(
  channelIndex: number,
  durationMs: number,
  pointCount = 40,
): EmgSample {
  const startTime = Date.now();
  const data: number[] = [];

  for (let index = 0; index < pointCount; index += 1) {
    const progress = index / Math.max(pointCount - 1, 1);
    const phase = progress * Math.PI * 6;
    const envelope = 0.14 + Math.sin(progress * Math.PI) * 0.68;
    const oscillation = channelSignalValue(channelIndex, phase);
    const noise = (Math.random() - 0.5) * 0.03;
    const value = Math.max(
      0,
      Math.min(1, envelope + oscillation * 0.12 + noise),
    );
    data.push(Number(value.toFixed(4)));
  }

  return {
    id: `probe-channel-${channelIndex + 1}-${startTime}`,
    gestureId: `probe-channel-${channelIndex + 1}`,
    gestureName: `Probe Channel ${channelIndex + 1}`,
    timestamp: startTime,
    data,
    duration: durationMs,
    quality: 'good',
  };
}

export function generateNoiseMockEmgSample(
  durationMs: number,
  pointCount = 40,
): EmgSample {
  const startTime = Date.now();
  const data: number[] = [];

  for (let index = 0; index < pointCount; index += 1) {
    const burst = Math.random() > 0.7 ? Math.random() * 0.35 : 0;
    const value = Math.max(0, Math.min(1, 0.18 + (Math.random() - 0.5) * 0.45 + burst));
    data.push(Number(value.toFixed(4)));
  }

  return {
    id: `probe-noise-${startTime}`,
    gestureId: 'probe-noise',
    gestureName: 'Probe Noise',
    timestamp: startTime,
    data,
    duration: durationMs,
    quality: 'noisy',
  };
}
