import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';import {mount,text} from './support/mounted-capture-state-fixture.mjs';
const runnerSource=fs.readFileSync(new URL('../game/main.js',import.meta.url),'utf8');
function resolver(options){const start=runnerSource.indexOf('function resolveObstacle('),code=runnerSource.slice(start,runnerSource.indexOf('\n}',start)+2);const c=vm.createContext({performance:{now:()=>Date.now()},activeGameOptions:options});vm.runInContext(`let obstaclesResolved=0,lastObstacleIndex=0,completeUntil=0,lastObstacleResult,lastObstacleTarget,lastExpectedAction,lastEncounterId,lives=3,startingLives=3,runOver=false,laneIndex=0,obstacleLimit=20;function isTutorialRun(){return false;}function retargetUpcomingGates(){};${code};globalThis.resolve=resolveObstacle;`,c);return c.resolve;}

for(const condition of ['button','threshold'])test(`${condition}: actual StudySession + GameScreen + live source keep game mounted through disconnect`,async t=>{
 globalThis.__gameMounts=0;globalThis.__gameUnmounts=0;
 const f=await mount(t,condition,false,{game:true,mock:false});
 await f.click('Connect device');f.liveFeed(true);await f.advance(500);
 const play=f.renderer.root.findAllByType('button').find(n=>text(n).includes('Play')&&text(n).includes('Use the captures'));assert.ok(play);await f.settle(()=>play.props.onClick());
 assert.equal(__gameMounts,1);await f.settle(()=>f.disconnect());f.liveFeed(false);
 assert.equal(__gameUnmounts,0,'actual parent must retain runner across source disconnect');assert.ok(f.button('Resume same run'));assert.equal(f.button('Resume same run').props.disabled,true);
 assert.ok(f.button('Reconnect device'),'held game exposes reconnect without capture navigation');
 await f.click('Reconnect device');f.liveFeed(true);await f.advance(500);assert.equal(f.button('Resume same run').props.disabled,true);
 await f.click('Redo resting setup');assert.ok(f.button('Begin resting recording'));await f.click('Begin resting recording');await f.advance(11000);
 assert.equal(f.button('Resume same run').props.disabled,false,'actual persisted rest enables explicit resume');await f.click('Resume same run');assert.equal(__gameMounts,1);assert.equal(__gameUnmounts,0);assert.equal(__gameOptions.isStreamReady(),true);
 const saved=JSON.parse(localStorage.getItem('emg-study-session'));assert.equal(saved.modelRevisionId,'frozen-model');assert.equal(saved.runs.length,0);assert.equal(saved.stage,'game');
 f.liveFeed(false);await f.advance(1600);assert.equal(__gameOptions.isStreamReady(),false,'packet silence between windows must hold before another cue');assert.ok(f.button('Resume same run'));assert.equal(f.button('Resume same run').props.disabled,true);
});
for(const condition of ['button','threshold'])test(`${condition}: sample-backed 20 trials retain indexed outcomes through interrupted capture and reconnect`,async t=>{
 globalThis.__gameMounts=0;globalThis.__gameUnmounts=0;const f=await mount(t,condition,false,{game:true,mock:false});
 await f.click('Connect device');f.liveFeed(true);await f.advance(500);const play=f.renderer.root.findAllByType('button').find(n=>text(n).includes('Play')&&text(n).includes('Use the captures'));await f.settle(()=>play.props.onClick());
 const options=__gameOptions,resolve=resolver(options),sequence=JSON.parse(localStorage.getItem('emg-study-session')).officialSequence;let firstCue;
 for(let trial=1;trial<=20;trial++){
  const encounterId=`synthetic-${trial}:0`,expectedAction=sequence[trial-1]==='wrist-up'?'jump':'switch-lane';
  options.getRecordingProgress(encounterId,trial);
  if(trial===2){await f.advance(500);await f.settle(()=>f.disconnect());f.liveFeed(false);await f.advance(30000);
   await f.settle(()=>options.onQteUpdate({status:'processing',progress:1,encounterId,trialIndex:trial,expectedAction,switchDirection:1}));
   assert.equal(JSON.parse(localStorage.getItem('emg-study-session')).runs.length,0);assert.equal(__gameUnmounts,0);
   await f.click('Reconnect device');f.liveFeed(true);await f.advance(500);await f.click('Redo resting setup');await f.click('Begin resting recording');await f.advance(11000);await f.click('Resume same run');options.getRecordingProgress(encounterId,trial);
  }
  const cue=Date.now();if(trial===1)firstCue=cue;await f.advance(2100);assert.equal(options.getRecordingProgress(encounterId,trial),1);
  await f.settle(()=>options.onQteUpdate({status:'processing',progress:1,encounterId,trialIndex:trial,expectedAction,switchDirection:1}));
  // A controlled missed collision, not a fabricated correct recognition result.
  await f.settle(()=>resolve({userData:{obstacleType:expectedAction==='jump'?'jump':'switch',spawnIndex:trial-1,obstacleId:`synthetic-${trial}`,encounter:0}},false));
  if(trial===1)await f.settle(()=>options.onObstacleResult({correct:false,encounterId,expectedAction,trialIndex:trial}));
 }
 const saved=JSON.parse(localStorage.getItem('emg-study-session'));assert.equal(saved.runs.length,1);const run=saved.runs[0];assert.equal(run.outcomes.length,20);assert.equal(run.modelRevisionId,'frozen-model');assert.equal(run.completionStatus,'complete');assert.equal(run.gameScore,0);
 assert.deepEqual(run.outcomes.map(o=>o.trialIndex),Array.from({length:20},(_,i)=>i+1));assert.deepEqual(run.outcomes.map(o=>o.expectedGestureId),sequence);assert.equal(new Set(run.outcomes.map(o=>o.attemptId)).size,20);assert.equal(run.outcomes[0].cueAt,firstCue);
 for(const o of run.outcomes){assert.equal(o.recordingEndedAt-o.recordingStartedAt,2000);assert.ok(o.sampleCount>=399);assert.notEqual(o.result,'recording_failure');assert.equal(o.attemptId,`${run.runId}:${o.trialIndex}`);}
 await f.advance(1000);const walk=p=>fs.readdirSync(p,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(p+'/'+e.name):[p+'/'+e.name]);const persisted=walk(f.data).filter(p=>p.endsWith('.json')).map(p=>{try{return JSON.parse(fs.readFileSync(p,'utf8'));}catch{return null;}}).find(r=>r?.id===run.id&&r?.outcomes?.length===20);assert.ok(persisted,'actual temp backend persists the same 20 outcomes');const publicOutcome=({latestSampleAt,startedAt,endedAt,...o})=>o;assert.deepEqual(persisted.outcomes.map(publicOutcome),run.outcomes.map(publicOutcome));
 if(process.env.EMG_BATCH_EVIDENCE_DIR){fs.mkdirSync(process.env.EMG_BATCH_EVIDENCE_DIR,{recursive:true});fs.writeFileSync(`${process.env.EMG_BATCH_EVIDENCE_DIR}/synthetic-${condition}-20trial.json`,JSON.stringify({coverage:'actual mounted StudySession/GameScreen/useSignalSource/condition model/rest persistence; controlled 200Hz live transport; actual VM resolveObstacle with deliberate missed collisions; legacy test participant backend, not v2 pilot readiness or native Bluetooth',run,persisted},null,2));}
});
