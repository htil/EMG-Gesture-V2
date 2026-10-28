import test from 'node:test';
import assert from 'node:assert/strict';
import {mount,text} from './support/mounted-study-fixture.mjs';

const circle=h=>h.renderer.root.findByProps({'aria-label':'Capture status'});

test('actual shared Practice circle follows detector readiness, movement confirmation and recording',async t=>{
 const h=await mount(t);assert.equal(circle(h).props['data-capture-state'],'Rest');
 await h.click('Begin practice');await h.click('Start mock stream');await h.click('I’m ready to rest');await h.click('Begin resting recording');
 assert.equal(circle(h).props['data-capture-state'],'Recording','rest setup uses its actual recording state too');
 await h.advance(10500);assert.equal(circle(h).props['data-capture-state'],'Rest','unintroduced automatic capture is not Ready');
 await h.click('Begin gesture practice');
 const states=new Set();for(let ms=0;ms<6000;ms+=50){await h.advance(50);states.add(circle(h).props['data-capture-state']);}
 for(const state of ['Rest','Ready','Movement','Recording'])assert.ok(states.has(state),'actual source/recorder path must show '+state);
 assert.equal((await h.read()).filter(r=>r.kind==='capture').length,1,'status presentation preserves actual archive capture');
 await h.click('Pause stream');assert.equal(circle(h).props['data-capture-state'],'Rest');assert.match(text(circle(h)),/connect/i);
});

test('Button circle uses Ready, countdown Movement and Recording without requiring threshold calibration',async t=>{
 const h=await mount(t,'button',true);await h.click('Back to capture');await h.click('Start mock stream');await h.advance(500);
 assert.equal(circle(h).props['data-capture-state'],'Ready');assert.match(text(circle(h)),/press Capture/i);
 await h.click('Capture Space');assert.equal(circle(h).props['data-capture-state'],'Movement');
 await h.advance(2800);assert.equal(circle(h).props['data-capture-state'],'Movement','the normal three-second countdown is not shortened');
 await h.advance(300);assert.equal(circle(h).props['data-capture-state'],'Recording');
});

test('a real connection failure puts Error in the circle rather than Ready',async t=>{
 const h=await mount(t,'threshold',false,{mock:false});await h.click('Begin practice');await h.click('Connect device');
 assert.equal(circle(h).props['data-capture-state'],'Error');assert.match(text(circle(h)),/connection/i);
});

test('even test IDs start on real input; Mock requires an explicit test-only selection',async t=>{
 const h=await mount(t,'threshold',false,{mock:false});await h.click('Begin practice');
 assert.ok(h.button('Connect device'),'the participant guide must not default a test ID into generated input');
 assert.equal(h.button('Start mock stream'),undefined);
 await h.click('Mock');assert.ok(h.button('Start mock stream'));
 const warning=h.renderer.root.findByProps({'aria-label':'Simulated signal'});assert.match(text(warning),/does not respond to your movements/i);
 await h.click('Start mock stream');await h.advance(500);
 assert.ok(h.button('I’m ready to rest'),'explicitly changing source must preserve the participant’s current orientation step');
 assert.equal(h.renderer.root.findAllByProps({'aria-label':'Simulated signal'}).length,1,'warning stays visible while Mock runs');
});

test('ordinary participants cannot choose Mock in preparation or capture',async t=>{
 const h=await mount(t,'threshold',false,{mock:false});const saved=JSON.parse(localStorage.getItem('emg-study-session'));saved.isTestParticipant=false;localStorage.setItem('emg-study-session',JSON.stringify(saved));await h.remount();await h.click('Begin practice');
 assert.ok(h.button('Connect device'));assert.equal(h.button('Mock'),undefined);assert.equal(h.button('Start mock stream'),undefined);
 saved.stage='review';saved.unlockedThrough='review';localStorage.setItem('emg-study-session',JSON.stringify(saved));await h.remount();await h.click('Back to capture');assert.equal(h.button('Mock'),undefined);assert.ok(h.button('Connect device'));
});
