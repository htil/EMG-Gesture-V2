// The gamification branch owns the game (mountGame in game/main.js).
// Call submitGameRun from that game when a run ends. This is the handoff, not a second game.
export const DEFAULT_DIFFICULTY = 'standard';

export type GestureAttemptResult = 'correct' | 'wrong' | 'unknown' | 'recording_failure';

export interface GestureTestOutcome {
  trialIndex?: number; // One-based trial ordinal from the game producer.
  cueAt?: number;
  recordingStartedAt?: number | null;
  recordingEndedAt?: number | null;
  sampleCount?: number;
  startedAt?: number | null;
  endedAt?: number | null;
  inferenceStartedAt?: number | null;
  inferenceEndedAt?: number | null;
  attemptId: string;
  expectedGestureId: string;
  expectedGestureName: string;
  result: GestureAttemptResult;
  predictedGestureId: string | null;
  predictedGestureName: string | null;
}

export interface GameRunHandoff {
  runId?: string;
  completionStatus?: 'complete' | 'incomplete';
  invalidationReason?: string | null;
  startedAt?: number;
  endedAt?: number;
  activeDurationMs?: number;
  sourceRecoveryPauses?: Array<{ startedAt: number; endedAt: number; reason: string }>;
  runKind?: 'official' | 'replay' | 'practice';
  officialSequence?: Array<'wrist-up' | 'wrist-down'>;
  signalSource?: 'mock' | 'live';
  streamReady?: boolean;
  evidenceKind?: 'synthetic-test' | 'measured-live' | 'practice';
  condition: 'button' | 'threshold';
  difficulty: string;
  gameScore: number;
  outcomes: GestureTestOutcome[];
  obstacleSuccess?: boolean | null;
}

export interface StoredGameRun extends GameRunHandoff {
  id: string;
  sessionId?: string;
  round: number;
  recordedAt: number;
  modelRevisionId?: string | null;
  obstacleSuccess?: boolean | null;
  generation?: number;
}

type GameRunListener = (handoff: GameRunHandoff) => void;

let listener: GameRunListener | null = null;

export function registerGameRunListener(next: GameRunListener) {
  listener = next;
  return () => {
    if (listener === next) listener = null;
  };
}

export function submitGameRun(handoff: GameRunHandoff) {
  if (!listener) return false;
  listener(handoff);
  return true;
}
