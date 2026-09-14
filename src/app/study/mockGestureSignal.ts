import type { TrialSegment } from '../pipeline/testingSessionConfig';

// Source-only cue bookkeeping, independent of condition and classifier input.
export function cueMockTrial(trial: TrialSegment | undefined, cued: Set<number>, emit: (gestureId: string) => void) {
  if (!trial || trial.phase !== 'trial' || cued.has(trial.trialIndex)) return;
  emit(trial.gestureId);
  cued.add(trial.trialIndex);
}

// Diagnostic envelopes, not physiological models or classifier benchmarks.
// The fixed gesture ordering gives both study periods the same profiles.
export function mockGestureSignal(gestureIndex: number, elapsedMs: number, durationMs: number): number {
  const duration = Math.max(1, durationMs);
  // Leave room for a human/cue delay without putting relaxation inside a full capture.
  const activeMs = duration + 1000;
  const cycleMs = activeMs + 1200;
  const cycle = ((elapsedMs % cycleMs) + cycleMs) % cycleMs;
  const index = Math.max(0, gestureIndex);
  if (cycle >= activeMs) return 0.08 + 0.015 * Math.sin(cycle * 0.017 + index);
  // Stationary, periodic profiles: a duration-long window sees a complete cycle,
  // rather than a different gesture shape depending on which trigger started it.
  const phase = 2 * Math.PI * cycle / duration;
  const ripple = 0.012 * Math.sin(phase * 3 + index * 2);
  let value: number;
  switch (index % 3) {
    case 0: value = 0.74 + 0.09 * Math.sin(phase); break;
    case 1: value = 0.78 + 0.1 * Math.sin(phase * 2); break;
    default: value = 0.76 + 0.15 * Math.sin(phase * 4); break;
  }
  return Math.max(0, Math.min(1, value + ripple + 0.02 * Math.sin(index * phase)));
}
