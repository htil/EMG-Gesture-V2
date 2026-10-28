import test from 'node:test';
import assert from 'node:assert/strict';
import { mount, text } from './support/mounted-study-fixture.mjs';

test('actual Threshold Practice waits for method introduction before arming; tutorial Next never fabricates a sample',async t=>{
 const h=await mount(t);await h.click('Begin practice');await h.click('Start mock stream');await h.click('I’m ready to rest');await h.click('Begin resting recording');await h.advance(18000);
 assert.equal((await h.read()).filter(r=>r.kind==='capture').length,0,'reading the capture introduction must not trigger an unseen example');
 assert.ok(h.button('Begin gesture practice'));assert.match(text(h.renderer.toJSON()),/automatically/);
 await h.click('Begin gesture practice');await h.advance(6500);assert.equal((await h.read()).filter(r=>r.kind==='capture').length,1,'real source/recorder creates the example after introduction');
});

test('actual preparation guide follows real stream/rest actions and exposes highlight targets without fake Next progression',async t=>{
 const h=await mount(t,'button');const step=()=>h.renderer.root.findByProps({'aria-label':'Practice guidance'}).props['data-guide-step'];
 assert.equal(step(),'welcome');await h.click('Begin practice');assert.equal(step(),'connect');
 await h.click('Hide guidance');assert.ok(h.button('Show guidance again'));await h.click('Show guidance again');assert.equal(step(),'connect');
 await h.click('Start mock stream');await h.advance(500);assert.equal(step(),'signal');await h.click('I’m ready to rest');assert.equal(step(),'rest');
 const start=h.button('Begin resting recording');assert.equal(start.props['data-practice-target'],'rest-start');await h.click('Begin resting recording');await h.advance(500);assert.equal(step(),'rest-recording');
 assert.equal((await h.read()).length,0,'no metadata Next button invents a completed reference');
});

test('actual shared Practice guidance teaches saved sample → inspect/delete/replace → archived Train without inventing completion',async t=>{
 const h=await mount(t,'button');const step=()=>h.renderer.root.findByProps({'aria-label':'Practice guidance'}).props['data-guide-step'];
 await h.click('Begin practice');await h.click('Start mock stream');await h.click('I’m ready to rest');await h.click('Begin resting recording');await h.advance(10500);assert.equal(step(),'capture-introduction');await h.click('Begin gesture practice');assert.equal(step(),'capture');
 const select=async id=>h.settle(()=>h.renderer.root.findAllByType('darkselect-fixture').find(n=>n.props.label==='Gesture').props.onChange(id));
 await h.click('Capture Space');await h.advance(5000);assert.equal(step(),'sample-saved');await h.click('Continue practice');assert.equal(step(),'select-gesture');
 for(const id of ['squeeze','relax']){await select(id);await h.click('Capture Space');await h.advance(5000);}assert.equal(step(),'review');await h.click('Pause stream');await h.click('Review captures');assert.equal(step(),'inspect','offline review should not point at a nonexistent stream button');
 await h.click('Graph');assert.equal(step(),'sample-open');await h.settle(()=>h.renderer.root.findByType('samplegraphpanel-fixture').props.onClose());assert.equal(step(),'delete');await h.click('Delete Pinch sample 1');assert.equal(step(),'replace');
 await h.click('Back to capture');await h.click('Start mock stream');await select('pinch');await h.click('Capture Space');await h.advance(5000);await h.click('Review captures');assert.equal(step(),'inspect');await h.click('Graph');await h.settle(()=>h.renderer.root.findByType('samplegraphpanel-fixture').props.onClose());assert.equal(step(),'train');await h.click('Train model');await h.advance(1500);assert.equal(step(),'game-handoff');assert.equal((await h.read()).filter(r=>r.kind==='game').length,0);
 await h.click('Play');assert.equal(h.renderer.root.findAllByType('gamescreen-fixture').length,0,'Play must explain the game rather than abruptly mount it');assert.ok(h.renderer.root.findByProps({'aria-label':'Practice game introduction'}));
 await h.click('Back to review');assert.equal(h.renderer.root.findAllByType('gamescreen-fixture').length,0);await h.click('Play');await h.click('Start practice game');assert.equal(h.renderer.root.findAllByType('gamescreen-fixture').length,1);assert.equal(h.renderer.root.findAllByProps({'aria-label':'Practice guidance'}).length,0,'no tutorial overlay on the running game');
});
