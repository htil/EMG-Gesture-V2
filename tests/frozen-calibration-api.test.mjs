import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './support/practice-fixture.mjs';
import { restCalibration } from '../src/app/study/frozenCalibration.mjs';
import fs from 'node:fs';

test('saved rest retains recomputable immutable envelope calibration, including tied source samples', async t => {
  const f = await fixture(t);
  const rest = { ...f.record, flowVersion: 2 };
  rest.points = rest.points.flatMap((p,i) => [{ ...p, activityEnvelope: i % 2 ? 0.12 : 0.08 }, { ...p, value: -p.value, activityEnvelope: i % 2 ? 0.08 : 0.12 }]);
  rest.calibration = { version: 1, formula: 'rest-envelope-mean-plus-3-population-sd', revision: rest.id,
    participantId: rest.participantId, experimentId: rest.experimentId, sessionId: rest.sessionId, generation: rest.generation, round: rest.round, condition: rest.condition,
    signalSource: rest.signalSource, channelIndex: rest.channelIndex, restId: rest.id, mean: 0.1, sd: 0.02, threshold: 0.16, count: 402, durationMs: 10000,
    activationHoldMs: 100, restHoldMs: 300, maxGapMs: 500, displayMax: 0.32 };
  const saved = await f.call('POST','/practice',{id:f.participant.id,record:rest});
  assert.equal(saved.status,200);
  const read = (await f.call('GET','/practice/'+f.participant.id)).body.records.find(r=>r.id===rest.id);
  assert.deepEqual(read.calibration,rest.calibration);
  assert.deepEqual(read.points,rest.points);
});

test('measured collection, reload and ZIP retain exact calibration and confirmation anchors; malformed/scope-mismatched lineage is rejected', async t => {
 const f=await fixture(t);const rest={...f.record,flowVersion:2};rest.calibration=restCalibration(rest);
 assert.equal((await f.call('POST','/practice',{id:f.participant.id,record:rest})).status,200);
 const sample={sampleId:'measured-fixed',participantId:rest.participantId,experimentId:rest.experimentId,sessionId:rest.sessionId,generation:rest.generation,condition:rest.condition,round:1,phase:'capture',gestureId:'pinch',gestureLabel:'Pinch',capturedAt:22000,recordingStartedAt:10000,recordingEndedAt:11400,triggeredAt:10200,firstCrossingAt:null,preTriggerPointCount:4,points:f.capture('pinch').points,signalSource:'mock',channelIndex:0,settings:rest.settings,calibration:rest.calibration};
 assert.equal((await f.call('POST','/collection',{id:f.participant.id,items:[{kind:'sample',record:sample}]})).status,200);
 const files=fs.readdirSync(f.data,{recursive:true}).filter(p=>p.endsWith('/samples/measured-fixed.json'));assert.equal(files.length,1);
 const saved=JSON.parse(fs.readFileSync(f.data+'/'+files[0],'utf8'));assert.deepEqual(saved.calibration,sample.calibration);assert.equal(saved.firstCrossingAt,null);
 await f.call('POST','/collection',{id:f.participant.id,items:[{kind:'checkpoint',record:{sessionId:rest.sessionId,generation:rest.generation,round:1,stage:'capture',unlockedThrough:'capture',trials:[],modelRevisionId:null}}]});
 const joined=(await f.call('POST','/join',{id:f.participant.id})).body;
 assert.deepEqual(joined.restored.trials.find(x=>x.id===sample.sampleId).calibration,sample.calibration);
 for(const override of [{threshold:0.9},{channelIndex:1},{revision:'fabricated'},{activationHoldMs:0}]){
  const invalid={...sample,sampleId:'invalid-'+Object.keys(override)[0],calibration:{...sample.calibration,...override}};
  assert.equal((await f.call('POST','/collection',{id:f.participant.id,items:[{kind:'sample',record:invalid}]})).status,400);
 }
 const exported=await f.call('GET','/export/'+f.experiment.id+'/collection',{},true);assert.equal(exported.status,200);
 const bytes=exported.buffer;let offset=0,entries={};while(bytes.readUInt32LE(offset)===0x04034b50){const size=bytes.readUInt32LE(offset+18),n=bytes.readUInt16LE(offset+26),e=bytes.readUInt16LE(offset+28);const name=bytes.subarray(offset+30,offset+30+n).toString();const start=offset+30+n+e;entries[name]=bytes.subarray(start,start+size).toString();offset=start+size;}
 assert.deepEqual(JSON.parse(entries['waveforms.json']).samples.find(s=>s.sampleId===sample.sampleId).calibration,sample.calibration);
 assert.match(entries['samples.csv'],/calibration_revision/);assert.match(entries['samples.csv'],new RegExp(sample.calibration.revision));
});

test('invalid rest statistics fail with client error; revision labels cannot smuggle malformed calibration through checkpoint or progress',async t=>{
 const f=await fixture(t);const rest={...f.record,flowVersion:2};rest.calibration=restCalibration(rest);
 for(const points of [rest.points.map(p=>({...p,activityEnvelope:undefined})),rest.points.map(p=>({...p,activityEnvelope:0}))]) assert.equal((await f.call('POST','/practice',{id:f.participant.id,record:{...rest,points}})).status,400);
 const trial={id:'fabricated-trial',gestureId:'pinch',points:f.capture('pinch').points,calibration:{...rest.calibration,threshold:100}};
 assert.equal((await f.call('POST','/collection',{id:f.participant.id,items:[{kind:'checkpoint',record:{sessionId:rest.sessionId,generation:rest.generation,round:1,trials:[trial]}}]})).status,400);
 assert.equal((await f.call('POST','/progress',{id:f.participant.id,round:1,trials:[trial]})).status,400);
});

test('new measured calibrated records reject invalid raw/time data instead of coercing it during persistence',async t=>{
 const f=await fixture(t),rest={...f.record,flowVersion:2};rest.calibration=restCalibration(rest);await f.call('POST','/practice',{id:f.participant.id,record:rest});
 const capture=f.capture('pinch');const sample={...rest,sampleId:'invalid-raw',gestureId:'pinch',gestureLabel:'Pinch',phase:'capture',triggeredAt:10200,recordingStartedAt:10000,recordingEndedAt:11400,preTriggerPointCount:4,points:capture.points,calibration:rest.calibration};
 for(const point of [{time:10000,value:NaN},{time:999,value:.1},{time:null,value:.1}])assert.equal((await f.call('POST','/collection',{id:f.participant.id,items:[{kind:'sample',record:{...sample,points:sample.points.map((p,i)=>i===5?point:p)}}]})).status,400);
});

test('new calibration-bearing collection records reject stale generations instead of acknowledging a skipped save',async t=>{
 const f=await fixture(t);const record={...f.record,generation:f.record.generation+1,sampleId:'stale-generation',calibration:restCalibration(f.record)};
 assert.equal((await f.call('POST','/collection',{id:f.participant.id,items:[{kind:'sample',record}]})).status,409);
});
