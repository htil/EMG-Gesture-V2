import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
process.env.EMG_ADMIN_PIN=randomBytes(24).toString('hex');
import {createStudyDesk,dispatchStudyRequest} from '../server/study-api.mjs';
import {contextItemForSample} from './support/pilot-context-fixture.mjs';
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'core-resume-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const desk=createStudyDesk(dir);const call=(method,pathname,body={},admin=false)=>desk.handle({method,pathname,body,headers:admin?{'x-admin-pin':process.env.EMG_ADMIN_PIN}:{},searchParams:new URLSearchParams()});
 const exp=call('POST','/experiments',{name:'Declared synthetic historical core resume',protocolVersion:'within-subject-v1',capturesMin:1,capturesMax:1},true).body;
 const p=call('POST','/participants/generate',{experimentId:exp.id,count:1,assignment:'button',isTestParticipant:true},true).body.participants[0];
 const joined=call('POST','/join',{id:p.id}).body;
 const scope={participantId:p.id,sessionId:'resume-session',generation:1,round:1,condition:'button'};
 const sample=(id,g='wrist-up')=>({...scope,sampleId:id,attemptId:'attempt-'+id,centerDurationMs:2000,gestureId:g,gestureLabel:g,signalSource:'mock',triggeredAt:5000,recordingStartedAt:5000,recordingEndedAt:7000,preTriggerPointCount:0,points:Array.from({length:400},(_,i)=>({time:5000+i*5,value:i+.123})),settings:{segmentDurationMs:2000,preTriggerWindowMs:0}});
 const context=(id='context-1')=>({schemaVersion:1,contextId:id,scope:{participantId:p.id,sessionId:scope.sessionId,condition:'button',source:'mock',sourceEpoch:1,channel:0},attempt:{attemptId:id,gestureId:'wrist-up',cueAt:5000},sampleId:'s-up',status:'captured',disposition:'retained',center:{startAt:5000,endAt:7000,startIndex:1000,endIndexExclusive:1400,startConsumptionId:1000},window:{startAt:0,endAt:12000,preMs:5000,postMs:5000},points:Array.from({length:2400},(_,i)=>({time:i*5,raw:i+.123,consumptionId:i})),complete:true,reasons:[]});
 return {dir,desk,call,exp,p,joined,scope,sample,context};
}
test('current pilot requires explicit half-open center boundaries and never acknowledges extra or unsupported records',t=>{
 const f=fixture(t);const record=f.sample('s-up');
 for(const override of [{centerDurationMs:undefined},{attemptId:undefined},{recordingEndedAt:7001},{points:[...record.points,{time:7000,value:999}]},{participantId:'OTHER'}])assert.throws(()=>f.call('POST','/collection',{id:f.p.id,items:[{kind:'sample',record:{...record,...override}}]}),/center|attempt|scope|participant/i);
 assert.throws(()=>f.call('POST','/collection',{id:f.p.id,items:[{kind:'unsupported',record:f.scope}]}),/Unsupported/);
 const saved=f.call('POST','/collection',{id:f.p.id,items:[{kind:'sample',record}]});assert.equal(saved.body.acceptedCount,1);
 assert.equal(f.call('POST','/collection',{id:f.p.id,items:[{kind:'sample',record}]}).body.acceptedCount,1,'idempotent retry acknowledges the entire persisted batch');
});
test('context readback is generation/condition/session scoped and preserves append-only deletion evidence',async t=>{
 const f=fixture(t),context=f.context();const envelope={...f.scope,context};
 const saved=await f.call('POST','/collection',{id:f.p.id,items:[{kind:'context',record:envelope}]});assert.equal(saved.body.acceptedCount,1);
 const read=await f.call('POST','/contexts/read',{id:f.p.id,...f.scope});assert.equal(read.body.records.length,1);assert.deepEqual(read.body.records[0].context,context);
 await f.call('POST','/collection',{id:f.p.id,items:[{kind:'event',record:{...f.scope,eventId:'deleted-context',type:'sample_deleted',sampleId:'s-up',at:10000}}]});
 const after=await f.call('POST','/contexts/read',{id:f.p.id,...f.scope});assert.equal(after.body.records[0].derivedDisposition,'deleted');assert.deepEqual(after.body.records[0].context.points,context.points);
 for(const override of [{generation:2},{condition:'threshold'},{round:2}])assert.throws(()=>f.call('POST','/contexts/read',{id:f.p.id,...f.scope,...override}),/scope|generation/i);
 assert.throws(()=>f.call('POST','/contexts/read',{id:f.p.id,...f.scope,sessionId:'another-session'}),/session|scope/i);
});
test('invalid later item cannot publish an earlier otherwise-valid center',t=>{
 const f=fixture(t);assert.throws(()=>f.call('POST','/collection',{id:f.p.id,items:[{kind:'sample',record:f.sample('must-not-publish')},{kind:'sample',record:{...f.sample('bad','wrist-down'),calibration:{revision:'forged'}}}]}),/calibration|Invalid/i);
 assert.equal(fs.existsSync(path.join(f.dir,'sessions',f.p.id,'collection',f.scope.sessionId,'samples','must-not-publish.json')),false);
});
test('official and replay results require honest indexed raw-window metadata; primary is immutable and replay cannot replace it',async t=>{
 const f=fixture(t);const ids=['s-up','s-down'];f.call('POST','/collection',{id:f.p.id,items:[{kind:'sample',record:f.sample(ids[0])},{kind:'sample',record:f.sample(ids[1],'wrist-down')}]});
 await f.call('POST','/collection',{id:f.p.id,items:ids.map((id,i)=>contextItemForSample(f.sample(id,i?'wrist-down':'wrist-up')))});
 const scope={id:f.p.id,...f.scope};f.call('POST','/protocol/survey',{...scope,confirmed:true},true);f.call('POST','/protocol/lock',{...scope,sampleIds:ids,revisionId:'locked-model'});
 f.call('POST','/collection',{id:f.p.id,items:[{kind:'training',record:{...f.scope,revisionId:'locked-model',sampleIds:ids,status:'success',settings:{segmentDurationMs:2000}}}]});
 const run={...f.scope,id:'official-resume',runId:'official-resume',runKind:'official',completionStatus:'complete',startedAt:10000,endedAt:71000,gameScore:0,modelRevisionId:'locked-model',signalSource:'mock',streamReady:true,officialSequence:f.joined.officialSequence,outcomes:f.joined.officialSequence.map((g,i)=>({trialIndex:i+1,attemptId:`official-resume:${i+1}`,expectedGestureId:g,result:'unknown',predictedGestureId:null,cueAt:10000+i*3000,recordingStartedAt:10000+i*3000,recordingEndedAt:12000+i*3000,sampleCount:401,inferenceStartedAt:12000+i*3000,inferenceEndedAt:12001+i*3000}))};
 for(const override of [{outcomes:run.outcomes.map((o,i)=>i?o:{...o,recordingEndedAt:undefined})},{outcomes:run.outcomes.map((o,i)=>i?o:{...o,attemptId:'invented'})},{outcomes:run.outcomes.map((o,i)=>i?o:{...o,sampleCount:0})},{runId:'different'},{officialSequence:run.officialSequence.slice(0,19)},{outcomes:run.outcomes.map((o,i)=>i?o:{...o,result:'correct',predictedGestureId:o.expectedGestureId==='wrist-up'?'wrist-down':'wrist-up'})}])assert.throws(()=>f.call('POST','/runs',{id:f.p.id,run:{...run,...override}}),/metadata|identity|sequence|window|indexed|prediction/i);
 const duplicateOfficial={...run,id:'official-second-in-batch',runId:'official-second-in-batch',outcomes:run.outcomes.map((o,i)=>({...o,attemptId:`official-second-in-batch:${i+1}`}))};
 assert.throws(()=>f.call('POST','/collection',{id:f.p.id,items:[{kind:'run',record:run},{kind:'run',record:duplicateOfficial}]}),/one official/i);
 assert.equal(f.call('POST','/join',{id:f.p.id}).body.runs.length,0,'a rejected two-primary batch must publish neither run');
 f.call('POST','/runs',{id:f.p.id,run});const before=f.call('POST','/join',{id:f.p.id}).body.runs[0];
 const replay={...run,id:'replay-resume',runId:'replay-resume',runKind:'replay',gameScore:100,outcomes:run.outcomes.map((o,i)=>({...o,attemptId:`replay-resume:${i+1}`}))};f.call('POST','/runs',{id:f.p.id,run:replay});
 assert.throws(()=>f.call('POST','/runs',{id:f.p.id,run:{...run,gameScore:900}}),/immutable/i);const after=f.call('POST','/join',{id:f.p.id}).body.runs;assert.deepEqual(after.find(r=>r.id===run.id),before);assert.equal(after.length,2);
});
test('both AB and BA keep the same generated person over two complete independent visits and export both models/results',async t=>{
 const f=fixture(t);const second=f.call('POST','/participants/generate',{experimentId:f.exp.id,count:1,assignment:'threshold',isTestParticipant:true},true).body.participants[0];
 for(const person of [f.p,second]){
  const first=f.call('POST','/join',{id:person.id}).body;
  for(let round=1;round<=2;round++){
   const joined=f.call('POST','/join',{id:person.id}).body;assert.equal(joined.participantId,person.id);assert.equal(joined.condition,first.conditionOrder[round-1]);assert.deepEqual(joined.officialSequence,first.officialSequence);
   const condition=joined.condition,sessionId=`${person.id}-visit-${round}`,scope={id:person.id,participantId:person.id,condition,generation:1,round,sessionId},ids=[`${sessionId}-up`,`${sessionId}-down`],revisionId=`${sessionId}-model`;
   f.call('POST','/collection',{id:person.id,items:ids.map((id,i)=>({kind:'sample',record:{...f.sample(id,i?'wrist-down':'wrist-up'),...scope}}))});
   await f.call('POST','/collection',{id:person.id,items:ids.map((id,i)=>contextItemForSample({...f.sample(id,i?'wrist-down':'wrist-up'),...scope}))});
   f.call('POST','/protocol/survey',{...scope,confirmed:true},true);f.call('POST','/protocol/lock',{...scope,sampleIds:ids,revisionId});
   f.call('POST','/collection',{id:person.id,items:[{kind:'training',record:{...scope,revisionId,sampleIds:ids,status:'success',settings:{segmentDurationMs:2000}}}]});
   const runId=`${sessionId}-official`;const run={...scope,id:runId,runId,runKind:'official',completionStatus:'complete',startedAt:10000,endedAt:71000,gameScore:0,modelRevisionId:revisionId,signalSource:'mock',streamReady:true,officialSequence:first.officialSequence,outcomes:first.officialSequence.map((g,i)=>({trialIndex:i+1,attemptId:`${runId}:${i+1}`,expectedGestureId:g,result:'recording_failure',predictedGestureId:null,cueAt:10000+i*3000,recordingStartedAt:10000+i*3000,recordingEndedAt:12000+i*3000,sampleCount:401,inferenceStartedAt:12000+i*3000,inferenceEndedAt:12001+i*3000}))};
   f.call('POST','/runs',{id:person.id,run});f.call('POST','/progress',{...scope,trials:ids.map(id=>({id}))});
  }
  const finished=f.call('POST','/join',{id:person.id}).body;assert.equal(finished.status,'completed');assert.equal(finished.participantId,person.id);assert.equal(finished.runs.length,2);assert.deepEqual(finished.runs.map(r=>r.condition),first.conditionOrder);assert.equal(new Set(finished.runs.map(r=>r.modelRevisionId)).size,2);
 }
 const bytes=f.call('GET',`/export/${f.exp.id}/collection`,{},true).buffer,entries={};for(let at=0;bytes.readUInt32LE(at)===0x04034b50;){const n=bytes.readUInt16LE(at+26),e=bytes.readUInt16LE(at+28),size=bytes.readUInt32LE(at+18),name=bytes.subarray(at+30,at+30+n).toString(),start=at+30+n+e;entries[name]=bytes.subarray(start,start+size).toString();at=start+size;}
 const protocol=JSON.parse(entries['protocol.json']),models=JSON.parse(entries['models-and-runs.json']);assert.equal(protocol.participants.length,2);assert.ok(protocol.participants.every(p=>p.visits.length===2&&p.runs.length===2));assert.equal(models.training.length,4);assert.equal(JSON.parse(entries['waveforms.json']).samples.length,8);
});
test('mixed-batch context conflicts and duplicate sample identities are rejected before any center publication',async t=>{
 const f=fixture(t),context=f.context();await f.call('POST','/collection',{id:f.p.id,items:[{kind:'context',record:{...f.scope,context}}]});
 const changed={...context,points:context.points.map((p,i)=>i? p:{...p,raw:999})};
 assert.throws(()=>f.call('POST','/collection',{id:f.p.id,items:[{kind:'sample',record:f.sample('not-published')},{kind:'context',record:{...f.scope,context:changed}}]}),/immutable|conflict/i);
 const target=path.join(f.dir,'sessions',f.p.id,'collection',f.scope.sessionId,'samples','not-published.json');assert.equal(fs.existsSync(target),false);
 const first=f.sample('duplicate'),second={...first,points:first.points.map(p=>({...p,value:999}))};assert.throws(()=>f.call('POST','/collection',{id:f.p.id,items:[{kind:'sample',record:first},{kind:'sample',record:second}]}),/immutable|conflict/i);
});
test('failed official construction can retry the same locked lineage without losing failure audit, while a ready model cannot be replaced',async t=>{
 const f=fixture(t),ids=['train-up','train-down'],scope={id:f.p.id,...f.scope};
 await f.call('POST','/collection',{id:f.p.id,items:ids.flatMap((id,i)=>{const record=f.sample(id,i?'wrist-down':'wrist-up');return [{kind:'sample',record},contextItemForSample(record)];})});
 f.call('POST','/protocol/survey',{...scope,confirmed:true},true);f.call('POST','/protocol/lock',{...scope,sampleIds:ids,revisionId:'retry-model'});
 const failure={...f.scope,revisionId:'retry-model',trainingAttemptId:'construction-1',sampleIds:ids,status:'failure',error:'declared synthetic construction failure',settings:{segmentDurationMs:2000},startedAt:1,finishedAt:2};
 f.call('POST','/collection',{id:f.p.id,items:[{kind:'training',record:failure}]});
 const success={...failure,trainingAttemptId:'construction-2',status:'success',error:'',startedAt:3,finishedAt:4};f.call('POST','/collection',{id:f.p.id,items:[{kind:'training',record:success}]});
 const directory=path.join(f.dir,'sessions',f.p.id,'collection',f.scope.sessionId);assert.equal(JSON.parse(fs.readFileSync(path.join(directory,'training','retry-model.json'),'utf8')).status,'success');
 const attempts=fs.readdirSync(path.join(directory,'training-attempts')).map(name=>JSON.parse(fs.readFileSync(path.join(directory,'training-attempts',name),'utf8')));assert.equal(attempts.length,2);assert.ok(attempts.some(a=>a.status==='failure'));assert.ok(attempts.some(a=>a.status==='success'));
 assert.equal(f.call('POST','/join',{id:f.p.id}).body.protocolState.trainingStatus,'success');
 const zip=f.call('GET',`/export/${f.exp.id}/collection`,{},true).buffer;let history;for(let at=0;zip.readUInt32LE(at)===0x04034b50;){const n=zip.readUInt16LE(at+26),e=zip.readUInt16LE(at+28),size=zip.readUInt32LE(at+18),name=zip.subarray(at+30,at+30+n).toString(),start=at+30+n+e;if(name==='training-attempts.json')history=JSON.parse(zip.subarray(start,start+size).toString());at=start+size;}assert.equal(history?.records.length,2,'failure and successful retry are included in decoded ZIP');
 assert.throws(()=>f.call('POST','/collection',{id:f.p.id,items:[{kind:'training',record:{...success,trainingAttemptId:'not-a-restore'}}]}),/ready|frozen|restore/i);
 assert.equal(f.call('POST','/collection',{id:f.p.id,items:[{kind:'training',record:success}]}).body.acceptedCount,1,'exact retry is idempotent');
});
test('a visit binds one condition dataset session so another session cannot create a second quota or overwrite restore',t=>{
 const f=fixture(t);f.call('POST','/collection',{id:f.p.id,items:[{kind:'sample',record:f.sample('bound-up')}]});
 assert.throws(()=>f.call('POST','/collection',{id:f.p.id,items:[{kind:'sample',record:{...f.sample('extra-up'),sessionId:'quota-bypass'}}]}),/session|scope/i);
 const joined=f.call('POST','/join',{id:f.p.id}).body;assert.equal(joined.protocolState.sessionId,f.scope.sessionId);assert.equal(joined.restored.sessionId,f.scope.sessionId);assert.equal(joined.restored.trials.length,1);
});
export {fixture};
