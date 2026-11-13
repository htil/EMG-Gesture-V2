import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './support/practice-fixture.mjs';

test('flow v2 Relax uses cued rest rather than assigned upward threshold', async t => {
  const { call, record, capture, participant } = await fixture(t);
  const post = r => call('POST', '/practice', { id: participant.id, record: r });
  await post({ ...record, flowVersion: 2 });
  const relax = { ...capture('relax'), flowVersion: 2, captureProcedure: 'cued_rest', triggerMode: 'button' };
  const saved = await post(relax);
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const read = (await call('GET', '/practice/' + participant.id)).body.records.find(r => r.id === relax.id);
  assert.equal(read.flowVersion, 2);
  assert.equal(read.captureProcedure, 'cued_rest');
});

test('flow v2 completion requires retained training and actual scored game lineage', async t => {
  const { call, record, capture, participant } = await fixture(t);
  const post = r => call('POST', '/practice', { id: participant.id, record: { ...r, flowVersion: 2 } });
  const base = { ...record, points: [] };
  await post(record);
  for (const id of ['pinch', 'squeeze', 'relax']) await post({ ...capture(id), captureProcedure: id === 'relax' ? 'cued_rest' : 'button', triggerMode: 'button' });
  await post({ ...base, id: 'removed-1', kind: 'removed', referenceId: 'practice-pinch' });
  await post({ ...capture('pinch', 'replacement'), captureProcedure: 'button' });
  await post({ ...base, id: 'review-1', kind: 'reviewed', referenceId: 'replacement' });
  const sampleIds = ['replacement', 'practice-squeeze', 'practice-relax'];
  const completion = { ...base, id: 'complete-2', kind: 'completed', restId: record.id, sampleIds, reviewedId: 'replacement', removedId: 'removed-1', trainingId: 'train-1', gameId: 'game-1' };
  assert.equal((await post(completion)).status, 400);
  const training = { ...base, id: 'train-1', kind: 'training', sampleIds, status: 'success', startedAt: 1, finishedAt: 2, error: '', classifier: 'knn' };
  assert.equal((await post(training)).status, 200);
  assert.equal((await post(completion)).status, 400, 'Training alone is not a game');
  const game = { ...base, id: 'game-1', kind: 'game', trainingId: training.id, sampleIds, gameScore: 0, difficulty: 'standard', outcomes: [{ attemptId: 'obstacle-1:1', expectedGestureId: 'pinch', expectedGestureName: 'Pinch', predictedGestureId: 'unknown', predictedGestureName: 'Unknown', result: 'unknown' }] };
  assert.equal((await post(game)).status, 200, 'Honest Unknown is a scored outcome');
  assert.equal((await post(completion)).status, 200);
  await post({ ...base, id: 'removed-2', kind: 'removed', referenceId: 'replacement' });
  assert.equal((await post({ ...completion, id: 'complete-stale' })).status, 400, 'Deleted model inputs invalidate completion');
  assert.equal((await call('POST', '/join', { id: participant.id })).body.restored?.trials.length || 0, 0);
});
