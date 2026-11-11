import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';import {mount,text} from './support/mounted-capture-state-fixture.mjs';
const runnerSource=fs.readFileSync(new URL('../game/main.js',import.meta.url),'utf8');
function resolver(options){const start=runnerSource.indexOf('function resolveObstacle('),code=runnerSource.slice(start,runnerSource.indexOf('\n}',start)+2);const c=vm.createContext({performance:{now:()=>Date.now()},activeGameOptions:options});vm.runInContext(`let obstaclesResolved=0,lastObstacleIndex=0,completeUntil=0,lastObstacleResult,lastObstacleTarget,lastExpectedAction,lastEncounterId,lives=3,startingLives=3,runOver=false,laneIndex=0,obstacleLimit=20;function isTutorialRun(){return false;}function retargetUpcomingGates(){};${code};globalThis.resolve=resolveObstacle;`,c);return c.resolve;}

for(const condition of ['button','threshold'])test(`${condition}: actual StudySession + GameScreen + live source keep game mounted through disconnect`,async t=>{
 globalThis.__gameMounts=0;globalThis.__gameUnmounts=0;
 const f=await mount(t,condition,false,{game:true,mock:false,v2:true});
 await f.connect();f.liveFeed(true);await f.advance(500);
 const play=f.renderer.root.findAllByType('button').find(n=>text(n).includes('Play')&&text(n).includes('Use the captures'));assert.ok(play);await f.settle(()=>play.props.onClick());
 assert.equal(__gameMounts,1);await f.settle(()=>f.disconnect());f.liveFeed(false);
 assert.equal(__gameUnmounts,0,'actual parent must retain runner across source disconnect');assert.ok(f.button('Resume same run'));assert.equal(f.button('Resume same run').props.disabled,true);
 assert.ok(f.button('Reconnect device'),'held game exposes reconnect without capture navigation');
 await f.click('Reconnect device');f.liveFeed(true);await f.advance(500);assert.equal(f.button('Resume same run').props.disabled,true);
 await f.click('Redo resting setup');assert.ok(f.button('Begin resting recording'));await f.click('Begin resting recording');await f.advance(11000);
 assert.equal(f.button('Resume same run').props.disabled,false,'actual persisted rest enables explicit resume');await f.click('Resume same run');assert.equal(__gameMounts,1);assert.equal(__gameUnmounts,0);assert.equal(__gameOptions.isStreamReady(),true);
 const saved=JSON.parse(localStorage.getItem('emg-study-session'));assert.equal(saved.modelRevisionId,'frozen-model');assert.equal(saved.runs.length,0);assert.equal(saved.stage,'game');
 await f.advance(65000);assert.equal(__gameOptions.isStreamReady(),true,'rolling bounded raw buffer stays healthy after old run boundary expires');
 f.liveFeed(false);await f.advance(1600);assert.equal(__gameOptions.isStreamReady(),false,'packet silence between windows must hold before another cue');assert.ok(f.button('Resume same run'));assert.equal(f.button('Resume same run').props.disabled,true);
});
for(const condition of ['button','threshold'])test(`${condition}: sample-backed 20 trials retain indexed outcomes through interrupted capture and reconnect`,async t=>{
 globalThis.__gameMounts=0;globalThis.__gameUnmounts=0;const f=await mount(t,condition,false,{game:true,mock:false,v2:true});
 await f.connect();f.liveFeed(true);await f.advance(500);const play=f.renderer.root.findAllByType('button').find(n=>text(n).includes('Play')&&text(n).includes('Use the captures'));await f.settle(()=>play.props.onClick());
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
 assert.equal(persisted.sourceRecoveryPauses.length,1);assert.deepEqual(persisted.sourceRecoveryPauses,run.sourceRecoveryPauses);assert.equal(persisted.activeDurationMs,run.activeDurationMs);
 const paused=run.sourceRecoveryPauses.reduce((n,p)=>n+p.endedAt-p.startedAt,0);assert.ok(paused>=41000);assert.equal(run.endedAt-run.startedAt-paused,run.activeDurationMs);
 assert.equal((await f.call('POST','/collection',{id:f.p.id,items:[{kind:'run',record:persisted}]})).body.acceptedCount,1);
 assert.equal((await f.call('POST','/collection',{id:f.p.id,items:[{kind:'run',record:{...persisted,sourceRecoveryPauses:persisted.sourceRecoveryPauses.map(p=>({...p,reason:'changed immutable reason'}))}}]})).status,409);
 const exported=await f.call('GET','/export/'+f.experiment.id+'/collection',{},true);assert.equal(exported.status,200);const bytes=exported.buffer;let offset=0,entries={};while(bytes.readUInt32LE(offset)===0x04034b50){const size=bytes.readUInt32LE(offset+18),n=bytes.readUInt16LE(offset+26),x=bytes.readUInt16LE(offset+28),start=offset+30+n+x;entries[bytes.subarray(offset+30,offset+30+n).toString()]=bytes.subarray(start,start+size).toString();offset=start+size;}assert.match(entries['runs.csv'],/active_duration_ms/);assert.ok(entries['runs.csv'].includes(String(run.activeDurationMs)));assert.match(entries['runs.csv'],/source_recovery_pauses_json/);const cells=entries['runs.csv'].split('\n')[1].match(/("(?:[^"]|"")*"|[^,]*)(,|$)/g).filter(Boolean).map(v=>v.replace(/,$/,'')).map(v=>v.startsWith('"')?v.slice(1,-1).replaceAll('""','"'):v);const headers=entries['runs.csv'].split('\n')[0].split(',');assert.deepEqual(JSON.parse(cells[headers.indexOf('source_recovery_pauses_json')]),run.sourceRecoveryPauses,'decoded ZIP retains exact ordered pauses');assert.equal(Number(cells[headers.indexOf('active_duration_ms')]),run.activeDurationMs);
 const finalized=await f.call('POST','/progress',{id:f.p.id,participantId:f.p.id,sessionId:saved.sessionId,generation:saved.generation,round:1,condition,trials:saved.trials});assert.equal(finalized.status,200,JSON.stringify(finalized.body));assert.equal(finalized.body.status,'completed');assert.equal((await f.call('POST','/join',{id:f.p.id})).body.status,'completed');
 if(process.env.EMG_BATCH_EVIDENCE_DIR){fs.mkdirSync(process.env.EMG_BATCH_EVIDENCE_DIR,{recursive:true});fs.writeFileSync(`${process.env.EMG_BATCH_EVIDENCE_DIR}/synthetic-${condition}-20trial.json`,JSON.stringify({coverage:'actual mounted StudySession/GameScreen/useSignalSource/condition model/rest persistence; controlled 200Hz live transport; actual VM resolveObstacle with deliberate missed collisions; current between-subject-v2; 16 synthetic center-backed samples + incomplete pre/post contexts seeded via real APIs; saved flow4 rest, actual researcher skip/lock/training API; actual condition engine trained; initial source start instrumented through actual hook (locked-review UI has no connect control); recovery rest/epoch guards real; no native Bluetooth',run,persisted},null,2));}
});
