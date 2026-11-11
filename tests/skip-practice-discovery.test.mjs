import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {mount,text} from './support/mounted-capture-state-fixture.mjs';
const hashes=dir=>Object.fromEntries(fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?Object.entries(hashes(path.join(dir,e.name))).map(([p,h])=>[path.join(e.name,p),h]):[[e.name,crypto.createHash('sha256').update(fs.readFileSync(path.join(dir,e.name))).digest('hex')]]));
for(const condition of ['button','threshold'])test(condition+': visible post-rest Skip Practice retains PIN authorization, scope and pre-measured eligibility',async t=>{
 const f=await mount(t,condition,false,{v2:true,freshV2:true,mock:false});
 const original=JSON.parse(localStorage.getItem('emg-study-session')),scope={id:f.p.id,participantId:f.p.id,experimentId:f.experiment.id,sessionId:original.sessionId,generation:original.generation,round:1,condition};
 assert.equal(f.button('Skip gesture practice'),undefined,'no skip before resting calibration');
 let before=hashes(f.data);assert.equal((await f.call('POST','/protocol/practice/skip',scope,true)).status,409,'saved rest remains mandatory');assert.deepEqual(hashes(f.data),before);
 await f.click('Connect device');f.liveFeed(true);await f.advance(500);await f.click('Begin practice');await f.click('I’m ready to rest');await f.click('Begin resting recording');await f.advance(11000);
 const panel=f.renderer.root.findAllByType('details').find(n=>text(n).includes('Researcher: skip gesture practice'));assert.ok(panel);assert.equal(panel.props.open,true,'existing researcher PIN panel must be immediately visible after rest');
 assert.equal(f.button('Skip gesture practice').props.disabled,true,'blank PIN remains disabled');
 const rests=(await f.read()).filter(r=>r.kind==='rest');assert.equal(rests.length,1);
 for(const change of [{generation:2},{round:2},{condition:condition==='button'?'threshold':'button'},{sessionId:'wrong-scope'}]){before=hashes(f.data);assert.equal((await f.call('POST','/protocol/practice/skip',{...scope,...change},true)).status,409);assert.deepEqual(hashes(f.data),before);}
 const pin=()=>f.renderer.root.findAllByType('input').find(n=>n.props['aria-label']==='Researcher PIN');
 await f.settle(()=>pin().props.onChange({target:{value:'incorrect-test-pin'}}));await f.click('Skip gesture practice');assert.equal((await f.call('POST','/join',{id:f.p.id})).body.protocolState?.practice??null,null,'wrong PIN cannot skip');
 await f.settle(()=>pin().props.onChange({target:{value:process.env.EMG_ADMIN_PIN}}));await f.click('Skip gesture practice');
 const joined=(await f.call('POST','/join',{id:f.p.id})).body;assert.equal(joined.protocolState.practice.status,'skipped');
 for(const key of ['sessionId','generation','round','condition'])assert.equal(joined.protocolState.practice[key],scope[key]);assert.equal(f.button('Skip gesture practice'),undefined,'existing saved decision hides the action');assert.equal(joined.restored?.trials?.length??0,0);
 assert.deepEqual((await f.read()).filter(r=>r.kind==='rest'),rests,'saved resting evidence unchanged');
 await f.settle(()=>f.whenSaved());await f.unmount();await f.settle(()=>f.whenSaved());
 const {id,...sampleScope}=scope,at=Date.now()+1000,rest=rests[0];
 const sample={...sampleScope,sampleId:'measured-first',attemptId:'measured-attempt',centerDurationMs:2000,gestureId:'wrist-up',gestureLabel:'Wrist up',signalSource:'live',channelIndex:0,capturedAt:at+2000,triggeredAt:at,firstCrossingAt:condition==='threshold'?at-100:null,recordingStartedAt:at,recordingEndedAt:at+2000,preTriggerPointCount:0,points:Array.from({length:400},(_,i)=>({time:at+i*5,value:.00001})),settings:rest.settings,calibration:rest.calibration};
 assert.equal((await f.call('POST','/collection',{id:f.p.id,items:[{kind:'sample',record:sample}]})).status,200);
 before=hashes(f.data);assert.equal((await f.call('POST','/protocol/practice/skip',scope,true)).status,409,'skip cannot be retroactively written after measured collection');assert.deepEqual(hashes(f.data),before);
});
