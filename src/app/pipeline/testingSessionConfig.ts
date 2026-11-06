// Configuration and scheduling helpers for the testing session.

import type { Gesture } from './types';

export interface TestingSessionSettings {
  trialPeriodMs: number;
  restPeriodMs: number;
  numberOfTrials: number;
  predictionFrequencyMs: number;
}

export const DEFAULT_TESTING_SESSION_SETTINGS: TestingSessionSettings = {
  trialPeriodMs: 3000,
  restPeriodMs: 1000,
  numberOfTrials: 15,
  predictionFrequencyMs: 150,
};

export interface NumericSettingBounds {
  min: number;
  max: number;
  step: number;
}

export const TESTING_SESSION_LIMITS: Record<keyof TestingSessionSettings, NumericSettingBounds> = {
  trialPeriodMs: { min: 500, max: 10000, step: 100 },
  restPeriodMs: { min: 0, max: 10000, step: 100 },
  numberOfTrials: { min: 1, max: 100, step: 1 },
  predictionFrequencyMs: { min: 50, max: 2000, step: 50 },
};

export function clampSetting(value: number, key: keyof TestingSessionSettings): number {
  const bounds = TESTING_SESSION_LIMITS[key];
  const clamped = Math.max(bounds.min, Math.min(bounds.max, value));
  return key === 'numberOfTrials' ? Math.round(clamped) : clamped;
}

export type TrialPhase = 'trial' | 'rest';

export interface TrialSegment {
  trialIndex: number;
  gestureId: string;
  phase: TrialPhase;
  startMs: number;
  endMs: number;
  durationMs: number;
}

// Distributes the requested number of trials evenly across the available gestures
// using a round-robin order (e.g. 15 trials over 3 gestures => each shown 5 times).
export function buildTrialSchedule(gestures: Gesture[], numberOfTrials: number): string[] {
  if (gestures.length === 0 || numberOfTrials <= 0) {
    return [];
  }

  return Array.from(
    { length: numberOfTrials },
    (_, index) => gestures[index % gestures.length].id,
  );
}

export function buildSessionTimeline(
  schedule: string[],
  settings: TestingSessionSettings,
): TrialSegment[] {
  const segments: TrialSegment[] = [];
  let cursor = 0;

  schedule.forEach((gestureId, trialIndex) => {
    segments.push({
      trialIndex,
      gestureId,
      phase: 'trial',
      startMs: cursor,
      endMs: cursor + settings.trialPeriodMs,
      durationMs: settings.trialPeriodMs,
    });
    cursor += settings.trialPeriodMs;

    if (settings.restPeriodMs > 0) {
      segments.push({
        trialIndex,
        gestureId,
        phase: 'rest',
        startMs: cursor,
        endMs: cursor + settings.restPeriodMs,
        durationMs: settings.restPeriodMs,
      });
      cursor += settings.restPeriodMs;
    }
  });

  return segments;
}

export function calculateSessionDurationMs(settings: TestingSessionSettings): number {
  return settings.numberOfTrials * (settings.trialPeriodMs + settings.restPeriodMs);
}

export function formatSessionLength(durationMs: number): string {
  const totalSeconds = Math.round(durationMs / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds} s`;
  }

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}
