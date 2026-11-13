import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {dispatchStudyRequest} from '../server/study-api.mjs';
import {mount,text} from './support/mounted-capture-state-fixture.mjs';

const intentKey='emg-next-round-intent-v1';
const advances=f=>f.writes.filter(w=>w.url.endsWith('/protocol/next-round'));
const completed=async t=>{const f=await mount(t,'button',false,{v2:true,results:true,mock:false});await f.click('Submit session');await f.advance(500);return f;};
const walk=dir=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(dir,e.name)):[path.join(dir,e.name)]);
function oldContext(f,s){const file=walk(f.data).find(p=>p.endsWith('.json')&&!p.endsWith('.context.json')&&p.includes('/contexts/'));const record=JSON.parse(fs.readFileSync(file));return {kind:'context',record:{...record,sessionId:s.sessionId}};}

test('pending durable ACK prevents any advance request',async t=>{
 const f=await completed(t),s=JSON.parse(localStorage.getItem('emg-study-session'));
 let release;const gate=new Promise(r=>release=r);t.after(()=>release());const original=globalThis.fetch;let held=0;
 globalThis.fetch=async(...args)=>{if(args[0].endsWith('/collection')){held++;await gate;}return original(...args);};
 void f.enqueue([oldContext(f,s)]);await f.advance(100);assert.ok(held);
 await f.click('Start next round');await f.advance(200);
 assert.equal(advances(f).length,0);assert.ok(JSON.parse(localStorage.getItem('emg-collection-queue')).length);
 release();await f.advance(500);assert.equal(advances(f).length,1);assert.equal((await f.call('POST','/join',{id:f.p.id})).body.round,2);
});

test('failed durable intent storage fails closed before POST',async t=>{
 const f=await completed(t);const set=localStorage.setItem.bind(localStorage);
 localStorage.setItem=(k,v)=>{if(k===intentKey)throw new Error('SYNTHETIC_INTENT_STORAGE_FAILURE');set(k,v);};
 await f.click('Start next round');await f.advance(100);
 assert.equal(advances(f).length,0);assert.ok(text(f.renderer.toJSON()).includes('SYNTHETIC_INTENT_STORAGE_FAILURE'));
 assert.equal((await f.call('POST','/join',{id:f.p.id})).body.round,1);
});

test('lost real advance response retains identical source across reload and explicit retry',async t=>{
 const f=await completed(t),original=globalThis.fetch;let lose=true;
 globalThis.fetch=async(...args)=>{const r=await original(...args);if(args[0].endsWith('/protocol/next-round')&&lose){lose=false;throw new Error('SYNTHETIC_LOST_ADVANCE_RESPONSE');}return r;};
 await f.click('Start next round');await f.advance(200);
 assert.equal((await f.call('POST','/join',{id:f.p.id})).body.round,2);const saved=localStorage.getItem(intentKey);assert.ok(saved);
 await f.reload();await f.advance(300);assert.equal(advances(f).length,1,'reload never advances automatically');
 assert.equal(localStorage.getItem(intentKey),saved);assert.ok(text(f.renderer.toJSON()).includes('Session complete'));
 await f.click('Start next round');await f.advance(300);
 assert.deepEqual(advances(f)[1].body,advances(f)[0].body);assert.equal(localStorage.getItem(intentKey),null);
 assert.equal(JSON.parse(localStorage.getItem('emg-study-session')).round,2);assert.equal((await f.call('POST','/join',{id:f.p.id})).body.round,2);
});

test('new authoritative session storage failure keeps source retry, never silently adopts on reload',async t=>{
 const f=await completed(t),set=localStorage.setItem.bind(localStorage);let broken=true;
 localStorage.setItem=(k,v)=>{if(broken&&k==='emg-study-session'&&JSON.parse(v).round===2)throw new Error('SYNTHETIC_NEW_SCOPE_STORAGE_FAILURE');set(k,v);};
 await f.click('Start next round');await f.advance(200);const saved=localStorage.getItem(intentKey);assert.ok(saved);
 assert.equal(JSON.parse(localStorage.getItem('emg-study-session')).round,1);
 await f.reload();await f.advance(200);assert.equal(advances(f).length,1);assert.equal(localStorage.getItem(intentKey),saved);
 broken=false;await f.click('Start next round');await f.advance(300);
 assert.deepEqual(advances(f)[0].body,advances(f)[1].body);assert.equal(localStorage.getItem(intentKey),null);assert.equal(JSON.parse(localStorage.getItem('emg-study-session')).round,2);
});

test('late old Submit continuation cannot republish after next scope remount',async t=>{
 const f=await mount(t,'button',false,{v2:true,results:true,mock:false});const oldSubmit=f.button('Submit session').props.onClick;
 await f.click('Submit session');await f.advance(500);await f.click('Start next round');await f.advance(500);
 const count=f.writes.length;await f.settle(()=>oldSubmit());await f.advance(1500);
 assert.equal(f.writes.slice(count).filter(w=>w.body.round===1||w.body.items?.some(i=>i.record.round===1)).length,0);
 assert.equal(JSON.parse(localStorage.getItem('emg-study-session')).round,2);
 await f.reload();await f.advance(500);const s=JSON.parse(localStorage.getItem('emg-study-session'));
 assert.equal(s.round,2);assert.equal(s.modelRevisionId,null);assert.deepEqual(s.runs,[]);assert.deepEqual(s.trials,[]);
});

test('round two collection warning set and clear send full item scope',async t=>{
 const f=await completed(t);await f.click('Start next round');await f.advance(500);
 const s=JSON.parse(localStorage.getItem('emg-study-session')),original=globalThis.fetch;let failing=true;
 globalThis.fetch=async(...args)=>{if(failing&&args[0].endsWith('/collection'))return {ok:false,text:async()=>JSON.stringify({error:'SYNTHETIC_NETWORK_FAILURE'})};return original(...args);};
 await f.settle(()=>f.enqueue([{kind:'checkpoint',record:s}]));await f.advance(7000);
 const warnings=()=>f.writes.filter(w=>w.url.endsWith('/save-alert'));
 assert.ok(warnings().some(w=>w.body.active));
 const readAlerts=async()=>{const r=await dispatchStudyRequest(f.data,{method:'GET',pathname:'/participants',body:{},headers:{'x-admin-pin':process.env.EMG_ADMIN_PIN},searchParams:new URLSearchParams({experimentId:f.experiment.id})});assert.equal(r.status,200);return r.body.saveAlerts;};
 const active=await readAlerts();assert.ok(active.some(a=>a.participantId===f.p.id),'real server readback sees scoped warning');
 failing=false;await f.advance(9000);
 assert.ok(warnings().some(w=>w.body.active===false));
 assert.ok(!(await readAlerts()).some(a=>a.participantId===f.p.id),'real server readback confirms clear');
 for(const {body} of warnings()){for(const k of ['round','sessionId','condition','generation'])assert.equal(body[k],s[k],`scoped warning ${k}`);}
});

test('Submit receipt followed by lost completed readback remains exact retryable submission',async t=>{
 const f=await mount(t,'button',false,{v2:true,results:true,mock:false}),original=globalThis.fetch;let lose=true;
 globalThis.fetch=async(...args)=>{const r=await original(...args);if(args[0].endsWith('/join')&&lose){lose=false;throw new Error('SYNTHETIC_LOST_COMPLETED_READBACK');}return r;};
 await f.click('Submit session');await f.advance(100);
 assert.equal(f.button('Start next round'),undefined);
 assert.ok(f.button('Retry submission'),'uncertain completion must remain retryable');
 await f.click('Retry submission');await f.advance(250);
 assert.ok(f.button('Start next round'));assert.equal((await f.call('POST','/join',{id:f.p.id})).body.round,1);
 const posts=f.writes.filter(w=>w.url.endsWith('/progress'));assert.equal(posts.length,2);assert.deepEqual(posts[0].body,posts[1].body);
});

test('malformed durable collection backup cannot be treated as an empty ACKed queue',async t=>{
 const f=await completed(t);localStorage.setItem('emg-collection-queue','{BROKEN_QUEUE');
 await f.click('Start next round');await f.advance(250);
 assert.equal(advances(f).length,0,'unreadable durable queue blocks advance');
 assert.equal(localStorage.getItem('emg-collection-queue'),'{BROKEN_QUEUE');
});

test('pending-intent removal failure reload keeps completed source rather than starting prep',async t=>{
 const f=await completed(t),remove=localStorage.removeItem.bind(localStorage);let broken=true;
 localStorage.removeItem=k=>{if(k===intentKey&&broken)throw new Error('SYNTHETIC_REMOVE_FAILURE');remove(k);};
 await f.click('Start next round');await f.advance(250);assert.ok(localStorage.getItem(intentKey));
 await f.reload();await f.advance(250);
 assert.ok(text(f.renderer.toJSON()).includes('Session complete'));
 assert.equal(f.button('Begin resting recording'),undefined,'pending completed retry cannot run new preparation');
 assert.ok(!text(f.renderer.toJSON()).includes('Resting setup'),'no new scope prep before intent recovery');
 broken=false;await f.click('Start next round');await f.advance(250);assert.equal(localStorage.getItem(intentKey),null);
 assert.deepEqual(advances(f)[0].body,advances(f)[1].body);
});

test('authoritative next-round readback mismatch retains old completed source and pending retry',async t=>{
 const f=await completed(t),original=globalThis.fetch;let corrupt=true;
 globalThis.fetch=async(...args)=>{const response=await original(...args);if(args[0].endsWith('/join')&&corrupt){const body=JSON.parse(await response.text());if(body.round===2){body.condition='threshold';return {...response,text:async()=>JSON.stringify(body)};}}return response;};
 await f.click('Start next round');await f.advance(250);
 assert.ok(localStorage.getItem(intentKey));assert.equal(JSON.parse(localStorage.getItem('emg-study-session')).round,1);
 assert.ok(text(f.renderer.toJSON()).includes('scope')||text(f.renderer.toJSON()).includes('does not match'));
 corrupt=false;await f.click('Start next round');await f.advance(250);assert.equal(JSON.parse(localStorage.getItem('emg-study-session')).round,2);
 assert.deepEqual(advances(f)[0].body,advances(f)[1].body);
});

test('legacy completed participant remains finished without repeat controls',async t=>{
 const f=await mount(t,'button',false,{mock:false});
 assert.equal((await f.call('POST','/progress',{id:f.p.id,round:1,trials:[]})).status,200);
 await f.showGate();await f.settle(()=>f.renderer.root.findByType('input').props.onChange({target:{value:f.p.id}}));
 await f.settle(()=>f.renderer.root.findByType('form').props.onSubmit({preventDefault(){}}));
 assert.ok(text(f.renderer.toJSON()).includes('already finished'));assert.equal(globalThis.__captureNavigation,null);
 assert.equal(f.button('Start next round'),undefined);assert.equal(advances(f).length,0);
});

test('authoritative readback carrying an old model is rejected before adoption',async t=>{
 const f=await completed(t),original=globalThis.fetch;
 globalThis.fetch=async(...args)=>{const r=await original(...args);if(args[0].endsWith('/join')){const b=JSON.parse(await r.text());if(b.round===2){b.restored.modelRevisionId='frozen-model';return {...r,text:async()=>JSON.stringify(b)};}}return r;};
 await f.click('Start next round');await f.advance(250);
 assert.equal(JSON.parse(localStorage.getItem('emg-study-session')).round,1,'old model must not become the new playable model');
 assert.ok(localStorage.getItem(intentKey));
});

test('completed participant gate rejoins completed round without advancing',async t=>{
 const f=await mount(t,'button',false,{v2:true,results:true,mock:false});
 await f.click('Submit session');await f.advance(500);
 const old=JSON.parse(localStorage.getItem('emg-study-session'));localStorage.removeItem('emg-study-session');
 await f.showGate();
 await f.settle(()=>f.renderer.root.findByType('input').props.onChange({target:{value:f.p.id}}));
 await f.settle(()=>f.renderer.root.findByType('form').props.onSubmit({preventDefault(){}}));
 assert.equal(globalThis.__captureNavigation,'/session','completed capable join enters completed view');
 await f.reload();
 assert.ok(f.button('Start next round'));assert.ok(text(f.renderer.toJSON()).includes('Session complete'));
 const restored=JSON.parse(localStorage.getItem('emg-study-session'));
 assert.equal(restored.stage,'done');assert.equal(restored.sessionId,old.sessionId);assert.equal(restored.round,1);
 assert.equal(f.writes.filter(w=>w.url.endsWith('/protocol/next-round')).length,0);
});

test('completed reload blocks a malformed raw recovery journal instead of advancing',async t=>{
 const f=await mount(t,'button',false,{v2:true,results:true,mock:false});
 await f.click('Submit session');await f.advance(500);
 const s=JSON.parse(localStorage.getItem('emg-study-session'));
 const owner=sessionStorage.getItem('emg-context-recovery-owner');
 const key=`emg-context-recovery:${owner}:${JSON.stringify([s.participantId,s.sessionId,s.condition,s.generation,s.round])}`;
 localStorage.setItem(key,'{BROKEN');
 await f.reload();await f.advance(250);
 const button=f.button('Start next round');if(button&&!button.props.disabled)await f.click('Start next round');
 await f.advance(100);
 assert.equal(f.writes.filter(w=>w.url.endsWith('/protocol/next-round')).length,0,'raw recovery failures forbid advance');
 assert.equal(localStorage.getItem(key),'{BROKEN','never erase recovery failure');
});

// Preparation is synthetic and seeded through real temp-server APIs. Actual
// mounted ResultsPanel Submit and explicit next-round buttons own all transitions.
for(const condition of ['button','threshold']) test(`${condition}: actual Submit then explicit next opens clean same-condition round`,async t=>{
 const f=await mount(t,condition,false,{v2:true,results:true,mock:false});
 assert.equal(f.button('Start next round'),undefined,'Results is not completed');
 await f.click('Submit session'); await f.advance(1000);
 assert.equal((await f.call('POST','/join',{id:f.p.id})).body.status,'completed');
 assert.ok(f.button('Start next round'),'successful Submit exposes explicit repeat control');
 assert.equal(f.writes.filter(w=>w.url.endsWith('/protocol/next-round')).length,0);
 const source=JSON.parse(localStorage.getItem('emg-study-session'));
 const oldHashes=Object.fromEntries(walk(path.join(f.data,'sessions')).map(p=>[path.relative(f.data,p),crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')]));
 await f.click('Start next round');await f.advance(1000);
 const s=JSON.parse(localStorage.getItem('emg-study-session'));
 assert.equal(s.round,2,text(f.renderer.toJSON()));assert.equal(s.condition,condition);assert.equal(s.stage,'capture');assert.equal(s.modelRevisionId,null);
 for(const k of ['trials','runs','pendingReplacements'])assert.deepEqual(s[k],[]);
 for(const k of ['openCapture','trainingRun'])assert.equal(s[k],null);
 assert.equal(s.protocolState.lock,null);assert.equal(s.protocolState.survey,null);assert.equal(s.protocolState.practice,null);
 assert.ok(text(f.renderer.toJSON()).includes('Stream idle'));assert.ok(!text(f.renderer.toJSON()).includes('Round 2/1'));assert.ok(!text(f.renderer.toJSON()).includes('Round 2 of 1'));
 assert.equal(f.writes.filter(w=>w.url.endsWith('/protocol/next-round')).length,1);
 assert.ok(f.renderer.root.findAll(n=>n.props['aria-label']==='Practice preparation').length,'fresh mandatory setup is mounted');
 assert.ok(f.button('Begin practice'),'new round begins the actual fresh preparation flow');
 const post=advances(f)[0].body;
 assert.deepEqual(Object.keys(post).sort(),['id','experimentId','generation','condition','fromRound','fromSessionId','requestId','finalizationReceiptDigest'].sort());
 assert.equal(post.fromSessionId,source.sessionId);assert.equal(post.fromRound,1);
 const historyKey=`emg-completed-round:${source.participantId}:${source.generation}:${source.round}:${source.sessionId}`;
 const history=JSON.parse(localStorage.getItem(historyKey));assert.equal(history.trials.length,16);assert.equal(history.runs.length,1);
 for(const [p,h] of Object.entries(oldHashes))assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(f.data,p))).digest('hex'),h,'preserved old server bytes '+p);
 if(process.env.EMG_BATCH_EVIDENCE_DIR)fs.writeFileSync(path.join(process.env.EMG_BATCH_EVIDENCE_DIR,`${condition}-mounted-repeat-proof.json`),JSON.stringify({coverage:'Synthetic API-seeded preparation; actual React ResultsPanel Submit, completed view and explicit next button; real temp dispatcher POSTs; no hardware or classifier performance claim',source,next:s,oldHashes,request:post,writes:f.writes.filter(w=>!w.body.items),ui:text(f.renderer.toJSON())},null,2));
});
