import test from 'node:test';
import assert from 'node:assert/strict';
import { mount, text } from './support/mounted-study-fixture.mjs';
test('mounted Practice requires three retained wrist examples each, archives training, leaves measured quotas unchanged',async t=>{
 const h=await mount(t,'button');
 const measured=JSON.parse(localStorage.getItem('emg-study-session'));
 await h.click('Begin practice');await h.click('Start mock stream');await h.click('I’m ready to rest');await h.click('Begin resting recording');await h.advance(10500);await h.click('Begin gesture practice');
 const select=async id=>h.settle(()=>h.renderer.root.findAllByType('darkselect-fixture').find(n=>n.props.label==='Gesture').props.onChange(id));
 for(const [id,index] of ['wrist-up','wrist-down'].entries().map(([i,v])=>[v,i])){
  await select(id);
  for(let n=1;n<=3;n++){
   assert.ok(h.button('Capture Space')&&!h.button('Capture Space').props.disabled,`${id} example ${n} available`);
   await h.click('Capture Space');await h.advance(5000);
   if(index===0&&n===1)await h.click('Continue practice');
   if(index===0||n<3){await h.click('Review captures');assert.equal(h.button('Train model').props.disabled,true,'partial dataset cannot train');await h.click('Back to capture');}
  }
 }
 assert.equal(h.button('Review captures').props.disabled,false);
 await h.click('Review captures');await h.click('Graph');await h.settle(()=>h.renderer.root.findByType('samplegraphpanel-fixture').props.onClose());
 await h.click('Delete Wrist up sample 1');assert.equal(h.button('Train model').props.disabled,true);
 await h.click('Back to capture');await select('wrist-up');await h.click('Capture Space');await h.advance(5000);await h.click('Review captures');await h.click('Train model');await h.advance(1500);
 const records=await h.read();const captures=records.filter(r=>r.kind==='capture'&&!records.some(d=>d.kind==='removed'&&d.referenceId===r.id));
 assert.equal(captures.length,6);assert.ok(captures.every(r=>r.flowVersion===3));assert.equal(records.filter(r=>r.kind==='training'&&r.status==='success').length,1);
 assert.equal(JSON.parse(localStorage.getItem('emg-study-session')).capturesMin,measured.capturesMin);
 assert.match(text(h.renderer.toJSON()),/palm down|palm facing down/i);
 // Mounted routing/lineage regression only: do not invent a game result.
 await h.click('Play');await h.click('Start practice game');
 const game=h.renderer.root.findByType('gamescreen-fixture');assert.deepEqual(game.props.actionGestures,{jump:{id:'wrist-up',name:'Wrist up'},switchLane:{id:'wrist-down',name:'Wrist down'}});
 await h.settle(()=>game.props.onSecondary());const results=h.renderer.root.findByType('resultspanel-fixture');assert.equal(results.props.currentRun,null,'no fabricated outcomes');assert.equal(results.props.tryAgainEnabled,true);
 const before=await h.read();await h.settle(()=>results.props.onTryAgain());assert.equal(h.renderer.root.findAllByType('gamescreen-fixture').length,1,'Replay returns directly to the actual game boundary');
 assert.deepEqual(await h.read(),before,'Replay does not retrain, remove samples or reset archived practice');
});
