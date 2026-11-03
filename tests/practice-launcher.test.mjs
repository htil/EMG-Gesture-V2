import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('review launcher boots actual UI/API with two disposable assignments and shuts down', () => {
  const run = spawnSync(process.execPath, ['scripts/review-practice.mjs', '--smoke'], { encoding: 'utf8', timeout: 45000 });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /button/); assert.match(run.stdout, /threshold/);
  assert.match(run.stdout, /SMOKE PASS/);
});
