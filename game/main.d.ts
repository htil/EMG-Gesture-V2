export interface GameQteUpdate {
  status: 'rest' | 'ready' | 'recording' | 'processing' | 'complete';
  progress: number;
  targetGestureName: string;
  resultLabel?: string;
  encounterId?: string;
  expectedAction?: 'jump' | 'switch-lane';
  switchDirection?: number;
}

export interface GameObstacleResult {
  correct: boolean;
  encounterId: string;
  expectedAction: 'jump' | 'switch-lane';
}

export interface GameMountOptions {
  onQteUpdate?: (state: GameQteUpdate) => void;
  onObstacleResult?: (result: GameObstacleResult) => void;
}

export function mountGame(container: HTMLElement, options?: GameMountOptions): () => void;
export function startJump(): void;
export function startLaneSwitch(direction: number): void;
export function queueGestureAction(
  action: 'jump' | 'switch-lane',
  direction: number,
  encounterId: string,
): void;
