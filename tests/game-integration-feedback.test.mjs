import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire,Module} from 'node:module';
import {build} from 'esbuild';
import * as THREE from 'three';
const root=new URL('../',import.meta.url).pathname,source=fs.readFileSync(new URL('../game/main.js',import.meta.url),'utf8');
function fn(name){const start=source.indexOf('function '+name+'(');assert.ok(start>=0,'actual runner implements '+name);return source.slice(start,source.indexOf('\n}',start)+2);}
const text=n=>typeof n==='string'?n:(n.children??[]).map(text).join('');
test('actual red lane geometry matches existing two-second acquisition distances and projects both lane guides',()=>{
 const paint=fn('addRecordingZone'),projection=fn('closestRecordingZoneScreenPoints');
 const prefix=source.slice(0,source.indexOf('const scene =')).replace(/^import .*;\n/gm,'');
 const material=source.match(/const recordingZoneMaterial = new THREE.MeshBasicMaterial\([\s\S]*?\n\}\);/)[0],geometry=source.match(/const recordingZoneGeometry = [^\n]+/)[0];
 const camera=new THREE.PerspectiveCamera(60,1280/720,.1,1000);camera.position.set(0,5,10);camera.lookAt(0,0,-20);camera.updateMatrixWorld();
 const hurdle=new THREE.Group();hurdle.position.z=-50;hurdle.updateMatrixWorld();const c=vm.createContext({THREE,camera,nearestUpcomingHurdle:()=>hurdle,activeRenderer:{domElement:{getBoundingClientRect:()=>({left:0,top:0,width:1280,height:720})}}});
 vm.runInContext(`${prefix}\n${material}\n${geometry}\nconst recordingZoneSample=new THREE.Vector3(),recordingZoneCamera=new THREE.Vector3();${paint}\n${projection}\nglobalThis.paint=addRecordingZone;globalThis.project=closestRecordingZoneScreenPoints;globalThis.dims={speed:RUN_SPEED,start:RECORDING_START_DISTANCE,ready:READY_START_DISTANCE,end:RECORDING_END_DISTANCE,length:RECORDING_ZONE_LENGTH,center:RECORDING_ZONE_CENTER};`,c);
 assert.equal(c.dims.speed,10);assert.equal(c.dims.start,30);assert.equal(c.dims.ready,38);assert.equal(c.dims.length,c.dims.speed*2);assert.equal(c.dims.end,c.dims.start-c.dims.length);
 const group=new THREE.Group();c.paint(group);assert.equal(group.children.length,2);assert.deepEqual(group.children.map(m=>m.position.x),[-1.5,1.5]);for(const mesh of group.children){assert.equal(mesh.geometry.parameters.height,c.dims.length);assert.equal(mesh.position.z-mesh.geometry.parameters.height/2,c.dims.end);assert.equal(mesh.position.z+mesh.geometry.parameters.height/2,c.dims.start);assert.equal(mesh.material.color.getHex(),0xfb7185);}
 const points=c.project();assert.equal(points.length,2);for(const p of points)assert.ok(Number.isFinite(p.x)&&Number.isFinite(p.y));assert.notEqual(points[0].x,points[1].x);c.activeRenderer=null;assert.equal(c.project().length,0);
});
for(const condition of ['button','threshold'])test(condition+': concise track guidance stays in the existing tutorial hold and never replaces official or recovery controls',async t=>{
 const require=createRequire(import.meta.url),React=require('react'),{act,create}=require('react-test-renderer');const old={window:globalThis.window,localStorage:globalThis.localStorage,raf:globalThis.requestAnimationFrame,caf:globalThis.cancelAnimationFrame};
 const store=new Map(),frames=new Map();let serial=0;const raf=fn=>{frames.set(++serial,fn);return serial;};globalThis.window={addEventListener(){},removeEventListener(){},requestAnimationFrame:raf,cancelAnimationFrame:id=>frames.delete(id)};globalThis.requestAnimationFrame=raf;globalThis.cancelAnimationFrame=id=>frames.delete(id);globalThis.localStorage={getItem:k=>store.get(k)??null,setItem:(k,v)=>store.set(k,v)};
 globalThis.__feedback={mounts:0,unmounts:0,releases:0};
 const b=await build({entryPoints:[root+'src/app/GameScreen.tsx'],bundle:true,platform:'node',format:'cjs',jsx:'automatic',write:false,external:['react','react/jsx-runtime'],plugins:[{name:'presentation-runner-seam',setup(p){p.onResolve({filter:/game\/main\.js$/},()=>({path:'runner',namespace:'fixture'}));p.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:`export function mountGame(c,o){globalThis.__feedback.mounts++;globalThis.__feedback.options=o;queueMicrotask(()=>o.onTutorialHold?.('intro'));return()=>globalThis.__feedback.unmounts++;}export function releaseTutorialHold(){globalThis.__feedback.releases++;}export function holdForSourceRecovery(){}export function resumeAfterSourceRecovery(){}export function queueGestureAction(){}export function closestRecordingZoneScreenPoints(){return[{x:100,y:100},{x:200,y:100}];}`}));}}]});
 const mod=new Module(root+'tests/feedback-mounted.cjs');mod.paths=require.resolve.paths('react');mod._compile(b.outputFiles[0].text,root+'tests/feedback-mounted.cjs');
 const settle=async fn=>act(async()=>{await fn?.();for(let i=0;i<30;i++)await Promise.resolve();});let renderer;await settle(()=>{renderer=create(React.createElement(mod.exports.default,{condition,runKind:'official',tutorialPractice:{status:'completed',scopeKey:'synthetic-full-scope-'+condition},streamReady:true,sourceEpoch:1,recoveryReady:true,recoveryToken:'rest-one',onExit(){},officialSequence:Array.from({length:20},(_,i)=>i%4<2?'wrist-up':'wrist-down'),actionGestures:{jump:{id:'wrist-up',name:'Up'},switchLane:{id:'wrist-down',name:'Down'}},predictWindow:()=>null}),{createNodeMock:()=>({})});});
 t.after(async()=>{await settle(()=>renderer.unmount());Object.assign(globalThis,{window:old.window,localStorage:old.localStorage,requestAnimationFrame:old.raf,cancelAnimationFrame:old.caf});});
 const next=()=>settle(()=>renderer.root.findAllByType('button').find(n=>text(n)==='Next').props.onClick());const body=()=>text(renderer.toJSON());
 assert.equal(__feedback.options.obstacleCount,8);assert.equal(__feedback.options.runKind,'practice');assert.equal(__feedback.options.officialSequence,undefined);assert.equal(__feedback.mounts,1);
 await next();assert.match(body(),/lives/i);assert.equal(__feedback.releases,0);await next();assert.match(body(),/red portion of the track/i);assert.equal(__feedback.releases,0,'instruction clicks must not start a recording');
 await settle(()=>{for(const[id,cb]of [...frames]){frames.delete(id);cb();}});assert.equal(renderer.root.findAll(n=>n.type==='svg'&&n.props['data-game-track-guide']===true).length,1);
 await next();assert.equal(__feedback.releases,1);assert.equal(__feedback.mounts,1,'guide substeps do not remount the runner');
 for(const beat of ['wrist-up','wrist-down','farewell']){await settle(()=>__feedback.options.onTutorialHold(beat));await next();}
 await settle(()=>__feedback.options.onRunComplete());await next();assert.equal(__feedback.mounts,2);assert.equal(__feedback.options.runKind,'official');assert.equal(__feedback.options.officialSequence.length,20);assert.equal(typeof __feedback.options.getRecordingProgress,'function','sample-backed recording gate retained');assert.equal(typeof __feedback.options.isStreamReady,'function','source fence retained');
});
