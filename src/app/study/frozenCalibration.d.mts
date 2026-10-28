export interface FrozenCalibration {
 version: 1; formula: 'rest-envelope-mean-plus-3-population-sd'; revision: string; restId: string;
 participantId: string; experimentId: string; sessionId: string; generation: number; round: number; condition: 'button' | 'threshold';
 signalSource: 'mock' | 'live'; channelIndex: number; mean: number; sd: number; threshold: number; count: number; durationMs: number;
 activationHoldMs: 100; restHoldMs: 300; maxGapMs: 500; displayMax: number;
}
export function restCalibration(rest: unknown): FrozenCalibration;
export function sameCalibration(left: unknown, right: unknown): boolean;
