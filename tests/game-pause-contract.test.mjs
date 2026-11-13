import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './support/practice-fixture.mjs';

test('pause contract survives actual backend readback and rejects invalid accounting',async t=>{
 const f=await fixture(t);
 const e=await f.call('POST','/experiments',{name:'Synthetic pause contract',protocolVersion:'legacy-fixed-v1'},true);
 const p=(await f.call('POST','/participants/generate',{experimentId:e.body.id,count:1,assignment:'button',isTestParticipant:true},true)).body.participants[0];
 const run={id:'pause-run',sessionId:'pause-session',round:1,condition:'button',gameScore:0,outcomes:[],startedAt:1000,endedAt:10000,activeDurationMs:5000,sourceRecoveryPauses:[{startedAt:2000,endedAt:6000,reason:'Source changed'}]};
 assert.equal((await f.call('POST','/runs',{id:p.id,run})).status,200);
 assert.equal((await f.call('POST','/collection',{id:p.id,items:[{kind:'run',record:{...run,generation:1}}]})).body.acceptedCount,1);
 const fs=await import('node:fs');const walk=p=>fs.readdirSync(p,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(p+'/'+e.name):[p+'/'+e.name]);
 const saved=walk(f.data).filter(p=>p.endsWith('.json')).map(p=>JSON.parse(fs.readFileSync(p))).flatMap(r=>Array.isArray(r)?r:[]).find(r=>r.id===run.id);
 const exported=await f.call('GET','/export/'+e.body.id+'/collection',{},true);assert.equal(exported.status,200);
 const bytes=exported.buffer;let offset=0,entries={};while(bytes.readUInt32LE(offset)===0x04034b50){const size=bytes.readUInt32LE(offset+18),n=bytes.readUInt16LE(offset+26),x=bytes.readUInt16LE(offset+28),start=offset+30+n+x;entries[bytes.subarray(offset+30,offset+30+n).toString()]=bytes.subarray(start,start+size).toString();offset=start+size;}
 assert.match(entries['runs.csv'],/active_duration_ms/);assert.match(entries['runs.csv'],/source_recovery_pauses_json/);assert.match(entries['runs.csv'],/5000/);assert.match(entries['runs.csv'],/Source changed/);
 assert.ok(entries['runs.csv'].includes('"'+JSON.stringify(run.sourceRecoveryPauses).replaceAll('"','""')+'"'));
 assert.ok(saved,'actual persisted run');assert.equal(saved.activeDurationMs,5000);assert.deepEqual(saved.sourceRecoveryPauses,run.sourceRecoveryPauses);assert.equal(saved.startedAt,1000);assert.equal(saved.endedAt,10000);
 assert.equal((await f.call('POST','/runs',{id:p.id,run:{...run,id:'zero-active',startedAt:2000,endedAt:2000,activeDurationMs:0,sourceRecoveryPauses:[{startedAt:2000,endedAt:2000,reason:'held exit'}]}})).status,200);
 for(const patch of [{activeDurationMs:-1},{activeDurationMs:5001},{sourceRecoveryPauses:[{startedAt:0,endedAt:6000,reason:'bad'}]},{sourceRecoveryPauses:[{startedAt:2000,endedAt:6000,reason:'a'},{startedAt:5000,endedAt:7000,reason:'b'}]},{activeDurationMs:Infinity},{sourceRecoveryPauses:undefined}])assert.ok((await f.call('POST','/runs',{id:p.id,run:{...run,...patch,id:'invalid'}})).status>=400,JSON.stringify(patch));
});
