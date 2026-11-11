import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
import {createStudyDesk} from '../server/study-api.mjs';
const hashes=dir=>Object.fromEntries(fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?Object.entries(hashes(path.join(dir,e.name))).map(([p,h])=>[path.join(e.name,p),h]):[[e.name,crypto.createHash('sha256').update(fs.readFileSync(path.join(dir,e.name))).digest('hex')]]));
const unzip=b=>{let o=0,r={};while(b.readUInt32LE(o)===0x04034b50){const n=b.readUInt16LE(o+26),x=b.readUInt16LE(o+28),z=b.readUInt32LE(o+18),s=o+30+n+x;r[b.subarray(o+30,o+30+n).toString()]=b.subarray(s,s+z).toString();o=s+z;}return r;};
import {roundFixture} from './support/round-api-fixture.mjs';
import {fixture} from './support/practice-fixture.mjs';
test('legacy later-round checkpoint keeps its existing singleton contract',async t=>{
 const f=await fixture(t);const e=(await f.call('POST','/experiments',{name:'Synthetic legacy checkpoint',protocolVersion:'legacy-fixed-v1',repetitions:2,capturesMin:1,capturesMax:1},true)).body;
 const p=(await f.call('POST','/participants/generate',{experimentId:e.id,count:1,assignment:'button',isTestParticipant:true},true)).body.participants[0];await f.call('POST','/join',{id:p.id});assert.equal((await f.call('POST','/progress',{id:p.id,round:1,trials:[]})).status,200);
 const record={sessionId:'legacy-second',generation:1,round:2,condition:'button',stage:'results',trials:[]};assert.equal((await f.call('POST','/collection',{id:p.id,items:[{kind:'checkpoint',record}]})).status,200);
 assert.equal(fs.existsSync(path.join(f.data,'sessions',p.id,'checkpoint.json')),true);assert.equal((await f.call('POST','/join',{id:p.id})).body.restored.stage,'results');
});
for(const condition of ['button','threshold'])test(condition+': completed v2 explicitly starts independent round two',async t=>{
 const f=await roundFixture(t,condition),old=await f.complete();
 const request={id:f.p.id,experimentId:f.experiment.id,generation:1,condition,fromRound:1,fromSessionId:old.s.sessionId,requestId:'advance-1',finalizationReceiptDigest:(await f.join()).finalizationReceiptDigest};
 const before=hashes(path.join(f.data,'sessions'));
 const next=await f.call('POST','/protocol/next-round',request);assert.equal(next.status,200,JSON.stringify(next));
 assert.equal(next.body.round,2);assert.notEqual(next.body.sessionId,old.s.sessionId);assert.equal(next.body.condition,condition);
 const joined=await f.join();assert.equal(joined.round,2);assert.equal(joined.restored.trials.length,0);assert.equal(joined.protocolState.lock,null);assert.equal(joined.protocolState.practice,null);
 const same=await f.call('POST','/protocol/next-round',{...request,requestId:'other-tab'});assert.deepEqual(same.body,next.body);
 assert.deepEqual((await f.call('POST','/progress',old.progress)).body,old.receipt);
 assert.equal((await f.join()).round,2);
 assert.equal((await f.call('POST','/collection',{id:f.p.id,items:[old.contexts[0]]})).status,200,'exact archived context is read-only ACK');
 const changed=structuredClone(old.contexts[0]);changed.record.context.points[0].raw+=1;
 assert.equal((await f.call('POST','/collection',{id:f.p.id,items:[changed]})).status,409);
 assert.equal((await f.call('POST','/save-alert',{id:f.p.id,generation:1,round:1,sessionId:old.s.sessionId,condition,active:true})).status,409);
 const second=await f.complete(2,next.body.sessionId);const beforeSecond=hashes(path.join(f.data,'sessions'));
 const next2=await f.call('POST','/protocol/next-round',{...request,fromRound:2,fromSessionId:next.body.sessionId,requestId:'advance-2',finalizationReceiptDigest:(await f.join()).finalizationReceiptDigest});assert.equal(next2.status,200,JSON.stringify(next2));assert.equal(next2.body.round,3);
 assert.deepEqual((await f.call('POST','/protocol/next-round',request)).body,next.body,'old retry never advances current round');
 const archive=await f.call('GET','/export/'+f.experiment.id+'/collection',{},true);assert.equal(archive.status,200);const entries=unzip(archive.buffer);
 const sampleLine=entries['samples.csv'].split('\n').find(l=>l.startsWith('r2-wrist-up-0,'));assert.ok(sampleLine);assert.ok(sampleLine.includes(',retained,'),'old-round event cannot mark new-round same ID deleted');
 assert.match(entries['attempts.csv'].split('\n')[0],/round/);assert.match(entries['attempts.csv'].split('\n')[0],/session_id/);assert.match(entries['attempts.csv'].split('\n')[0],/generation/);
 assert.equal(JSON.parse(entries['protocol.json']).participants[0].visits.length,3);
 const history=JSON.parse(entries['round-history.json']).participants.find(p=>p.participantId===f.p.id);assert.equal(history.finalizations.length,2);assert.equal(history.advances.length,2);assert.equal(history.checkpoints.length,3);
 assert.equal(JSON.parse(entries['models-and-runs.json']).training.length,2);assert.equal(JSON.parse(entries['models-and-runs.json']).runs.length,2);
 const after=hashes(path.join(f.data,'sessions'));for(const [p,h]of Object.entries(beforeSecond))assert.equal(after[p],h,'all prior round 1+2 bytes '+p);for(const [p,h] of Object.entries(before).filter(([p])=>!p.endsWith('-runs.json')))assert.equal(after[p],h,'immutable prior bytes '+p);
 if(process.env.EMG_ROUND_EVIDENCE_DIR){const dir=process.env.EMG_ROUND_EVIDENCE_DIR;fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,condition+'-all-rounds.zip'),archive.buffer);fs.writeFileSync(path.join(dir,condition+'-proof.json'),JSON.stringify({coverage:'Synthetic API-seeded preparation; real rest/skip/lock/training/run/finalization/advance APIs. No physical signal or classifier performance claim.',participantId:f.p.id,condition,source:old.s,round2:next.body,round3:next2.body,oldRoundHashes:before,afterHashes:after,history,zipMembers:Object.keys(entries)},null,2));}
 const rows=await createStudyDesk(f.data).handle({method:'GET',pathname:'/participants',body:{},headers:{'x-admin-pin':process.env.EMG_ADMIN_PIN},searchParams:new URLSearchParams({experimentId:f.experiment.id})});assert.equal(rows.status,200);const view=rows.body.participants.find(p=>p.id===f.p.id);assert.equal(view.roundsCompleted,2);assert.equal(view.roundHistory.visits.length,3);
});
test('advance rejects a missing source checkpoint before intent',async t=>{
 const f=await roundFixture(t),old=await f.complete(),root=path.join(f.data,'sessions',f.p.id),file=path.join(root,'checkpoint.json');
 const request={id:f.p.id,experimentId:f.experiment.id,generation:1,condition:'button',fromRound:1,fromSessionId:old.s.sessionId,requestId:'missing-checkpoint',finalizationReceiptDigest:(await f.join()).finalizationReceiptDigest};
 assert.equal(fs.existsSync(file),true,'real completion wrote the synthetic source checkpoint');fs.unlinkSync(file);
 const before=hashes(f.data),result=await f.call('POST','/protocol/next-round',request),after=hashes(f.data);
 const absent=Object.fromEntries(['checkpoint.json','advance-1-1.json','visit-2.json','checkpoints/1-2.json'].map(name=>[name,!fs.existsSync(path.join(root,name))]));
 if(process.env.EMG_ROUND_EVIDENCE_DIR){fs.mkdirSync(process.env.EMG_ROUND_EVIDENCE_DIR,{recursive:true});fs.writeFileSync(path.join(process.env.EMG_ROUND_EVIDENCE_DIR,'missing-checkpoint-proof.json'),JSON.stringify({coverage:'Real synthetic roundFixture completion; delete only its source checkpoint; hash entire fixture data after deletion.',status:result.status,response:result.body,beforeHashes:before,afterHashes:after,absent},null,2));}
 assert.equal(result.status,409,JSON.stringify(result));assert.deepEqual(after,before,'all fixture data bytes unchanged after rejection');
 for(const [name,missing] of Object.entries(absent))assert.equal(missing,true,'no source repair or advance target: '+name);
});
test('advance rejects a corrupted source checkpoint before intent',async t=>{
 const f=await roundFixture(t),old=await f.complete(),file=path.join(f.data,'sessions',f.p.id,'checkpoint.json');const cp=JSON.parse(fs.readFileSync(file,'utf8'));cp.sessionId='wrong-source';fs.writeFileSync(file,JSON.stringify(cp));
 const before=hashes(f.data);const r=await f.call('POST','/protocol/next-round',{id:f.p.id,experimentId:f.experiment.id,generation:1,condition:'button',fromRound:1,fromSessionId:old.s.sessionId,requestId:'corrupt-checkpoint',finalizationReceiptDigest:(await f.join()).finalizationReceiptDigest});assert.equal(r.status,409);assert.deepEqual(hashes(f.data),before);
});
for(const boundary of ['after-intent','after-target-visit','after-checkpoint','after-pointer','after-commit'])test('restart recovers exactly one target at '+boundary,async t=>{
 const f=await roundFixture(t),old=await f.complete();const request={id:f.p.id,experimentId:f.experiment.id,generation:1,condition:'button',fromRound:1,fromSessionId:old.s.sessionId,requestId:'crash-request',finalizationReceiptDigest:(await f.join()).finalizationReceiptDigest};
 const before=hashes(path.join(f.data,'sessions'));let fired=false;
 const desk=createStudyDesk(f.data,{roundAdvanceFault:at=>{if(at===boundary&&!fired){fired=true;throw new Error('synthetic crash '+at);}}});
 assert.throws(()=>desk.handle({method:'POST',pathname:'/protocol/next-round',body:request,headers:{},searchParams:new URLSearchParams()}),/synthetic crash/);
 const intent=JSON.parse(fs.readFileSync(path.join(f.data,'sessions',f.p.id,'advance-1-1.json'),'utf8'));
 const joined=await f.join();assert.equal(joined.round,2);assert.equal(joined.sessionId,intent.payload.response.sessionId);assert.equal(joined.restored.sessionId,joined.sessionId);
 assert.deepEqual((await f.call('POST','/protocol/next-round',request)).body,intent.payload.response);
 assert.equal(fs.existsSync(path.join(f.data,'sessions',f.p.id,'visit-3.json')),false);
 assert.deepEqual((await f.call('POST','/progress',old.progress)).body,old.receipt);assert.equal((await f.join()).round,2);
 const after=hashes(path.join(f.data,'sessions'));for(const [p,h]of Object.entries(before))assert.equal(after[p],h,p);
});
test('archived ACK must match sealed source manifest, not rewritten canonical files',async t=>{
 const f=await roundFixture(t),old=await f.complete();const request={id:f.p.id,experimentId:f.experiment.id,generation:1,condition:'button',fromRound:1,fromSessionId:old.s.sessionId,requestId:'sealed-ack',finalizationReceiptDigest:(await f.join()).finalizationReceiptDigest};assert.equal((await f.call('POST','/protocol/next-round',request)).status,200);
 const item=structuredClone(old.contexts[0]);item.record.context.points[0].raw+=1;const context=item.record.context,hash=crypto.createHash('sha256').update(context.contextId).digest('hex'),dir=path.join(f.data,'sessions',f.p.id,'collection',old.s.sessionId,'contexts');
 fs.writeFileSync(path.join(dir,hash+'.context.json'),JSON.stringify(context));fs.writeFileSync(path.join(dir,hash+'.json'),JSON.stringify({generation:1,round:1,condition:'button',context}));
 const before=hashes(f.data);assert.equal((await f.call('POST','/collection',{id:f.p.id,items:[item]})).status,409);assert.deepEqual(hashes(f.data),before);
});
test('intent rename failure publishes no target; new desk retries safely',async t=>{
 const f=await roundFixture(t),old=await f.complete();const request={id:f.p.id,experimentId:f.experiment.id,generation:1,condition:'button',fromRound:1,fromSessionId:old.s.sessionId,requestId:'io-fault',finalizationReceiptDigest:(await f.join()).finalizationReceiptDigest};
 const rename=fs.renameSync;fs.renameSync=(a,b)=>{if(b.endsWith('advance-1-1.json'))throw new Error('synthetic intent rename failure');return rename(a,b);};let failed;
 try{failed=await f.call('POST','/protocol/next-round',request);}finally{fs.renameSync=rename;}
 assert.equal(failed.status,500);assert.equal((await f.join()).status,'completed');assert.equal(fs.existsSync(path.join(f.data,'sessions',f.p.id,'visit-2.json')),false);
 const next=await f.call('POST','/protocol/next-round',request);assert.equal(next.status,200);assert.equal((await f.join()).sessionId,next.body.sessionId);
});
test('pending advance rejects changed source without publishing target',async t=>{
 const f=await roundFixture(t),old=await f.complete();const request={id:f.p.id,experimentId:f.experiment.id,generation:1,condition:'button',fromRound:1,fromSessionId:old.s.sessionId,requestId:'pending-corruption',finalizationReceiptDigest:(await f.join()).finalizationReceiptDigest};
 const desk=createStudyDesk(f.data,{roundAdvanceFault:at=>{if(at==='after-intent')throw new Error('synthetic stop');}});assert.throws(()=>desk.handle({method:'POST',pathname:'/protocol/next-round',body:request,headers:{},searchParams:new URLSearchParams()}),/synthetic stop/);
 const file=path.join(f.data,'sessions',f.p.id,'checkpoint.json');fs.appendFileSync(file,' ');
 const before=hashes(f.data);const result=await f.call('POST','/join',{id:f.p.id});assert.equal(result.status,409);assert.deepEqual(hashes(f.data),before);assert.equal(fs.existsSync(path.join(f.data,'sessions',f.p.id,'visit-2.json')),false);
});
test('source validation and stale writers reject without any writes',async t=>{
 const f=await roundFixture(t),s=f.scope(1,'synthetic-round-1');
 const request={id:f.p.id,experimentId:f.experiment.id,generation:1,condition:'button',fromRound:1,fromSessionId:s.sessionId,requestId:'negative',finalizationReceiptDigest:'not-committed'};
 let before=hashes(f.data);assert.equal((await f.call('POST','/protocol/next-round',request)).status,409);assert.deepEqual(hashes(f.data),before);
 const old=await f.complete();request.finalizationReceiptDigest=(await f.join()).finalizationReceiptDigest;
 for(const change of [{condition:'threshold'},{generation:2},{fromRound:2},{experimentId:'other-experiment'},{fromSessionId:'wrong-session'},{id:'OTHER-PERSON'},{extra:'unknown'},{finalizationReceiptDigest:'changed'}]){before=hashes(f.data);const r=await f.call('POST','/protocol/next-round',{...request,...change});assert.equal(r.status,409,JSON.stringify(r));assert.deepEqual(hashes(f.data),before);}
 const results=await Promise.all([f.call('POST','/protocol/next-round',request),f.call('POST','/protocol/next-round',{...request,requestId:'second-tab'})]);assert.deepEqual(results[0].body,results[1].body);
 const next=results[0].body,scope=f.scope(2,next.sessionId);
 assert.equal((await f.call('POST','/save-alert',{id:f.p.id,...scope,active:true,message:'round two'})).status,200);
 before=hashes(f.data);
 for(const body of [{id:f.p.id,generation:1,active:false},{id:f.p.id,...old.s,active:false},{id:f.p.id,...old.s,active:true}])assert.equal((await f.call('POST','/save-alert',body)).status,409);
 for(const item of [{kind:'meta',record:old.s},{kind:'checkpoint',record:{...old.s,trials:[]}},{kind:'context',record:{...old.contexts[0].record,context:{...old.contexts[0].record.context,contextId:'new-old-context'}}}])assert.equal((await f.call('POST','/collection',{id:f.p.id,items:[item]})).status,409);
 assert.deepEqual(hashes(f.data),before);
 assert.equal((await f.call('POST','/protocol/lock',{id:f.p.id,...scope,sampleIds:[],revisionId:'old-model'})).status,409,'fresh rest/Practice/samples are mandatory');
});
