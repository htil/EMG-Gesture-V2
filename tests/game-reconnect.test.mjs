import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire,Module} from 'node:module';
import {build} from 'esbuild';
const require=createRequire(import.meta.url),React=require('react'),{act,create}=require('react-test-renderer');
const root=new URL('../',import.meta.url).pathname;
async function mounted(t,condition){
 globalThis.__game={mounts:0,unmounts:0,holds:0,resumes:0};globalThis.localStorage={getItem:()=>null};
 const b=await build({stdin:{contents:`export {default} from './src/app/GameScreen';export {registerGameRunListener} from './src/app/study/gameHandoff';`,resolveDir:root},bundle:true,platform:'node',format:'cjs',jsx:'automatic',write:false,plugins:[{name:'runner',setup(b){b.onResolve({filter:/^react(?:\/jsx-runtime)?$/},a=>({path:require.resolve(a.path),external:true}));b.onResolve({filter:/game\/main\.js$/},()=>({path:'runner',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:`export function mountGame(c,o){globalThis.__game.mounts++;globalThis.__game.options=o;return ()=>globalThis.__game.unmounts++;}export function holdForSourceRecovery(){globalThis.__game.holds++;}export function resumeAfterSourceRecovery(){globalThis.__game.resumes++;}export function queueGestureAction(){};export function releaseTutorialHold(){}` }));}}]});
 const m=new Module(root+'tests/game-mount.cjs');m.paths=require.resolve.paths('react');m._compile(b.outputFiles[0].text,m.filename=root+'tests/game-mount.cjs');
 const handoffs=[];m.exports.registerGameRunListener(p=>handoffs.push(p));
 const props={condition,runKind:'official',streamReady:true,sourceEpoch:1,recoveryReady:true,recoveryToken:'rest-1',onExit(){},officialSequence:['wrist-up','wrist-up','wrist-down','wrist-down','wrist-up','wrist-up','wrist-down','wrist-down','wrist-up','wrist-up','wrist-down','wrist-down','wrist-up','wrist-up','wrist-down','wrist-down','wrist-up','wrist-up','wrist-down','wrist-down'],actionGestures:{jump:{id:'wrist-up',name:'Up'},switchLane:{id:'wrist-down',name:'Down'}},predictWindow:()=>({predictedGestureId:'wrist-up',predictedGestureName:'Up',confidence:90})};
 let renderer;const settle=fn=>act(async()=>{fn?.();for(let i=0;i<25;i++)await Promise.resolve();});
 await settle(()=>renderer=create(React.createElement(m.exports.default,props),{createNodeMock:()=>({})}));t.after(()=>settle(()=>renderer.unmount()));
 return {props,handoffs,get renderer(){return renderer;},update:async patch=>{Object.assign(props,patch);await settle(()=>renderer.update(React.createElement(m.exports.default,props)));},settle};
}
for(const condition of ['button','threshold'])test(`${condition}: mounted game holds rather than unmounting/submitting on disconnect`,async t=>{
 const f=await mounted(t,condition);assert.equal(__game.mounts,1);await f.update({streamReady:false,recoveryReady:false,sourceEpoch:2});
 assert.equal(__game.unmounts,0,'disconnect must preserve owned runner');assert.equal(f.handoffs.length,0,'no incomplete result for recoverable interruption');assert.ok(__game.holds>0);
 await f.update({streamReady:true,sourceEpoch:3});assert.equal(__game.resumes,0,'reconnect alone cannot resume before explicit rest and resume');assert.equal(__game.mounts,1);
});
for(const condition of ['button','threshold'])test(`${condition}: invalid raw capture requires NEW rest, not previous calibration`,async t=>{
 const original=Date.now;let now=100000;Date.now=()=>now;t.after(()=>{Date.now=original;});
 const f=await mounted(t,condition);let predictions=0;await f.update({predictWindow:()=>{predictions++;return null;}});
 __game.options.getRecordingProgress('cue',1);now+=100;await f.update({emgPoints:[{time:now,raw:NaN}]});await f.settle(()=>__game.options.getRecordingProgress('cue',1));
 assert.equal(f.handoffs.length,0);assert.equal(predictions,0);const resume=()=>f.renderer.root.findAllByType('button').find(b=>b.children.join('')==='Resume same run');
 assert.equal(resume().props.disabled,true,'pre-interruption rest must not authorize recovery');
 await f.update({recoveryToken:'rest-2',emgPoints:[{time:now,raw:.00001}]});assert.equal(resume().props.disabled,false);await f.settle(()=>resume().props.onClick());assert.equal(__game.resumes,1);
});

test('legacy encounter idempotency retains distinct results and indexed metadata without double scoring',async t=>{
 const f=await mounted(t,'button');
 const emit=event=>f.settle(()=>__game.options.onObstacleResult(event));
 const a={correct:true,encounterId:'legacy-a',expectedAction:'jump'};
 const b={correct:true,encounterId:'legacy-b',expectedAction:'switch-lane'};
 await emit(a);await emit(a);await emit(b);await emit(b);
 await f.settle(()=>__game.options.getRecordingProgress('indexed',3));
 const indexed={correct:true,encounterId:'indexed',expectedAction:'jump',trialIndex:3};
 await emit(indexed);await emit({...indexed,encounterId:'indexed-duplicate'});
 await f.settle(()=>__game.options.onRunComplete());
 const run=f.handoffs[0];
 assert.equal(run.outcomes.length,3,'two distinct legacy encounters plus one indexed encounter');
 assert.equal(run.gameScore,300,'duplicate callbacks must not increment scored counts');
 assert.deepEqual(run.outcomes.map(o=>o.trialIndex),[undefined,undefined,3]);
 assert.deepEqual(run.outcomes.map(o=>o.expectedGestureId),['wrist-up','wrist-down','wrist-up']);
 assert.equal(new Set(run.outcomes.map(o=>o.attemptId)).size,3);
 assert.equal(typeof run.outcomes[2].cueAt,'number');
 assert.equal(run.outcomes[2].sampleCount,0);
 assert.deepEqual(run.outcomes.map(o=>o.result),['recording_failure','recording_failure','recording_failure']);
});

test('pause accounting spans repeated holds through explicit resume and closes held exit',async t=>{
 const original=Date.now;let now=100000;Date.now=()=>now;t.after(()=>Date.now=original);
 const f=await mounted(t,'button');now=101000;await f.update({streamReady:false});now=102000;await f.update({sourceEpoch:2});
 now=106000;await f.update({streamReady:true,recoveryReady:true,recoveryToken:'rest-2'});
 await f.settle(()=>f.renderer.root.findAllByType('button').find(b=>b.children.join('')==='Resume same run').props.onClick());
 now=108000;await f.update({streamReady:false});now=110000;
 await f.settle(()=>f.renderer.root.findAllByType('button').find(b=>b.props['aria-label']==='Back to training').props.onClick());
 assert.equal(f.handoffs.length,1);const run=f.handoffs[0];assert.equal(run.startedAt,100000);assert.equal(run.endedAt,110000);assert.equal(run.activeDurationMs,3000);
 assert.deepEqual(run.sourceRecoveryPauses.map(p=>[p.startedAt,p.endedAt]),[[101000,106000],[108000,110000]]);assert.equal(run.outcomes.length,0);
});
