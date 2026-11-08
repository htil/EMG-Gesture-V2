import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Module} from 'node:module';
const root=new URL('../',import.meta.url).pathname;
async function load(entry='captureContext') { const b=await build({entryPoints:[root+`src/app/study/${entry}.ts`],bundle:true,platform:'node',format:'cjs',write:false});const m=new Module(root+'tests/recovery.cjs');m._compile(b.outputFiles[0].text,root+'tests/recovery.cjs');return m.exports; }
const scope={participantId:'P1',sessionId:'S1',condition:'button',source:'live',sourceEpoch:3,channel:0};
const attempt={attemptId:'A1',gestureId:'wrist-up',cueAt:5000};
const destination={participantId:'P1',sessionId:'S1',condition:'button',generation:1,round:1};
function memory(){const values=new Map();return {getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};}
test('abrupt remount recovers only saved points, seals before enqueue, retries identical bytes until ACK',async()=>{
 const {CaptureContextRecorder}=await load();const {ActiveContextRecovery}=await load('activeContextRecovery');const storage=memory(),sent=[];let ack;
 const r=active(CaptureContextRecorder);const first=new ActiveContextRecovery({storage,key:'journal',destination,recorder:r,send:async()=>{},saved:()=>new Promise(()=>{})});first.start();first.checkpoint();
 r.push({time:5200,raw:5200.25,consumptionId:52}); // no timer/boundary: intentionally lost tail
 const fresh=new CaptureContextRecorder({...scope,sourceEpoch:0});const recovered=new ActiveContextRecovery({storage,key:'journal',destination,recorder:fresh,send:async records=>sent.push(structuredClone(records)),saved:()=>new Promise(resolve=>{ack=resolve})});recovered.start();await recovered.drain();
 assert.equal(sent.length,1);assert.equal(sent[0][0].points.at(-1).time,5100);assert.equal(sent[0][0].scope.sourceEpoch,3);assert.equal(fresh.hasAttempt('A1'),false);assert.ok(JSON.parse(storage.getItem('journal')).sealed.length);await recovered.drain();assert.equal(sent.length,1);ack();await new Promise(setImmediate);assert.equal(JSON.parse(storage.getItem('journal')).sealed.length,0);
});
test('foreign person/session/condition/generation/round and corrupt point lineage are quarantined without writes',async()=>{
 const {CaptureContextRecorder}=await load();const {ActiveContextRecovery}=await load('activeContextRecovery');
 const record=active(CaptureContextRecorder).recoverySnapshot()[0];
 for(const change of [{participantId:'P2'},{sessionId:'S2'},{condition:'threshold'},{generation:2},{round:2},null,'extra']) {
  const storage=memory();const bad=structuredClone(record);if(!change)bad.points[1].consumptionId=bad.points[0].consumptionId;if(change==='extra')bad.unrecognized='not-a-context-field';
  const raw=JSON.stringify({version:1,destination:{...destination,...(change==='extra'?{}:change)},active:[bad],sealed:[]});storage.setItem('j',raw);
  const c=new ActiveContextRecovery({storage,key:'j',destination,recorder:new CaptureContextRecorder(scope),send:async()=>assert.fail('foreign/corrupt record uploaded'),saved:async()=>{}});c.start();assert.ok(c.error);await assert.rejects(c.drain());assert.equal(storage.getItem('j'),raw);
 }
});
test('failed storage preserves last checkpoint, blocks new attempts and can retry without duplicate uploads',async()=>{
 const {CaptureContextRecorder}=await load();const {ActiveContextRecovery}=await load('activeContextRecovery');const base=memory();let broken=false,writes=0;const storage={getItem:base.getItem,setItem(k,v){writes++;if(broken)throw new Error('quota');base.setItem(k,v)}};
 const r=active(CaptureContextRecorder);let calls=0;const c=new ActiveContextRecovery({storage,key:'j',destination,recorder:r,send:async()=>{calls++},saved:()=>new Promise(()=>{})});c.start();c.checkpoint();const original=base.getItem('j');broken=true;r.push({time:5200,raw:9,consumptionId:52});c.checkpoint();assert.ok(c.error);assert.equal(base.getItem('j'),original);assert.throws(()=>r.beginAttempt({...attempt,attemptId:'blocked'}),/recovery/i);
 const before=writes;for(let i=0;i<20;i++){r.push({time:5205+i*5,raw:i,consumptionId:53+i});await c.drain().catch(()=>{});}assert.equal(writes,before,'failure must not become per-point storage retries');broken=false;await c.retry();assert.equal(c.error,'');r.flush('disconnected');await c.drain();await c.drain();assert.equal(calls,1);
});
test('finished centers keep exact saved pre/center/post, timeout has no center, and reconnect never appends',async()=>{
 const {CaptureContextRecorder,centerWaveform}=await load();const {validateContextRecord}=await import('../server/context-records.mjs');
 for(const status of ['captured','timeout','failed']) {
  const r=new CaptureContextRecorder(scope);for(let t=0;t<=8000;t+=100){const p={time:t,raw:t+.5,consumptionId:t/100};r.push(p);if(t===5000){r.beginAttempt(attempt);if(status==='captured')r.capture('A1',p);}if(t===7000){if(status==='captured')r.finishCapture('A1','sample-1');else r.endAttempt('A1',status,t);}}
  const [c]=r.recoverySnapshot();validateContextRecord(c);assert.equal(c.status,status);assert.equal(c.complete,false);assert.deepEqual(c.reasons,['interrupted','incomplete_post']);assert.equal(c.points.at(-1).time,8000);assert.equal(c.points[0].time,0);assert.equal(centerWaveform(c).length,status==='captured'?20:0);
  r.flush('disconnected');const [interrupted]=r.drainCompleted();assert.equal(interrupted.scope.sourceEpoch,3);r.setScope({...scope,sourceEpoch:4,channel:1});r.push({time:0,raw:999,consumptionId:0});r.beginAttempt({...attempt,attemptId:'new',cueAt:0});r.capture('new',{time:0,raw:999,consumptionId:0});r.flush('stopped');const [next]=r.drainCompleted();assert.deepEqual(next.points,[{time:0,raw:999,consumptionId:0}]);assert.equal(c.points.at(-1).raw,8000.5);
 }
});
test('coalesced point checkpoints perform no idle/per-point writes and sealed durable queue dedup is exact',async()=>{
 const {CaptureContextRecorder}=await load();const {ActiveContextRecovery}=await load('activeContextRecovery');const base=memory();let writes=0;const storage={getItem:base.getItem,setItem(k,v){writes++;base.setItem(k,v)}};
 const r=new CaptureContextRecorder(scope);const c=new ActiveContextRecovery({storage,key:'j',destination,recorder:r,send:async()=>assert.fail('already queued'),queued:()=>JSON.parse(base.getItem('j')).sealed,saved:()=>new Promise(()=>{})});c.start();for(let t=0;t<5000;t+=5){r.push({time:t,raw:1});await c.drain();}c.checkpoint();assert.equal(writes,0);
 const anchor={time:5000,raw:2};r.push(anchor);r.beginAttempt(attempt);r.capture('A1',anchor);assert.equal(writes,2);for(let t=5005;t<=6000;t+=5){r.push({time:t,raw:3});await c.drain();}assert.equal(writes,2);c.checkpoint();assert.equal(writes,3);r.flush('disconnected');await c.drain();await c.drain();assert.equal(JSON.parse(base.getItem('j')).sealed.length,1);
});
test('send retry reuses immutable sealed payload; conflicting queued evidence and byte limits never discard backups',async()=>{
 const {CaptureContextRecorder}=await load();const {ActiveContextRecovery}=await load('activeContextRecovery');const storage=memory(),calls=[];let offline=true;const r=active(CaptureContextRecorder);const c=new ActiveContextRecovery({storage,key:'j',destination,recorder:r,send:async batch=>{calls.push(batch);if(offline)throw new Error('offline')},saved:()=>new Promise(()=>{})});c.start();r.flush('disconnected');await assert.rejects(c.drain(),/offline/);const original=storage.getItem('j');offline=false;await c.retry();assert.deepEqual(calls[0],calls[1]);assert.equal(storage.getItem('j'),original);
 const conflict=structuredClone(calls[0]);conflict[0].points[0].raw=-9;const fresh=new ActiveContextRecovery({storage,key:'j',destination,recorder:new CaptureContextRecorder(scope),queued:()=>conflict,send:async()=>assert.fail('conflict'),saved:async()=>{}});fresh.start();await assert.rejects(fresh.drain(),/Conflicting/);assert.equal(storage.getItem('j'),original);
 const limitedStorage=memory(),limited=new ActiveContextRecovery({storage:limitedStorage,key:'limited',destination,recorder:active(CaptureContextRecorder),maxBytes:100,send:async()=>assert.fail('oversized'),saved:async()=>{}});limited.start();limited.checkpoint();assert.match(limited.error,/byte budget/);assert.equal(limitedStorage.getItem('limited'),null);
});
function active(Recorder,options) { const r=new Recorder(scope,options);for(let t=0;t<=5100;t+=100){const p={time:t,raw:t+.25,consumptionId:t/100};r.push(p);if(t===5000){r.beginAttempt(attempt);r.capture('A1',p);}}return r; }
test('checkpoint terminalizes an abrupt partial center without changing live acquisition or original evidence',async()=>{
 const {CaptureContextRecorder,centerWaveform}=await load();const r=active(CaptureContextRecorder);
 const [saved]=r.recoverySnapshot();assert.equal(r.hasAttempt('A1'),true);assert.deepEqual(saved.points.map(p=>p.time),Array.from({length:52},(_,i)=>i*100));assert.equal(saved.points.at(-1).raw,5100.25);assert.equal(saved.status,'interrupted');assert.equal(saved.complete,false);assert.ok(saved.reasons.includes('incomplete_center'));assert.ok(saved.reasons.includes('incomplete_post'));assert.deepEqual(centerWaveform(saved),[]);
 r.push({time:5200,raw:99,consumptionId:52});assert.equal(saved.points.at(-1).time,5100);
});
test('point budget interrupts a contiguous prefix and boundaries notify without per-point storage',async()=>{
 const {CaptureContextRecorder}=await load();const r=new CaptureContextRecorder(scope,{maxAttemptPoints:3});const changes=[];r.onChange=kind=>changes.push(kind);
 r.push({time:5000,raw:1});r.beginAttempt(attempt);r.capture('A1',{time:5000,raw:1,consumptionId:0});r.push({time:5100,raw:2});r.push({time:5200,raw:3});r.push({time:5300,raw:4});
 const [c]=r.drainCompleted();assert.ok(c);assert.deepEqual(c.points.map(p=>p.raw),[1,2,3]);assert.equal(c.complete,false);assert.ok(c.reasons.includes('interrupted'));assert.ok(changes.includes('boundary'));assert.ok(changes.includes('point'));
});
