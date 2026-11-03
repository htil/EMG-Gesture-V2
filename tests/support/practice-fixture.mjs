import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dispatchStudyRequest } from '../../server/study-api.mjs';

// Synthetic API fixtures only. No physical-signal or recognition claims.
export async function fixture(t) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'emg-practice-api-'));
  t.after(() => fs.rmSync(data, { recursive: true, force: true }));
  const call = (method, pathname, body = {}, admin = false) => dispatchStudyRequest(data, { method, pathname, body, headers: admin ? { 'x-admin-pin': 'emg-admin' } : {}, searchParams: new URLSearchParams() });
  const e = await call('POST', '/experiments', { name: 'Synthetic practice API fixture', repetitions: 1, capturesMin: 1, capturesMax: 1 }, true);
  assert.equal(e.status, 201);
  const p = await call('POST', '/participants/generate', { experimentId: e.body.id, count: 1, assignment: 'button', isTestParticipant: true }, true);
  const participant = p.body.participants[0];
  const joined = (await call('POST', '/join', { id: participant.id })).body;
  const record = { id: 'practice-rest-1', attemptId: 'practice-attempt-1', kind: 'rest', participantId: participant.id, experimentId: e.body.id, sessionId: 'practice-test-session', generation: joined.generation, condition: 'button', round: 1, signalSource: 'mock', channelIndex: 0, createdAt: 20000, settings: { segmentDurationMs: 1200, preTriggerWindowMs: 175, countdownMs: 3000, activityThreshold: 0.6 },
    points: Array.from({ length: 201 }, (_, i) => ({ time: 10000 + i * 50, value: 0.1 + (i % 3) * 0.001, activityEnvelope: 0.1 })),
  };
  const capture = (gestureId, id = 'practice-' + gestureId) => ({ ...record, id, kind: 'capture', restId: record.id, gestureId, triggerMode: record.condition, triggeredAt: 10200, completedAt: 11400, preTriggerPointCount: 4, points: record.points.slice(0, 29).map(({ time, value }) => ({ time, value })) });
  return { call, record, capture, participant, experiment: e.body, data };
}
