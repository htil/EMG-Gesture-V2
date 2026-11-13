import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const bundled = await build({ entryPoints: [new URL('../src/app/study/conditionTraining.ts', import.meta.url).pathname], bundle: true, platform: 'node', format: 'esm', write: false });
const models = await import('data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64'));
test('practice model metadata stays memory-only, independently scoped from measured storage', () => {
  const old = globalThis.sessionStorage;
  const writes = [];
  globalThis.sessionStorage = { getItem: () => null, setItem: (key, value) => writes.push([key, value]) };
  try {
    models.markDatasetChanged('practice:real-participant:1:attempt', 'threshold', ['practice-sample']);
    assert.deepEqual(models.readModelState('practice:real-participant:1:attempt', 'threshold').datasetTrialIds, ['practice-sample']);
    assert.equal(writes.length, 0);
    models.markDatasetChanged('real-participant', 'threshold', ['measured-sample']);
    assert.equal(writes.length, 1);
    assert.equal(writes[0][0], 'emg-condition-model:real-participant:threshold');
  } finally { globalThis.sessionStorage = old; }
});
