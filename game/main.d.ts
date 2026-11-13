export type TutorialBeat = 'intro' | 'wrist-up' | 'wrist-down' | 'farewell';

export interface GameQteUpdate {
  status: 'rest' | 'ready' | 'recording' | 'processing' | 'complete';
  progress: number;
  targetGestureName: string;
  /** True during tutorial guidance; status is not recording until released. */
  tutorialHeld?: boolean;
  resultLabel?: string;
  encounterId?: string;
  expectedAction?: 'jump' | 'switch-lane';
  switchDirection?: number;
  trialIndex?: number;
  trialCount?: number;
}

export interface GameObstacleResult {
  trialIndex?: number;
  correct: boolean;
  encounterId: string;
  expectedAction: 'jump' | 'switch-lane';
}

export interface GameMountOptions {
  /** Effective only with runKind practice and no officialSequence; capped at eight obstacles. */
  tutorial?: boolean;
  /** Effective only for that isolated tutorial, never official/replay. */
  preserveLives?: boolean;
  onTutorialHold?: (beat: TutorialBeat) => void;
  runKind?: 'official' | 'replay' | 'practice';
  officialSequence?: string[];
  jumpGestureId?: string;
  isStreamReady?: () => boolean;
  getRecordingProgress?: (encounterId: string, trialIndex: number) => number;
  /** Read on each keydown so a running game can toggle debug arrows. Defaults to enabled. */
  isDebugKeyboardEnabled?: () => boolean;
  obstacleCount?: number;
  startingLives?: number;
  onQteUpdate?: (state: GameQteUpdate) => void;
  onObstacleResult?: (result: GameObstacleResult) => void;
  onLivesChange?: (lives: number, maxLives: number) => void;
  onGameOver?: () => void;
  onRunComplete?: () => void;
}

export function mountGame(container: HTMLElement, options?: GameMountOptions): () => void;
export function holdForSourceRecovery(): void;
export function resumeAfterSourceRecovery(): void;
/** Screen position of each lane's nearest recording section. */
export function closestRecordingZoneScreenPoints(): Array<{ x: number; y: number }>;
export function startJump(): void;
export function startLaneSwitch(direction: number): void;
export function queueGestureAction(
  action: 'jump' | 'switch-lane',
  direction: number,
  encounterId: string,
): void;

/** No-op outside an active isolated practice tutorial hold. */
export function releaseTutorialHold(): void;
