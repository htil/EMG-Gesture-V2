import test from 'node:test';
import assert from 'node:assert/strict';
import {mount,text} from './support/mounted-capture-state-fixture.mjs';
const saved=()=>JSON.parse(localStorage.getItem('emg-study-session'));
const dialog=f=>f.renderer.root.findAll(n=>n.type==='div'&&(n.props.role==='dialog'||n.props.role==='alertdialog'))[0];
async function clickDialog(f,label){const b=dialog(f).findAllByType('button').find(n=>text(n).trim()===label);assert.ok(b,'dialog action '+label);assert.equal(!!b.props.disabled,false);await f.settle(()=>b.props.onClick());}
async function ready(t,condition){
 const f=await mount(t,condition,false,{game:true,mock:false});
 await f.click('Connect device');f.liveFeed(true);await f.advance(500);
 await f.click('Redo resting setup');await f.click('Begin resting recording');await f.advance(11000);return f;
}
test('participant activity omits questionnaire and technical receipt notices while keeping actual saved Practice receipt',async t=>{
 const f=await mount(t,'threshold',false,{v2:true,mock:false});
 const original=(await f.call('POST','/join',{id:f.p.id})).body.protocolState.practice;assert.ok(original);
 const ui=text(f.renderer.toJSON());assert.doesNotMatch(ui,/external Pre questionnaire|external Post questionnaire|saved receipt|Gesture practice (?:completed|skipped by researcher) ·/);
 assert.equal(f.renderer.root.findAll(n=>n.props['aria-label']==='Pre/Post activity protocol').length,0);
 assert.deepEqual((await f.call('POST','/join',{id:f.p.id})).body.protocolState.practice,original);
});
for(const condition of ['button','threshold'])test(condition+': Pause opens confirmation; Cancel leaves streaming/calibration intact; Confirm alone disconnects',async t=>{
 const f=await ready(t,condition),original=saved(),rest=(await f.read()).filter(r=>r.kind==='rest');let stops=0;
 const transport=globalThis.__captureStateTransport,stop=transport.stopStreaming;transport.stopStreaming=async()=>{stops++;return stop();};
 await f.click('Pause stream');assert.ok(dialog(f),'manual pause must first display an overlay dialog');assert.equal(dialog(f).props.role,'alertdialog');assert.equal(dialog(f).props['aria-modal'],'true');assert.match(text(dialog(f)),/Pause stream\?/);assert.equal(stops,0);
 let stoppedKeys=0;dialog(f).props.onKeyDown({key:' ',stopPropagation(){stoppedKeys++;}});assert.equal(stoppedKeys,1,'modal keyboard events must not reach the background Capture shortcut');
 await clickDialog(f,'Cancel');assert.equal(dialog(f),undefined);assert.equal(stops,0);assert.ok(f.button('Pause stream'));assert.match(text(f.renderer.toJSON()),/Resting setup saved/);assert.deepEqual((await f.read()).filter(r=>r.kind==='rest'),rest);
 await f.click('Pause stream');await clickDialog(f,'Confirm');f.liveFeed(false);assert.equal(stops,1);assert.match(text(dialog(f)),/Stream paused by you/);
 for(const key of ['participantId','sessionId','round','condition','modelRevisionId'])assert.equal(saved()[key],original[key]);assert.deepEqual(saved().trials,original.trials);assert.deepEqual(saved().runs,original.runs);
});
for(const condition of ['button','threshold'])test(condition+': disconnect/reconnect/rest guidance is centered fixed overlay with existing capture space unchanged',async t=>{
 const f=await ready(t,condition),original=saved();const method=()=>f.renderer.root.find(n=>n.props['data-practice-target']==='capture-method');const instructions=method().props.className;
 await f.settle(()=>f.disconnect());f.liveFeed(false);assert.ok(dialog(f),'unexpected disconnect must open a dialog, not an in-flow notice');assert.equal(dialog(f).props['aria-modal'],'true');assert.match(text(dialog(f)),/Bluetooth connection lost/);
 const overlay=f.renderer.root.find(n=>n.props['data-participant-dialog-overlay']!==undefined);assert.equal(overlay.props.style.position,'fixed');assert.equal(overlay.props.style.inset,0);assert.equal(overlay.props.style.alignItems,'center');assert.equal(overlay.props.style.justifyContent,'center');assert.equal(method().props.className,instructions);
 assert.equal(f.renderer.root.findAll(n=>n.type==='section'&&n.props['aria-label']==='Signal reconnection guidance').length,0,'no top-of-page recovery section');
 await clickDialog(f,'Reconnect Ganglion');f.liveFeed(true);await f.advance(500);assert.match(text(dialog(f)),/Redo resting calibration before recording or resuming/);
 await clickDialog(f,'Redo resting setup');assert.equal(dialog(f),undefined);await f.click('Begin resting recording');await f.advance(11000);assert.equal(dialog(f),undefined);assert.match(text(f.renderer.toJSON()),/Resting setup saved/);
 for(const key of ['sessionId','round','condition','modelRevisionId'])assert.equal(saved()[key],original[key]);assert.deepEqual(saved().trials,original.trials);assert.deepEqual(saved().runs,original.runs);
});
