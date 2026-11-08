import assert from 'node:assert/strict';
import { createRequire, Module } from 'node:module';
import { build } from 'esbuild';
import { fixture } from './practice-fixture.mjs';
const require=createRequire(import.meta.url), React=require('react'),{act,create}=require('react-test-renderer');
const root=new URL('../../',import.meta.url).pathname;
const text=n=>typeof n==='string'?n:(n.children??[]).map(text).join('');
const storage=()=>{const m=new Map();return {getItem:k=>m.get(k)??null,setItem:(k,v)=>m.set(k,String(v)),removeItem:k=>m.delete(k)};};
async function mount(t,condition='threshold',measured=false,{mock=true,testParticipant=true,pilot=false,measuredSetupStub=false}={}) {
 const f=await fixture(t,{deferCleanup:true});
 let sampleListener,liveFeed=false,rawValue=.00001;
 globalThis.__captureStateTransport={deviceName:'Synthetic 200Hz',onSample(fn){sampleListener=fn;},onDisconnected(){},startStreaming:async()=>{},stopStreaming:async()=>{},disconnect(){}};
 if(pilot){const e=await f.call('POST','/experiments',{name:'Synthetic bounded capture-state fixture',protocolVersion:'between-subject-v1',repetitions:1,capturesMin:8,capturesMax:8},true);assert.equal(e.status,201);f.experiment=e.body;}
 // Default fixtures exercise single-round operation lifetimes, not pilot quota8.
 // A modern ordinary participant must opt into authoritative pilot restore.
 if(!pilot){const e=await f.call('POST','/experiments',{name:'Synthetic mounted operation fixture',protocolVersion:'legacy-fixed-v1',repetitions:1,capturesMin:1,capturesMax:1},true);assert.equal(e.status,201);f.experiment=e.body;}
 const p=(await f.call('POST','/participants/generate',{experimentId:f.experiment.id,count:1,assignment:condition,isTestParticipant:testParticipant},true)).body.participants[0];
 const joined=(await f.call('POST','/join',{id:p.id})).body;
 const session={participantId:p.id,experimentId:f.experiment.id,experimentName:'Controlled synthetic-clock Mock integration',sessionId:'frozen-session',generation:joined.generation,isTestParticipant:joined.isTestParticipant,protocolVersion:joined.protocolVersion,updatedAt:1,repetitions:1,capturesMin:8,capturesMax:8,capturesPerRound:2,obstacleCount:2,startingLives:3,round:1,condition,manualTrigger:condition==='button',status:'in_progress',stage:'capture',unlockedThrough:'capture',modelRevisionId:null,trials:[],runs:[],pendingReplacements:[],openCapture:null,trainingRun:null};
 if(pilot) Object.assign(session,{protocolVersion:joined.protocolVersion,conditionOrder:joined.conditionOrder,visit:joined.visit,officialSequence:joined.officialSequence,protocolState:joined.protocolState,isTestParticipant:joined.isTestParticipant});
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
 const res=await f.call(init?.method??'GET',url.replace('/api/study',''),body);if(measuredSetupStub&&url.endsWith('/join')){res.body.protocolState={...res.body.protocolState,practice:session.protocolState.practice};}return {ok:res.status<400,json:async()=>res.body,text:async()=>JSON.stringify(res.body)};};
 const bundle=await build({stdin:{contents:`export {default} from './src/app/study/StudySession'`,resolveDir:root},bundle:true,platform:'node',format:'cjs',jsx:'automatic',write:false,logLevel:'silent',plugins:[{name:'visuals',setup(b){
 b.onResolve({filter:/^react(?:\/jsx-runtime)?$/},a=>({path:require.resolve(a.path),external:true}));
 b.onResolve({filter:/^(react-router|lucide-react|recharts)$|\/(ganglion|GameScreen|DarkSelect|SampleGraphPanel|ResultsPanel)$/},a=>({path:a.path,namespace:'fixture'}));
 b.onLoad({filter:/.*/,namespace:'fixture'},a=>{
 if(a.path==='react-router')return {contents:`export const useNavigate=()=>()=>{};`};
 if(a.path.endsWith('ganglion'))return {contents:`export const isWebBluetoothAvailable=()=>true;export const connectGanglion=async()=>globalThis.__captureStateTransport;`};
 if(a.path==='lucide-react'||a.path==='recharts')return {contents:`import React from 'react';const L=({children})=>React.createElement('visual',null,children);export {L as Activity,L as ArrowRight,L as Check,L as CircleDot,L as Hand,L as Pause,L as Play,L as Radio,L as Trash2,L as Waves,L as Area,L as AreaChart,L as CartesianGrid,L as Line,L as LineChart,L as ReferenceArea,L as ReferenceLine,L as ResponsiveContainer,L as XAxis,L as YAxis};`};
 return {contents:`import React from 'react';export default p=>React.createElement('${a.path.split('/').at(-1).toLowerCase()}-fixture',p);`};
 });}}]});
 const m=new Module(root+'tests/frozen-mounted.cjs');m.paths=require.resolve.paths('react');m._compile(bundle.outputFiles[0].text,root+'tests/frozen-mounted.cjs');
 let renderer;const settle=async fn=>act(async()=>{await fn?.();for(let i=0;i<30;i++)await Promise.resolve();});await settle(()=>{renderer=create(React.createElement(m.exports.default));});
 const button=label=>renderer.root.findAllByType('button').find(n=>text(n).trim()===label||n.props['aria-label']===label);
 // Mock journeys explicitly choose test input when the actual source controls mount.
 const chooseMock=async()=>{if(mock&&button('Mock')&&!button('Start mock stream')&&!button('Pause stream'))await settle(()=>button('Mock').props.onClick());};
 const click=async label=>{const b=button(label);assert.ok(b,'button '+label);assert.equal(!!b.props.disabled,false,label+' enabled');await settle(()=>b.props.onClick());if(label==='Back to capture')await chooseMock();};
 const advance=async ms=>{for(let end=now+ms;now<end;){now=Math.min(now+50,end);await settle(()=>{if(liveFeed&&sampleListener)for(let dt=45;dt>=0;dt-=5)sampleListener({timestamp:now-dt,data:[rawValue]});for(const [id,v]of [...timers])if(v.at<=now){if(v.repeat)v.at=now+v.ms;else timers.delete(id);v.fn();}});}};
 const waitUntil=async(predicate,label,maxMs=6000)=>{for(let elapsed=0;!predicate()&&elapsed<maxMs;elapsed+=50)await advance(50);assert.ok(predicate(),`${label} within ${maxMs}ms; UI: ${text(renderer.toJSON())}`);};
 t.after(async()=>{await settle(()=>renderer.unmount());f.cleanup();Date.now=original;globalThis.setInterval=oi;globalThis.clearInterval=oc;});
 await chooseMock();
 return {...f,p,get renderer(){return renderer;},click,button,advance,waitUntil,writes,settle,liveFeed:(enabled,value=.00001)=>{liveFeed=enabled;rawValue=value;},emitPending:count=>{for(let i=0;i<count;i++){now+=5;sampleListener({timestamp:now,data:[rawValue]});}return now;},emit:(timestamp,raw)=>sampleListener({timestamp,data:[raw]}),remount:async()=>{await settle(()=>renderer.unmount());await settle(()=>{renderer=create(React.createElement(m.exports.default));});await chooseMock();},hold:promise=>{gate=promise;},read:async()=>(await f.call('GET','/practice/'+p.id)).body.records};
}
export {mount, text};
