export const PRACTICE_REST_MS: number;
export const PRACTICE_MAX_GAP_MS: number;
export function validatePracticePoints(points: unknown, minimumDurationMs: number): boolean;
export function practicePointIssue(points: unknown, minimumDurationMs: number): string | null;
