import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {validateContextRecord,persistContextRecord,readContextRecords,exportContextRecords,setContextDisposition} from '../server/context-records.mjs';
test('context validator does not accept impossible five-second completeness or a shortened captured post window',()=>{
 for(const mutate of [r=>{r.points=r.points.slice(2);r.center.startIndex-=2;r.center.endIndexExclusive-=2;},r=>{r.points=r.points.slice(0,-2);},r=>{r.window.endAt=11000;r.points=r.points.filter(p=>p.time<11000);}]){
  const r=fixture();mutate(r);assert.throws(()=>validateContextRecord(r),/coverage|post boundary/);
 }
});
const fixture=()=>({schemaVersion:1,contextId:'context-1',scope:{participantId:'fixture-code',sessionId:'v1',condition:'button',source:'mock',sourceEpoch:1,channel:0},attempt:{attemptId:'context-1',gestureId:'wrist-up',cueAt:5000},sampleId:'sample-1',status:'captured',disposition:'retained',center:{startAt:5000,endAt:7000,startIndex:10,endIndexExclusive:14,startConsumptionId:10},window:{startAt:0,endAt:12000,preMs:5000,postMs:5000},points:Array.from({length:24},(_,i)=>({time:i*500,raw:i+.123,consumptionId:i})),complete:true,reasons:[]});
test('isolated context persistence/export roundtrip is idempotent and deletion preserves raw rejected evidence',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'emg-context-'));try{
 const original=fixture();assert.deepEqual(validateContextRecord(original),original);
 await persistContextRecord(dir,original);await persistContextRecord(dir,structuredClone(original));assert.equal((await readContextRecords(dir)).length,1);
 await setContextDisposition(dir,'context-1','rejected');await setContextDisposition(dir,'context-1','deleted');
 const [record]=await readContextRecords(dir);assert.deepEqual(record.points,original.points);assert.equal(record.disposition,'deleted');
 const exported=await exportContextRecords(dir);assert.equal(JSON.parse(exported.json)[0].disposition,'deleted');assert.deepEqual(JSON.parse(exported.dispositionJson).map(e=>e.disposition),['rejected','deleted']);assert.match(exported.csv,/context-1,sample-1,10,center,10,5000,10.123/);
 await assert.rejects(()=>persistContextRecord(dir,{...original,sampleId:'conflicting'}),/conflict/i);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('context validator rejects extra identifying keys, invalid clocks, index mismatch, nonfinite and broadened center',()=>{
 for(const mutate of [r=>r.name='not allowed',r=>r.scope.name='not allowed',r=>r.attempt.email='not allowed',r=>r.points[0].deviceName='not allowed',r=>r.points[2].time=-1,r=>r.points[2].time=1250,r=>r.points[2].raw=NaN,r=>r.center.startIndex=9,r=>r.center.endAt=7175,r=>r.points[1].consumptionId=0]){
 const r=fixture();mutate(r);assert.throws(()=>validateContextRecord(r));
 }
});
