import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createServer, loadConfigFromFile, transformWithEsbuild } from 'vite';
import { dispatchStudyRequest, studyApiPlugin } from '../server/study-api.mjs';

// Declared synthetic replay of paired host timestamps. No BLE/hardware,
// no measured training, no fabricated predictions or session-readiness edits.
const root = process.cwd();
const splitPairs = process.env.EMG_PRACTICE_SPLIT_PAIRS === '1';
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'emg-paired-practice-'));
const out = process.env.EMG_PRACTICE_EVIDENCE || fs.mkdtempSync(path.join(os.tmpdir(), 'emg-paired-evidence-'));
fs.mkdirSync(out, { recursive: true });
const report = { passed: false, scope: 'actual GuidedPractice + API, synthetic paired timestamp input, NOT hardware validation', errors: [] };
let server, browser, page;
try {
  const call = async (pathname, body) => {
    const response = await dispatchStudyRequest(data, { method: 'POST', pathname, body, headers: { 'x-admin-pin': 'emg-admin' }, searchParams: new URLSearchParams() });
    assert.ok(response.status < 400, JSON.stringify(response.body)); return response.body;
  };
  const experiment = await call('/experiments', { name: 'Synthetic paired-timestamp practice replay', repetitions: 1, capturesMin: 1, capturesMax: 1 });
  const participant = (await call('/participants/generate', { experimentId: experiment.id, count: 1, assignment: 'button', isTestParticipant: true })).participants[0];
  const joined = await call('/join', { id: participant.id });
  const session = { ...joined, sessionId: 'synthetic-paired-replay', manualTrigger: true, stage: 'capture', unlockedThrough: 'capture', trials: [], runs: [], pendingReplacements: [], modelRevisionId: null, openCapture: null, trainingRun: null };
  const source = `import React, {useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import GuidedPractice from '/src/app/study/GuidedPractice.tsx';
import '/src/styles/index.css';
const session=${JSON.stringify(session)};
const cue=()=>{};
function Replay(){
 const [points,setPoints]=useState([]),[streaming,setStreaming]=useState(false);
 useEffect(()=>{if(!streaming)return;let first=null;const timer=setInterval(()=>{const now=Date.now();const batch=[];
  if(${splitPairs}){
   if(first===null){first={time:now,raw:0.1,value:0.1,activityEnvelope:0.1,normalizedActivity:0.1};batch.push(first);}
   else{batch.push({...first,raw:0.105});first=null;}
  }else for(let i=0;i<5;i++)for(let pair=0;pair<2;pair++){const time=now-40+i*10;batch.push({time,raw:0.1+pair*0.005+i*0.0001,value:0.1,activityEnvelope:0.1,normalizedActivity:0.1});}
  setPoints(previous=>[...previous,...batch].filter(point=>point.time>=now-5000));
 },50);return()=>clearInterval(timer)},[streaming]);
 return <><p>Synthetic paired host-timestamp replay. No Bluetooth device.</p><GuidedPractice session={session} points={points} streaming={streaming} source="live" channel={0}
 settings={{segmentDurationMs:1200,preTriggerWindowMs:175,countdownMs:3000,activityThreshold:0.6}}
 bluetoothAvailable={true} connectionMessage="Synthetic replay only" onSource={()=>{}} onStream={()=>setStreaming(value=>!value)} onCue={cue}
 renderSignal={()=>null} onComplete={()=>{throw Error('This rest-only replay must not enter collection')}}/></>;
}
createRoot(document.getElementById('root')).render(<Replay/>);`;
  const config = await loadConfigFromFile({ command: 'serve', mode: 'development' }, path.join(root, 'vite.config.ts'));
  const port = await new Promise((resolve, reject) => { const probe = net.createServer(); probe.once('error', reject); probe.listen(0, '127.0.0.1', () => { const value = probe.address().port; probe.close(() => resolve(value)); }); });
  server = await createServer({ ...config.config, root, configFile: false, cacheDir: path.join(data, '.vite-cache'), plugins: [
    studyApiPlugin(data), ...config.config.plugins.filter(plugin => plugin?.name !== 'study-api'),
    { name: 'synthetic-paired-practice-replay', resolveId(id) { if (id === '/practice-replay.jsx') return '\0practice-replay.jsx'; }, load(id) { if (id === '\0practice-replay.jsx') return transformWithEsbuild(source, '/practice-replay.jsx', { loader: 'jsx', jsx: 'automatic' }); }, configureServer(vite) { vite.middlewares.use('/__practice_replay', (_req,res,next) => { vite.transformIndexHtml('/__practice_replay', '<div id="root"></div><script type="module" src="/practice-replay.jsx"></script>').then(html => { res.setHeader('Content-Type','text/html'); res.end(html); }).catch(next); }); } },
  ], server: { host: '127.0.0.1', port, strictPort: true, open: false } });
  await server.listen();
  const { chromium } = await import(process.env.EMG_PLAYWRIGHT_MODULE || '/root/emg-review-tools/node_modules/playwright/index.mjs');
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(10000); page.setDefaultNavigationTimeout(60000);
  page.on('pageerror', error => report.errors.push(error.message));
  const origin = `http://127.0.0.1:${port}`;
  await page.goto(origin + '/__practice_replay');
  await page.getByRole('button', { name: 'Begin practice', exact: true }).click();
  await page.getByRole('button', { name: 'Connect device', exact: true }).click();
  await page.getByRole('button', { name: 'I’m ready to rest', exact: true }).click();
  const started = Date.now();
  await page.getByRole('button', { name: 'Begin resting recording', exact: true }).click();
  await page.getByRole('heading', { name: 'Practise recording', exact: true }).waitFor({ timeout: 18000 });
  const read = await fetch(origin + '/api/study/practice/' + participant.id);
  const records = (await read.json()).records;
  assert.equal(records.length, 1); const rest = records[0];
  assert.ok(rest.points.some((point,index) => index && point.time === rest.points[index-1].time && point.value !== rest.points[index-1].value), 'Paired values/timestamps must be preserved, not deduplicated or retimed');
  assert.ok(rest.points.at(-1).time - rest.points[0].time >= 10000);
  assert.equal(rest.points.filter(point => point.time === rest.points.at(-1).time).length, 2, 'Preserve both distinct samples at the completed window endpoint, including split render batches');
  assert.ok(Date.now() - started >= 10000);
  assert.equal(rest.timing.deviceClockValidated, false);
  assert.ok(rest.timing.duplicateTimestampCount > 0);
  assert.deepEqual(report.errors, []);
  fs.writeFileSync(path.join(out, 'actual-rest-readback.json'), JSON.stringify(rest, null, 2));
  await page.screenshot({ path: path.join(out, 'rest-completed.png'), fullPage: true });
  report.passed = true; report.pointCount = rest.points.length; report.timing = rest.timing;
} catch (error) {
  report.failure = { message: error.message, stack: error.stack }; process.exitCode = 1;
  if (page) { await page.screenshot({ path: path.join(out, 'failure.png'), fullPage: true }).catch(()=>{}); fs.writeFileSync(path.join(out, 'failure-page.txt'), await page.locator('body').innerText().catch(()=>'')); }
} finally {
  if (browser) await browser.close(); if (server) await server.close();
  fs.rmSync(data, { recursive: true, force: true });
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
