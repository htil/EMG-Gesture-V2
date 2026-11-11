import assert from 'node:assert/strict';
import {fixture} from './practice-fixture.mjs';
import {restCalibration} from '../../src/app/study/frozenCalibration.mjs';
import {contextItemForSample} from './pilot-context-fixture.mjs';
// Synthetic API preparation only: no hardware or classifier-performance claim.
export async function roundFixture(t,condition='button') {
 const f=await fixture(t);
 const e=await f.call('POST','/experiments',{name:'Synthetic repeat rounds',protocolVersion:'between-subject-v2',repetitions:1,capturesMin:8,capturesMax:8},true);assert.equal(e.status,201);
 const p=(await f.call('POST','/participants/generate',{experimentId:e.body.id,count:1,assignment:condition,isTestParticipant:true},true)).body.participants[0];
 const join=async()=>(await f.call('POST','/join',{id:p.id})).body;
 await join();
 const scope=(round,sessionId)=>({participantId:p.id,experimentId:e.body.id,generation:1,round,sessionId,condition});
 async function complete(round=1,sessionId='synthetic-round-1') {
  const s=scope(round,sessionId),settings={segmentDurationMs:2000,preTriggerWindowMs:0,countdownMs:3000,activityThreshold:.6};
  const rest={...f.record,...s,id:'rest-'+round,attemptId:'rest-attempt-'+round,flowVersion:4,signalSource:'live',settings};rest.calibration=restCalibration(rest);
  const ok=async(method,url,body,admin=false)=>{const r=await f.call(method,url,body,admin);assert.equal(r.status,200,JSON.stringify(r));return r;};
  await ok('POST','/practice',{id:p.id,record:rest});await ok('POST','/protocol/practice/skip',{id:p.id,...s},true);
  if(round===1)await ok('POST','/collection',{id:p.id,items:[{kind:'event',record:{...s,eventId:'legacy-reused-id-event',type:'sample_deleted',sampleId:'r2-wrist-up-0',at:25000}}]});
  const samples=['wrist-up','wrist-down'].flatMap((g,j)=>Array.from({length:8},(_,k)=>{const at=30000+(j*8+k)*3000;return {...s,sampleId:`r${round}-${g}-${k}`,attemptId:`a${round}-${g}-${k}`,centerDurationMs:2000,gestureId:g,gestureLabel:g,signalSource:'live',channelIndex:0,capturedAt:at+2000,triggeredAt:at,firstCrossingAt:condition==='threshold'?at-100:null,recordingStartedAt:at,recordingEndedAt:at+2000,preTriggerPointCount:0,points:Array.from({length:400},(_,i)=>({time:at+i*5,value:Math.sin(i*(j+1)*.1)*.00001})),settings,calibration:rest.calibration};}));
  await ok('POST','/collection',{id:p.id,items:samples.map(record=>({kind:'sample',record}))});
  const contexts=samples.map(contextItemForSample);await ok('POST','/collection',{id:p.id,items:contexts});
  const revisionId='model-'+round;await ok('POST','/protocol/lock',{id:p.id,...s,sampleIds:samples.map(r=>r.sampleId),revisionId});
  await ok('POST','/collection',{id:p.id,items:[{kind:'training',record:{...s,revisionId,sampleIds:samples.map(r=>r.sampleId),status:'success',settings}}]});
  const joined=await join(),id='run-'+round,startedAt=100000;
  const run={...s,id,runId:id,modelRevisionId:revisionId,runKind:'official',completionStatus:'complete',officialSequence:joined.officialSequence,streamReady:true,signalSource:'live',startedAt,endedAt:160000,recordedAt:160000,difficulty:'easy',gameScore:0,outcomes:joined.officialSequence.map((g,i)=>({trialIndex:i+1,attemptId:`${id}:${i+1}`,expectedGestureId:g,result:'unknown',predictedGestureId:null,cueAt:startedAt+i*3000,recordingStartedAt:startedAt+i*3000,recordingEndedAt:startedAt+i*3000+2000,inferenceStartedAt:startedAt+i*3000+2000,inferenceEndedAt:startedAt+i*3000+2001,sampleCount:400}))};
  await ok('POST','/collection',{id:p.id,items:[{kind:'run',record:run},{kind:'checkpoint',record:{...s,stage:'results',trials:joined.restored.trials}}]});
  const progress={id:p.id,...s,trials:joined.restored.trials};const finalized=await ok('POST','/progress',progress);
  return {s,contexts,progress,receipt:finalized.body};
 }
 return {...f,p,experiment:e.body,join,scope,complete};
}
