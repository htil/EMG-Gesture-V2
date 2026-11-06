// Actual mounted Mock UI regression, no seeded readiness/waveforms/models/outcomes and no game runs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createServer, loadConfigFromFile } from 'vite';
import { studyApiPlugin } from '../server/study-api.mjs';
const { chromium } = await import(process.env.EMG_PLAYWRIGHT_MODULE || '/root/emg-review-tools/node_modules/playwright/index.mjs');
const out=process.env.EMG_PRACTICE_EVIDENCE || fs.mkdtempSync(path.join(os.tmpdir(),'emg-frozen-browser-'));
fs.mkdirSync(out,{recursive:true});
const data=fs.mkdtempSync(path.join(os.tmpdir(),'emg-frozen-api-'));
const report={passed:false,conditions:[],errors:[],gameRuns:0};let server,browser;
try {
 const root=process.cwd(),config=await loadConfigFromFile({command:'serve',mode:'development'},path.join(root,'vite.config.ts'));
 const port=await new Promise(resolve=>{const p=net.createServer();p.listen(0,'127.0.0.1',()=>{const port=p.address().port;p.close(()=>resolve(port));});});
 server=await createServer({...config.config,root,configFile:false,cacheDir:path.join(data,'.vite'),plugins:[studyApiPlugin(data),...config.config.plugins.filter(p=>p?.name!=='study-api')],server:{host:'127.0.0.1',port,strictPort:true,open:false}});await server.listen();
 const url=`http://127.0.0.1:${port}`;
 const api=async(method,endpoint,body,admin=false)=>{const r=await fetch(url+'/api/study'+endpoint,{method,headers:{...(body?{'Content-Type':'application/json'}:{}),...(admin?{'x-admin-pin':'emg-admin'}:{})},...(body?{body:JSON.stringify(body)}:{})});assert.ok(r.ok,await r.clone().text());return r.json();};
 const experiment=await api('POST','/experiments',{name:'Disposable final frozen calibration regression',repetitions:1,capturesMin:1,capturesMax:1},true);
 browser=await chromium.launch({headless:true,args:['--no-sandbox']});
 for(const condition of ['button','threshold']) {
  const participant=(await api('POST','/participants/generate',{experimentId:experiment.id,count:1,assignment:condition,isTestParticipant:true},true)).participants[0];
  const context=await browser.newContext(),page=await context.newPage();page.setDefaultTimeout(18000);page.on('pageerror',e=>report.errors.push(e.message));
  const records=async()=>(await api('GET','/practice/'+participant.id)).records;
  const count=async()=> (await records()).filter(r=>r.kind==='capture').length;
  const waitCount=async n=>{const end=Date.now()+18000;while(Date.now()<end&&await count()<n)await page.waitForTimeout(200);assert.equal(await count(),n);};
  const select=async name=>{await page.locator('button[aria-haspopup="listbox"]').first().click();await page.getByRole('option',{name,exact:true}).click();};
  const captureButton=()=>page.getByRole('button',{name:/^Capture Space$/});
  const rest=async()=>{await page.getByRole('button',{name:'Begin resting recording',exact:true}).click();await page.getByRole('region',{name:'Fixed rest calibration'}).waitFor({timeout:23000});if(await page.getByRole('button',{name:'Begin gesture practice',exact:true}).count())await page.getByRole('button',{name:'Begin gesture practice',exact:true}).click();};
  await page.goto(url);await page.getByLabel('Participant ID').fill(participant.id);await page.getByRole('button',{name:'Continue',exact:true}).click();await page.getByRole('button',{name:'Begin practice',exact:true}).click();await page.getByRole('button',{name:'Mock',exact:true}).click();await page.getByRole('button',{name:'Start mock stream',exact:true}).click();await page.getByRole('button',{name:'I’m ready to rest',exact:true}).click();await rest();
  const original=(await records()).find(r=>r.kind==='rest');assert.ok(original.calibration);
  if(condition==='button')await captureButton().click();await waitCount(1);
  await page.getByRole('button',{name:'Pause stream',exact:true}).click();await page.getByRole('button',{name:'Start mock stream',exact:true}).click();await select('Squeeze');await page.waitForTimeout(5500);assert.equal(await count(),1);
  await page.getByRole('region',{name:'Fixed rest calibration'}).getByText(/Redo your resting setup before recording/).waitFor();
  await page.getByRole('button',{name:'Redo resting setup',exact:true}).click();await rest();
  if(condition==='button')await captureButton().click();await waitCount(2);
  await select('Relax');await captureButton().click();await waitCount(3);
  await page.getByRole('button',{name:'Redo resting setup',exact:true}).click();await rest();
  await page.getByRole('button',{name:'Delete Relax sample 1',exact:true}).click();await captureButton().click();await waitCount(4);
  const saved=await records(),captures=saved.filter(r=>r.kind==='capture'),references=saved.filter(r=>r.kind==='rest');
  assert.equal(references.length,3);assert.deepEqual(saved.find(r=>r.id===original.id),original);
  assert.equal(captures.find(r=>r.gestureId==='pinch').calibration.revision,original.calibration.revision);
  for(const capture of captures){assert.ok(references.some(rest=>rest.calibration.revision===capture.calibration.revision));if(capture.gestureId==='relax'){assert.equal(capture.triggerMode,'button');assert.ok(capture.points.every(p=>p.value<.3),'actual separately cued Relax stays resting even after rest-only cleanup');}else if(condition==='threshold')assert.ok(capture.triggeredAt-capture.firstCrossingAt>=100);}
  assert.equal(new Set(captures.filter(r=>r.gestureId==='relax').map(r=>r.calibration.revision)).size,2);
  await page.screenshot({path:path.join(out,condition+'.png'),fullPage:true});fs.writeFileSync(path.join(out,condition+'-records.json'),JSON.stringify(saved,null,2));report.conditions.push({condition,restRecords:references.length,captureRecords:captures.length,passed:true});await context.close();
 }
 assert.equal(report.errors.length,0);report.passed=true;
} catch(error){report.failure=error.stack;process.exitCode=1;} finally {await browser?.close();await server?.close();fs.rmSync(data,{recursive:true,force:true});report.cleanedFixture=true;fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
