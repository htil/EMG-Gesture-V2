export interface GameQteUpdate {
  status: 'rest' | 'ready' | 'recording' | 'processing' | 'complete';
  progress: number;
  targetGestureName: string;
  resultLabel?: string;
  encounterId?: string;
  expectedAction?: 'jump' | 'switch-lane';
  switchDirection?: number;
  trialIndex?: number;
  trialCount?: number;
}

export interface GameObstacleResult {
  correct: boolean;
  encounterId: string;
  expectedAction: 'jump' | 'switch-lane';
}

export type TutorialBeat = 'intro' | 'wrist-up' | 'wrist-down' | 'farewell';

export interface GameMountOptions {
  /** Read on each keydown so a running game can toggle debug arrows. Defaults to enabled. */
  isDebugKeyboardEnabled?: () => boolean;
  obstacleCount?: number;
  startingLives?: number;
  tutorial?: boolean;
  preserveLives?: boolean;
  onQteUpdate?: (state: GameQteUpdate) => void;
  onObstacleResult?: (result: GameObstacleResult) => void;
  onLivesChange?: (lives: number, maxLives: number) => void;
  onGameOver?: () => void;
  onRunComplete?: () => void;
  onTutorialHold?: (beat: TutorialBeat) => void;
}

export function mountGame(container: HTMLElement, options?: GameMountOptions): () => void;
export function releaseTutorialHold(): void;
export function startJump(): void;
export function startLaneSwitch(direction: number): void;
export function queueGestureAction(
  action: 'jump' | 'switch-lane',
  direction: number,
  encounterId: string,
): void;
