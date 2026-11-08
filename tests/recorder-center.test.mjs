import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, Module } from 'node:module';
import { build } from 'esbuild';
const require=createRequire(import.meta.url), React=require('react'),{act,create}=require('react-test-renderer');
const root=new URL('../',import.meta.url).pathname;
async function harness(options={}) {
 const b=await build({stdin:{contents:`export {useGestureRecorder} from './src/app/useGestureRecorder';export {CaptureContextRecorder} from './src/app/study/captureContext';`,resolveDir:root},bundle:true,platform:'node',format:'cjs',write:false,external:['react']});
 const m=new Module(root+'tests/center.cjs');m.paths=require.resolve.paths('react');m._compile(b.outputFiles[0].text,root+'tests/center.cjs');
 const contextRecorder=new m.exports.CaptureContextRecorder({participantId:'fixture',sessionId:'visit1',condition:options.triggerMode??'button',source:'mock',sourceEpoch:1,channel:0});
 let result,renderer;let opts={signalPoints:[],threshold:.6,segmentDurationMs:2000,isStreaming:true,resetKey:'fixture',minSegmentPoints:2,preTriggerWindowMs:175,triggerMode:'button',contextRecorder,...options};
 function Probe(){result=m.exports.useGestureRecorder(opts);return null;}
 await act(()=>{renderer=create(React.createElement(Probe));});
 const update=async patch=>{opts={...opts,...patch};await act(()=>renderer.update(React.createElement(Probe)));};
 return {get:()=>result,contextRecorder,update,feed:async (entries,acquireFirst=false,cloneHistory=false)=>{const start=opts.signalPoints.length;const points=entries.map(([time,n=.1],i)=>({time,consumptionId:start+i,raw:time+.001,activityEnvelope:n,normalizedActivity:n,value:.999}));if(acquireFirst)points.forEach(p=>contextRecorder.push(p));await update({signalPoints:[...(cloneHistory?opts.signalPoints.map(p=>({...p})):opts.signalPoints),...points]});},close:()=>act(()=>renderer.unmount())};
}
for(const triggerMode of ['button','threshold'])test(`mounted ${triggerMode} center is exactly two seconds, half-open and excludes old 175ms pre-roll`,async()=>{
 const h=await harness({triggerMode});try{
 await h.feed(Array.from({length:51},(_,i)=>[i*100,.1]));
 if(triggerMode==='button')await h.update({manualTriggerToken:1});
 await h.feed([[5100,.9],[5100,.95],...Array.from({length:20},(_,i)=>[5200+i*100,.9]),[7100,.95],[7200,.1]]);
 const s=h.get().completedSegment;assert.ok(s);assert.equal(s.triggeredAt,5100);assert.equal(s.completedAt,7100);assert.equal(s.preTriggerPointCount,0);
 assert.ok(s.points.every(p=>p.time>=5100&&p.time<7100));assert.equal(s.points.filter(p=>p.time===5100).length,2);
 assert.equal(s.centerDurationMs,2000);assert.ok(s.attemptId,'actual mounted context binding, not unmounted helper');
 await h.feed(Array.from({length:51},(_,i)=>[7300+i*100,.1]));
 const [c]=h.contextRecorder.drainCompleted();assert.ok(c);assert.equal(c.attempt.attemptId,s.attemptId);assert.equal(c.complete,true);assert.deepEqual(c.points.slice(c.center.startIndex,c.center.endIndexExclusive).map(p=>({time:p.time,value:p.raw})),s.points);
 }finally{await h.close();}
});
test('recorder deduplicates cloned history before detector state changes and preserves equal-time split packets',async()=>{
 const h=await harness();try{
 await h.feed(Array.from({length:51},(_,i)=>[i*100,.1]),true);
 await h.update({manualTriggerToken:1});await h.feed([[5100,.9]],true);
 await h.feed([[5100,.95],[5200,.9]],true,true);
 assert.equal(h.get().isRecording,true,'cloned prehistory cannot rewind and cancel the real anchor');
 await h.feed(Array.from({length:19},(_,i)=>[5300+i*100,.9]),true,true);
 const s=h.get().completedSegment;assert.ok(s);assert.equal(s.points.filter(p=>p.time===5100).length,2);
 assert.equal(s.points.length,21,'only distinct acquisition identities enter the center');
 await h.feed(Array.from({length:50},(_,i)=>[7200+i*100,.1]),true,true);
 const [c]=h.contextRecorder.drainCompleted();assert.ok(c);assert.equal(c.complete,true);
 assert.deepEqual(c.points.slice(c.center.startIndex,c.center.endIndexExclusive).map(p=>({time:p.time,value:p.raw})),s.points);
 }finally{await h.close();}
});
test('detector reset between gestures does not truncate the independent post-context of a completed center',async()=>{
 const h=await harness();try{
 await h.feed(Array.from({length:51},(_,i)=>[i*100,.1]),true);await h.update({manualTriggerToken:1});
 await h.feed(Array.from({length:21},(_,i)=>[5100+i*100,.9]),true);
 const first=h.get().completedSegment;assert.ok(first);await h.update({resetKey:'next-gesture'});
 assert.equal(h.contextRecorder.drainCompleted().length,0,'detector-only reset is not a source/person archive interruption');
 await h.feed(Array.from({length:51},(_,i)=>[7200+i*100,.1]),true);
 const [c]=h.contextRecorder.drainCompleted();assert.equal(c.attempt.attemptId,first.attemptId);assert.equal(c.complete,true);
 }finally{await h.close();}
});
test('raw gap before a delayed idle Button batch does not anchor a center in discarded source history',async()=>{
 const h=await harness();try{await h.feed([[0,.1]]);await h.update({manualTriggerToken:1});await h.feed([[100,.9],[1000,.9]],true);assert.equal(h.get().isRecording,false);assert.equal(h.get().completedSegment,null);}finally{await h.close();}
});
test('raw acquisition interruption ahead of a delayed React completion cancels safely without unknown-attempt errors',async()=>{
 const h=await harness();try{
 await h.feed([[0,.1]]);await h.update({manualTriggerToken:1});await h.feed(Array.from({length:20},(_,i)=>[100+i*100,.9]),true);assert.equal(h.get().isRecording,true);
 await h.feed([[2100,.9],[3000,.9]],true);assert.equal(h.get().isRecording,false);assert.equal(h.get().completedSegment,null);assert.ok(h.contextRecorder.drainCompleted().some(c=>c.reasons.includes('source_gap')));
 }finally{await h.close();}
});
