import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createRequire,Module} from 'node:module';
import {build} from 'esbuild';
import {mount,text} from './support/mounted-capture-state-fixture.mjs';
const saved=()=>JSON.parse(localStorage.getItem('emg-study-session'));
const prompt=f=>f.renderer.root.findAll(n=>n.props['aria-label']==='Signal reconnection guidance')[0];
async function ready(t,condition){
 const f=await mount(t,condition,false,{game:true,mock:false});
 await f.click('Connect device');f.liveFeed(true);await f.advance(500);
 await f.click('Redo resting setup');await f.click('Begin resting recording');await f.advance(11000);
 assert.match(text(f.renderer.toJSON()),/Resting setup saved/);return f;
}
for(const condition of ['button','threshold'])test(condition+': disconnect and intentional stop guide reconnect then saved rest without restarting scope',async t=>{
 const f=await ready(t,condition),original=saved(),oldRest=(await f.read()).filter(r=>r.kind==='rest');assert.equal(oldRest.length,1);
 await f.settle(()=>f.disconnect());f.liveFeed(false);
 assert.ok(prompt(f),'unexpected disconnect must show a persistent recovery prompt');assert.match(text(prompt(f)),/Bluetooth connection lost/);assert.doesNotMatch(text(prompt(f)),/paused by you/);
 assert.ok(f.button('Reconnect Ganglion'));await f.click('Reconnect Ganglion');f.liveFeed(true);await f.advance(500);
 assert.match(text(prompt(f)),/Redo resting calibration before recording or resuming/);
 if(condition==='button')assert.equal(f.button('Capture Space').props.disabled,true,'Button cannot record using rest from the old connection');
 await f.click('Redo resting setup');await f.click('Begin resting recording');await f.advance(11000);
 assert.equal(prompt(f),undefined,'only actual saved rest clears the reconnect guidance');
 assert.equal((await f.read()).filter(r=>r.kind==='rest').length,2);
 for(const key of ['participantId','sessionId','condition','round','modelRevisionId'])assert.equal(saved()[key],original[key],key+' preserved');
 assert.deepEqual(saved().trials,original.trials);assert.deepEqual(saved().runs,original.runs);
 await f.click('Pause stream');assert.ok(f.button('Cancel'));assert.ok(f.button('Confirm'));await f.click('Confirm');f.liveFeed(false);assert.match(text(prompt(f)),/Stream paused by you/);assert.doesNotMatch(text(prompt(f)),/Bluetooth connection lost/);
 await f.click('Restart stream');f.liveFeed(true);await f.advance(500);assert.match(text(prompt(f)),/Redo resting calibration before recording or resuming/);
});
for(const condition of ['button','threshold'])test(condition+': ordinary amplitude changes and a brief sample pause do not request recalibration',async t=>{
 const f=await ready(t,condition),before=(await f.read()).filter(r=>r.kind==='rest');
 f.liveFeed(true,.000012);await f.advance(150);f.liveFeed(false);await f.advance(100);f.liveFeed(true,.00001);await f.advance(500);
 assert.equal(prompt(f),undefined);assert.match(text(f.renderer.toJSON()),/Resting setup saved/);
 assert.deepEqual((await f.read()).filter(r=>r.kind==='rest'),before);
});
test('practice guidance reserves one fixed layout slot through recording/saved steps and never auto-scrolls',async t=>{
 const require=createRequire(import.meta.url),React=require('react'),{act,create}=require('react-test-renderer');
 const root=fileURLToPath(new URL('../',import.meta.url));
 const b=await build({entryPoints:[root+'src/app/study/PracticeGuide.tsx'],bundle:true,platform:'node',format:'cjs',jsx:'automatic',write:false,external:['react','react/jsx-runtime']});
 const m=new Module(root+'tests/guide-layout.cjs');m.paths=require.resolve.paths('react');m._compile(b.outputFiles[0].text,root+'tests/guide-layout.cjs');
 const oldWindow=globalThis.window,oldDocument=globalThis.document;let scrolls=0;
 const rect={top:10,left:10,width:100,height:60,bottom:70,right:110};
 globalThis.document={querySelector:()=>({isConnected:true,scrollIntoView(){scrolls++;},getBoundingClientRect:()=>rect})};
 globalThis.window={innerWidth:1200,innerHeight:900,addEventListener(){},removeEventListener(){}};
 let renderer;t.after(()=>{act(()=>renderer?.unmount());globalThis.window=oldWindow;globalThis.document=oldDocument;});
 const render=(id,busy,target)=>React.createElement(m.exports.default,{busy,step:{id,title:id,body:id==='saved'?'A longer message about the captured example.':'Keep resting.',target}});
 act(()=>{renderer=create(render('ready',false,'[data-capture]'),{createNodeMock:()=>({getBoundingClientRect:()=>rect})});});
 const slot=()=>renderer.root.findAll(n=>n.props['data-practice-guide-slot']!==undefined)[0];assert.ok(slot(),'guide must always retain a stable in-flow slot');
 const height=slot().props.style.height;assert.ok(height>0);
 for(const [id,busy,target]of [['recording',true,undefined],['saved',false,'[data-sample]'],['ready',false,'[data-capture]']]){act(()=>renderer.update(render(id,busy,target)));assert.equal(slot().props.style.height,height);}
 assert.equal(scrolls,0,'recording/instruction changes must not move the viewport');
});
test('capture instruction block keeps fixed space while Button records and saves',async t=>{
 const f=await ready(t,'button');
 const method=()=>f.renderer.root.find(n=>n.props['data-practice-target']==='capture-method');
 assert.match(method().props.className,/h-36/,'instruction height must not change the Capture button position');
 const before=method().props.className;
 const recordings=()=>f.renderer.root.find(n=>n.props['aria-label']==='This round recordings');
 assert.match(recordings().props.className,/h-80/,'growing saved cards must not push Capture down on narrow screens');
 const listClass=recordings().props.className;
 await f.click('Capture Space');await f.advance(11000);assert.equal(method().props.className,before);assert.equal(recordings().props.className,listClass);
 assert.ok(saved().trials.length>6,'actual recorder completed another example');
});
