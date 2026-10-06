// The gamification branch owns the game (mountGame in game/main.js).
// Call submitGameRun from that game when a run ends. This is the handoff, not a second game.
export const DEFAULT_DIFFICULTY = 'standard';

export type GestureAttemptResult = 'correct' | 'wrong' | 'unknown' | 'recording_failure';

export interface GestureTestOutcome {
  attemptId: string;
  expectedGestureId: string;
  expectedGestureName: string;
  result: GestureAttemptResult;
  predictedGestureId: string | null;
  predictedGestureName: string | null;
}

export interface GameRunHandoff {
  condition: 'button' | 'threshold';
  difficulty: string;
  gameScore: number;
  outcomes: GestureTestOutcome[];
}

export interface StoredGameRun extends GameRunHandoff {
  id: string;
  round: number;
  recordedAt: number;
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
