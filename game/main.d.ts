export interface GameQteUpdate {
  status: 'rest' | 'ready' | 'recording' | 'processing' | 'complete';
  progress: number;
  targetGestureName: string;
  resultLabel?: string;
}

export interface GameMountOptions {
  onQteUpdate?: (state: GameQteUpdate) => void;
  onObstacleResult?: (correct: boolean) => void;
}

export function mountGame(container: HTMLElement, options?: GameMountOptions): () => void;
export function startJump(): void;
export function startLaneSwitch(direction: number): void;
