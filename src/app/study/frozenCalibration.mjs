import { validatePracticePoints, PRACTICE_REST_MS } from './practice.mjs';

export function restCalibration(rest) {
  if (!validatePracticePoints(rest.points, PRACTICE_REST_MS) || rest.points.some(p => !Number.isFinite(p.activityEnvelope) || p.activityEnvelope < 0)) throw new Error('Calibration needs a complete finite envelope resting reference.');
  let mean = 0, m2 = 0, count = 0;
  for (const p of rest.points) { count++; const delta = p.activityEnvelope - mean; mean += delta / count; m2 += delta * (p.activityEnvelope - mean); }
  const sd = Math.sqrt(m2 / count), threshold = mean + 3 * sd;
  if (!Number.isFinite(threshold) || threshold <= 0) throw new Error('Rest has no positive usable activity boundary. Check the signal and repeat rest.');
  const number = n => Number(n.toPrecision(15));
  return Object.freeze({ version: 1, formula: 'rest-envelope-mean-plus-3-population-sd', revision: rest.id,
    participantId: rest.participantId, experimentId: rest.experimentId, sessionId: rest.sessionId, generation: rest.generation, round: rest.round, condition: rest.condition,
    signalSource: rest.signalSource, channelIndex: rest.channelIndex, restId: rest.id, mean: number(mean), sd: number(sd), threshold: number(threshold), count,
    durationMs: rest.points.at(-1).time - rest.points[0].time, activationHoldMs: 100, restHoldMs: 300, maxGapMs: 500, displayMax: number(threshold * 2) });
}

export function sameCalibration(left, right) {
  return !!left && !!right && Object.keys(right).length === Object.keys(left).length && Object.keys(right).every(key => left[key] === right[key]);
}
