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
const recovery = process.env.EMG_PRACTICE_RECOVERY === '1';
assert.ok(['button', 'threshold'].includes(condition));
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'emg-guided-practice-'));
const out = process.env.EMG_PRACTICE_EVIDENCE || fs.mkdtempSync(path.join(os.tmpdir(), 'emg-practice-evidence-'));
fs.mkdirSync(out, { recursive: true });
const report = { passed: false, errors: [], consoleErrors: [], checkpoints: [], disposableData: data };
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
    await page.getByRole('button', { name: 'Retry saving practice', exact: true }).click();
    report.checkpoints.push('Rest saving failure blocks advancement; exact-record Retry succeeds');
  }
  await page.getByRole('heading', { name: 'Practise recording', exact: true }).waitFor({ timeout: 20000 });
  const archived = await request('GET', '/practice/' + participant.id);
  assert.equal(archived.records.filter(record => record.kind === 'rest').length, 1);
  const rest = archived.records.find(record => record.kind === 'rest');
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
    await page.getByRole('button', { name: 'Retry saving practice', exact: true }).click();
    report.checkpoints.push('Completion saving failure cannot open measured collection; Retry succeeds');
  }
  await page.getByRole('region', { name: 'Session steps', exact: true }).waitFor();
  assert.equal(await page.getByRole('region', { name: 'Guided practice', exact: true }).count(), 0);
  const complete = await request('GET', '/practice/' + participant.id);
  assert.equal(complete.records.filter(record => record.kind === 'completed').length, 1);
  assert.equal(complete.records.filter(record => record.kind === 'removed').length, 1);
  assert.equal(complete.records.filter(record => record.kind === 'capture').length, 4);
  report.checkpoints.push('Actual review, removal, replacement and explicit collection transition with durable practice completion');
  if (process.env.EMG_PRACTICE_KEYBOARD === '1') {
    await page.getByRole('button', { name: 'Reopen guided practice', exact: true }).focus();
    await page.keyboard.press('Space');
    await page.getByRole('heading', { name: 'Guided practice', exact: true }).waitFor({ timeout: 5000 });
    assert.equal((await page.evaluate(() => JSON.parse(localStorage.getItem('emg-study-session')))).trials.length, 0);
    report.checkpoints.push('Keyboard activation of Practice cannot invoke the measured Capture shortcut');
  } else {
  for (const [index, gesture] of ['Pinch', 'Squeeze', 'Relax'].entries()) {
    if (index) { await page.locator('button[aria-haspopup="listbox"]').first().click(); await page.getByRole('option', { name: gesture, exact: true }).getByRole('button').click(); }
    if (condition === 'button') await page.getByRole('button', { name: /^Capture.*Space$/ }).click();
    await page.waitForFunction(n => JSON.parse(localStorage.getItem('emg-study-session')).trials.length === n, index + 1, { timeout: 20000 });
  }
  const measured = await page.evaluate(() => JSON.parse(localStorage.getItem('emg-study-session')));
  assert.ok(measured.trials.every(trial => !complete.records.some(record => record.id === trial.id)));
  assert.equal(measured.obstacleCount, 7); assert.equal(measured.startingLives, 4);
  await page.getByRole('button', { name: 'Review captures', exact: true }).click();
  await page.getByRole('button', { name: 'Train model', exact: true }).click();
  await page.waitForFunction(() => !!JSON.parse(localStorage.getItem('emg-study-session')).modelRevisionId);
  assert.equal(await page.getByRole('button', { name: 'Play', exact: true }).isEnabled(), true);
  fs.writeFileSync(path.join(out, 'actual-measured-state.json'), JSON.stringify(await page.evaluate(() => JSON.parse(localStorage.getItem('emg-study-session'))), null, 2));
  fs.writeFileSync(path.join(out, 'actual-practice-readback.json'), JSON.stringify(complete, null, 2));
  const exported = await fetch(url + '/api/study/export/' + experiment.id + '/collection', { headers: { 'x-admin-pin': 'emg-admin' } });
  assert.equal(exported.status, 200);
  fs.writeFileSync(path.join(out, 'actual-export.zip'), Buffer.from(await exported.arrayBuffer()));
  report.checkpoints.push('Measured recorder and actual Train use only new measured examples; current game limits preserved');
  await page.getByRole('button', { name: 'Back to capture', exact: true }).click();
  if (process.env.EMG_PRACTICE_ZERO_COUNTDOWN === '1') await page.getByLabel('Countdown ms').fill('0');
  await page.getByRole('button', { name: 'Reopen guided practice', exact: true }).click();
  await page.getByRole('heading', { name: 'Guided practice', exact: true }).waitFor({ timeout: 5000 });
  assert.deepEqual((await page.evaluate(() => JSON.parse(localStorage.getItem('emg-study-session')))).trials, measured.trials);
  report.checkpoints.push('Reopening practice preserves measured data');
  if (process.env.EMG_PRACTICE_ZERO_COUNTDOWN === '1') {
    await page.getByRole('button', { name: 'Begin practice', exact: true }).click();
    await page.getByRole('button', { name: 'I’m ready to rest', exact: true }).click();
    await page.getByRole('button', { name: 'Begin resting recording', exact: true }).click();
    await page.getByRole('heading', { name: 'Practise recording', exact: true }).waitFor({ timeout: 20000 });
    await page.getByRole('button', { name: 'Practise Pinch', exact: true }).click();
    await page.getByText('Pinch practice example saved.', { exact: true }).waitFor({ timeout: 8000 });
    const records = (await request('GET', '/practice/' + participant.id)).records;
    assert.ok(records.some(record => record.kind === 'capture' && record.settings.countdownMs === 0));
    assert.deepEqual((await page.evaluate(() => JSON.parse(localStorage.getItem('emg-study-session')))).trials, measured.trials);
    report.checkpoints.push('Zero-countdown practice records through the real hook without altering retained measured examples');
  }
  }
  assert.deepEqual(report.errors, []);
  if (!recovery) assert.deepEqual(report.consoleErrors, []);
  else { report.expectedConsoleFailures = 2; assert.equal(report.consoleErrors.length, 2); }
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
