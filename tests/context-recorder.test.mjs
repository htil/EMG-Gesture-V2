import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Module, createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const root=fileURLToPath(new URL('../',import.meta.url));
async function load(){
 const b=await build({entryPoints:[root+'src/app/study/captureContext.ts'],bundle:true,platform:'node',format:'cjs',write:false});
 const m=new Module(root+'tests/context.cjs');m._compile(b.outputFiles[0].text,root+'tests/context.cjs');return m.exports;
}
const scope={participantId:'fixture-code',sessionId:'visit-1',condition:'button',source:'mock',sourceEpoch:1,channel:0};
const meta={attemptId:'attempt-1',gestureId:'wrist-up',cueAt:5000};
const p=time=>({time,raw:time/100});
test('context saves original order and exact half-open center index boundaries without leaking pre/post',async()=>{
 const {CaptureContextRecorder,centerWaveform}=await load();const r=new CaptureContextRecorder(scope);
 const points=Array.from({length:2402},(_,i)=>p(i*5));points.forEach(point=>{r.push(point);if(point.time===5000){r.beginAttempt(meta);r.capture(meta.attemptId,point);}});
 r.finishCapture(meta.attemptId,'sample-1');
 const [c]=r.drainCompleted();assert.ok(c);assert.equal(c.complete,true);assert.equal(c.sampleId,'sample-1');
 assert.deepEqual(c.center,{startAt:5000,endAt:7000,startIndex:1000,endIndexExclusive:1400,startConsumptionId:1000});
 assert.equal(c.points.length,2400);assert.equal(centerWaveform(c).length,400);assert.equal(centerWaveform(c)[0].time,5000);assert.equal(centerWaveform(c).at(-1).time,6995);
 assert.equal(c.points[0].raw,0);assert.equal(r.drainCompleted().length,0);
 for(const disposition of ['deleted','rejected']){const evidence={...c,disposition};assert.deepEqual(centerWaveform(evidence),[]);assert.deepEqual(evidence.points,c.points,'disposition excludes training without dropping raw evidence');}
});
test('irregular timestamp boundaries use actual acquisition coverage, not a forced sample grid',async()=>{
 const {CaptureContextRecorder}=await load();const r=new CaptureContextRecorder(scope);
 for(let t=0;t<=12100;t+=100){const point=p(t);r.push(point);if(t===5100){r.beginAttempt({...meta,cueAt:5053});r.capture(meta.attemptId,point);r.finishCapture(meta.attemptId);}}
 const [c]=r.drainCompleted();assert.equal(c.complete,true);
 const r2=new CaptureContextRecorder(scope);for(let t=0;t<=12100;t+=99){const point=p(t);r2.push(point);if(t===5049){r2.beginAttempt({...meta,cueAt:t});r2.capture(meta.attemptId,point);r2.finishCapture(meta.attemptId);}}
 assert.equal(r2.drainCompleted()[0].complete,true,'pre coverage exists even without a point exactly at the cutoff');
});
test('overlapping contexts, cloned identities and equal-time split boundaries preserve distinct raw order',async()=>{
 const {CaptureContextRecorder,centerWaveform}=await load();const r=new CaptureContextRecorder(scope);
 let id=0;for(let time=0;time<=12500;time+=100){
  const point={...p(time),consumptionId:id++};r.push(point);r.push({...point});
  if(time===5000||time===5400){const attempt={...meta,attemptId:'a-'+time,cueAt:time};r.beginAttempt(attempt);r.capture(attempt.attemptId,point);r.finishCapture(attempt.attemptId);}
  if(time===5000||time===7000)r.push({time,raw:-time,consumptionId:id++});
 }
 const records=r.drainCompleted();assert.equal(records.length,2);assert.ok(records.every(c=>c.complete));
 assert.deepEqual(centerWaveform(records[0]).filter(p=>p.time===5000).map(p=>p.value),[50,-5000]);assert.ok(centerWaveform(records[0]).every(p=>p.time<7000));
 assert.equal(records[0].points.filter(p=>p.time===7000).length,2);assert.notEqual(records[0].points,records[1].points);
});
test('source/person transitions and partial pre/post preserve interrupted evidence without contamination',async()=>{
 const {CaptureContextRecorder}=await load();const r=new CaptureContextRecorder(scope);
 const first=p(5000);r.push(first);r.beginAttempt(meta);r.capture(meta.attemptId,first);r.push(p(5100));
 r.setScope({...scope,participantId:'other-code',sourceEpoch:2});
 const [old]=r.drainCompleted();assert.equal(old.complete,false);assert.ok(old.reasons.includes('scope_changed'));assert.ok(old.reasons.includes('incomplete_pre'));assert.ok(old.reasons.includes('incomplete_post'));
 const second=p(6000);r.push(second);r.beginAttempt({...meta,attemptId:'new-attempt',cueAt:6000});r.capture('new-attempt',second);r.flush('disconnected');
 const [next]=r.drainCompleted();assert.equal(next.scope.participantId,'other-code');assert.deepEqual(next.points.map(p=>p.time),[6000]);
});
test('500ms acquisition gaps are retained, >500ms/backward/invalid samples interrupt honestly',async()=>{
 const {CaptureContextRecorder}=await load();
 for(const bad of [p(1001),p(499),{time:501,raw:NaN}]){
  const r=new CaptureContextRecorder(scope),anchor=p(0);r.push(anchor);r.beginAttempt({...meta,cueAt:0});r.capture(meta.attemptId,anchor);r.push(p(500));assert.equal(r.drainCompleted().length,0);r.push(bad);
  const [c]=r.drainCompleted();assert.equal(c.complete,false);assert.ok(c.reasons.some(v=>['source_gap','source_backwards','invalid_sample'].includes(v)));assert.deepEqual(c.points.map(p=>p.time),[0,500]);
 }
});
test('cued timeout keeps passive context without inventing a center or training sample',async()=>{
 const {CaptureContextRecorder,centerWaveform}=await load();const r=new CaptureContextRecorder(scope);
 for(let time=0;time<=11000;time+=100){r.push(p(time));if(time===5000)r.beginAttempt(meta);if(time===6000)r.endAttempt(meta.attemptId,'timeout',time);}
 const [c]=r.drainCompleted();assert.equal(c.complete,true);assert.equal(c.center,null);assert.equal(c.status,'timeout');assert.deepEqual(centerWaveform(c),[]);
});
test('context retry queue survives empty flush, failure and enqueues during pending persistence',async()=>{
 const {ContextPersistenceQueue}=await load();const calls=[];let fail=true,release;
 const q=new ContextPersistenceQueue(async records=>{calls.push(structuredClone(records));if(fail)throw new Error('offline');await new Promise(r=>{release=r;});});
 await q.flush();q.enqueue([{contextId:'a'}]);await assert.rejects(()=>q.flush(),/offline/);assert.equal(q.pendingCount,1);fail=false;
 const saving=q.flush();await new Promise(r=>setImmediate(r));q.enqueue([{contextId:'b'}]);release();await new Promise(r=>setImmediate(r));release();await saving;
 assert.equal(q.pendingCount,0);assert.deepEqual(calls.map(batch=>batch.map(r=>r.contextId)),[['a'],['a'],['b']]);
});
test('an equal-time point consumed before the capture marker remains context only',async()=>{
 const {CaptureContextRecorder,centerWaveform}=await load();const r=new CaptureContextRecorder(scope);
 for(let time=0;time<=4900;time+=100)r.push(p(time));
 r.push({time:5000,raw:-1});const anchor={time:5000,raw:2};r.push(anchor);r.beginAttempt(meta);r.capture(meta.attemptId,anchor);r.finishCapture(meta.attemptId);
 for(let time=5100;time<=12000;time+=100)r.push(p(time));
 const [c]=r.drainCompleted();assert.equal(c.center.startIndex,51);assert.equal(centerWaveform(c)[0].value,2);assert.ok(!centerWaveform(c).some(p=>p.value===-1));
});
test('flushing a cued but uncaptured attempt does not drop its final raw point',async()=>{
 const {CaptureContextRecorder}=await load();const r=new CaptureContextRecorder(scope);r.push(p(5000));r.beginAttempt(meta);r.push(p(5100));r.flush('disconnected');
 const [c]=r.drainCompleted();assert.deepEqual(c.points.map(p=>p.time),[5000,5100]);assert.ok(c.reasons.includes('incomplete_post'));
});
test('React replay of already acquired identities after a raw gap cannot rewind or contaminate the next attempt',async()=>{
 const {CaptureContextRecorder}=await load();const r=new CaptureContextRecorder(scope);
 const old={time:0,raw:1,consumptionId:0},next={time:1000,raw:2,consumptionId:1};r.push(old);r.beginAttempt({...meta,cueAt:0});r.capture(meta.attemptId,old);r.push(next);
 assert.equal(r.drainCompleted().length,1);r.beginAttempt({...meta,attemptId:'after-gap',cueAt:1000});r.capture('after-gap',next);
 r.push({...old});assert.equal(r.drainCompleted().length,0,'old render clone is already consumed, not a new backwards sample');r.flush('disconnected');assert.deepEqual(r.drainCompleted()[0].points.map(p=>p.time),[1000]);
});
test('raw acquisition ahead of React capture binding retains the entire requested five-second pre-window',async()=>{
 const {CaptureContextRecorder}=await load();const r=new CaptureContextRecorder(scope);let anchor;
 for(let time=0;time<=5500;time+=100){const point={...p(time),consumptionId:time/100};r.push(point);if(time===5000)anchor=point;}
 r.beginAttempt(meta);r.capture(meta.attemptId,anchor);r.finishCapture(meta.attemptId);
 for(let time=5600;time<=12000;time+=100)r.push({...p(time),consumptionId:time/100});
 const [c]=r.drainCompleted();assert.equal(c.complete,true);assert.equal(c.points[0].time,0);assert.equal(c.center.startIndex,50);
});
export {load,scope,meta,p};
