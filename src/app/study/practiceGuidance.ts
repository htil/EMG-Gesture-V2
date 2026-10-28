import type { PracticeGuideStep } from './PracticeGuide';

export interface GuidanceState {
  stage: string; condition: 'button' | 'threshold'; streaming: boolean; calibrated: boolean;
  introduced: boolean; firstSampleExplained: boolean; sampleCount: number; selectedFull: boolean;
  roundComplete: boolean; gestureName: string; nextGesture: string; relax: boolean; manual: boolean;
  recording: boolean; countdown: boolean; inspecting: boolean; training: boolean;
  missing: boolean; reviewed: boolean; removed: boolean; modelReady: boolean; saveError: boolean;
  introduce: () => void; explainSample: () => void;
}
const target = (name: string) => `[data-practice-target="${name}"]`;
const step = (id: string, title: string, body: string, name?: string): PracticeGuideStep => ({ id, title, body, ...(name ? { target: target(name) } : {}) });

// This is a view of real workflow state, not another collection state machine.
export function practiceGuidance(s: GuidanceState): PracticeGuideStep | null {
  if (s.stage === 'game') return null;
  if (s.stage === 'game-introduction') return step('game-introduction', 'Before you play', 'Read how the game works. Press Start practice game when you are ready.', 'start-game');
  if (s.saveError) return step('save-retry', 'Your practice has not saved yet', 'Press Retry saving practice. Your examples are still here.', 'practice-save-retry');
  if (!s.streaming && s.stage === 'capture') return step('connect', 'Reconnect your signal', 'Start your signal again. Your saved examples will stay here.', 'stream');
  if (s.stage === 'capture') {
    if (s.condition === 'threshold' && !s.calibrated) return step('recalibrate', 'Redo your resting setup', 'Your connection changed. Press Redo resting setup, then rest your hand. Your saved examples will stay here.', 'recalibrate');
    if (!s.introduced) return { ...step('capture-introduction', s.relax || s.manual ? 'You choose when to record' : 'Recording starts on its own', (s.relax ? `For ${s.gestureName}, keep your hand resting. Press Capture and keep resting until the timer finishes.` : s.manual ? `Press Capture. When you see Recording, make ${s.gestureName}. Keep doing it until the timer finishes.` : `Rest your hand. Then make ${s.gestureName}. The app will start recording automatically.`) + ' Nothing will record until you press Begin gesture practice.', 'signal'), action: { label: 'Begin gesture practice', onClick: s.introduce } };
    if (s.recording || s.countdown) return step('recording', s.countdown ? 'Prepare for the recording' : 'Recording your example', s.relax ? `For ${s.gestureName}, keep your hand resting until the timer finishes.` : s.countdown ? `Get ready to make ${s.gestureName}. Wait until you see Recording.` : `Keep doing ${s.gestureName} until the timer finishes.`);
    if (s.sampleCount && !s.firstSampleExplained) return { ...step('sample-saved', 'Your example is here', 'This card shows what you just recorded. Later, you can look at it or replace it.'), target: '[data-practice-sample]', action: { label: 'Continue practice', onClick: s.explainSample } };
    if (s.roundComplete) return step('review', 'Check your examples', 'Press Review captures. You’ll look at an example and practise replacing it.', 'review');
    if (s.selectedFull) return step('select-gesture', `Choose ${s.nextGesture}`, `${s.gestureName} is complete. Choose ${s.nextGesture} from the Gesture menu.`, 'gesture');
    return step('capture', `Record ${s.gestureName}`, s.relax ? `For ${s.gestureName}, keep your hand resting. Press Capture and keep resting until the timer finishes.` : s.manual ? `Press Capture. When you see Recording, make ${s.gestureName}. Keep doing it until the timer finishes.` : `Rest your hand. Then make ${s.gestureName}. Recording starts on its own. Keep doing it until the timer finishes.`, s.manual ? 'capture' : 'signal');
  }
  if (s.stage === 'review') {
    if (s.inspecting) return step('sample-open', 'Look at your recording', 'The line shows what was recorded. Close the graph when you are ready.');
    if (s.missing) return step('replace', 'Record a replacement', 'You deleted an example. Press Back to capture to record another one.', 'back-capture');
    if (s.training) return step('training', 'Learning from your examples', 'Please wait. The app is using your examples to learn your movements.');
    if (!s.reviewed) return step('inspect', 'Look at one example', 'Press Graph on an example you kept.', 'inspect-sample');
    if (!s.removed) return step('delete', 'Practise replacing an example', 'Delete one example. Then you’ll record another one in its place.', 'delete-sample');
    if (!s.modelReady) return step('train', 'Teach the app your movements', 'Press Train model. The app will use the examples you kept to try recognising your movements.', 'train');
    return step('game-handoff', 'Try your examples in the game', 'Press Play to read how the game works. The game will not start yet.', 'play');
  }
  if (s.stage === 'results') return step('results', 'How did practice go?', 'Look at your game score and the movements the app recognised. You can check your examples again before starting the study.', 'results');
  return null;
}
