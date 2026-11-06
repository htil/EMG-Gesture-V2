import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dispatchStudyRequest } from '../server/study-api.mjs';
import { fixture } from './support/practice-fixture.mjs';

function unzipStored(buffer) {
  const entries = new Map();
  for (let at = 0; buffer.readUInt32LE(at) === 0x04034b50;) {
    const size = buffer.readUInt32LE(at + 18), length = buffer.readUInt16LE(at + 26), extra = buffer.readUInt16LE(at + 28);
    const start = at + 30 + length + extra;
    entries.set(buffer.subarray(at + 30, at + 30 + length).toString(), buffer.subarray(start, start + size).toString());
    at = start + size;
  }
  return entries;
}

test('exports label every joinable data family using server assignments and preserve legacy archive bytes', async t => {
  const { call, record, participant, experiment, data } = await fixture(t);
  assert.equal((await call('POST', '/practice', { id: participant.id, record: { ...record, isTestParticipant: false } })).status, 200);
  const file = path.join(data, 'sessions', participant.id, 'collection', record.sessionId, 'practice', record.id + '.json');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).isTestParticipant, true);
  const legacy = JSON.parse(fs.readFileSync(file, 'utf8')); delete legacy.isTestParticipant; delete legacy.timing;
  const bytes = JSON.stringify(legacy); fs.writeFileSync(file, bytes);
  assert.equal((await call('POST', '/practice', { id: participant.id, record })).status, 200);
  const base = { sessionId: record.sessionId, generation: 1, round: 1, condition: 'button', isTestParticipant: false };
  await call('POST', '/collection', { id: participant.id, items: [
    { kind: 'meta', record: { ...base, experimentId: experiment.id } },
    { kind: 'sample', record: { ...base, sampleId: 'sample-flag', points: [] } },
    { kind: 'event', record: { ...base, eventId: 'event-flag', type: 'sample_replaced', sampleId: 'sample-flag', replacementSampleId: 'replacement-flag' } },
    { kind: 'training', record: { ...base, revisionId: 'training-flag', status: 'success' } },
    { kind: 'run', record: { ...base, id: 'run-flag', gameScore: 1, outcomes: [{ attemptId: 'attempt-flag', result: 'correct' }] } },
  ] });
  const metaFile = path.join(data, 'sessions', participant.id, 'collection', record.sessionId, 'meta.json');
  assert.equal(JSON.parse(fs.readFileSync(metaFile, 'utf8')).isTestParticipant, true);
  const exported = await call('GET', '/export/' + experiment.id + '/collection', {}, true);
  const entries = unzipStored(exported.buffer);
  assert.match(entries.get('participants.csv'), new RegExp(participant.id + ',.*true'));
  for (const name of ['sessions', 'samples', 'events', 'replacements', 'training', 'runs', 'attempts']) {
    const [header, row] = entries.get(name + '.csv').trim().split('\n');
    const keys = header.split(','), values = row.split(',');
    assert.ok(keys.includes('participant_id'), name);
    assert.equal(values[keys.indexOf('participant_id')], participant.id, name);
    assert.equal(values[keys.indexOf('is_test_participant')], 'true', name);
  }
  assert.equal(JSON.parse(entries.get('practice.json')).records[0].isTestParticipant, true);
  const waveforms = JSON.parse(entries.get('waveforms.json'));
  assert.equal(waveforms.sessions[0].isTestParticipant, true);
  assert.equal(waveforms.samples[0].isTestParticipant, true);
  const roster = await call('GET', '/export/' + experiment.id, {}, true);
  assert.match(roster.text.split('\n')[0], /is_test_participant/);
  assert.match(roster.text.split('\n')[1], /true/);
  assert.equal(fs.readFileSync(file, 'utf8'), bytes);
  assert.equal((await call('POST', '/practice', { id: participant.id, record: { ...record, points: record.points.map(p => ({ ...p, value: p.value + 1 })) } })).status, 409);
});

async function setup(t) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'emg-participant-flags-'));
  t.after(() => fs.rmSync(data, { recursive: true, force: true }));
  const call = (method, url, body = {}, admin = true) => {
    const parsed = new URL(url, 'http://localhost');
    return dispatchStudyRequest(data, { method, pathname: parsed.pathname, searchParams: parsed.searchParams, body, headers: admin ? { 'x-admin-pin': 'emg-admin' } : {} });
  };
  const experiment = (await call('POST', '/experiments', { name: 'Disposable flag regression', repetitions: 1, capturesMin: 1, capturesMax: 1 })).body;
  const generate = (extra = {}, admin = true) => call('POST', '/participants/generate', { experimentId: experiment.id, count: 1, assignment: 'button', ...extra }, admin);
  return { data, call, experiment, generate };
}

test('only authenticated generation explicitly assigns test participants; omitted means study', async t => {
  const { generate, call, experiment, data } = await setup(t);
  assert.equal((await generate({ isTestParticipant: true }, false)).status, 401);
  const study = await generate();
  const demo = await generate({ isTestParticipant: true });
  const explicitStudy = await generate({ isTestParticipant: false });
  assert.equal(study.body.participants[0].isTestParticipant, false);
  assert.equal(demo.body.participants[0].isTestParticipant, true);
  assert.equal(explicitStudy.body.participants[0].isTestParticipant, false);
  const listed = await call('GET', `/participants?experimentId=${experiment.id}`);
  assert.deepEqual(listed.body.participants.map(p => p.isTestParticipant), [false, true, false]);
  assert.match(fs.readFileSync(path.join(data, 'participants.csv'), 'utf8'), /is_test_participant/);
});

test('malformed flags are rejected without creating assignments', async t => {
  const { generate, call, experiment } = await setup(t);
  for (const value of [null, 'true', 'false', 1, 0, [], {}]) {
    const result = await generate({ isTestParticipant: value });
    assert.equal(result.status, 400, JSON.stringify(value));
    assert.match(result.body.error, /isTestParticipant.*boolean/);
  }
  assert.deepEqual((await call('GET', `/participants?experimentId=${experiment.id}`)).body.participants, []);
});

test('join ignores participant flag forgery and reset preserves researcher assignment', async t => {
  const { generate, call } = await setup(t);
  for (const flag of [false, true]) {
    const participant = (await generate({ isTestParticipant: flag })).body.participants[0];
    const joined = await call('POST', '/join', { id: participant.id, isTestParticipant: !flag, is_test_participant: String(!flag) }, false);
    assert.equal(joined.body.isTestParticipant, flag);
    const reset = await call('POST', `/participants/${participant.id}/reset`, { isTestParticipant: !flag });
    assert.equal(reset.body.isTestParticipant, flag);
    const rejoined = await call('POST', '/join', { id: participant.id }, false);
    assert.equal(rejoined.body.isTestParticipant, flag);
    assert.equal(rejoined.body.generation, 2);
    await call('POST', '/progress', { id: participant.id, round: 1, trials: [] }, false);
    assert.equal((await call('POST', '/join', { id: participant.id }, false)).body.isTestParticipant, flag);
  }
});

test('legacy CSV missing flag reads false without read-time migration', async t => {
  const { data, call, experiment } = await setup(t);
  const file = path.join(data, 'participants.csv');
  const legacy = `id,experiment_id,condition,status,current_round,created_at,generation\nLEGACY,${experiment.id},button,in_progress,1,2020-01-01,1\n`;
  fs.writeFileSync(file, legacy);
  assert.equal((await call('GET', `/participants?experimentId=${experiment.id}`)).body.participants[0].isTestParticipant, false);
  assert.equal((await call('POST', '/join', { id: 'LEGACY', isTestParticipant: true }, false)).body.isTestParticipant, false);
  assert.equal(fs.readFileSync(file, 'utf8'), legacy);
});

test('mixed exports derive both labels from roster and ignore forged archived labels', async t => {
  const { data, generate, call, experiment } = await setup(t);
  const participants = [];
  for (const flag of [false, true]) {
    const participant = (await generate({ isTestParticipant: flag })).body.participants[0];
    participants.push(participant);
    const directory = path.join(data, 'sessions', participant.id, 'collection', 'legacy-session');
    fs.mkdirSync(directory, { recursive: true });
    const archive = JSON.stringify({ participantId: 'FORGED', sessionId: 'legacy-session', isTestParticipant: !flag });
    fs.writeFileSync(path.join(directory, 'meta.json'), archive);
    const patched = await call('PATCH', `/participants/${participant.id}`, { condition: 'threshold', isTestParticipant: !flag });
    assert.equal(patched.body.isTestParticipant, flag);
  }
  const entries = unzipStored((await call('GET', `/export/${experiment.id}/collection`)).buffer);
  const waveforms = JSON.parse(entries.get('waveforms.json'));
  assert.deepEqual(waveforms.sessions.map(session => [session.participantId, session.isTestParticipant]), participants.map(p => [p.id, p.isTestParticipant]));
  for (const participant of participants) {
    const file = path.join(data, 'sessions', participant.id, 'collection', 'legacy-session', 'meta.json');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).isTestParticipant, !participant.isTestParticipant, 'Export must not rewrite an old archive');
  }
});
