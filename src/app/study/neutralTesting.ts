import type { TrialSegment } from '../pipeline/testingSessionConfig';
export const TEST_CUE_DELAY_MS = 250;
// One cue-timed capture per trial, independent of condition, threshold and expected label.
export function neutralCaptureDue(trial: TrialSegment | undefined, elapsedMs: number, durationMs: number) {
  return !!trial && trial.phase === 'trial' && elapsedMs >= trial.startMs + TEST_CUE_DELAY_MS &&
    elapsedMs + durationMs + 200 < trial.endMs;
}
