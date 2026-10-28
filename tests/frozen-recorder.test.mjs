import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, Module } from 'node:module';
import { build } from 'esbuild';
const require=createRequire(import.meta.url), React=require('react'), {act,create}=require('react-test-renderer');
const root=new URL('../',import.meta.url).pathname;
async function harness(options={}) {
 const b=await build({stdin:{contents:`export {useGestureRecorder} from './src/app/useGestureRecorder'`,resolveDir:root},bundle:true,platform:'node',format:'cjs',write:false,plugins:[{name:'react',setup(b){b.onResolve({filter:/^react$/},a=>({path:require.resolve(a.path),external:true}));}}]});
 const m=new Module(root+'tests/recorder.cjs'); m.paths=require.resolve.paths('react');m._compile(b.outputFiles[0].text,root+'tests/recorder.cjs');
 let value, renderer, points=[]; let opts={signalPoints:points,threshold:0.6,segmentDurationMs:200,isStreaming:true,resetKey:'one',minSegmentPoints:2,cooldownMs:450,frozenCalibration:{revision:'rest1',threshold:0.2,restHoldMs:300,activationHoldMs:100,maxGapMs:500},...options};
 function Probe(){value=m.exports.useGestureRecorder(opts); return null;}
 await act(()=>{renderer=create(React.createElement(Probe));});
 const update=async patch=>{opts={...opts,...patch};await act(()=>renderer.update(React.createElement(Probe)));};
 return {get:()=>value, update, feed:async entries=>{points=[...points,...entries.map(([time,envelope,normalized=1])=>({time,activityEnvelope:envelope,normalizedActivity:normalized,raw:time/10,value:0.999}))];await update({signalPoints:points});},close:()=>act(()=>renderer.unmount())};
}
test('actual recorder uses envelope rest/onset holds, not normalized display, and preserves tied onset/endpoint samples',async()=>{
 const h=await harness();
 await h.feed([[0,0.5],[100,0.5],[200,0.5],[300,0.5]]); assert.equal(h.get().isRecording,false,'initial high disarmed');
 await h.feed([[400,0.1],[500,0.1],[600,0.1],[700,0.1]]);
 await h.feed([[750,0.3],[800,0.1],[850,0.3],[900,0.3]]); assert.equal(h.get().isRecording,false,'dip breaks onset');
 await h.feed([[950,0.3,0],[950,0.4,0]]); assert.equal(h.get().recordingStartTime,950,'confirmation, not first crossing');
 await h.feed([[1000,0.3],[1100,0.3],[1150,0.3]]);
 await h.feed([[1150,0.4],[1200,0.3]]);
 const s=h.get().completedSegment; assert.ok(s); assert.equal(s.firstCrossingAt,850);assert.equal(s.triggeredAt,950);assert.equal(s.completedAt,1150);
 assert.deepEqual(s.points.filter(p=>p.time===950).map(p=>p.value),[95,95]);
 assert.deepEqual(s.points.filter(p=>p.time===1150).map(p=>p.value),[115,115]);
 assert.equal(s.calibration.revision,'rest1');
 await h.feed([[1300,0.3],[1600,0.3],[1800,0.1],[1850,0.3],[1950,0.3]]);assert.equal(h.get().isRecording,false,'isolated low cannot rearm');
 await h.close();
});
export {harness};

test('read-only readiness reports the actual rest and activation holds and clears on disarm',async()=>{
 const h=await harness();
 try {
  assert.equal(h.get().thresholdReadiness,'unavailable');
  await h.feed([[0,.1],[100,.1],[200,.1],[299,.1]]);assert.equal(h.get().thresholdReadiness,'rest','one dip or an incomplete rest hold must not show Ready');
  await h.feed([[300,.1]]);assert.equal(h.get().thresholdReadiness,'ready');
  await h.feed([[350,.3],[400,.3]]);assert.equal(h.get().thresholdReadiness,'movement','activity confirmation is distinct from Recording');assert.equal(h.get().isRecording,false);
  await h.feed([[450,.3]]);assert.equal(h.get().isRecording,true);assert.equal(h.get().recordingStartTime,450,'observing readiness must not change the detector anchor');
  await h.update({isArmed:false});assert.equal(h.get().thresholdReadiness,'unavailable');
  await h.update({isArmed:true});await h.feed([[500,.3],[600,.3]]);assert.equal(h.get().thresholdReadiness,'rest','old rest is not retained after reset');
  await h.feed([[650,.1],[750,.1],[850,.1],[950,.1]]);assert.equal(h.get().thresholdReadiness,'ready');
  await h.feed([[1600,.1]]);assert.equal(h.get().thresholdReadiness,'rest','a continuity gap invalidates readiness');
  await h.update({isStreaming:false});assert.equal(h.get().thresholdReadiness,'unavailable');
 } finally {await h.close();}
});

test('disarming cancels in-flight capture and cannot carry a partial hold across rearming',async()=>{
 const h=await harness();await h.feed([[0,.1],[100,.1],[200,.1],[300,.1],[350,.3],[400,.3]]);
 await h.update({isArmed:false});await h.feed([[450,.3]]);await h.update({isArmed:true});await h.feed([[500,.3],[600,.3]]);assert.equal(h.get().isRecording,false,'old partial onset cannot finish after rearm');
 await h.feed([[650,.1],[750,.1],[850,.1],[950,.1],[1000,.3],[1100,.3]]);assert.equal(h.get().isRecording,true);
 await h.update({isArmed:false});assert.equal(h.get().isRecording,false,'cancel actual in-flight window');assert.equal(h.get().completedSegment,null);await h.close();
});
test('activity within a captured waveform never overwrites its first crossing anchor',async()=>{
 const h=await harness({segmentDurationMs:1000});await h.feed([[0,.1],[100,.1],[200,.1],[300,.1],[350,.3],[450,.3],[500,.1],[600,.1],[700,.1],[800,.1],[850,.3],[950,.3],[1050,.3],[1150,.3],[1250,.3],[1350,.3],[1450,.3],[1500,.3]]);
 assert.equal(h.get().completedSegment.firstCrossingAt,350);await h.close();
});

test('legacy display threshold changes do not interrupt a calibrated hold or alter its boundary',async()=>{
 const h=await harness();await h.feed([[0,.1],[100,.1],[200,.1],[300,.1],[350,.3],[400,.3]]);await h.update({threshold:.99});await h.feed([[450,.3,0]]);assert.equal(h.get().recordingStartTime,450);await h.close();
});

test('cooldown stays anchored to the saved endpoint rather than delayed observation of its closing sample',async()=>{
 const h=await harness();await h.feed([[0,.1],[100,.1],[200,.1],[300,.1],[350,.3],[450,.3],[550,.3],[650,.3],[700,.1],[800,.1],[900,.1],[1000,.1],[1100,.1],[1150,.3],[1250,.3]]);assert.equal(h.get().recordingStartTime,1250);await h.close();
});

test('synthetic source batches produce identical confirmed anchors and raw windows with overlapping inputs',async()=>{
 const entries=[[0,.1],[100,.1],[200,.1],[300,.1],[350,.3],[400,.3],[450,.3],[450,.4],[500,.3],[550,.3],[600,.3],[650,.3],[650,.4],[700,.3]];
 const a=await harness(),b=await harness();await a.feed(entries);for(const batch of [entries.slice(0,3),entries.slice(3,7),entries.slice(7,12),entries.slice(12)])await b.feed(batch);
 assert.deepEqual(a.get().completedSegment,b.get().completedSegment);await a.close();await b.close();
});
for(const bad of [[250,.1],[1000,.1],[400,NaN],[400,Infinity]])test('synthetic invalid/backwards/gapped source safely disarms: '+JSON.stringify(bad),async()=>{
 const h=await harness();await h.feed([[0,.1],[100,.1],[200,.1],[300,.1],[350,.3]]);await h.feed([bad]);await h.feed([[1100,.3],[1200,.3]]);assert.equal(h.get().isRecording,false);await h.close();
});
test('null live calibration never falls back to normalized threshold triggering',async()=>{
 const h=await harness({frozenCalibration:null});await h.feed([[0,.1,0],[100,.1,0],[200,.1,0],[300,.1,0],[350,.9,1],[450,.9,1],[550,.9,1]]);assert.equal(h.get().isRecording,false);await h.close();
});

test('Button retains its manual trigger anchor and existing cooldown/resting gate without threshold onset holds',async()=>{
 const h=await harness({triggerMode:'button'});await h.update({manualTriggerToken:1});await h.feed([[0,.8,.8],[100,.8,.8],[200,.8,.8],[250,.8,.8],[650,.8,.8]]);assert.equal(h.get().completedSegment.triggeredAt,0);assert.equal(h.get().recorderState,'cooldown','held active Button input retains its existing cooldown gate');await h.feed([[700,.1,.1]]);assert.equal(h.get().recorderState,'idle');await h.close();
});
