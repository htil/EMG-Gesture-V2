import test from 'node:test';
import assert from 'node:assert/strict';
import { mount, text } from './support/mounted-study-fixture.mjs';
test('mounted source → rest save/readback → StudySession recorder installs fixed lineage; reconnect recalibrates without resetting rehearsal',async t=>{
 const h=await mount(t);await h.click('Begin practice');await h.click('Start mock stream');await h.advance(500);await h.click('I’m ready to rest');await h.click('Begin resting recording');await h.advance(10500);
 let records=await h.read();const rest=records.find(r=>r.kind==='rest');assert.ok(rest?.calibration,'actual preparation saves computed calibration');await h.click('Begin gesture practice');
 await h.advance(6500);records=await h.read();const capture=records.find(r=>r.kind==='capture');assert.ok(capture,'actual threshold recorder captured '+JSON.stringify({records:records.map(r=>({kind:r.kind,id:r.id})),writes:h.writes.map(w=>({url:w.url,kind:w.body.record?.kind})),ui:text(h.renderer.toJSON())}));assert.deepEqual(capture.calibration,rest.calibration);assert.equal(capture.triggeredAt-capture.firstCrossingAt,100);
 await h.click('Pause stream');await h.click('Start mock stream');await h.advance(6000);assert.equal((await h.read()).filter(r=>r.kind==='capture').length,1,'stream restart cannot reuse historical readiness');
 assert.ok(h.button('Redo resting setup'),'convenient rest-only path');await h.click('Redo resting setup');await h.click('Begin resting recording');await h.advance(10500);
 records=await h.read();assert.equal(records.filter(r=>r.kind==='rest').length,2);assert.equal(records.filter(r=>r.kind==='capture').length,1,'recalibration preserves rehearsal samples');assert.equal(h.renderer.root.findAllByProps({'aria-label':'Practice objective'}).length,1,'not a second practice/game requirement');
});

test('stale asynchronous rest save/readback after actual source stop cannot install live readiness',async t=>{
 const h=await mount(t);await h.click('Begin practice');await h.click('Start mock stream');await h.click('I’m ready to rest');
 let release;h.hold(new Promise(r=>{release=r;}));await h.click('Begin resting recording');await h.advance(10500);
 // Invoke stream stop despite the disabled UI to model a transport disconnect during persistence.
 await h.settle(()=>h.button('Pause stream').props.onClick());h.hold(null);await h.settle(()=>release());
 assert.equal((await h.read()).filter(r=>r.kind==='rest').length,1,'historical evidence may finish saving');
 assert.equal(h.renderer.root.findAllByProps({'aria-label':'Practice objective'}).length,0,'stale completion must not enter rehearsal');
 await h.click('Start mock stream');await h.click('Begin resting recording');await h.advance(10500);assert.equal(h.renderer.root.findAllByProps({'aria-label':'Practice objective'}).length,1,'explicit fresh rest recovers');
});
test('actual measured hook capture survives reload as evidence only, then rest-only recalibration preserves earlier calibration lineage',async t=>{
 const h=await mount(t,'threshold',true);await h.click('Back to capture');await h.click('Start mock stream');await h.advance(6000);
 assert.equal(JSON.parse(localStorage.getItem('emg-study-session')).trials.length,0,'uncalibrated Threshold has no adaptive fallback');
 await h.click('Redo resting setup');await h.click('Begin resting recording');await h.advance(17500);
 let saved=JSON.parse(localStorage.getItem('emg-study-session'));assert.equal(saved.trials.length,1);const first=saved.trials[0];assert.ok(first.calibration);
 await h.remount();await h.click('Start mock stream');await h.settle(()=>h.renderer.root.findAllByType('darkselect-fixture').find(n=>n.props.label==='Gesture').props.onChange('squeeze'));await h.advance(6000);
 saved=JSON.parse(localStorage.getItem('emg-study-session'));assert.equal(saved.trials.length,1,'reload cannot rearm historical rest');
 await h.click('Redo resting setup');await h.click('Begin resting recording');await h.advance(17500);
 saved=JSON.parse(localStorage.getItem('emg-study-session'));assert.equal(saved.trials.length,2);assert.deepEqual(saved.trials.find(x=>x.id===first.id).calibration,first.calibration);assert.notEqual(saved.trials.find(x=>x.id!==first.id).calibration.revision,first.calibration.revision);
 const read=(await h.call('POST','/join',{id:h.p.id})).body;assert.equal(read.restored.trials.length,2);assert.deepEqual(read.restored.trials.find(x=>x.id===first.id).calibration,first.calibration);
});

test('mounted Threshold UI has a read-only envelope boundary rather than a misleading editable normalized threshold',async t=>{
 const h=await mount(t,'threshold',true);await h.click('Back to capture');
 assert.equal(h.renderer.root.findAllByType('input').some(n=>n.props.value===0.6),false,'no editable legacy threshold');
 assert.ok(h.renderer.root.findAllByProps({'aria-label':'Fixed envelope boundary'}).length===1);
});

test('rest-only recalibration returns to the separately cued Relax source rather than Mock active cycling',async t=>{
 const h=await mount(t,'threshold',true);await h.click('Back to capture');await h.click('Start mock stream');await h.settle(()=>h.renderer.root.findAllByType('darkselect-fixture').find(n=>n.props.label==='Gesture').props.onChange('relax'));
 await h.click('Redo resting setup');await h.click('Begin resting recording');await h.advance(17500);
 const panel=h.renderer.root.findAll(n=>n.type?.name==='LivePanel')[0];assert.ok(panel.props.recordingSignalData.every(point=>point.activityEnvelope<.3),'Relax remains actual idle Mock input after reference cleanup');
});

test('rest-only recalibration after actual capture and Train preserves measured dataset/model and invalidates a changed channel',async t=>{
 const h=await mount(t,'button',true);await h.click('Back to capture');await h.click('Start mock stream');await h.click('Redo resting setup');await h.click('Begin resting recording');await h.advance(10500);
 for(const id of ['pinch','squeeze','relax']){await h.settle(()=>h.renderer.root.findAllByType('darkselect-fixture').find(n=>n.props.label==='Gesture').props.onChange(id));await h.click('Capture Space');await h.advance(5000);}
 let saved=JSON.parse(localStorage.getItem('emg-study-session'));assert.equal(saved.trials.length,3);await h.click('Review captures');await h.click('Train model');await h.advance(1500);
 saved=JSON.parse(localStorage.getItem('emg-study-session'));assert.ok(saved.modelRevisionId,'actual constructed and archived model');const revision=saved.modelRevisionId,ids=saved.trials.map(t=>t.id);
 await h.click('Back to capture');await h.settle(()=>h.renderer.root.findAllByType('darkselect-fixture').find(n=>n.props.label==='Channel').props.onChange('1'));await h.advance(500);
 assert.match(text(h.renderer.toJSON()),/Redo your resting setup before recording/);await h.click('Redo resting setup');await h.click('Begin resting recording');await h.advance(10500);
 saved=JSON.parse(localStorage.getItem('emg-study-session'));assert.equal(saved.modelRevisionId,revision);assert.deepEqual(saved.trials.map(t=>t.id),ids);assert.ok((await h.read()).some(r=>r.kind==='rest'&&r.calibration.channelIndex===1));
});
