import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire, Module } from 'node:module';
import { build } from 'esbuild';
import { fixture } from './practice-fixture.mjs';
import {restCalibration} from '../../src/app/study/frozenCalibration.mjs';
import {contextItemForSample} from './pilot-context-fixture.mjs';
const require=createRequire(import.meta.url), React=require('react'),{act,create}=require('react-test-renderer');
const root=new URL('../../',import.meta.url).pathname;
const text=n=>typeof n==='string'?n:(n.children??[]).map(text).join('');
const storage=()=>{const m=new Map();return {getItem:k=>m.get(k)??null,setItem:(k,v)=>m.set(k,String(v)),removeItem:k=>m.delete(k)};};
async function mount(t,condition='threshold',measured=false,{mock=true,testParticipant=true,pilot=false,measuredSetupStub=false,game=false,v2=false,results=false,freshV2=false}={}) {
 const f=await fixture(t,{deferCleanup:true});
 let sampleListener,disconnectListener,liveFeed=false,rawValue=.00001;
 globalThis.__captureStateTransport={deviceName:'Synthetic 200Hz',onSample(fn){sampleListener=fn;},onDisconnected(fn){disconnectListener=fn;},startStreaming:async()=>{},stopStreaming:async()=>{},disconnect(){}};
 if(pilot||v2){const e=await f.call('POST','/experiments',{name:'Synthetic bounded capture-state fixture',protocolVersion:v2?'between-subject-v2':'between-subject-v1',repetitions:1,capturesMin:8,capturesMax:8},true);assert.equal(e.status,201);f.experiment=e.body;}
 // Default fixtures exercise single-round operation lifetimes, not pilot quota8.
 // A modern ordinary participant must opt into authoritative pilot restore.
 if(!pilot&&!v2){const e=await f.call('POST','/experiments',{name:'Synthetic mounted operation fixture',protocolVersion:'legacy-fixed-v1',repetitions:1,capturesMin:1,capturesMax:1},true);assert.equal(e.status,201);f.experiment=e.body;}
 const p=(await f.call('POST','/participants/generate',{experimentId:f.experiment.id,count:1,assignment:condition,isTestParticipant:testParticipant},true)).body.participants[0];
 const joined=(await f.call('POST','/join',{id:p.id})).body;
 const session={participantId:p.id,experimentId:f.experiment.id,experimentName:'Controlled synthetic-clock Mock integration',sessionId:'frozen-session',generation:joined.generation,isTestParticipant:joined.isTestParticipant,protocolVersion:joined.protocolVersion,updatedAt:1,repetitions:1,capturesMin:8,capturesMax:8,capturesPerRound:2,obstacleCount:2,startingLives:3,round:1,condition,manualTrigger:condition==='button',status:'in_progress',stage:'capture',unlockedThrough:'capture',modelRevisionId:null,trials:[],runs:[],pendingReplacements:[],openCapture:null,trainingRun:null};
 if(game){session.capturesMin=1;session.capturesMax=8;session.officialSequence=Array.from({length:20},(_,i)=>i%4<2?'wrist-up':'wrist-down');session.modelRevisionId='frozen-model';session.trials=['wrist-up','wrist-down'].flatMap((id,j)=>Array.from({length:3},(_,k)=>({id:id+k,condition,gestureId:id,gestureName:id,capturedAt:1,triggeredAt:1,centerDurationMs:2000,points:Array.from({length:400},(_,i)=>({time:1+i*5,raw:Math.sin(i*(j+1)*.1)*.00001,value:Math.sin(i*(j+1)*.1)*.00001,activityEnvelope:.01})),metrics:{durationMs:2000},preTriggerPointCount:0,quality:'usable'})));}
 if(pilot||v2) Object.assign(session,{protocolVersion:joined.protocolVersion,conditionOrder:joined.conditionOrder,visit:joined.visit,officialSequence:joined.officialSequence,protocolState:joined.protocolState,isTestParticipant:joined.isTestParticipant});
 if(v2&&!freshV2){
  const scope={participantId:p.id,experimentId:f.experiment.id,sessionId:session.sessionId,generation:joined.generation,condition,round:1};
  const rest={...f.record,...scope,id:'seed-rest',attemptId:'seed-rest-attempt',flowVersion:4,signalSource:'live',settings:{segmentDurationMs:2000,preTriggerWindowMs:0,countdownMs:3000,activityThreshold:.6}};rest.calibration=restCalibration(rest);
  assert.equal((await f.call('POST','/practice',{id:p.id,record:rest})).status,200);
  assert.equal((await f.call('POST','/protocol/practice/skip',{id:p.id,...scope},true)).status,200);
  const samples=['wrist-up','wrist-down'].flatMap((g,j)=>Array.from({length:8},(_,k)=>{const at=30000+(j*8+k)*3000;return {...scope,sampleId:g+k,attemptId:'seed-'+g+k,centerDurationMs:2000,gestureId:g,gestureLabel:g,signalSource:'live',channelIndex:0,capturedAt:at+2000,triggeredAt:at,firstCrossingAt:condition==='threshold'?at-100:null,recordingStartedAt:at,recordingEndedAt:at+2000,preTriggerPointCount:0,points:Array.from({length:400},(_,i)=>({time:at+i*5,value:Math.sin(i*(j+1)*.1)*.00001})),settings:rest.settings,calibration:rest.calibration};}));
  assert.equal((await f.call('POST','/collection',{id:p.id,items:samples.map(record=>({kind:'sample',record}))})).status,200);
  assert.equal((await f.call('POST','/collection',{id:p.id,items:samples.map(contextItemForSample)})).status,200);
  assert.equal((await f.call('POST','/protocol/lock',{id:p.id,...scope,sampleIds:samples.map(s=>s.sampleId),revisionId:'frozen-model'})).status,200);
  assert.equal((await f.call('POST','/collection',{id:p.id,items:[{kind:'training',record:{...scope,revisionId:'frozen-model',sampleIds:samples.map(s=>s.sampleId),status:'success',settings:rest.settings}}]})).status,200);
  const ready=(await f.call('POST','/join',{id:p.id})).body;
  session.protocolState=ready.protocolState;session.trials=ready.restored.trials;session.capturesMin=8;session.capturesMax=8;session.obstacleCount=20;
 }
 if(results){
  // API-seeded preparation, not hardware or observed classifier performance.
  const s={participantId:p.id,experimentId:f.experiment.id,sessionId:session.sessionId,generation:session.generation,round:1,condition};
  const id='seed-official-run',startedAt=100000;
  const run={...s,id,runId:id,modelRevisionId:'frozen-model',runKind:'official',completionStatus:'complete',officialSequence:session.officialSequence,streamReady:true,signalSource:'live',startedAt,endedAt:160000,recordedAt:160000,difficulty:'easy',gameScore:0,outcomes:session.officialSequence.map((g,i)=>({trialIndex:i+1,attemptId:`${id}:${i+1}`,expectedGestureId:g,result:'unknown',predictedGestureId:null,cueAt:startedAt+i*3000,recordingStartedAt:startedAt+i*3000,recordingEndedAt:startedAt+i*3000+2000,inferenceStartedAt:startedAt+i*3000+2000,inferenceEndedAt:startedAt+i*3000+2001,sampleCount:400}))};
  Object.assign(session,{stage:'results',unlockedThrough:'results',modelRevisionId:'frozen-model',runs:[run]});
  assert.equal((await f.call('POST','/collection',{id:p.id,items:[{kind:'run',record:run},{kind:'checkpoint',record:session}]})).status,200);
 }
 if(measuredSetupStub) session.protocolState={...session.protocolState,practice:{status:'skipped',at:1,sessionId:session.sessionId,generation:session.generation,round:session.round,condition}};
 if(measured){session.stage='review';session.unlockedThrough='review';}
 globalThis.localStorage=storage();globalThis.sessionStorage=storage();localStorage.setItem('emg-study-session',JSON.stringify(session));
 const original=Date.now;let now=100000;Date.now=()=>now;
 const timers=new Map();let serial=0;const set=(fn,ms,repeat)=>{const id=++serial;timers.set(id,{fn,at:now+Math.max(ms,1),ms:Math.max(ms,1),repeat});return id;};
 globalThis.window={addEventListener(){},removeEventListener(){},setInterval:(f,ms)=>set(f,ms,true),setTimeout:(f,ms)=>set(f,ms,false),clearInterval:id=>timers.delete(id),clearTimeout:id=>timers.delete(id)};
 // useSignalSource's Mock timer uses unqualified setInterval.
 const oi=globalThis.setInterval,oc=globalThis.clearInterval;globalThis.setInterval=window.setInterval;globalThis.clearInterval=window.clearInterval;
 const writes=[];let gate=null;
 globalThis.fetch=async(url,init)=>{const body=init?.body?JSON.parse(init.body):{};if(init?.method==='POST'){writes.push({url,body});if(gate && body.record?.kind==='rest')await gate;}
 const res=await f.call(init?.method??'GET',url.replace('/api/study',''),body,new Headers(init?.headers).get('x-admin-pin')===process.env.EMG_ADMIN_PIN);if(measuredSetupStub&&url.endsWith('/join')){res.body.protocolState={...res.body.protocolState,practice:session.protocolState.practice};}return {ok:res.status<400,json:async()=>res.body,text:async()=>JSON.stringify(res.body)};};
 const bundle=await build({stdin:{contents:`export {default as ParticipantGate} from './src/app/study/ParticipantGate';export {recordCollection,whenCollectionSaved} from './src/app/study/collection';export {default} from './src/app/study/StudySession';export {trainConditionModel} from './src/app/study/conditionTraining';export {DEFAULT_GESTURES} from './src/app/pipeline';`,resolveDir:root},bundle:true,platform:'node',format:'cjs',jsx:'automatic',write:false,logLevel:'silent',plugins:[{name:'visuals',setup(b){
 if(v2)b.onLoad({filter:/useSignalSource\.ts$/},a=>({contents:fs.readFileSync(a.path,'utf8').replace('  return {\n    subscribeRawPoints,','  globalThis.__v2StartSource = startStreamForMode;\n  return {\n    subscribeRawPoints,'),loader:'ts'}));
 b.onResolve({filter:/^react(?:\/jsx-runtime)?$/},a=>({path:require.resolve(a.path),external:true}));
 b.onResolve({filter:/^(react-router|lucide-react|recharts)$|\/(ganglion|GameScreen|DarkSelect|SampleGraphPanel|ResultsPanel)$/},a=>(game&&a.path.endsWith('GameScreen'))||(results&&a.path.endsWith('ResultsPanel'))?null:({path:a.path,namespace:'fixture'}));
 if(game){b.onResolve({filter:/game\/main\.js$/},()=>({path:'runner',namespace:'fixture'}));}
 b.onLoad({filter:/.*/,namespace:'fixture'},a=>{
 if(a.path==='runner')return {contents:`export function mountGame(c,o){globalThis.__gameMounts=(globalThis.__gameMounts??0)+1;globalThis.__gameOptions=o;return ()=>globalThis.__gameUnmounts=(globalThis.__gameUnmounts??0)+1;}export function holdForSourceRecovery(){};export function resumeAfterSourceRecovery(){};export function queueGestureAction(){};export function releaseTutorialHold(){}`};
 if(a.path==='react-router')return {contents:`export const useNavigate=()=>path=>{globalThis.__captureNavigation=path;};`};
 if(a.path.endsWith('ganglion'))return {contents:`export const isWebBluetoothAvailable=()=>true;export const connectGanglion=async()=>globalThis.__captureStateTransport;`};
 if(a.path==='lucide-react'||a.path==='recharts')return {contents:`import React from 'react';const L=({children})=>React.createElement('visual',null,children);export {L as ArrowLeft,L as CheckCircle2,L as Heart,L as XCircle,L as Zap,L as Activity,L as ArrowRight,L as Check,L as CircleDot,L as Hand,L as Pause,L as Play,L as Radio,L as Trash2,L as Waves,L as Area,L as AreaChart,L as CartesianGrid,L as Line,L as LineChart,L as ReferenceArea,L as ReferenceLine,L as ResponsiveContainer,L as XAxis,L as YAxis};`};
 return {contents:`import React from 'react';export default p=>React.createElement('${a.path.split('/').at(-1).toLowerCase()}-fixture',p);`};
 });}}]});
 const loadModule=()=>{const loaded=new Module(root+'tests/frozen-mounted.cjs');loaded.paths=require.resolve.paths('react');loaded._compile(bundle.outputFiles[0].text,root+'tests/frozen-mounted.cjs');return loaded;};
 let m=loadModule();
 if(game){const fakeTimeout=window.setTimeout;window.setTimeout=globalThis.setTimeout;const trained=await m.exports.trainConditionModel(`${session.participantId}:${session.generation}:${session.sessionId}:${session.round}`,condition,session.trials,m.exports.DEFAULT_GESTURES,2000);assert.equal(trained.status,'ready',trained.error);window.setTimeout=fakeTimeout;}
 let renderer;const settle=async fn=>act(async()=>{await fn?.();for(let i=0;i<30;i++)await Promise.resolve();});await settle(()=>{renderer=create(React.createElement(m.exports.default),{createNodeMock:()=>({})});});
 const button=label=>renderer.root.findAllByType('button').find(n=>text(n).trim()===label||n.props['aria-label']===label);
 // Mock journeys explicitly choose test input when the actual source controls mount.
 const chooseMock=async()=>{if(mock&&button('Mock')&&!button('Start mock stream')&&!button('Pause stream'))await settle(()=>button('Mock').props.onClick());};
 const click=async label=>{const b=button(label);assert.ok(b,'button '+label);assert.equal(!!b.props.disabled,false,label+' enabled');await settle(()=>b.props.onClick());if(label==='Back to capture')await chooseMock();};
 const advance=async ms=>{for(let end=now+ms;now<end;){now=Math.min(now+50,end);await settle(()=>{if(liveFeed&&sampleListener)for(let dt=45;dt>=0;dt-=5)sampleListener({timestamp:now-dt,data:[rawValue]});for(const [id,v]of [...timers])if(v.at<=now){if(v.repeat)v.at=now+v.ms;else timers.delete(id);v.fn();}});}};
 const waitUntil=async(predicate,label,maxMs=6000)=>{for(let elapsed=0;!predicate()&&elapsed<maxMs;elapsed+=50)await advance(50);assert.ok(predicate(),`${label} within ${maxMs}ms; UI: ${text(renderer.toJSON())}`);};
 t.after(async()=>{await settle(()=>renderer.unmount());f.cleanup();Date.now=original;globalThis.setInterval=oi;globalThis.clearInterval=oc;});
 await chooseMock();
 return {...f,p,unmount:()=>settle(()=>renderer.unmount()),whenSaved:()=>m.exports.whenCollectionSaved(),enqueue:items=>m.exports.recordCollection(p.id,items),showGate:async()=>{await settle(()=>renderer.unmount());globalThis.__captureNavigation=null;await settle(()=>{renderer=create(React.createElement(m.exports.ParticipantGate));});},connect:()=>settle(()=>globalThis.__v2StartSource('live')),get renderer(){return renderer;},click,button,advance,waitUntil,writes,settle,disconnect:()=>disconnectListener?.(),liveFeed:(enabled,value=.00001)=>{liveFeed=enabled;rawValue=value;},emitPending:count=>{for(let i=0;i<count;i++){now+=5;sampleListener({timestamp:now,data:[rawValue]});}return now;},emit:(timestamp,raw)=>sampleListener({timestamp,data:[raw]}),reload:async()=>{await settle(()=>renderer.unmount());m=loadModule();await settle(()=>{renderer=create(React.createElement(m.exports.default),{createNodeMock:()=>({})});});await chooseMock();},remount:async()=>{await settle(()=>renderer.unmount());await settle(()=>{renderer=create(React.createElement(m.exports.default),{createNodeMock:()=>({})});});await chooseMock();},hold:promise=>{gate=promise;},read:async()=>(await f.call('GET','/practice/'+p.id)).body.records};
}
export {mount, text};
