import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const require = createRequire(import.meta.url);
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'emg-notice-unit-'));
let Notice;
try {
  await build({ entryPoints: ['src/app/study/DismissibleNotice.tsx'], bundle: true, platform: 'node', format: 'esm', jsx: 'automatic',
    outfile: path.join(directory, 'notice.mjs'), plugins: [{ name: 'shared-react', setup(builder) {
      builder.onResolve({ filter: /^react(?:\/.*)?$/ }, args => ({ path: require.resolve(args.path), external: true }));
    } }],
  });
  Notice = (await import(pathToFileURL(path.join(directory, 'notice.mjs')).href)).default;
} finally { fs.rmSync(directory, { recursive: true, force: true }); }

test('resolved errors render no warning or controls', () => {
  assert.equal(renderToStaticMarkup(createElement(Notice, { message: '', summary: 'Save issue' })), '');
});

test('unresolved issue starts expanded with accessible linked details', () => {
  const html = renderToStaticMarkup(createElement(Notice, { message: 'Save failed', summary: 'Save issue' }));
  assert.match(html, /aria-label="Save issue — unresolved"/);
  assert.match(html, /role="alert"/);
  assert.match(html, /aria-expanded="true"/);
  const controls = html.match(/aria-controls="([^"]+)"/)[1];
  assert.ok(html.includes(`id="${controls}"`));
  assert.match(html, />Hide details</);
  assert.match(html, />Save failed</);
  assert.doesNotMatch(html, /hidden=""/);
});

test('error details are escaped and recovery actions remain available', () => {
  const html = renderToStaticMarkup(createElement(Notice, { message: '<script>unsafe</script>', summary: 'Save issue',
    actions: createElement('button', { type: 'button' }, 'Retry saving'),
  }));
  assert.match(html, /&lt;script&gt;unsafe&lt;\/script&gt;/);
  assert.match(html, />Retry saving</);
  assert.doesNotMatch(html, /<script>/);
});
