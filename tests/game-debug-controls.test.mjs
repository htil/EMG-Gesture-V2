import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

// Execute the actual mount/controls functions, isolating only WebGL/assets.
const source = readFileSync(new URL('../game/main.js', import.meta.url), 'utf8');
function functionSource(name) {
  const start = source.indexOf(`export function ${name}(`);
  assert.notEqual(start, -1);
  const end = source.indexOf('\n}', start) + 2;
  return source.slice(start, end).replace('export ', '');
}
function harness() {
  const window = new EventTarget();
  const context = vm.createContext({ window });
  vm.runInContext(`
    let activeRenderer = null, activeGameOptions = {}, obstacleLimit, startingLives, lives = 3;
    let isJumping = false, isSwitching = false, laneIndex = 0;
    let switchFrom, switchTo, switchElapsed, pendingGestureAction = null;
    const LANE_OFFSET = 1.5, DEFAULT_OBSTACLE_COUNT = 20, DEFAULT_STARTING_LIVES = 3;
    const camera = { updateProjectionMatrix() {} };
    const characterRoot = { position: { x: -1.5 } };
    const action = { reset() {}, crossFadeFrom() {}, play() {} };
    const jumpAction = action, runAction = action;
    const clock = { getDelta() {} };
    const animate = () => {};
    const resetGame = () => { isJumping = false; isSwitching = false; laneIndex = 0; pendingGestureAction = null; };
    const wholeNumber = (value, fallback) => value ?? fallback;
    class ResizeObserver { observe() {} disconnect() { globalThis.disconnected = true; } }
    const THREE = { WebGLRenderer: class {
      domElement = { style: {}, remove() { globalThis.removed = true; } };
      setSize() {} setAnimationLoop(value) { globalThis.loop = value; }
      dispose() { globalThis.disposed = true; }
    }};
    ${['mountGame', 'startJump', 'startLaneSwitch', 'queueGestureAction'].map(functionSource).join('\n')}
    globalThis.mount = mountGame;
    globalThis.state = () => ({ isJumping, isSwitching, laneIndex, pendingGestureAction });
    globalThis.queue = queueGestureAction;
    globalThis.controlJump = startJump;
    globalThis.controlSwitch = startLaneSwitch;
  `, context);
  const mount = (options) => context.mount({ clientWidth: 800, clientHeight: 600, appendChild() {} }, options);
  const key = (code, repeat = false) => {
    const event = new Event('keydown', { cancelable: true });
    Object.assign(event, { code, repeat });
    window.dispatchEvent(event);
    assert.equal(event.defaultPrevented, false, 'must not swallow page keys');
  };
  return { context, mount, key, state: context.state };
}

test('default-on arrow controls preserve existing movement and repeat behavior', () => {
  for (const code of ['ArrowUp', 'ArrowRight', 'ArrowLeft']) {
    const h = harness();
    const cleanup = h.mount();
    h.key(code, true);
    assert.equal(h.state().isJumping || h.state().isSwitching, false);
    h.key(code);
    assert.equal(h.state().isJumping, code === 'ArrowUp');
    assert.equal(h.state().laneIndex, code === 'ArrowRight' ? 1 : 0);
    cleanup();
  }
});

test('live debug toggle blocks arrows without blocking recognition/control entry points', () => {
  const h = harness();
  let enabled = false;
  const cleanup = h.mount({ isDebugKeyboardEnabled: () => enabled });
  for (const code of ['ArrowUp', 'ArrowLeft', 'ArrowRight', 'KeyA']) h.key(code);
  assert.equal(h.state().isJumping, false, 'disabled ArrowUp must not jump');
  assert.equal(h.state().laneIndex, 0, 'disabled arrows must not switch lanes');
  assert.equal(h.state().pendingGestureAction, null, 'disabled arrows must not queue actions');
  h.context.queue('jump', 0, 'recognition-encounter');
  assert.equal(h.state().pendingGestureAction.encounterId, 'recognition-encounter');
  enabled = true;
  h.key('ArrowRight');
  assert.equal(h.state().laneIndex, 1, 'toggle must apply without remount');
  enabled = false;
  h.context.controlJump(); // Switching already in progress still retains its normal guard.
  assert.equal(h.state().isJumping, false);
  cleanup();

  const second = harness();
  const secondCleanup = second.mount({ isDebugKeyboardEnabled: () => false });
  second.context.controlJump();
  assert.equal(second.state().isJumping, true, 'direct recognition control remains available');
  secondCleanup();

  const third = harness();
  const thirdCleanup = third.mount({ isDebugKeyboardEnabled: () => false });
  third.context.controlSwitch(1);
  assert.equal(third.state().laneIndex, 1, 'direct lane control remains available');
  thirdCleanup();
});

test('unmount removes keyboard listener and next run restores compatibility default', () => {
  const h = harness();
  const cleanup = h.mount({ isDebugKeyboardEnabled: () => false });
  cleanup();
  h.key('ArrowRight');
  assert.equal(h.state().laneIndex, 0);
  assert.equal(h.context.loop, null);
  assert.equal(h.context.disconnected && h.context.removed && h.context.disposed, true);
  const nextCleanup = h.mount();
  h.key('ArrowRight');
  assert.equal(h.state().laneIndex, 1);
  nextCleanup();
  h.key('ArrowUp');
  assert.equal(h.state().isJumping, false, 'unmounted default-on run must not respond');
});
