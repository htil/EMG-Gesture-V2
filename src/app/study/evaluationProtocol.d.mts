export const OFFICIAL_TRIAL_COUNT: 20;
export const INFERENCE_WINDOW_MS: 2000;
export const OFFICIAL_GESTURE_IDS: readonly ['wrist-up', 'wrist-down'];
export function generateOfficialSequence(seed: string | number): Array<'wrist-up' | 'wrist-down'>;
export function validateOfficialSequence(sequence: unknown): sequence is Array<'wrist-up' | 'wrist-down'>;
export function assertOfficialSequence(sequence: unknown): Array<'wrist-up' | 'wrist-down'>;
export function inferenceWindow(points: Array<{time:number; raw?:number}>, cueAt:number, now:number, previousLatestAt?:number|null): {startedAt:number|null; endedAt:number|null; progress:number; invalidReason:string|null; latestAt:number|null; complete:boolean; points:Array<{time:number;raw:number}>};
