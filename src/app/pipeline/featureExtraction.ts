import type { EmgFeatures, FeatureKey, FeatureSetId } from './types';

export const DEFAULT_FEATURE_SET_ID: FeatureSetId = 'extended';

export const FEATURE_SET_OPTIONS: Array<{
  id: FeatureSetId;
  label: string;
  shortLabel: string;
  description: string;
  featureKeys: FeatureKey[];
}> = [
  {
    id: 'extended',
    label: 'Extended 10-Feature Set',
    shortLabel: 'Extended',
    description: 'Uses the current 10-feature model, including zero crossings, Willison amplitude, and Hjorth metrics.',
    featureKeys: [
      'rms',
      'mav',
      'std',
      'peak',
      'waveformLength',
      'zeroCrossings',
      'slopeSignChanges',
      'willisonAmplitude',
      'hjorthMobility',
      'hjorthComplexity',
    ],
  },
  {
    id: 'educational',
    label: 'Educational 5-Feature Set',
    shortLabel: 'Educational',
    description: 'Keeps the model beginner-friendly with RMS, MAV, standard deviation, peak, and waveform length.',
    featureKeys: [
      'rms',
      'mav',
      'std',
      'peak',
      'waveformLength',
    ],
  },
];

export function getFeatureSetDefinition(featureSetId: FeatureSetId = DEFAULT_FEATURE_SET_ID) {
  return FEATURE_SET_OPTIONS.find((option) => option.id === featureSetId) ?? FEATURE_SET_OPTIONS[0];
}

export function getFeatureSetKeys(featureSetId: FeatureSetId = DEFAULT_FEATURE_SET_ID): FeatureKey[] {
  return getFeatureSetDefinition(featureSetId).featureKeys;
}

export function extractEmgFeatures(values: number[]): EmgFeatures {
  if (values.length === 0) {
    return {
      rms: 0,
      mav: 0,
      std: 0,
      peak: 0,
      waveformLength: 0,
      zeroCrossings: 0,
      slopeSignChanges: 0,
      willisonAmplitude: 0,
      hjorthMobility: 0,
      hjorthComplexity: 0,
    };
  }

  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const meanSquare = values.reduce((sum, value) => sum + value * value, 0) / values.length;
  const mav = values.reduce((sum, value) => sum + Math.abs(value), 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) * (value - mean), 0) / values.length;
  const std = Math.sqrt(variance);
  const peak = values.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
  const centered = values.map((value) => value - mean);
  const diffs = values.slice(1).map((value, index) => value - values[index]);
  const diffVariance = diffs.length > 0
    ? diffs.reduce((sum, diff) => sum + diff * diff, 0) / diffs.length
    : 0;
  const secondDiffs = diffs.slice(1).map((value, index) => value - diffs[index]);
  const secondDiffVariance = secondDiffs.length > 0
    ? secondDiffs.reduce((sum, diff) => sum + diff * diff, 0) / secondDiffs.length
    : 0;
  const zeroCrossingThreshold = Math.max(std * 0.05, 1e-4);
  const willisonThreshold = Math.max(std * 0.35, 0.01);

  let waveformLength = 0;
  let zeroCrossings = 0;
  let slopeSignChanges = 0;
  let willisonAmplitude = 0;

  for (let index = 1; index < values.length; index += 1) {
    waveformLength += Math.abs(values[index] - values[index - 1]);

    if (
      (
        centered[index - 1] >= zeroCrossingThreshold &&
        centered[index] <= -zeroCrossingThreshold
      ) ||
      (
        centered[index - 1] <= -zeroCrossingThreshold &&
        centered[index] >= zeroCrossingThreshold
      )
    ) {
      zeroCrossings += 1;
    }

    if (Math.abs(values[index] - values[index - 1]) >= willisonThreshold) {
      willisonAmplitude += 1;
    }
  }

  for (let index = 1; index < diffs.length; index += 1) {
    const previous = diffs[index - 1];
    const current = diffs[index];
    const crossed = (previous >= 0 && current < 0) || (previous < 0 && current >= 0);

    if (crossed && Math.abs(previous - current) >= zeroCrossingThreshold) {
      slopeSignChanges += 1;
    }
  }

  const hjorthMobility = variance > 1e-10 ? Math.sqrt(diffVariance / variance) : 0;
  const diffStd = Math.sqrt(diffVariance);
  const secondDiffStd = Math.sqrt(secondDiffVariance);
  const diffMobility = diffVariance > 1e-10 ? secondDiffStd / Math.max(diffStd, 1e-6) : 0;
  const hjorthComplexity = hjorthMobility > 1e-10 ? diffMobility / hjorthMobility : 0;

  return {
    rms: Math.sqrt(meanSquare),
    mav,
    std,
    peak,
    waveformLength,
    zeroCrossings,
    slopeSignChanges,
    willisonAmplitude,
    hjorthMobility,
    hjorthComplexity,
  };
}
