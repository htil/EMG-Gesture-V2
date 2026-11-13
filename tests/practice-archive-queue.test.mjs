import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { build } from 'esbuild';
const bundled = await build({ entryPoints: [new URL('../src/app/study/practiceArchive.ts', import.meta.url).pathname], bundle: true, platform: 'node', format: 'esm', write: false });
const { PracticeArchive } = await import('data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64'));

test('empty practice flush cannot strand later records; failed head retries exact identity and readback', async () => {
  const old = globalThis.fetch;
  const records = [];
  const posts = [];
  let fail = true;
  globalThis.fetch = async (url, init) => {
    if (init?.method === 'POST') {
      const { record } = JSON.parse(init.body); posts.push(record);
      if (fail) { fail = false; return { ok: false, json: async () => ({ error: 'intentional fixture failure' }) }; }
      records.push(record); return { ok: true, json: async () => ({ id: record.id }) };
    }
    return { ok: true, json: async () => ({ records }) };
  };
  try {
    const archive = new PracticeArchive({ id: 'rest', kind: 'rest', participantId: 'real-id', generation: 1, attemptId: 'attempt', points: [] }, () => {});
    await archive.flush();
    const event = archive.record('event', { type: 'capture_cancelled' });
    await archive.enqueue(event);
    assert.equal(archive.pending.length, 1);
    assert.equal(archive.error, 'intentional fixture failure');
    await archive.barrier();
    assert.equal(archive.pending.length, 0);
    assert.deepEqual(posts, [event, event]);
    assert.equal(archive.saved.at(-1).id, event.id);
  } finally { globalThis.fetch = old; }
});
