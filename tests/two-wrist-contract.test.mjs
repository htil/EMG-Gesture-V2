import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fixture } from './support/practice-fixture.mjs';
import { mount, text } from './support/mounted-study-fixture.mjs';
test('restored historical classes stay intact and cannot be mixed into a wrist session',async t=>{
 const h=await mount(t,'button',true);const saved=JSON.parse(localStorage.getItem('emg-study-session'));
 saved.trials=[{id:'historical-pinch',gestureId:'pinch',gestureName:'Pinch',pairIndex:1,capturedAt:1,points:[{time:0,value:-1},{time:50,value:1}]}];
 localStorage.setItem('emg-study-session',JSON.stringify(saved));await h.remount();
 assert.match(text(h.renderer.toJSON()),/historical gesture set/i);assert.equal(h.button('Train model'),undefined);assert.equal(h.button('Reopen guided practice'),undefined);
 assert.deepEqual(JSON.parse(localStorage.getItem('emg-study-session')).trials,saved.trials);
});
test('v3 API enforces three retained examples per wrist and consistent game movement names',async t=>{
 const f=await fixture(t),post=r=>f.call('POST','/practice',{id:f.participant.id,record:r});
 const base={...f.record,flowVersion:3,points:[]};await post({...f.record,flowVersion:3});
 const captures=[];
 for(const id of ['wrist-up','wrist-down'])for(let n=0;n<3;n++)captures.push({...f.capture(id,`${id}-${n}`),flowVersion:3,captureProcedure:'button'});
 await post(captures[0]);await post(captures[3]);
 const training={...base,id:'training',kind:'training',sampleIds:[captures[0].id,captures[3].id],classifier:'knn',status:'success',startedAt:1,finishedAt:2};
 assert.equal((await post(training)).status,400,'one each is not sufficient');
 for(const sample of captures.filter((_,i)=>i!==0&&i!==3))assert.equal((await post(sample)).status,200);
 training.sampleIds=captures.map(c=>c.id);assert.equal((await post(training)).status,200);
 // Explicit synthetic protocol fixtures, not game or recognition evidence.
 const game={...base,id:'game',kind:'game',trainingId:training.id,sampleIds:training.sampleIds,gameScore:0,difficulty:'standard',outcomes:[{attemptId:'obstacle:0',expectedGestureId:'wrist-up',expectedGestureName:'Pinch',predictedGestureId:'unknown',predictedGestureName:'Unknown',result:'unknown'}]};
 assert.equal((await post(game)).status,400,'wrong physical label must not enter wrist exports');game.outcomes[0].expectedGestureName='Wrist up';assert.equal((await post(game)).status,200);
});
const load=async entry=>{const b=await build({entryPoints:[new URL('../'+entry,import.meta.url).pathname],bundle:true,platform:'node',format:'esm',write:false});return import('data:text/javascript;base64,'+Buffer.from(b.outputFiles[0].text).toString('base64'));};
test('new active classes have distinct wrist IDs, never relabel historical pinch/squeeze/relax',async()=>{
 const {DEFAULT_GESTURES}=await load('src/app/pipeline/gestureUtils.ts');
 assert.deepEqual(DEFAULT_GESTURES,[{id:'wrist-up',name:'Wrist up'},{id:'wrist-down',name:'Wrist down'}]);
});
test('v3 wrist captures validate and read back while v2 historical movement labels remain unchanged',async t=>{
 const f=await fixture(t);const post=r=>f.call('POST','/practice',{id:f.participant.id,record:r});
 const rest={...f.record,flowVersion:3};assert.equal((await post(rest)).status,200);
 const up={...f.capture('wrist-up'),flowVersion:3,captureProcedure:'button'};
 assert.equal((await post(up)).status,200);
 const bad={...f.capture('pinch','bad'),flowVersion:3,captureProcedure:'button'};assert.equal((await post(bad)).status,400);
 const legacyRest={...f.record,id:'legacy-rest',attemptId:'legacy-attempt',flowVersion:2};assert.equal((await post(legacyRest)).status,200);
 const legacy={...f.capture('pinch','legacy-capture'),restId:legacyRest.id,attemptId:legacyRest.attemptId,flowVersion:2,captureProcedure:'button'};assert.equal((await post(legacy)).status,200);
 const records=(await f.call('GET','/practice/'+f.participant.id)).body.records;
 assert.equal(records.find(r=>r.id===up.id).gestureName,'Wrist up');assert.equal(records.find(r=>r.id===legacy.id).gestureName,'Pinch');
});
