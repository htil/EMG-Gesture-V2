import type { EmgFeatures } from './types';

export function extractEmgFeatures(values: number[]): EmgFeatures {
  if (values.length === 0) {
    return {
      rms: 0,
      mav: 0,
      std: 0,
      peak: 0,
      waveformLength: 0,
    };
  }

  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const meanSquare = values.reduce((sum, value) => sum + value * value, 0) / values.length;
  const mav = values.reduce((sum, value) => sum + Math.abs(value), 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) * (value - mean), 0) / values.length;
  const peak = values.reduce((max, value) => Math.max(max, Math.abs(value)), 0);

  let waveformLength = 0;
  for (let index = 1; index < values.length; index += 1) {
    waveformLength += Math.abs(values[index] - values[index - 1]);
  }

  return {
    rms: Math.sqrt(meanSquare),
    mav,
    std: Math.sqrt(variance),
    peak,
    waveformLength,
  };
}
