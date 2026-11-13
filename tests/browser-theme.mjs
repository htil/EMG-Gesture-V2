import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { createServer, loadConfigFromFile } from 'vite';
import { studyApiPlugin } from '../server/study-api.mjs';
const { chromium } = await import('/root/emg-review-tools/node_modules/playwright/index.mjs');
const out = process.env.EMG_THEME_EVIDENCE || '/workspace/EMG-Next-UI-Theme-Validation';
fs.mkdirSync(out, { recursive: true });
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'emg-theme-'));
const report = { passed: false, pageErrors: [], consoleErrors: [], checks: [] };
let server, browser, page;
try {
  const config = await loadConfigFromFile({ command: 'serve', mode: 'development' }, path.resolve('vite.config.ts'));
  const port = await new Promise(resolve => { const probe = net.createServer(); probe.listen(0, '127.0.0.1', () => { const port = probe.address().port; probe.close(() => resolve(port)); }); });
  server = await createServer({ ...config.config, root: process.cwd(), configFile: false, cacheDir: path.join(temp, 'cache'),
    plugins: [studyApiPlugin(path.join(temp, 'data')), ...config.config.plugins.filter(p => p?.name !== 'study-api')],
    server: { host: '127.0.0.1', port, strictPort: true, open: false } });
  await server.listen();
  const url = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(10000);
  page.setDefaultNavigationTimeout(60000);
  page.on('pageerror', e => report.pageErrors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') report.consoleErrors.push(m.text()); });
  await page.goto(url);
  const toggle = page.getByRole('button', { name: 'Light mode', exact: true });
  await toggle.waitFor({ timeout: 15000 });
  assert.equal(await toggle.getAttribute('aria-pressed'), 'false');
  assert.equal(await page.locator('[data-participant-theme]').getAttribute('data-participant-theme'), 'dark');
  const initialStorage = await page.evaluate(() => ({ ...localStorage }));
  await page.screenshot({ path: path.join(out, 'entry-dark.png'), fullPage: true });
  await toggle.focus(); await page.keyboard.press('Enter');
  assert.equal(await toggle.getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('[data-participant-theme]').getAttribute('data-participant-theme'), 'light');
  const storage = await page.evaluate(() => ({ ...localStorage }));
  assert.deepEqual(Object.keys(storage).filter(k => storage[k] !== initialStorage[k]), ['emg-ui-theme']);
  assert.equal(storage['emg-ui-theme'], 'light');
  await page.reload();
  assert.equal(await toggle.getAttribute('aria-pressed'), 'true');
  await page.screenshot({ path: path.join(out, 'entry-light.png'), fullPage: true });
  report.checks.push('Default dark; keyboard toggle; separate visual-only storage; reload persistence');
  if (process.env.EMG_THEME_BASIC !== '1') {
    const colours = await page.getByLabel('Participant ID').evaluate(el => ({ color: getComputedStyle(el).color, background: getComputedStyle(el).backgroundColor }));
    assert.equal(colours.color, 'rgb(15, 23, 42)');
    assert.equal(colours.background, 'rgb(241, 245, 249)');
    report.entryColours = colours;
  }

  if (process.env.EMG_THEME_BASIC !== '1') {
  const condition = 'button';
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
  const checkTheme = async (name, chart = false) => {
    const before = await page.evaluate(() => localStorage.getItem('emg-study-session'));
    for (const mode of ['dark', 'light']) {
      if (await page.locator('[data-participant-theme]').getAttribute('data-participant-theme') !== mode) await toggle.click();
      const colors = await page.locator('h1, h2').first().evaluate(el => ({ color: getComputedStyle(el).color, background: getComputedStyle(el.closest('.min-h-screen')).backgroundColor }));
      assert.equal(colors.background, mode === 'light' ? 'rgb(248, 250, 252)' : 'rgb(5, 8, 18)');
      assert.equal(colors.color, mode === 'light' ? 'rgb(15, 23, 42)' : 'rgb(255, 255, 255)');
      await toggle.focus(); await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
      const outline = await toggle.evaluate(el => getComputedStyle(el).outlineStyle);
      assert.equal(outline, 'solid');
      if (chart) {
        const curve = page.locator('.recharts-area-curve').first();
        await curve.waitFor();
        assert.equal(await curve.evaluate(el => getComputedStyle(el).stroke), mode === 'light' ? 'rgb(14, 116, 144)' : 'rgb(34, 211, 238)');
      }
      await page.screenshot({ path: path.join(out, `${name}-${mode}.png`), fullPage: true });
    }
    assert.equal(await page.evaluate(() => localStorage.getItem('emg-study-session')), before, 'Theme must not mutate or remount the study');
    report.checks.push(name + ': both themes, heading/surface/focus colours, unchanged study storage');
  };
  await page.getByLabel('Participant ID').fill(participant.id);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('heading', { name: 'Guided practice', exact: true }).waitFor();
  await checkTheme('guided-welcome');
  await page.getByRole('button', { name: 'Begin practice', exact: true }).click();
  await page.getByRole('button', { name: 'Start mock stream', exact: true }).click();
  await page.waitForTimeout(600);
  await checkTheme('guided-live', true);
  await page.getByRole('button', { name: 'I’m ready to rest', exact: true }).click();
  await page.getByRole('button', { name: 'Begin resting recording', exact: true }).click();
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(out, 'practice-rest-live.png'), fullPage: true });
  await page.getByRole('heading', { name: 'Practise recording', exact: true }).waitFor({ timeout: 20000 });
  const archived = await request('GET', '/practice/' + participant.id);
  assert.equal(archived.records.filter(record => record.kind === 'rest').length, 1);
  const rest = archived.records.find(record => record.kind === 'rest');
  assert.ok(rest.points.at(-1).time - rest.points[0].time >= 10000);
  assert.equal((await page.evaluate(() => JSON.parse(localStorage.getItem('emg-study-session')))).trials.length, 0);
  report.checks.push('Actual guided rest lasts 10 seconds and persists outside measured training');
  for (const gesture of ['Pinch', 'Squeeze', 'Relax']) {
    await page.getByRole('button', { name: 'Practise ' + gesture, exact: true }).click();
    await page.getByText(gesture + ' practice example saved.', { exact: true }).waitFor({ timeout: 18000 });
    assert.equal((await page.evaluate(() => JSON.parse(localStorage.getItem('emg-study-session')))).trials.length, 0);
  }
  await page.getByRole('heading', { name: 'Review your practice examples', exact: true }).waitFor();
  const captured = await request('GET', '/practice/' + participant.id);
  assert.equal(captured.records.filter(record => record.kind === 'capture').length, 3);
  report.checks.push('Actual assigned recorder saves all three gestures only into the practice archive');
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
  await page.getByRole('region', { name: 'Session steps', exact: true }).waitFor();
  assert.equal(await page.getByRole('region', { name: 'Guided practice', exact: true }).count(), 0);
  await checkTheme('collection', true);
  const collectionTheme = await toggle.getAttribute('aria-pressed');
  await toggle.focus();
  await page.keyboard.press('Space');
  await page.waitForFunction(expected => document.querySelector('.participant-theme-toggle').getAttribute('aria-pressed') === expected, collectionTheme === 'true' ? 'false' : 'true', { timeout: 1500 });
  assert.equal(await page.getByRole('button', { name: /^Capture.*Space$/ }).isEnabled(), true, 'Space on the theme button must not arm a measured recording');
  report.checks.push('Space activates the focused theme button during armed collection without triggering capture');
  const complete = await request('GET', '/practice/' + participant.id);
  assert.equal(complete.records.filter(record => record.kind === 'completed').length, 1);
  assert.equal(complete.records.filter(record => record.kind === 'removed').length, 1);
  assert.equal(complete.records.filter(record => record.kind === 'capture').length, 4);
  report.checks.push('Actual review, removal, replacement and explicit collection transition with durable practice completion');
  for (const [index, gesture] of ['Pinch', 'Squeeze', 'Relax'].entries()) {
    if (index) { await page.locator('button[aria-haspopup="listbox"]').first().click(); await page.getByRole('option', { name: gesture, exact: true }).getByRole('button').click(); }
    if (condition === 'button') {
      const capture = page.getByRole('button', { name: /^Capture.*Space$/ });
      if (index === 0) { await capture.focus(); await page.keyboard.press('Space'); }
      else if (index === 1) { await page.getByRole('heading', { name: 'Live activity', exact: true }).click(); await page.keyboard.press('Space'); }
      else await capture.click();
    }
    await page.waitForFunction(n => JSON.parse(localStorage.getItem('emg-study-session')).trials.length === n, index + 1, { timeout: 20000 });
  }
  const measured = await page.evaluate(() => JSON.parse(localStorage.getItem('emg-study-session')));
  assert.ok(measured.trials.every(trial => !complete.records.some(record => record.id === trial.id)));
  assert.equal(measured.obstacleCount, 7); assert.equal(measured.startingLives, 4);
  await page.getByRole('button', { name: 'Review captures', exact: true }).click();
  await checkTheme('review');
  for (const mode of ['dark', 'light']) {
    if (await page.locator('[data-participant-theme]').getAttribute('data-participant-theme') !== mode) await toggle.click();
    await page.getByRole('button', { name: 'Graph', exact: true }).first().click();
    const drawer = page.locator('aside').filter({ has: page.getByRole('heading', { name: 'Pinch', exact: true }) });
    await drawer.waitFor();
    const tick = drawer.locator('.recharts-cartesian-axis-tick text').first();
    await tick.waitFor();
    assert.equal(await tick.evaluate(el => getComputedStyle(el).fill), mode === 'light' ? 'rgb(71, 85, 105)' : 'rgba(255, 255, 255, 0.55)');
    await page.screenshot({ path: path.join(out, `sample-graph-${mode}.png`), fullPage: true });
    await page.getByRole('button', { name: 'Close sample graph', exact: true }).last().click();
  }
  report.checks.push('Actual measured sample graph drawer and SVG tick contrast in both themes');
  await page.getByRole('button', { name: 'Train model', exact: true }).click();
  await page.waitForFunction(() => !!JSON.parse(localStorage.getItem('emg-study-session')).modelRevisionId);
  assert.equal(await page.getByRole('button', { name: 'Play', exact: true }).isEnabled(), true);
  report.checks.push('Measured recorder and actual Train use only new measured examples; current game limits preserved');
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await page.locator('canvas').first().waitFor({ timeout: 30000 });
  for (const mode of ['dark', 'light']) {
    if (await page.locator('[data-participant-theme]').getAttribute('data-participant-theme') !== mode) await toggle.click();
    if (mode === 'light') assert.equal(await page.locator('circle[fill="rgba(2, 6, 23, .74)"]').evaluate(el => getComputedStyle(el).fill), 'rgb(241, 245, 249)', 'Game status backing must support dark light-theme text');
    const filters = await page.locator('canvas').first().evaluate(el => { const result=[]; for(let p=el;p;p=p.parentElement) result.push(getComputedStyle(p).filter); return result; });
    assert.ok(filters.every(f => f === 'none'), 'No filter on WebGL canvas or its ancestors');
    await page.screenshot({ path: path.join(out, `game-${mode}.png`), fullPage: true });
  }
  await page.getByRole('button', { name: 'Finish Run', exact: true }).click();
  await page.getByRole('heading', { name: 'This run', exact: true }).waitFor();
  await checkTheme('results');
  assert.equal(await page.getByText('No scored attempts yet.', { exact: true }).count(), 1);
  report.checks.push('Real UI game mount, unfiltered canvas, honest empty results; no seeded predictions/outcomes');
  }

  await page.goto(url);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(out, 'entry-mobile-light.png'), fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.evaluate(() => localStorage.setItem('emg-ui-theme', 'invalid'));
  await page.reload();
  assert.equal(await toggle.getAttribute('aria-pressed'), 'false');
  await page.goto(url + '/admin');
  assert.equal(await page.locator('[data-participant-theme]').count(), 0);
  await page.goto(url);
  await page.evaluate(() => {
    const get = Storage.prototype.getItem, set = Storage.prototype.setItem;
    Storage.prototype.getItem = function(key) { if (key === 'emg-ui-theme') throw new DOMException('Blocked', 'SecurityError'); return get.call(this, key); };
    Storage.prototype.setItem = function(key, value) { if (key === 'emg-ui-theme') throw new DOMException('Blocked', 'SecurityError'); return set.call(this, key, value); };
  });
  // A document reload restores built-ins, so exercise unmount/remount via router first.
  await page.evaluate(() => { history.pushState({}, '', '/admin'); dispatchEvent(new PopStateEvent('popstate')); });
  await page.locator('[data-participant-theme]').waitFor({ state: 'detached' });
  await page.evaluate(() => { history.pushState({}, '', '/'); dispatchEvent(new PopStateEvent('popstate')); });
  await toggle.waitFor();
  assert.equal(await toggle.getAttribute('aria-pressed'), 'false');
  await toggle.click();
  assert.equal(await toggle.getAttribute('aria-pressed'), 'true');
  report.checks.push('Mobile entry without horizontal overflow; invalid preference defaults dark; admin unthemed; blocked storage remains usable');
  assert.deepEqual(report.pageErrors, []);
  // Existing SampleGraphPanel spreads Recharts' key into WaveformDot (unchanged here).
  report.knownWarnings = report.consoleErrors.filter(message => message.startsWith('Warning: A props object containing a "key" prop is being spread into JSX:') && message.includes('WaveformDot'));
  assert.deepEqual(report.consoleErrors.filter(message => !report.knownWarnings.includes(message)), []);
  report.passed = true;
} catch (e) {
  report.failure = e.stack;
  if (page) await page.screenshot({ path: path.join(out, 'failure.png'), fullPage: true }).catch(() => {});
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  if (server) await server.close();
  fs.rmSync(temp, { recursive: true, force: true });
  fs.writeFileSync(path.join(out, process.env.EMG_THEME_REPORT || 'browser-results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
