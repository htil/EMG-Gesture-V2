import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {mount,text} from './support/mounted-capture-state-fixture.mjs';
const out=process.env.EMG_BATCH_EVIDENCE_DIR || '/workspace/EMG-Backend-Batch-Validation-20261108/implementation/matrix';fs.mkdirSync(out,{recursive:true});
const results=[];
const files=root=>fs.readdirSync(root,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(path.join(root,e.name)):[path.join(root,e.name)]);
const bytes=root=>Object.fromEntries(files(root).filter(p=>p.includes('/contexts/')||p.includes('/samples/')).map(p=>[p,fs.readFileSync(p,'utf8')]));
const capture=async f=>{await f.waitUntil(()=>f.button('Capture Space')&&!f.button('Capture Space').props.disabled,'usable capture');await f.click('Capture Space');await f.advance(11000);};
for(const fault of ['checkpoint-active-rejected','checkpoint-finalization-rejected','collection-rejected','partial-ACK','delayed-ACK'].filter(f=>!process.env.TEST_FAULT||f===process.env.TEST_FAULT))test(fault,{concurrency:false},async t=>{
 const result={fault,status:'SETUPBLOCKED',steps:[],checks:[]};results.push(result);t.after(()=>fs.writeFileSync(path.join(out,process.env.TEST_FAULT?process.env.TEST_FAULT+'.json':'matrix-results.json'),JSON.stringify({runtime:process.version,cadence:'mock 20Hz, controlled 50ms clock',setup:'between-subject-v1 quota8; measured setup receipt stubbed, not full v2 journey; visuals/Bluetooth stubbed; production recorder/archive/collection/backend real',results},null,2)));
 const check=(name,fn)=>{try{fn();result.checks.push({name,status:'PASS'});}catch(e){result.checks.push({name,status:'RED',message:e.message});}};
 const f=await mount(t,'button',false,{pilot:true,measuredSetupStub:true});await f.click('Start mock stream');await f.advance(6000);
 await f.click('Capture Space');await f.advance(5500);
 check('healthy post-context overlap permits Capture',()=>assert.ok(f.button('Capture Space')&&!f.button('Capture Space').props.disabled));await f.advance(5500);await capture(f);result.steps.push('two same-gesture captures completed');
 const before=bytes(f.data);const records=Object.entries(before).filter(([p])=>p.endsWith('.context.json')).map(([,v])=>JSON.parse(v));
 console.log(fault,'BASELINE',JSON.stringify(records).slice(0,600),'FILES',Object.keys(before));
 result.baselineFiles=Object.keys(before).map(p=>p.replace(f.data,''));
 result.baselineSyntheticBytes=before;
 check('two ACKed same gesture contexts with exact raw 5/2/5',()=>{assert.equal(records.length,2);assert.equal(new Set(records.map(r=>r.attempt.gestureId)).size,1);for(const r of records){assert.equal(r.status,'captured');assert.equal(r.complete,true);assert.equal(r.center.endAt-r.center.startAt,2000);assert.equal(r.center.startAt-r.window.startAt,5000);assert.equal(r.window.endAt-r.center.endAt,5000);assert.equal(r.points.length,240);assert.equal(r.center.endIndexExclusive-r.center.startIndex,40);const sample=JSON.parse(Object.entries(before).find(([p])=>p.endsWith('/'+r.sampleId+'.json'))[1]);assert.deepEqual(sample.points,r.points.slice(r.center.startIndex,r.center.endIndexExclusive).map(p=>({time:p.time,value:p.raw})));}});
 // Observe real localStorage writes and reject the actual checkpoint persistence call.
 const stored=new Map();const set=localStorage.setItem.bind(localStorage),get=localStorage.getItem.bind(localStorage);let rejectCheckpoint=false;
 const firstIds=new Set(records.map(r=>r.contextId));const checkpointFault=fault.startsWith('checkpoint-');result.rejectedCheckpoints=[];
 localStorage.setItem=(k,v)=>{if(rejectCheckpoint&&k.startsWith('emg-context-recovery:')){const j=JSON.parse(v);const target=(fault==='checkpoint-active-rejected'?j.active:j.sealed).find(r=>!firstIds.has(r.contextId)&&r.center);if(target||result.rejectedCheckpoints.length){result.rejectedCheckpoints.push({at:Date.now(),lastDurable:get(k),attemptedRAMJournal:String(v)});throw new Error('SYNTHETIC_CHECKPOINT_REJECTED');}}stored.set(k,String(v));set(k,v);};
 const baseFetch=globalThis.fetch;result.responses=[];const fetch=async(...args)=>{const response=await baseFetch(...args);if(args[0]==='/api/study/collection')result.responses.push({at:Date.now(),ok:response.ok,body:await response.text()});return response;};let active=true,release;const gate=new Promise(r=>release=r);let injected=0;
 globalThis.fetch=async(url,init)=>{if(active&&url==='/api/study/collection'){
  injected++;result.steps.push({event:'fault collection dispatch',at:Date.now(),items:JSON.parse(init.body).items.map(i=>i.kind)});
  if(fault==='collection-rejected')throw new Error('SYNTHETIC_COLLECTION_NETWORK_REJECTION');
  if(fault==='partial-ACK')return {ok:true,text:async()=>JSON.stringify({ok:true,acceptedCount:0}),json:async()=>({ok:true,acceptedCount:0})};
  if(fault==='delayed-ACK')await gate;
 }return fetch(url,init);};
 await f.click('Capture Space');rejectCheckpoint=checkpointFault;await f.advance(11000);
 result.injectedRequests=injected;result.failureUI=text(f.renderer.toJSON());
 result.pendingQueue=JSON.parse(get('emg-collection-queue')??'[]');result.journals=[...stored].filter(([k])=>k.startsWith('emg-context-recovery:')).map(([k,v])=>({key:k,value:JSON.parse(v)}));
 check('first two remain byte-equivalent after third fault',()=>{const after=bytes(f.data);for(const [p,v]of Object.entries(before))assert.equal(after[p],v,p);});
 if(!checkpointFault){check('failed or held ACK leaves third sample/context records queued',()=>{assert.ok(result.pendingQueue.some(q=>q.item.kind==='sample'));assert.ok(result.pendingQueue.some(q=>q.item.kind==='context'));});await f.advance(500);const later=JSON.parse(get('emg-collection-queue')??'[]');check('no queued item popped across failed/partial/held ACK',()=>assert.deepEqual(later.slice(0,result.pendingQueue.length),result.pendingQueue));result.pendingQueueAfterFurtherFailedACK=later;}
 if(checkpointFault)check('rendered recovery controls exposed',()=>assert.ok(f.button('Retry raw/context recovery')));
 // Healing storage then Retry must remain fenced while the actual HTTP ACK is held.
 rejectCheckpoint=false;active=false;
 if(checkpointFault){
  let actualHeldRequests=0;globalThis.fetch=async(url,init)=>{if(url==='/api/study/collection'){actualHeldRequests++;await gate;}return fetch(url,init);};
  await f.click('Retry raw/context recovery');await f.advance(250);
  check('Retry reached actual held collection request',()=>assert.ok(actualHeldRequests>0));
  check('held actual retry ACK cannot arm Capture',()=>assert.ok(!f.button('Capture Space')||f.button('Capture Space').props.disabled));
 }
 release();await f.advance(2500);
 if(f.button('Retry saving'))await f.click('Retry saving');
 if(f.button('Retry raw/context recovery')&&!f.button('Retry raw/context recovery').props.disabled)await f.click('Retry raw/context recovery');
 await f.advance(1000);
 if(f.button('Retry opportunity')&&!f.button('Retry opportunity').props.disabled){await f.click('Retry opportunity');await f.advance(250);result.steps.push('rendered Retry opportunity after interrupted center');}
 check('release success allows usable rendered Capture',()=>assert.ok(f.button('Capture Space')&&!f.button('Capture Space').props.disabled));
 result.afterUI=text(f.renderer.toJSON());
 const beforeFresh=bytes(f.data);const oldSampleIds=Object.keys(beforeFresh).filter(p=>p.includes('/samples/'));
 if(f.button('Capture Space')&&!f.button('Capture Space').props.disabled){await capture(f);result.freshUI=text(f.renderer.toJSON());result.finalQueue=JSON.parse(get('emg-collection-queue')??'[]');result.finalSyntheticBytes=bytes(f.data);check('fresh Capture produces distinct usable ID and lineage',()=>{const fresh=Object.entries(bytes(f.data)).filter(([p])=>p.endsWith('.context.json')&&!beforeFresh[p]).map(([,v])=>JSON.parse(v));assert.ok(fresh.some(r=>r.status==='captured'&&r.sampleId&&!oldSampleIds.some(p=>p.endsWith('/'+r.sampleId+'.json'))&&!firstIds.has(r.contextId)));});}
 if(checkpointFault){check('actual checkpoint rejection preserved serialized RAM evidence',()=>assert.ok(result.rejectedCheckpoints.length>0));check('failed third RAM bytes survive recovery under original ID',()=>{const first=JSON.parse(result.rejectedCheckpoints[0].attemptedRAMJournal);const raw=[...first.active,...first.sealed].find(r=>!firstIds.has(r.contextId)&&r.center);const recovered=Object.entries(bytes(f.data)).filter(([p])=>p.endsWith('.context.json')).map(([,v])=>JSON.parse(v)).find(r=>r.contextId===raw.contextId);assert.ok(recovered);for(const point of raw.points)assert.deepEqual(recovered.points.find(p=>p.consumptionId===point.consumptionId),point);if(fault==='checkpoint-finalization-rejected')assert.deepEqual(recovered,raw);if(fault==='checkpoint-active-rejected'){const fresh=Object.entries(bytes(f.data)).filter(([p])=>p.endsWith('.context.json')).map(([,v])=>JSON.parse(v)).find(r=>r.attempt.retryOf===raw.contextId);assert.ok(fresh&&fresh.contextId!==raw.contextId&&fresh.status==='captured');}});}
 check('first two immutable after recovery',()=>{const after=bytes(f.data);for(const [p,v]of Object.entries(before))assert.equal(after[p],v);});
 if(fault==='collection-rejected'&&result.finalQueue?.length){const items=result.finalQueue.map(q=>q.item);const payload={id:f.p.id,items};result.batchCauseProbe={};result.batchCauseProbe.fullBefore=await f.call('POST','/collection',payload);result.batchCauseProbe.samplesOnly=await f.call('POST','/collection',{id:f.p.id,items:items.filter(i=>i.kind==='sample')});result.batchCauseProbe.identicalFullAfter=await f.call('POST','/collection',payload);}
 result.status=result.checks.some(c=>c.status==='RED')?'RED':'PASS';
 assert.equal(result.status,'PASS',JSON.stringify(result.checks.filter(c=>c.status==='RED')));
});
