import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createServer, loadConfigFromFile } from 'vite';
import { studyApiPlugin } from '../server/study-api.mjs';
const { chromium } = await import(process.env.EMG_PLAYWRIGHT_MODULE || '/root/emg-review-tools/node_modules/playwright/index.mjs');
const root = process.cwd();
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'emg-flag-browser-'));
const out = process.env.EMG_FLAG_EVIDENCE || fs.mkdtempSync(path.join(os.tmpdir(), 'emg-flag-evidence-'));
fs.mkdirSync(out, { recursive: true });
const report = { passed: false, errors: [], expectedErrors: [], generated: [], disposableData: data };
let server, browser, page;
try {
  const config = await loadConfigFromFile({ command: 'serve', mode: 'development' }, path.join(root, 'vite.config.ts'));
  const port = await new Promise((resolve, reject) => { const probe = net.createServer(); probe.once('error', reject); probe.listen(0, '127.0.0.1', () => { const value = probe.address().port; probe.close(() => resolve(value)); }); });
  server = await createServer({ ...config.config, root, configFile: false, cacheDir: path.join(data, '.vite-cache'),
    plugins: [studyApiPlugin(data), ...config.config.plugins.filter(plugin => plugin?.name !== 'study-api')],
    server: { host: '127.0.0.1', port, strictPort: true, open: false },
  });
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  const api = async (endpoint, body, admin = true) => {
    const response = await fetch(origin + '/api/study' + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(admin ? { 'x-admin-pin': 'emg-admin' } : {}) }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const experiment = (await api('/experiments', { name: 'Disposable participant flags', repetitions: 1, capturesMin: 1, capturesMax: 1 })).body;
  for (const [body, admin, status] of [[{ isTestParticipant: true }, false, 401], [{ isTestParticipant: 'true' }, true, 400], [{ isTestParticipant: null }, true, 400]]) {
    const result = await api('/participants/generate', { experimentId: experiment.id, count: 1, assignment: 'button', ...body }, admin);
    assert.equal(result.status, status); report.expectedErrors.push(result);
  }
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  page.setDefaultTimeout(12000);
  page.setDefaultNavigationTimeout(60000);
  page.on('pageerror', error => report.errors.push(error.message));
  // Fixture credential only, not a real-user admin account.
  await page.addInitScript(() => sessionStorage.setItem('emg-admin-pin', 'emg-admin'));
  await page.goto(origin + '/admin');
  const toggle = page.getByRole('checkbox', { name: 'Test/demo participants (Mock and debug controls)' });
  await toggle.waitFor();
  assert.equal(await toggle.isChecked(), false);
  await page.getByLabel('How many', { exact: true }).fill('1');
  for (const flag of [false, true]) {
    await toggle.setChecked(flag);
    const generated = page.waitForResponse(response => response.url().endsWith('/api/study/participants/generate') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Generate IDs', exact: true }).click();
    const response = await generated;
    assert.equal(response.status(), 201);
    assert.equal(response.request().postDataJSON().isTestParticipant, flag);
    const participant = (await response.json()).participants[0];
    assert.equal(participant.isTestParticipant, flag);
    await page.getByRole('row').filter({ hasText: participant.id }).getByText(flag ? 'Test / demo' : 'Study / Ganglion', { exact: true }).waitFor();
    report.generated.push(participant);
  }
  await page.screenshot({ path: path.join(out, 'admin-flag-roster.png'), fullPage: true });
  for (const participant of report.generated) {
    await page.goto(origin);
    // A forged/stale local flag must lose to server join, even on local restore.
    await page.evaluate(p => localStorage.setItem('emg-study-session', JSON.stringify({ participantId: p.id, isTestParticipant: !p.isTestParticipant, stage: 'capture', unlockedThrough: 'capture', round: 1, generation: 1, updatedAt: Date.now() + 60000, sessionId: 'local-flag-restore', trials: [] })), participant);
    await page.getByLabel('Participant ID', { exact: true }).fill(participant.id);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.waitForURL('**/session');
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('emg-study-session')));
    assert.equal(stored.isTestParticipant, participant.isTestParticipant);
    assert.equal(stored.sessionId, 'local-flag-restore');
    await page.reload();
    const restored = await page.evaluate(async () => (await import('/src/app/study/api.ts')).loadClientSession());
    assert.equal(restored.isTestParticipant, participant.isTestParticipant);
    await page.screenshot({ path: path.join(out, participant.isTestParticipant ? 'test-joined.png' : 'study-joined.png'), fullPage: true });
  }
  assert.deepEqual(report.errors, []);
  report.passed = true;
} catch (error) {
  report.failure = error.stack;
  if (page) await page.screenshot({ path: path.join(out, 'flag-failure.png'), fullPage: true }).catch(() => {});
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  if (server) await server.close();
  fs.rmSync(data, { recursive: true, force: true });
  report.disposableDataRemoved = !fs.existsSync(data);
  fs.writeFileSync(path.join(out, 'flag-browser-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
