import type { Gesture } from '../pipeline';

export interface GestureQuota {
  gesture: Gesture;
  kept: number;
  required: number;
  missing: number;
}

export function keptForGesture<T extends { gestureId: string }>(samples: T[], gestureId: string) {
  return samples.filter((sample) => sample.gestureId === gestureId).length;
}

export function sampleNumber<T extends { id: string; gestureId: string; capturedAt: number }>(samples: T[], sampleId: string) {
  const sample = samples.find((item) => item.id === sampleId);
  if (!sample) return 0;
  const ordered = samples
    .filter((item) => item.gestureId === sample.gestureId)
    .slice()
    .sort((left, right) => left.capturedAt - right.capturedAt || left.id.localeCompare(right.id));
  return ordered.findIndex((item) => item.id === sampleId) + 1;
}

export function gestureQuotas<T extends { gestureId: string }>(gestures: Gesture[], samples: T[], required: number): GestureQuota[] {
  return gestures.map((gesture) => {
    const kept = keptForGesture(samples, gesture.id);
    return {
      gesture,
      kept,
      required,
      missing: Math.max(0, required - kept),
    };
  });
}

export function samplesComplete<T extends { gestureId: string }>(gestures: Gesture[], samples: T[], required: number) {
  return gestureQuotas(gestures, samples, required).every((row) => row.missing === 0);
}
