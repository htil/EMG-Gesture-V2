import type { EmgSample } from './types';

const MOCK_SAMPLE_INTERVAL_MS = 50;

type MockSignalState = 'idle' | 'active' | 'weak' | 'noisy' | 'short';

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

function clampMockValue(value: number) {
  return Math.max(0, Math.min(1, value));
}

function defaultPointCount(durationMs: number) {
  return Math.max(8, Math.round(durationMs / MOCK_SAMPLE_INTERVAL_MS));
}

export function getChannelMockSignalValue(
  channelIndex: number,
  progress: number,
  state: MockSignalState = 'active',
) {
  const phase = progress * Math.PI * 8;
  const baseNoise = (Math.random() - 0.5) * 0.1;
  const channelProfile = (() => {
    switch (channelIndex) {
      case 0:
        return {
          oscillation: Math.sin(phase * 0.45) * 0.05,
          noiseScale: 0.12,
          activityLift: 0,
        };
      case 1:
        return {
          oscillation: (2 / Math.PI) * Math.asin(Math.sin(phase * 1.25)) * 0.12,
          noiseScale: 0.18,
          activityLift: progress > 0.45 && progress < 0.7 ? 0.08 : 0,
        };
      case 2:
        return {
          oscillation: channelSignalValue(2, phase * 1.6) * 0.16,
          noiseScale: 0.24,
          activityLift: 0,
        };
      case 3:
        return {
          oscillation:
            Math.sin(phase * 0.75) * 0.08 +
            Math.sin(phase * 2.2) * 0.06 +
            (progress > 0.22 && progress < 0.34 ? 0.15 : 0) +
            (progress > 0.62 && progress < 0.78 ? 0.12 : 0),
          noiseScale: 0.35,
          activityLift: progress > 0.6 && progress < 0.8 ? 0.12 : 0,
        };
      default:
        return {
          oscillation: Math.sin(phase) * 0.06,
          noiseScale: 0.16,
          activityLift: 0,
        };
    }
  })();

  switch (state) {
    case 'active':
      return clampMockValue(
        0.64 + channelProfile.activityLift + channelProfile.oscillation + baseNoise * channelProfile.noiseScale,
      );
    case 'weak':
      return clampMockValue(
        0.3 +
          channelProfile.activityLift * 0.4 +
          channelProfile.oscillation * 0.65 +
          baseNoise * channelProfile.noiseScale * 1.2,
      );
    case 'noisy':
      return clampMockValue(
        0.56 +
          channelProfile.activityLift * 0.7 +
          channelProfile.oscillation * 0.8 +
          (Math.random() - 0.5) * (0.18 + channelProfile.noiseScale * 0.6),
      );
    case 'short':
      return clampMockValue(
        0.76 +
          channelProfile.activityLift * 0.5 +
          channelProfile.oscillation * 0.45 +
          baseNoise * channelProfile.noiseScale * 0.7,
      );
    case 'idle':
    default:
      return clampMockValue(
        0.12 + channelProfile.oscillation * 0.2 + baseNoise * channelProfile.noiseScale * 1.4,
      );
  }
}

export function generateMockEmgSample(
  gestureId: string,
  gestureName: string,
  durationMs: number,
  pointCount = defaultPointCount(durationMs),
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
  pointCount = defaultPointCount(durationMs),
): EmgSample {
  const startTime = Date.now();
  const data: number[] = [];

  for (let index = 0; index < pointCount; index += 1) {
    const progress = index / Math.max(pointCount - 1, 1);
    const value = getChannelMockSignalValue(channelIndex, progress, 'active');
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
  pointCount = defaultPointCount(durationMs),
): EmgSample {
  const startTime = Date.now();
  const data: number[] = [];

  for (let index = 0; index < pointCount; index += 1) {
    const burst = Math.random() > 0.6 ? Math.random() * 0.45 : 0;
    const drift = Math.sin(index * 0.65) * 0.08;
    const value = Math.max(0, Math.min(1, 0.16 + drift + (Math.random() - 0.5) * 0.55 + burst));
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
