import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createServer, loadConfigFromFile } from 'vite';
import { studyApiPlugin } from '../server/study-api.mjs';

const { chromium } = await import(process.env.EMG_PLAYWRIGHT_MODULE || '/root/emg-review-tools/node_modules/playwright/index.mjs');
const root = process.cwd();
const condition = process.env.EMG_PRACTICE_CONDITION || 'button';
const recovery = true;
assert.ok(['button', 'threshold'].includes(condition));
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'emg-guided-practice-'));
const out = process.env.EMG_NOTICE_EVIDENCE || '/workspace/EMG-Next-UI-Notices-Validation/green';
fs.mkdirSync(out, { recursive: true });
const report = { passed: false, errors: [], consoleErrors: [], checkpoints: [], disposableData: data };
const rejectedRecords = new Map();
let server, browser, page;
try {
  const config = await loadConfigFromFile({ command: 'serve', mode: 'development' }, path.join(root, 'vite.config.ts'));
  const port = await new Promise((resolve, reject) => {
    const probe = net.createServer(); probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => { const value = probe.address().port; probe.close(() => resolve(value)); });
  });
  server = await createServer({ ...config.config, root, configFile: false, cacheDir: path.join(data, '.vite-cache'),
    plugins: [studyApiPlugin(data), ...config.config.plugins.filter(plugin => plugin?.name !== 'study-api')],
    server: { host: '127.0.0.1', port, strictPort: true, open: false },
  });
  await server.listen();
  const url = `http://127.0.0.1:${server.httpServer.address().port}`;
  const request = async (method, endpoint, body, admin = false) => {
    const response = await fetch(url + '/api/study' + endpoint, { method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(admin ? { 'x-admin-pin': 'emg-admin' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    assert.ok(response.ok, `${endpoint}: ${response.status} ${await response.clone().text()}`);
    return response.json();
  };
  const experiment = await request('POST', '/experiments', { name: 'Disposable guided practice', repetitions: 1, capturesMin: 1, capturesMax: 1, obstacleCount: 7, startingLives: 4 }, true);
  const participant = (await request('POST', '/participants/generate', { experimentId: experiment.id, count: 1, assignment: condition, isTestParticipant: true }, true)).participants[0];
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(10000);
  page.setDefaultNavigationTimeout(60000);
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
  await page.goto(url);
  await page.getByLabel('Participant ID').fill(participant.id);
  let joinFailures = 0;
  await page.route('**/api/study/join', async route => {
    if (joinFailures++ < 2) await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Disposable participant access failure.' }) });
    else await route.continue();
  });
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  const accessNotice = page.getByRole('region', { name: 'Participant access issue — unresolved', exact: true });
  await accessNotice.getByRole('button', { name: 'Hide details', exact: true }).click();
  assert.equal(new URL(page.url()).pathname, '/');
  await accessNotice.getByRole('button', { name: 'Show details', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await accessNotice.getByRole('button', { name: 'Hide details', exact: true }).waitFor();
  await accessNotice.getByText('Disposable participant access failure.', { exact: true }).waitFor();
  report.checkpoints.push('Participant access stays blocked while collapsed; identical retried failure autoexpands');
  await page.screenshot({ path: path.join(out, 'participant-access-retry.png'), fullPage: true });
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.waitForURL('**/session');
  await page.getByRole('heading', { name: 'Guided practice', exact: true }).waitFor({ timeout: 5000 });
  await page.getByText('Practice mode — these examples won’t train your model.', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Train model', exact: true }).count(), 0);
  const session = await page.evaluate(() => JSON.parse(localStorage.getItem('emg-study-session')));
  assert.equal(session.trials.length, 0);
  report.checkpoints.push('Fresh actual participant enters guided Practice, not measured capture');
  await page.screenshot({ path: path.join(out, 'practice-welcome.png'), fullPage: true });
  await page.getByRole('button', { name: 'Begin practice', exact: true }).click();
  await page.getByRole('heading', { name: 'Watch your signal', exact: true }).waitFor({ timeout: 5000 });
  await page.getByRole('button', { name: 'Mock', exact: true }).click();
  await page.getByRole('button', { name: 'Start mock stream', exact: true }).click();
  if (recovery) {
    await page.getByRole('button', { name: 'I’m ready to rest', exact: true }).click();
    await page.getByRole('button', { name: 'Begin resting recording', exact: true }).click();
    await page.waitForTimeout(300);
    await page.getByRole('button', { name: 'Pause stream', exact: true }).click();
    await page.getByRole('heading', { name: 'Watch your signal', exact: true }).waitFor();
    assert.equal((await request('GET', '/practice/' + participant.id)).records.length, 0);
    await page.getByRole('button', { name: 'Start mock stream', exact: true }).click();
    const failed = new Set();
    await page.route('**/api/study/practice', async route => {
      const kind = route.request().postDataJSON()?.record?.kind;
      if (['rest', 'completed'].includes(kind) && !failed.has(kind)) {
        failed.add(kind);
        rejectedRecords.set(kind, route.request().postDataJSON().record);
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Intentional disposable-fixture save failure. Retry.' }) });
      } else await route.continue();
    });
    report.checkpoints.push('Pausing real rest cancels the partial window and requires a fresh attempt');
  }
  await page.getByRole('button', { name: 'I’m ready to rest', exact: true }).click();
  await page.getByRole('button', { name: 'Begin resting recording', exact: true }).click();
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(out, 'practice-rest-live.png'), fullPage: true });
  if (process.env.EMG_PRACTICE_GRAPH === '1') {
    await page.waitForTimeout(8300);
    const geometry = await page.getByRole('heading', { name: 'Live activity', exact: true }).evaluate(heading => {
      const panel = heading.closest('section');
      const line = panel.querySelector('.recharts-area-curve');
      const surface = panel.querySelector('.recharts-surface');
      return { lineWidth: line.getBBox().width, chartWidth: surface.getBoundingClientRect().width };
    });
    fs.writeFileSync(path.join(out, 'rest-graph-geometry.json'), JSON.stringify(geometry, null, 2));
    await page.screenshot({ path: path.join(out, 'practice-rest-late.png'), fullPage: true });
    assert.ok(geometry.lineWidth / geometry.chartWidth > 0.8, 'A 10-second resting capture must not shrink the rolling four-second graph');
    report.checkpoints.push('Late resting capture preserves the rolling graph width');
  }
  if (recovery) {
    await page.getByRole('button', { name: 'Retry saving practice', exact: true }).waitFor({ timeout: 20000 });
    assert.equal(await page.getByRole('heading', { name: 'Practise recording', exact: true }).count(), 0);
    const notice = page.getByRole('region', { name: 'Practice issue — unresolved', exact: true });
    await notice.getByRole('button', { name: 'Hide details', exact: true }).click();
    await notice.getByRole('button', { name: 'Show details', exact: true }).waitFor();
    assert.equal(await notice.getByText('Intentional disposable-fixture save failure. Retry.', { exact: true }).isVisible(), false);
    assert.equal(await page.getByRole('button', { name: 'Begin resting recording', exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole('region', { name: 'Session steps', exact: true }).count(), 0);
    assert.equal((await request('GET', '/practice/' + participant.id)).records.length, 0);
    await page.screenshot({ path: path.join(out, 'rest-error-collapsed.png'), fullPage: true });
    await notice.getByRole('button', { name: 'Show details', exact: true }).click();
    await notice.getByText('Intentional disposable-fixture save failure. Retry.', { exact: true }).waitFor();
    await page.screenshot({ path: path.join(out, 'rest-error-expanded.png'), fullPage: true });
    await notice.getByRole('button', { name: 'Hide details', exact: true }).click();
    await page.getByRole('button', { name: 'Retry saving practice', exact: true }).click();
    await notice.waitFor({ state: 'detached' });
    report.checkpoints.push('Collapse preserves unresolved warning, retry, retained recording, and blocked readiness; Show details restores the message');
    report.checkpoints.push('Rest saving failure blocks advancement; exact-record Retry succeeds');
  }
  await page.getByRole('heading', { name: 'Practise recording', exact: true }).waitFor({ timeout: 20000 });
  const archived = await request('GET', '/practice/' + participant.id);
  assert.equal(archived.records.filter(record => record.kind === 'rest').length, 1);
  const rest = archived.records.find(record => record.kind === 'rest');
  assert.equal(rest.id, rejectedRecords.get('rest').id);
  assert.deepEqual(rest.points, rejectedRecords.get('rest').points);
  assert.ok(rest.points.at(-1).time - rest.points[0].time >= 10000);
  assert.equal((await page.evaluate(() => JSON.parse(localStorage.getItem('emg-study-session')))).trials.length, 0);
  report.checkpoints.push('Actual guided rest lasts 10 seconds and persists outside measured training');
  for (const gesture of ['Pinch', 'Squeeze', 'Relax']) {
    await page.getByRole('button', { name: 'Practise ' + gesture, exact: true }).click();
    await page.getByText(gesture + ' practice example saved.', { exact: true }).waitFor({ timeout: 18000 });
    assert.equal((await page.evaluate(() => JSON.parse(localStorage.getItem('emg-study-session')))).trials.length, 0);
  }
  await page.getByRole('heading', { name: 'Review your practice examples', exact: true }).waitFor();
  const captured = await request('GET', '/practice/' + participant.id);
  assert.equal(captured.records.filter(record => record.kind === 'capture').length, 3);
  report.checkpoints.push('Actual assigned recorder saves all three gestures only into the practice archive');
  await page.getByRole('button', { name: 'Open Pinch practice example', exact: true }).click();
  await page.getByRole('img', { name: 'Pinch practice waveform', exact: true }).waitFor();
  await page.screenshot({ path: path.join(out, 'practice-review.png'), fullPage: true });
  await page.getByRole('button', { name: 'Remove Pinch practice example', exact: true }).click();
  await page.getByRole('button', { name: 'Practise Pinch', exact: true }).click();
  await page.getByRole('heading', { name: 'Review your practice examples', exact: true }).waitFor({ timeout: 18000 });
  assert.equal(await page.getByRole('button', { name: 'Finish practice', exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: 'Open Pinch practice example', exact: true }).click();
  await page.getByRole('button', { name: 'Finish practice', exact: true }).click();
  await page.getByRole('heading', { name: 'Practice complete', exact: true }).waitFor();
  assert.equal((await page.evaluate(() => JSON.parse(localStorage.getItem('emg-study-session')))).trials.length, 0);
  await page.screenshot({ path: path.join(out, 'practice-complete.png'), fullPage: true });
  await page.getByRole('button', { name: 'Begin collection', exact: true }).click();
  if (recovery) {
    await page.getByRole('button', { name: 'Retry saving practice', exact: true }).waitFor();
    assert.equal(await page.getByRole('region', { name: 'Session steps', exact: true }).count(), 0);
    const nextNotice = page.getByRole('region', { name: 'Practice issue — unresolved', exact: true });
    await nextNotice.getByRole('button', { name: 'Hide details', exact: true }).waitFor();
    await nextNotice.getByText('Intentional disposable-fixture save failure. Retry.', { exact: true }).waitFor();
    await page.screenshot({ path: path.join(out, 'next-error-expanded.png'), fullPage: true });
    await page.getByRole('button', { name: 'Retry saving practice', exact: true }).click();
    await nextNotice.waitFor({ state: 'detached' });
    report.checkpoints.push('Next same-message error autoexpands; actual completion retry persists');
    report.checkpoints.push('Completion saving failure cannot open measured collection; Retry succeeds');
  }
  await page.getByRole('region', { name: 'Session steps', exact: true }).waitFor();
  assert.equal(await page.getByRole('region', { name: 'Guided practice', exact: true }).count(), 0);
  const complete = await request('GET', '/practice/' + participant.id);
  assert.equal(complete.records.filter(record => record.kind === 'completed').length, 1);
  assert.equal(complete.records.find(record => record.kind === 'completed').id, rejectedRecords.get('completed').id);
  assert.equal(complete.records.filter(record => record.kind === 'removed').length, 1);
  assert.equal(complete.records.filter(record => record.kind === 'capture').length, 4);
  report.checkpoints.push('Actual review, removal, replacement and explicit collection transition with durable practice completion');
  fs.writeFileSync(path.join(out, 'actual-practice-readback.json'), JSON.stringify(complete, null, 2));
  assert.deepEqual(report.errors, []);
  if (!recovery) assert.deepEqual(report.consoleErrors, []);
  else { report.expectedConsoleFailures = 4; assert.equal(report.consoleErrors.length, 4); }
  await page.screenshot({ path: path.join(out, 'practice-recording.png'), fullPage: true });
  report.passed = true;
} catch (error) {
  report.failure = { message: error.message, stack: error.stack };
  if (page) { await page.screenshot({ path: path.join(out, 'failure.png'), fullPage: true }).catch(() => {}); fs.writeFileSync(path.join(out, 'failure-page.txt'), await page.locator('body').innerText().catch(() => '')); }
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  if (server) await server.close();
  fs.rmSync(data, { recursive: true, force: true });
  fs.writeFileSync(path.join(out, 'browser-results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
