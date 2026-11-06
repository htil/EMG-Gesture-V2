// Server/browser shared protocol. IDs mirror pipeline/gestureUtils DEFAULT_GESTURES.
export const OFFICIAL_TRIAL_COUNT = 20;
export const INFERENCE_WINDOW_MS = 2000;
export const OFFICIAL_GESTURE_IDS = Object.freeze(['wrist-up', 'wrist-down']);
export function validateOfficialSequence(sequence) {
 return Array.isArray(sequence) && sequence.length === OFFICIAL_TRIAL_COUNT
  && OFFICIAL_GESTURE_IDS.every(id => sequence.filter(value => value === id).length === 10)
  && !sequence.some((value,index) => index >= 3 && sequence.slice(index-3,index+1).every(item => item === value))
  && sequence.some((value,index) => index > 0 && value === sequence[index-1]);
}
export function assertOfficialSequence(sequence) {
 if (!validateOfficialSequence(sequence)) throw new Error('Official sequence requires 20 balanced wrist trials, maximum streak 3, and non-alternating order');
 return [...sequence];
}
export function inferenceWindow(points, cueAt, now, previousLatestAt = null) {
 // Validate acquisition order before filtering: malformed samples must not silently disappear.
 const fresh = [];
 let invalidReason = null;
 let previous = null;
 for (const point of points) {
  if (!Number.isFinite(point.time)) { invalidReason = 'Nonfinite timestamp during evaluation capture'; break; }
  if (point.time < cueAt && previous === null) continue;
  if (point.time > now) continue;
  if (!Number.isFinite(point.raw)) { invalidReason = 'Nonfinite raw sample during evaluation capture'; break; }
  if (previous !== null && point.time < previous) { invalidReason = 'Backwards timestamp during evaluation capture'; break; }
  if (previous !== null && point.time - previous > 500) { invalidReason = 'Sample gap exceeds 500ms during evaluation capture'; break; }
  fresh.push(point);
  previous = point.time;
 }
 const startedAt = fresh[0]?.time ?? null;
 const endedAt = startedAt === null ? null : startedAt + INFERENCE_WINDOW_MS;
 const latest = fresh.at(-1)?.time ?? null;
 // Overlapping buffers are expected; only new gaps or a regressed endpoint violate continuity.
 if (!invalidReason && previousLatestAt !== null && latest !== null) {
  if (latest < previousLatestAt) invalidReason = 'Backwards timestamp during evaluation capture';
  else if (startedAt - previousLatestAt > 500) invalidReason = 'Sample gap exceeds 500ms during evaluation capture';
 }
 const progress = startedAt === null ? 0 : Math.max(0, Math.min(1, ((latest ?? startedAt) - startedAt) / INFERENCE_WINDOW_MS));
 return { startedAt, endedAt, progress, invalidReason, latestAt: latest, complete: !invalidReason && endedAt !== null && now >= endedAt && latest >= endedAt,
  points: endedAt === null ? [] : fresh.filter(point => point.time < endedAt).map(({time,raw}) => ({time,raw})) };
}
export function generateOfficialSequence(seed) {
 let state=2166136261;
 for (const char of String(seed)) state=Math.imul(state ^ char.charCodeAt(0),16777619) >>> 0;
 const random=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state/4294967296;};
 // Rejection-shuffle avoids dead ends while preserving balance and seeded order.
 for (;;) {
  const sequence=Array.from({length:20},(_,index)=>OFFICIAL_GESTURE_IDS[index<10?0:1]);
  for(let i=sequence.length-1;i>0;i--){const j=Math.floor(random()*(i+1));[sequence[i],sequence[j]]=[sequence[j],sequence[i]];}
  if(validateOfficialSequence(sequence)) return sequence;
 }
}
