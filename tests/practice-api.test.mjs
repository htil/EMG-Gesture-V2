import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture } from './support/practice-fixture.mjs';

const invalidRestCases = [
  ['null raw value', record => { record.points[2].value = null; }],
  ['NaN raw value', record => { record.points[2].value = Number.NaN; }],
  ['string timestamp', record => { record.points[2].time = String(record.points[2].time); }],
  ['backwards timestamp', record => { record.points[2].time = record.points[1].time - 1; }],
  ['negative envelope', record => { record.points[2].activityEnvelope = -1; }],
  ['signal gap', record => { record.points.splice(2, 6); }],
  ['sparse endpoints', record => { record.points = [record.points[0], record.points.at(-1)]; }],
  ['short window', record => { record.points = record.points.slice(0, 150); }],
  ['invalid session token', record => { record.sessionId = '../other'; }],
  ['invalid channel', record => { record.channelIndex = 4; }],
  ['nonfinite setting', record => { record.settings.countdownMs = Number.NaN; }],
];
for (const [name, change] of invalidRestCases) test('practice rejects ' + name, async t => {
  const { call, record, participant } = await fixture(t);
  change(record);
  assert.equal((await call('POST', '/practice', { id: participant.id, record })).status, 400);
  assert.equal((await call('GET', '/practice/' + participant.id)).body.records.length, 0);
});

for (const [field, value] of [['participantId', 'OTHER'], ['experimentId', 'EXP-OTHER'], ['condition', 'threshold'], ['round', 2], ['generation', 0]]) test('practice fences ' + field, async t => {
  const { call, record, participant } = await fixture(t);
  assert.equal((await call('POST', '/practice', { id: participant.id, record: { ...record, [field]: value } })).status, 409);
});

test('practice records are immutable and retries preserve exact waveforms', async t => {
  const { call, record, participant } = await fixture(t);
  const post = item => call('POST', '/practice', { id: participant.id, record: item });
  assert.equal((await post(record)).status, 200);
  assert.equal((await post(record)).status, 200);
  const conflict = structuredClone(record); conflict.points[0].value += 0.1;
  assert.equal((await post(conflict)).status, 409);
  assert.deepEqual((await call('GET', '/practice/' + participant.id)).body.records[0].points, record.points);
});

test('reset removes old practice and rejects stale attempts', async t => {
  const { call, record, participant } = await fixture(t);
  await call('POST', '/practice', { id: participant.id, record });
  assert.equal((await call('POST', '/participants/' + participant.id + '/reset', {}, true)).status, 200);
  assert.equal((await call('GET', '/practice/' + participant.id)).body.records.length, 0);
  assert.equal((await call('POST', '/practice', { id: participant.id, record })).status, 409);
});

test('practice cannot capture against another attempt’s rest', async t => {
  const { call, record, capture, participant } = await fixture(t);
  await call('POST', '/practice', { id: participant.id, record });
  assert.equal((await call('POST', '/practice', { id: participant.id, record: { ...capture('pinch'), attemptId: 'another-attempt' } })).status, 400);
});

test('practice capture retains actual recorder metadata outside training', async t => {
  const { call, record, capture, participant } = await fixture(t);
  await call('POST', '/practice', { id: participant.id, record });
  const sample = capture('pinch');
  const saved = await call('POST', '/practice', { id: participant.id, record: sample });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const read = await call('GET', '/practice/' + participant.id);
  assert.equal(read.body.records.length, 2);
  assert.deepEqual(read.body.records.find(item => item.id === sample.id).points, sample.points);
});

test('archival rest preserves distinct paired values with equal host timestamps', async t => {
  const { call, record, participant } = await fixture(t);
  record.signalSource = 'live';
  record.points = record.points.flatMap(point => [point, { ...point, value: point.value + 0.0002 }]);
  const saved = await call('POST', '/practice', { id: participant.id, record });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const rest = (await call('GET', '/practice/' + participant.id)).body.records[0];
  assert.deepEqual(rest.points, record.points, 'Never drop or retime equal-timestamp source values');
  assert.equal(rest.timing.duplicateTimestampCount, 201);
  assert.equal(rest.timing.deviceClockValidated, false);
});

test('practice recorder captures also retain paired host timestamps', async t => {
  const { call, record, capture, participant } = await fixture(t);
  await call('POST', '/practice', { id: participant.id, record });
  const sample = capture('pinch');
  sample.points = sample.points.flatMap(point => [point, { ...point, value: point.value + 0.0002 }]);
  sample.preTriggerPointCount *= 2;
  assert.equal((await call('POST', '/practice', { id: participant.id, record: sample })).status, 200);
  const archived = (await call('GET', '/practice/' + participant.id)).body.records.find(item => item.id === sample.id);
  assert.deepEqual(archived.points, sample.points);
  assert.equal(archived.timing.duplicateTimestampCount, 29);
});

test('legacy practice records without timing diagnostics remain idempotent', async t => {
  const { call, record, participant, data } = await fixture(t);
  assert.equal((await call('POST', '/practice', { id: participant.id, record })).status, 200);
  const file = path.join(data, 'sessions', participant.id, 'collection', record.sessionId, 'practice', record.id + '.json');
  const legacy = JSON.parse(fs.readFileSync(file, 'utf8')); delete legacy.timing;
  fs.writeFileSync(file, JSON.stringify(legacy)); // Synthetic prior-format fixture only.
  assert.equal((await call('POST', '/practice', { id: participant.id, record })).status, 200);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).timing, undefined, 'Do not overwrite immutable old archives');
});

test('practice rest is durably read back separately from training', async t => {
  const { call, record, participant } = await fixture(t);
  const saved = await call('POST', '/practice', { id: participant.id, record });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const read = await call('GET', '/practice/' + participant.id);
  assert.equal(read.status, 200);
  assert.equal(read.body.records.length, 1);
  assert.deepEqual(read.body.records[0].points, record.points);
  assert.equal(read.body.records[0].archivalOnly, true);
  const joined = await call('POST', '/join', { id: participant.id });
  assert.equal(joined.body.restored?.trials.length || 0, 0);
});

test('practice export contains separate archival records, not training waveforms', async t => {
  const { call, record, participant, experiment } = await fixture(t);
  assert.equal((await call('POST', '/practice', { id: participant.id, record })).status, 200);
  const exported = await call('GET', '/export/' + experiment.id + '/collection', {}, true);
  assert.equal(exported.status, 200);
  const entries = new Map();
  for (let at = 0; exported.buffer.readUInt32LE(at) === 0x04034b50;) {
    assert.equal(exported.buffer.readUInt16LE(at + 8), 0, 'Stored ZIP entries');
    const size = exported.buffer.readUInt32LE(at + 18), nameLength = exported.buffer.readUInt16LE(at + 26), extra = exported.buffer.readUInt16LE(at + 28);
    const name = exported.buffer.subarray(at + 30, at + 30 + nameLength).toString();
    const start = at + 30 + nameLength + extra;
    entries.set(name, exported.buffer.subarray(start, start + size)); at = start + size;
  }
  assert.ok(entries.has('practice.json'), 'Practice archive must be exported');
  const practice = JSON.parse(entries.get('practice.json'));
  assert.deepEqual(practice.records[0].points, record.points);
  assert.equal(practice.records[0].archivalOnly, true);
  assert.equal(JSON.parse(entries.get('waveforms.json')).samples.length, 0);
});

test('review removal and replacement must be archived before practice completion', async t => {
  const { call, record, capture, participant } = await fixture(t);
  const post = item => call('POST', '/practice', { id: participant.id, record: item });
  await post(record);
  for (const id of ['pinch', 'squeeze', 'relax']) assert.equal((await post(capture(id))).status, 200);
  const completion = { ...record, id: 'practice-completed', kind: 'completed', points: [], restId: record.id,
    sampleIds: ['practice-pinch', 'practice-squeeze', 'practice-relax'], reviewedId: 'practice-pinch', removedId: 'practice-removed' };
  assert.equal((await post(completion)).status, 400, 'No removal/replacement has been demonstrated');
  const removed = { ...record, id: 'practice-removed', kind: 'removed', points: [], referenceId: 'practice-pinch' };
  assert.equal((await post(removed)).status, 200);
  assert.equal((await post(removed)).status, 200, 'Retry is idempotent');
  const replacement = capture('pinch', 'practice-pinch-replacement');
  assert.equal((await post(replacement)).status, 200);
  assert.equal((await post({ ...completion, sampleIds: ['practice-pinch-replacement', 'practice-squeeze', 'practice-relax'], reviewedId: 'practice-pinch-replacement' })).status, 200);
  assert.equal((await call('POST', '/join', { id: participant.id })).body.restored?.trials.length || 0, 0);
});
