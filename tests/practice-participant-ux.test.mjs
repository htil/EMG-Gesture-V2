import test from 'node:test';
import assert from 'node:assert/strict';
import { mount, text } from './support/mounted-study-fixture.mjs';

test('graph orientation keeps its only continuation action inside the nearby guidance',async t=>{
 const h=await mount(t);await h.click('Begin practice');await h.click('Start mock stream');await h.advance(500);
 const guide=h.renderer.root.findByProps({'aria-label':'Practice guidance'});
 assert.equal(guide.findAllByType('button').filter(b=>text(b).trim()==='I’m ready to rest').length,1,'participant can read and continue at the highlighted graph');
 assert.equal(h.renderer.root.findAllByType('button').filter(b=>text(b).trim()==='I’m ready to rest').length,1,'only one continuation control');
});

test('test-only capture settings and live diagnostics start collapsed',async t=>{
 const h=await mount(t,'threshold',true);await h.click('Back to capture');
 const details=h.renderer.root.findAllByType('details');
 const controls=details.find(n=>n.findAllByType('summary').some(s=>text(s)==='Researcher controls'));
 assert.ok(controls,'test controls belong in an explicit expandable section');assert.notEqual(controls.props.open,true);assert.ok(controls.findAllByType('input').length>0);
 const diagnostics=details.find(n=>n.findAllByType('summary').some(s=>text(s)==='Show signal details'));assert.ok(diagnostics);assert.notEqual(diagnostics.props.open,true);
 const saved=JSON.parse(localStorage.getItem('emg-study-session'));saved.isTestParticipant=false;saved.stage='review';localStorage.setItem('emg-study-session',JSON.stringify(saved));await h.remount();await h.click('Back to capture');
 assert.equal(h.renderer.root.findAllByType('details').some(n=>n.findAllByType('summary').some(s=>text(s)==='Researcher controls')),false,'ordinary study participants never receive the settings controls');
 assert.equal(h.renderer.root.findAllByType('darkselect-fixture').some(n=>n.props.label==='Channel'),false);
});

test('guided Practice has only one instruction source and the rest banner speaks to the participant',async t=>{
 const h=await mount(t);await h.click('Begin practice');await h.click('Start mock stream');await h.click('I’m ready to rest');await h.click('Begin resting recording');await h.advance(10500);
 const objective=h.renderer.root.findByProps({'aria-label':'Practice objective'});assert.doesNotMatch(text(objective),/Record Pinch:|Task: collect|Next:/,'old instruction panel must not compete with the guide');
 const rest=h.renderer.root.findByProps({'aria-label':'Fixed rest calibration'});assert.equal(text(rest.findAllByType('p')[0]),'Resting setup saved.');assert.ok(h.button('Redo resting setup'));
 const guide=h.renderer.root.findByProps({'aria-label':'Practice guidance'});assert.doesNotMatch(text(guide),/fixed rest and activity holds|acquisition|physiological|model revision/);
});

test('Space on a details summary never starts a manual capture',async t=>{
 const h=await mount(t,'button',true);await h.click('Back to capture');let onKey;
 window.addEventListener=(name,fn)=>{if(name==='keydown')onKey=fn;};await h.click('Start mock stream');await h.advance(500);assert.ok(onKey);
 let prevented=false;await h.settle(()=>onKey({code:'Space',target:{isContentEditable:false,closest:selector=>selector.split(',').some(part=>part.trim()==='summary')?{}:null},preventDefault(){prevented=true;}}));
 assert.equal(JSON.parse(localStorage.getItem('emg-study-session')).openCapture,null,'opening details must not arm countdown/recording');assert.equal(prevented,false,'summary keeps native keyboard activation');
});

for (const condition of ['threshold', 'button']) test(`${condition} rest-role guidance stays manual and restful from introduction through recording`,async t=>{
 const h=await mount(t,condition);await h.click('Begin practice');await h.click('Start mock stream');await h.click('I’m ready to rest');await h.click('Begin resting recording');await h.advance(10500);
 await h.settle(()=>h.renderer.root.findAllByType('darkselect-fixture').find(n=>n.props.label==='Gesture').props.onChange('relax'));
 const guidance=()=>text(h.renderer.root.findByProps({'aria-label':'Practice guidance'}));
 assert.match(guidance(),/For Relax, keep your hand resting/);assert.match(guidance(),/Press Capture/);assert.doesNotMatch(guidance(),/starts on its own|automatically|make Relax/);
 await h.click('Begin gesture practice');await h.click('Capture Space');assert.match(guidance(),/keep your hand resting/i);assert.doesNotMatch(guidance(),/make Relax/);
 await h.advance(1100);assert.match(guidance(),/keep your hand resting/i);assert.doesNotMatch(guidance(),/Keep doing Relax/);
 await h.advance(4000);assert.equal((await h.read()).filter(r=>r.kind==='capture'&&r.gestureId==='relax').length,1,'rest remains an actual separately cued capture');
});

test('guidance uses configured rest labels and actual manual trigger mode',async()=>{
 const {build}=await import('esbuild');const {Module,createRequire}=await import('node:module');const require=createRequire(import.meta.url);
 const root=new URL('../',import.meta.url).pathname;const bundle=await build({stdin:{contents:"export {practiceGuidance} from './src/app/study/practiceGuidance'",resolveDir:root},bundle:true,platform:'node',format:'cjs',write:false});
 const m=new Module(root+'tests/guidance-labels.cjs');m._compile(bundle.outputFiles[0].text,root+'tests/guidance-labels.cjs');
 const state={stage:'capture',condition:'threshold',streaming:true,calibrated:true,introduced:false,relax:true,manual:true,gestureName:'Resting hand',nextGesture:'Wrist turn'};
 for(const phase of [{introduced:false},{introduced:true,countdown:true},{introduced:true,recording:true}]){const guide=m.exports.practiceGuidance({...state,...phase});assert.match(guide.body,/For Resting hand, keep your hand resting/);assert.doesNotMatch(guide.body,/Relax|automatically|make Resting hand/);}
 const guide=m.exports.practiceGuidance({...state,relax:false,gestureName:'Wrist turn'});assert.match(guide.body,/Press Capture/);assert.doesNotMatch(guide.body,/automatically/);
});

test('connection failures stay visible outside collapsed signal details',async t=>{
 const h=await mount(t,'threshold',true);const saved=JSON.parse(localStorage.getItem('emg-study-session'));saved.isTestParticipant=false;saved.stage='review';localStorage.setItem('emg-study-session',JSON.stringify(saved));await h.remount();await h.click('Back to capture');await h.click('Connect device');
 const notices=h.renderer.root.findAllByProps({'aria-label':'Connection problem — unresolved'});assert.equal(notices.length,1,'a failed connection needs a visible action/error, not hidden diagnostics');assert.match(text(notices[0]),/Chrome or Edge/);for(let node=notices[0].parent;node;node=node.parent)assert.notEqual(node.type,'details');
});
