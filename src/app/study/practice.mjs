// Practice stays outside measured data; flow v2 trains only its own rehearsal model.
export const PRACTICE_REST_MS = 10000; // Prototype default, not a validated study duration.
export const PRACTICE_MAX_GAP_MS = 250;

export function practicePointIssue(points, minimumDurationMs) {
  if (!Array.isArray(points) || points.length < 6) return 'Not enough signal points arrived. Check the stream before retrying.';
  if (points.length > 10000) return 'Too many signal points arrived. Ask the researcher to check the source.';
  for (let index = 0; index < points.length; index++) {
    const point = points[index];
    if (!point || typeof point.time !== 'number' || !Number.isFinite(point.time)
      || typeof point.value !== 'number' || !Number.isFinite(point.value)
      || (point.activityEnvelope !== undefined && (typeof point.activityEnvelope !== 'number' || !Number.isFinite(point.activityEnvelope) || point.activityEnvelope < 0))) return 'The source supplied an invalid signal value or timestamp. Check the connection.';
    if (index) {
      const gap = point.time - points[index - 1].time;
      if (gap < 0) return 'The source timestamps moved backwards. Ask the researcher to check the connection.';
      if (gap > PRACTICE_MAX_GAP_MS) return 'The signal was interrupted. Check the connection before retrying.';
    }
  }
  // Paired samples can share one host timestamp. Keep both raw values and do
  // not invent a device clock, deduplicate, or demand unique millisecond times.
  if (!Number.isFinite(minimumDurationMs) || points.at(-1).time - points[0].time < minimumDurationMs) return 'The source has not supplied a full recording window yet. Keep the stream running.';
  return null;
}

export function validatePracticePoints(points, minimumDurationMs) {
  return practicePointIssue(points, minimumDurationMs) === null;
}

export function withPracticeTiming(record) {
  if (!['rest', 'capture'].includes(record.kind)) return record;
  const points = record.points;
  let duplicateTimestampCount = 0, maxGapMs = 0;
  for (let index = 1; index < points.length; index++) {
    const gap = points[index].time - points[index - 1].time;
    if (gap === 0) duplicateTimestampCount++;
    maxGapMs = Math.max(maxGapMs, gap);
  }
  return { ...record, timing: {
    pointCount: points.length, durationMs: points.at(-1).time - points[0].time,
    duplicateTimestampCount, maxGapMs,
    timestampBasis: record.signalSource === 'mock' ? 'Mock host timestamps' : 'Source-supplied timestamps; device clock unverified',
    deviceClockValidated: false,
  } };
}
