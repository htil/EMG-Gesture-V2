import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { transformWithEsbuild } from 'vite';

const source = fs.readFileSync(new URL('../src/app/study/api.ts', import.meta.url), 'utf8');
const { code } = await transformWithEsbuild(source, 'api.ts', { loader: 'ts' });
const { loadClientSession, saveClientSession } = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
const storage = () => {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
};

test('client storage roundtrip preserves explicit test and study assignment; legacy and malformed default study', () => {
  globalThis.localStorage = storage(); globalThis.sessionStorage = storage();
  try {
    for (const [input, expected] of [[true, true], [false, false], [undefined, false], ['true', false], [1, false]]) {
      saveClientSession({ participantId: 'FLAGID', stage: 'capture', unlockedThrough: 'capture', isTestParticipant: input });
      assert.equal(loadClientSession().isTestParticipant, expected);
    }
    localStorage.removeItem('emg-study-session');
    sessionStorage.setItem('emg-study-session', JSON.stringify({ stage: 'capture', unlockedThrough: 'capture', isTestParticipant: true }));
    assert.equal(loadClientSession().isTestParticipant, true);
    assert.ok(localStorage.getItem('emg-study-session'));
  } finally { delete globalThis.localStorage; delete globalThis.sessionStorage; }
});
