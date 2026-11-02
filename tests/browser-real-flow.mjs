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
const out = process.env.EMG_PRACTICE_EVIDENCE || fs.mkdtempSync(path.join(os.tmpdir(), 'emg-practice-evidence-'));
fs.mkdirSync(out, { recursive: true });
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'emg-real-flow-'));
const report = { passed: false, condition, evidence: out, errors: [], consoleErrors: [], checkpoints: [], writes: [] };
let server, browser, page;
try {
  const config = await loadConfigFromFile({ command: 'serve', mode: 'development' }, path.join(root, 'vite.config.ts'));
  const port = await new Promise((resolve, reject) => { const probe = net.createServer(); probe.once('error', reject); probe.listen(0, '127.0.0.1', () => { const port = probe.address().port; probe.close(() => resolve(port)); }); });
  server = await createServer({ ...config.config, root, configFile: false, cacheDir: path.join(data, '.vite-cache'), plugins: [studyApiPlugin(data), ...config.config.plugins.filter(plugin => plugin?.name !== 'study-api')], server: { host: '127.0.0.1', port, strictPort: true, open: false } });
  await server.listen();
  const url = `http://127.0.0.1:${port}`;
  const request = async (method, endpoint, body, admin = false, binary = false) => {
    const response = await fetch(url + '/api/study' + endpoint, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(admin ? { 'x-admin-pin': 'emg-admin' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.ok(response.ok, `${endpoint}: ${response.status} ${await response.clone().text()}`);
    return binary ? Buffer.from(await response.arrayBuffer()) : response.json();
  };
  const experiment = await request('POST', '/experiments', { name: 'Disposable faithful rehearsal', repetitions: 1, capturesMin: 1, capturesMax: 1, obstacleCount: 3, startingLives: 3 }, true);
  const participant = (await request('POST', '/participants/generate', { experimentId: experiment.id, count: 1, assignment: condition, isTestParticipant: true }, true)).participants[0];
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  // Ordinary assignments get only Ganglion connection, not participant-facing test controls.
  const ordinary = (await request('POST', '/participants/generate', { experimentId: experiment.id, count: 1, assignment: condition, isTestParticipant: false }, true)).participants[0];
  const ordinaryContext = await browser.newContext();
  const ordinaryPage = await ordinaryContext.newPage();
  await ordinaryPage.goto(url, { timeout: 60000 });
  await ordinaryPage.getByLabel('Participant ID').fill(ordinary.id);
  await ordinaryPage.getByRole('button', { name: 'Continue', exact: true }).click();
  await ordinaryPage.getByRole('heading', { name: 'Learn the real collection flow', exact: true }).waitFor();
  assert.equal(await ordinaryPage.getByRole('button', { name: 'Mock', exact: true }).count(), 0);
  assert.equal(await ordinaryPage.getByRole('button', { name: 'Start mock stream', exact: true }).count(), 0);
  assert.equal(await ordinaryPage.getByRole('button', { name: 'Connect device', exact: true }).count(), 1);
  assert.equal(await ordinaryPage.getByRole('spinbutton').count(), 0);
  await ordinaryPage.screenshot({ path: path.join(out, '00-ordinary-assignment.png'), fullPage: true });
  await ordinaryContext.close();
  report.checkpoints.push('Real researcher-created ordinary assignment defaults to Ganglion with no Mock/developer settings');
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(12000);
  page.setDefaultNavigationTimeout(60000);
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
  page.on('request', req => { if (req.method() === 'POST' && req.url().includes('/api/study/')) report.writes.push({ url: req.url().replace(url, ''), kind: req.postDataJSON()?.record?.kind, eventType: req.postDataJSON()?.record?.type, detail: req.postDataJSON()?.record?.detail }); });
  await page.goto(url);
  await page.getByLabel('Participant ID').fill(participant.id);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.waitForURL('**/session');
  await page.getByRole('heading', { name: 'Learn the real collection flow', exact: true }).waitFor();
  await page.screenshot({ path: path.join(out, '01-preparation.png'), fullPage: true });
  await page.getByRole('button', { name: 'Begin practice', exact: true }).focus();
  await page.keyboard.press('Space');
  await page.getByRole('heading', { name: 'Watch your signal', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Connect device', exact: true }).count(), 1, 'test IDs also default to real input');
  await page.getByRole('button', { name: 'Mock', exact: true }).click();
  await page.getByLabel('Simulated signal', { exact: true }).waitFor();
  // Observe actual mounted status changes; never inject readiness or waveforms.
  await page.evaluate(() => {
    window.__observedCaptureStates = [];
    const observe = () => { const value = document.querySelector('[data-capture-state]')?.getAttribute('data-capture-state'); if (value && window.__observedCaptureStates.at(-1) !== value) window.__observedCaptureStates.push(value); };
    new MutationObserver(observe).observe(document.body, {subtree:true,childList:true,attributes:true,attributeFilter:['data-capture-state']}); observe();
  });
  await page.getByRole('button', { name: 'Start mock stream', exact: true }).click();
  const orientationGuide = page.getByRole('region', { name: 'Practice guidance', exact: true });
  await orientationGuide.getByRole('button', { name: 'I’m ready to rest', exact: true }).waitFor();
  await page.waitForTimeout(700);
  const graphBox = await page.locator('[data-practice-target="signal"]').boundingBox();
  const guideBox = await orientationGuide.boundingBox();
  const side = await orientationGuide.getAttribute('data-guide-side');
  assert.ok(graphBox && guideBox && side, 'real graph orientation has an anchored instruction');
  const distances = [guideBox.x - graphBox.x - graphBox.width, graphBox.x - guideBox.x - guideBox.width, guideBox.y - graphBox.y - graphBox.height, graphBox.y - guideBox.y - guideBox.height];
  assert.ok(distances.some(gap => gap >= -1 && gap <= 20), 'instruction sits beside the graph, not over it or far away');
  assert.ok(guideBox.x >= 0 && guideBox.y >= 0 && guideBox.x + guideBox.width <= 1441 && guideBox.y + guideBox.height <= 1001, 'guide and its action stay inside the viewport');
  await page.screenshot({ path: path.join(out, '01a-graph-guidance.png'), fullPage: true });
  await orientationGuide.getByRole('button', { name: 'I’m ready to rest', exact: true }).click();
  await page.getByRole('button', { name: 'Begin resting recording', exact: true }).click();
  await page.waitForTimeout(350);
  await page.getByRole('button', { name: 'Cancel recording', exact: true }).click();
  assert.equal((await request('GET', '/practice/' + participant.id)).records.length, 0);
  report.checkpoints.push('Partial rest cancellation archives nothing and does not advance');
  // Fail one real request, then use the real Retry control and read-back.
  let failedRest = false;
  await page.route('**/api/study/practice', async route => {
    const record = route.request().postDataJSON()?.record;
    if (record?.kind === 'rest' && !failedRest) { failedRest = true; await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Disposable fixture intentional failure' }) }); }
    else await route.continue();
  });
  await page.getByRole('button', { name: 'Begin resting recording', exact: true }).click();
  await page.getByRole('button', { name: 'Retry saving practice', exact: true }).waitFor({ timeout: 22000 });
  await page.getByRole('button', { name: 'Retry saving practice', exact: true }).click();
  await page.getByRole('region', { name: 'Practice objective', exact: true }).waitFor();
  report.checkpoints.push('10s real Mock rest, save failure, exact retry and readback');
  await page.getByRole('region', { name: 'Practice guidance', exact: true }).getByText(/Recording starts on its own|You choose when to record/).waitFor();
  await page.waitForTimeout(5000);
  assert.equal((await request('GET', '/practice/' + participant.id)).records.filter(r => r.kind === 'capture').length, 0, 'No unseen automatic capture while the method introduction is open');
  await page.getByRole('button', { name: 'Begin gesture practice', exact: true }).click();
  const panelBorder = await page.getByRole('region', { name: 'Session steps', exact: true }).evaluate(element => {
    const style = getComputedStyle(element), canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d'); context.fillStyle = style.borderTopColor; context.fillRect(0, 0, 1, 1);
    return { alpha: context.getImageData(0, 0, 1, 1).data[3] / 255, width: parseFloat(style.borderTopWidth) };
  });
  assert.ok(panelBorder.alpha >= 0.2 && panelBorder.width >= 1, 'Participant panels need visibly separated borders without changing their layout');
  const measuredState = await page.evaluate(() => localStorage.getItem('emg-study-session'));
  // Use the unchanged configured countdown and recorder window.
  const selectGesture = async name => {
    await page.locator('button[aria-haspopup="listbox"]').first().click();
    await page.getByRole('option', { name, exact: true }).click();
  };
  const archiveCount = async () => (await request('GET', '/practice/' + participant.id)).records.filter(r => r.kind === 'capture').length;
  const capture = async (name, expected, keyboard = false) => {
    await selectGesture(name);
    if (condition === 'button') {
      const captureButton = page.getByRole('button', { name: /^Capture Space$/ });
      await captureButton.waitFor();
      await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent.includes('Capture') && b.textContent.includes('Space') && !b.disabled));
      if (keyboard) { await captureButton.focus(); await page.keyboard.press('Space'); }
      else await captureButton.click();
    }
    const until = Date.now() + 18000;
    while (Date.now() < until && await archiveCount() < expected) await page.waitForTimeout(200);
    assert.ok(await archiveCount() >= expected, `Real recorder completed ${name}`);
  };
  await capture('Wrist up', 1, true);
  await page.getByRole('button', { name: 'Continue practice', exact: true }).click();
  await capture('Wrist up', 2);
  await capture('Wrist up', 3);
  await capture('Wrist down', 4);
  await capture('Wrist down', 5);
  await capture('Wrist down', 6);
  const captures = (await request('GET', '/practice/' + participant.id)).records.filter(r => r.kind === 'capture');
  const estimatedRest = (await request('GET', '/practice/' + participant.id)).records.find(r => r.kind === 'rest');
  assert.ok(estimatedRest.calibration && estimatedRest.calibration.count === estimatedRest.points.length);
  assert.ok(captures.every(sample => JSON.stringify(sample.calibration) === JSON.stringify(estimatedRest.calibration)), 'All actual practice captures retain their frozen rest revision');
  assert.equal(captures.length,6);for(const id of ['wrist-up','wrist-down'])assert.equal(captures.filter(sample=>sample.gestureId===id).length,3);
  assert.ok(captures.every(sample=>sample.flowVersion===3&&sample.captureProcedure===condition&&sample.triggerMode===condition));
  if (condition === 'threshold') assert.ok(captures.every(sample => sample.triggeredAt - sample.firstCrossingAt >= 100));
  await page.screenshot({ path: path.join(out, '02-collect.png'), fullPage: true });
  assert.equal(await page.evaluate(() => localStorage.getItem('emg-study-session')), measuredState, 'Practice never changes measured session');
  await page.getByRole('button', { name: 'Review captures', exact: true }).click();
  await page.getByRole('button', { name: 'Graph', exact: true }).first().click();
  const dialog=page.getByRole('dialog',{name:'Saved sample graph'});
  await dialog.waitFor();assert.equal(await page.getByRole('region',{name:'Practice guidance',exact:true}).count(),0,'no guide behind modal');
  await page.getByRole('region',{name:'Saved graph guidance'}).waitFor();
  assert.equal(await dialog.getByRole('button',{name:'Close sample graph',exact:true}).evaluate(el=>document.activeElement===el),true);
  report.geometry=[];
  for(const viewport of [{width:1440,height:1000},{width:1280,height:720}]){
    await page.setViewportSize(viewport);await page.waitForTimeout(350);
    for(const locator of [page.getByRole('region',{name:'Saved graph guidance'}),dialog.getByRole('button',{name:'Close sample graph',exact:true})]){const b=await locator.boundingBox();assert.ok(b&&b.x>=0&&b.y>=0&&b.x+b.width<=viewport.width+1&&b.y+b.height<=viewport.height+1);report.geometry.push({screen:'saved-graph',viewport,box:b});}
    await page.screenshot({path:path.join(out,`03-graph-${viewport.width}.png`),fullPage:false});
  }
  await page.keyboard.press('Shift+Tab');assert.equal(await page.evaluate(()=>!!document.activeElement?.closest('[role="dialog"]')),true,'focus stays inside modal');
  await page.keyboard.press('Escape');await dialog.waitFor({state:'detached'});
  assert.equal(await page.getByRole('button',{name:'Graph',exact:true}).first().evaluate(el=>document.activeElement===el),true,'focus restored');
  await page.getByRole('button',{name:'Graph',exact:true}).first().click();
  await page.setViewportSize({width:1440,height:1000});
  const activityGraph = page.getByRole('region', { name: 'Saved movement activity', exact: true });
  await activityGraph.locator('.recharts-line-curve').waitFor();
  const ticks = await activityGraph.locator('.recharts-yAxis .recharts-cartesian-axis-tick-value').allTextContents();
  assert.ok(ticks.length && ticks.every(value => Number(value.replaceAll(',', '')) >= 0), 'Expanded participant graph has a nonnegative activity axis');
  const rawDetails = page.locator('details').filter({has:page.getByText('Researcher details: raw signal and data',{exact:true})});
  assert.equal(await rawDetails.getAttribute('open'), null);
  assert.equal(await rawDetails.locator('pre').isVisible(), false, 'Raw numerical detail is not participant-facing by default');
  await page.screenshot({ path: path.join(out, '03-graph.png'), fullPage: true });
  await rawDetails.locator('summary').click();
  const rawCsv = await rawDetails.locator('pre').innerText();
  assert.ok(rawCsv.includes(`${captures[0].gestureName},0,0,${captures[0].points[0].value}`), 'Expanded raw CSV retains the actual archived first sample');
  await rawDetails.locator('summary').click();
  const states = await page.evaluate(() => window.__observedCaptureStates);
  for (const state of ['Rest','Ready','Movement','Recording']) assert.ok(states.includes(state), 'Actual browser circle showed '+state);
  report.checkpoints.push('Actual circle Rest/Ready/Movement/Recording; positive expanded sample display with collapsed unchanged raw CSV');
  await page.getByRole('button', { name: 'Close sample graph',exact:true }).click();
  await page.getByRole('button', { name: 'Delete Wrist up sample 1', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'Train model', exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: 'Back to capture', exact: true }).click();
  await capture('Wrist up', 7, true);
  await page.getByRole('button', { name: 'Review captures', exact: true }).click();
  await page.getByRole('button', { name: 'Graph', exact: true }).last().click();
  await page.getByRole('button', { name:'Close sample graph',exact:true }).click();
  // Fail a training archive while the actual model is constructed; completion must not bypass it.
  let allowTrainingSave = false;
  let failedTrainingRecord;
  const trainingPosts = [];
  await page.route('**/api/study/practice', async route => {
    const record = route.request().postDataJSON()?.record;
    if (record?.kind === 'training') trainingPosts.push(record);
    if (record?.kind === 'training' && !allowTrainingSave) {
      failedTrainingRecord ??= record;
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Disposable training archive failure' }) });
    } else await route.continue();
  });
  await page.getByRole('button', { name: 'Train model', exact: true }).click();
  await page.getByRole('button', { name: 'Retry saving practice', exact: true }).waitFor();
  // Hold the outage through automatic retries, then wait for the failed
  // operation to settle. Saving its archive must not restore model readiness.
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent.trim() === 'Train model' && !button.disabled), null, { timeout: 20000 });
  assert.equal(await page.getByRole('button', { name: 'Play', exact: true }).isDisabled(), true);
  allowTrainingSave = true;
  // Native keyboard activation avoids the inherited anchored-guide scroll race.
  await page.getByRole('button', { name: 'Retry saving practice', exact: true }).focus();
  await page.keyboard.press('Space');
  await page.getByRole('button', { name: 'Retry saving practice', exact: true }).waitFor({ state: 'detached' });
  const savedTraining = (await request('GET', '/practice/' + participant.id)).records.find(record => record.id === failedTrainingRecord?.id);
  assert.ok(failedTrainingRecord && trainingPosts.length >= 2 && savedTraining?.kind === 'training');
  assert.ok(trainingPosts.every(record => record.id === failedTrainingRecord.id && JSON.stringify(record) === JSON.stringify(failedTrainingRecord)), 'Recovery retries the same immutable training record');
  assert.deepEqual(savedTraining.sampleIds, failedTrainingRecord.sampleIds);
  assert.equal(await page.getByRole('button', { name: 'Play', exact: true }).isDisabled(), true, 'Archive Retry alone cannot republish the invalidated model');
  await page.getByRole('button', { name: 'Train model', exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent.trim() === 'Play' && !button.disabled), null, { timeout: 20000 });
  const retrained = (await request('GET', '/practice/' + participant.id)).records.filter(record => record.kind === 'training');
  assert.ok(retrained.some(record => record.id !== failedTrainingRecord.id && record.status === 'success'), 'An actual new training revision is archived before Play enables');
  report.checkpoints.push('Persistent training-save outage retains the exact archive; Retry alone stays unready; real retraining persists a new playable revision');
  await page.screenshot({ path: path.join(out, '04-trained.png'), fullPage: true });
  report.checkpoints.push('Same sample list/Graph/Delete/replacement/Train; failed archive retries; configured countdown and native Space record real windows');
  let run;
  const maxGameRuns = Math.max(1, Math.min(2, Number(process.env.EMG_MAX_GAME_RUNS) || 2));
  for (let retry = 0; retry < maxGameRuns; retry++) {
    if (retry === 0) await page.getByRole('button', { name: 'Play', exact: true }).click();
    else await page.getByRole('button', { name: 'Replay game', exact: true }).click();
    if (await page.getByRole('region', { name: 'Practice game introduction', exact: true }).count()) {
      await page.screenshot({ path: path.join(out, '05-game-introduction.png'), fullPage: true });
      assert.equal((await request('GET', '/practice/' + participant.id)).records.filter(record => record.kind === 'game').length, 0, 'The introduction cannot fabricate a game result');
      await page.getByRole('button', { name: 'Start practice game', exact: true }).click();
    }
    await page.getByText('Neural Runner', { exact: true }).waitFor({ timeout: 15000 });
    assert.equal(await page.getByRole('region', { name: 'Practice guidance', exact: true }).count(), 0, 'No onboarding overlay during the actual game');
    await page.screenshot({ path: path.join(out, `05-game-${retry}.png`), fullPage: true });
    await page.getByRole('button', { name: 'Begin collection', exact: true }).waitFor({ timeout: 150000 });
    await page.waitForTimeout(600);
    const records = (await request('GET', '/practice/' + participant.id)).records;
    run = records.filter(r => r.kind === 'game').at(-1);
    assert.ok(run?.outcomes.length,'actual game archived its outcomes');
  }
  assert.ok(run?.outcomes.some(item => item.result !== 'recording_failure'), 'Bounded actual game yielded a scored attempt, not seeded outcomes');
  await page.screenshot({ path: path.join(out, '06-results.png'), fullPage: true });
  const gameRecords=(await request('GET','/practice/'+participant.id)).records;
  const games=gameRecords.filter(r=>r.kind==='game');assert.equal(games.length,maxGameRuns,'bounded actual game runs');if(games.length===2){assert.equal(games[0].trainingId,games[1].trainingId);assert.deepEqual(games[0].sampleIds,games[1].sampleIds);}report.actualGameRuns=games.length;report.actualReplayVerified=games.length===2;
  assert.ok(games.every(g=>g.outcomes.every(o=>['wrist-up','wrist-down'].includes(o.expectedGestureId))));
  for(const viewport of [{width:1440,height:1000},{width:1280,height:720}]){
    await page.setViewportSize(viewport);await page.waitForTimeout(350);
    const guide=page.getByRole('region',{name:'Practice guidance',exact:true});await guide.scrollIntoViewIfNeeded();const b=await guide.boundingBox();assert.ok(b&&b.x>=0&&b.y>=0&&b.x+b.width<=viewport.width+1&&b.y+b.height<=viewport.height+1);report.geometry.push({screen:'results',viewport,box:b});
    await page.screenshot({path:path.join(out,`06-results-guide-${viewport.width}.png`),fullPage:false});
    await guide.getByRole('button',{name:'Hide guidance'}).click();
    const explanation=page.getByRole('region',{name:'Results guidance'});await explanation.scrollIntoViewIfNeeded();assert.match(await explanation.innerText(),/same kept samples and trained model/);
    await page.screenshot({path:path.join(out,`06-results-explanation-${viewport.width}.png`),fullPage:false});
    await page.getByRole('button',{name:'Replay game',exact:true}).scrollIntoViewIfNeeded();await page.screenshot({path:path.join(out,`06-results-actions-${viewport.width}.png`),fullPage:false});
    await guide.getByRole('button',{name:'Show guidance again'}).click();
  }
  await page.setViewportSize({width:1440,height:1000});await page.getByRole('region',{name:'Practice guidance',exact:true}).getByRole('button',{name:'Hide guidance'}).click();
  assert.equal(await page.evaluate(() => localStorage.getItem('emg-study-session')), measuredState);
  report.checkpoints.push('Actual mounted game feeds actual Results, with honest predictions');
  assert.ok(report.writes.every(item => !['/api/study/collection', '/api/study/progress', '/api/study/runs'].includes(item.url)), 'All rehearsal writes use /practice only');
  let failedCompletion = false;
  await page.route('**/api/study/practice', async route => {
    const record = route.request().postDataJSON()?.record;
    if (record?.kind === 'completed' && !failedCompletion) { failedCompletion = true; await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Disposable completion failure' }) }); }
    else await route.continue();
  });
  await page.getByRole('button', { name: 'Begin collection', exact: true }).click();
  await page.getByRole('button', { name: 'Retry saving practice', exact: true }).waitFor();
  assert.equal(await page.getByRole('region', { name: 'Practice objective', exact: true }).count(), 1);
  await page.getByRole('button', { name: 'Retry saving practice', exact: true }).click();
  await page.getByRole('button', { name: 'Begin collection', exact: true }).click();
  await page.getByRole('button', { name: 'Reopen guided practice', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Pause stream', exact: true }).count(), 1, 'Stream connection preserved into measured mode');
  assert.equal((await page.evaluate(() => JSON.parse(localStorage.getItem('emg-study-session')))).trials.length, 0);
  await page.screenshot({ path: path.join(out, '07-measured.png'), fullPage: true });
  // The measured quota remains one per gesture in this disposable experiment.
  await selectGesture('Wrist up');
  if(condition==='button'){
    await page.getByText('Researcher controls',{exact:true}).focus();await page.keyboard.press('Space');
    await page.waitForTimeout(200);assert.equal((await page.evaluate(()=>JSON.parse(localStorage.getItem('emg-study-session')))).openCapture,null);
    await page.getByText('Countdown ms',{exact:true}).locator('input').fill('0');
    const theme=page.getByRole('button',{name:/Light mode|Dark mode/}).first();await theme.focus();await page.keyboard.press('Space');await page.waitForTimeout(200);
    assert.equal((await page.evaluate(()=>JSON.parse(localStorage.getItem('emg-study-session')))).trials.length,0);
    await page.getByRole('button',{name:/^Capture Space$/}).focus();await page.keyboard.press('Space');
  }
  await page.waitForFunction(()=>JSON.parse(localStorage.getItem('emg-study-session')).trials.some(t=>t.gestureId==='wrist-up'),null,{timeout:18000});
  if(condition==='button'){
    const zero=(await page.evaluate(()=>JSON.parse(localStorage.getItem('emg-study-session')))).trials[0];assert.ok(zero.points.length>=6);
    await page.getByRole('button',{name:'Delete Wrist up sample 1',exact:true}).click();
    await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(b=>b.textContent.includes('Capture')&&b.textContent.includes('Space')&&!b.disabled));
    await page.evaluate(()=>document.activeElement?.blur());await page.keyboard.press('Space');
    await page.waitForFunction(()=>JSON.parse(localStorage.getItem('emg-study-session')).trials.some(t=>t.gestureId==='wrist-up'));
    await page.getByText('Countdown ms',{exact:true}).locator('input').fill('3000');
    report.checkpoints.push('Measured zero-countdown native Capture Space and background Space save real active wrist windows; theme/details Space retain native behavior');
  }
  const measuredBeforeReconnect=await page.evaluate(()=>JSON.parse(localStorage.getItem('emg-study-session')));
  await page.getByRole('button',{name:'Pause stream',exact:true}).click();await page.getByRole('button',{name:'Start mock stream',exact:true}).click();
  await selectGesture('Wrist down');await page.waitForTimeout(5500);
  assert.equal((await page.evaluate(()=>JSON.parse(localStorage.getItem('emg-study-session')))).trials.length,1);
  await page.getByRole('region',{name:'Fixed rest calibration'}).getByText(/Redo your resting setup before recording/).waitFor();
  await page.getByRole('button',{name:'Redo resting setup',exact:true}).click();await page.getByRole('button',{name:'Begin resting recording',exact:true}).click();
  await page.getByRole('region',{name:'Fixed rest calibration'}).waitFor({timeout:22000});
  assert.equal((await page.evaluate(()=>JSON.parse(localStorage.getItem('emg-study-session')))).trials.find(t=>t.gestureId==='wrist-up').id,measuredBeforeReconnect.trials[0].id);
  if(condition==='button')await page.getByRole('button',{name:/^Capture Space$/}).click();
  await page.waitForFunction(()=>JSON.parse(localStorage.getItem('emg-study-session')).trials.some(t=>t.gestureId==='wrist-down'),null,{timeout:18000});await page.waitForTimeout(700);
  const measuredAfterReconnect=await page.evaluate(()=>JSON.parse(localStorage.getItem('emg-study-session')));
  assert.equal(measuredAfterReconnect.trials.length,2);assert.equal(measuredAfterReconnect.capturesMin,1);assert.equal(measuredAfterReconnect.capturesMax,1);
  assert.deepEqual(measuredAfterReconnect.trials.find(t=>t.gestureId==='wrist-up').calibration,estimatedRest.calibration);
  assert.notEqual(measuredAfterReconnect.trials.find(t=>t.gestureId==='wrist-down').calibration.revision,estimatedRest.calibration.revision);
  report.checkpoints.push('Reconnect disarms; full-duration rest recalibration preserves earlier measured wrist lineage; measured quota remains unchanged');
  const records = (await request('GET', '/practice/' + participant.id)).records;
  assert.deepEqual(records.find(record => record.id === estimatedRest.id), estimatedRest, 'Original estimate remains immutable after gestures and recalibration');
  fs.writeFileSync(path.join(out, 'practice-records.json'), JSON.stringify(records, null, 2));
  assert.ok(records.some(r => r.kind === 'completed'));
  const restored = await request('POST', '/join', { id: participant.id });
  assert.equal(restored.status, 'in_progress');
  assert.equal(restored.restored?.trials.length, 2, 'Server retains the actual measured captures, not practice samples');
  assert.ok((restored.restored?.trials ?? []).every(trial => trial.calibration && !records.some(record => record.kind === 'capture' && record.id === trial.id)));
  const freshContext = await browser.newContext();
  const freshPage = await freshContext.newPage();
  await freshPage.goto(url, { timeout: 60000 });
  await freshPage.getByLabel('Participant ID').fill(participant.id);
  await freshPage.getByRole('button', { name: 'Continue', exact: true }).click();
  await freshPage.getByRole('button', { name: 'Reopen guided practice', exact: true }).waitFor();
  assert.equal(await freshPage.getByRole('button', { name: 'Delete Wrist up sample 1', exact: true }).count(), 1);
  assert.equal(await freshPage.getByRole('button', { name: 'Connect device', exact: true }).count(), 1, 'Fresh rejoin returns to real input and remains disarmed');
  await freshPage.screenshot({ path: path.join(out, '08-fresh-rejoin.png'), fullPage: true });
  await freshPage.getByText('Researcher controls', {exact:true}).click();
  await freshPage.getByRole('button', { name: 'Mock', exact: true }).click();
  await freshPage.getByRole('button', { name: 'Start mock stream', exact: true }).click();
  await freshPage.getByRole('region', { name: 'Fixed rest calibration' }).getByText(/Redo your resting setup before recording/).waitFor();
  await freshContext.close();
  await page.reload();
  await page.getByRole('region', { name: 'Fixed rest calibration' }).getByText(/Redo your resting setup before recording/).waitFor();
  report.checkpoints.push('Fresh browser rejoin and ordinary reload retain capture evidence but never restore live readiness');
  const zip = await request('GET', '/export/' + experiment.id + '/collection', undefined, true, true);
  fs.writeFileSync(path.join(out, 'collection.zip'), zip);
  let offset = 0; const entries = {};
  while (zip.readUInt32LE(offset) === 0x04034b50) { const size = zip.readUInt32LE(offset + 18), n = zip.readUInt16LE(offset + 26), e = zip.readUInt16LE(offset + 28); const name = zip.subarray(offset + 30, offset + 30 + n).toString(); const start = offset + 30 + n + e; entries[name] = zip.subarray(start, start + size).toString(); offset = start + size; }
  const exported = JSON.parse(entries['waveforms.json']);
  for (const trial of measuredAfterReconnect.trials) { const archived = exported.samples.find(sample => sample.sampleId === trial.id); assert.deepEqual(archived.calibration, trial.calibration); assert.deepEqual(archived.points, trial.points); assert.equal(archived.firstCrossingAt, trial.firstCrossingAt); }
  assert.match(entries['samples.csv'], /calibration_revision/);
  assert.deepEqual(JSON.parse(entries['practice.json']).records.filter(record => record.kind === 'rest').map(record => record.calibration), records.filter(record => record.kind === 'rest').map(record => record.calibration));
  report.checkpoints.push('Decoded ZIP joins actual practice/rest/measured revisions and exact waveform timestamps/raw values');
  report.checkpoints.push('Completion save failure blocks transition, retry/readback retains lineage; measured trials/model empty, stream preserved; real API ZIP exported');
  assert.equal(report.errors.length, 0, report.errors.join('\n'));
  report.passed = true;
} catch (error) {
  report.failure = error.stack;
  if (page) report.failureSession = await page.evaluate(() => localStorage.getItem('emg-study-session')).catch(() => null);
  if (page) { await page.screenshot({ path: path.join(out, 'failure.png'), fullPage: true }).catch(() => {}); fs.writeFileSync(path.join(out, 'failure-body.txt'), await page.locator('body').innerText().catch(() => '')); }
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  if (server) await server.close();
  fs.rmSync(data, { recursive: true, force: true });
  report.cleanedFixture = true;
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
