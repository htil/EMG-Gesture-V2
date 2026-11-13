import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { transformWithEsbuild } from 'vite';
const source = fs.readFileSync(new URL('../src/app/study/recognition.ts', import.meta.url), 'utf8');
const { code } = await transformWithEsbuild(source, 'recognition.ts', { loader: 'ts' });
const recognition = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
test('recognition producer compares model IDs independently of obstacle collision or debug rescue', () => {
  assert.equal(typeof recognition.recognitionResult, 'function');
  assert.equal(recognition.recognitionResult('pinch', { predictedGestureId: 'pinch' }), 'correct');
  assert.equal(recognition.recognitionResult('pinch', { predictedGestureId: 'squeeze' }), 'wrong');
  assert.equal(recognition.recognitionResult('pinch', { predictedGestureId: 'unknown' }), 'unknown');
  assert.equal(recognition.recognitionResult('pinch', null), 'recording_failure');
  const gameSource = fs.readFileSync(new URL('../src/app/GameScreen.tsx', import.meta.url), 'utf8');
  assert.match(gameSource, /result: recognitionResult\(expectedGesture.id, prediction\)/);
});
