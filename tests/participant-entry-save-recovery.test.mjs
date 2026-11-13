import test from 'node:test';
import assert from 'node:assert/strict';
import {mount,text} from './support/mounted-capture-state-fixture.mjs';

test('rejected earlier save shows the actual failure and Retry without checking or adopting another ID',async t=>{
 const f=await mount(t,'button',false,{mock:false});
 const other=(await f.call('POST','/participants/generate',{experimentId:f.experiment.id,count:1,assignment:'button',isTestParticipant:true},true)).body.participants[0];
 const item={kind:'checkpoint',record:{participantId:f.p.id,sessionId:'synthetic-original-session',generation:2,round:1,condition:'button',stage:'capture',trials:[]}};
 const rejected=await f.call('POST','/collection',{id:f.p.id,items:[item]});assert.equal(rejected.status,409);
 await f.settle(()=>f.enqueue([item]));const queued=localStorage.getItem('emg-collection-queue');assert.equal(JSON.parse(queued).length,1);
 await f.showGate();f.writes.length=0;const savedSession=localStorage.getItem('emg-study-session');
 await f.settle(()=>f.renderer.root.findByProps({id:'participant-id'}).props.onChange({target:{value:other.id}}));
 await f.settle(()=>f.renderer.root.findByType('form').props.onSubmit({preventDefault(){}}));
 assert.ok(text(f.renderer.toJSON()).includes(rejected.body.error),'the real API save failure must be visible, not indefinite Checking ID');
 const retry=f.button('Retry saving and check ID');assert.ok(retry,'explicit retry must be available');assert.equal(retry.props.disabled,false);
 assert.equal(f.writes.filter(q=>q.url.endsWith('/join')).length,0);assert.notEqual(globalThis.__captureNavigation,'/session');
 await f.settle(()=>retry.props.onClick({preventDefault(){}}));
 assert.ok(text(f.renderer.toJSON()).includes(rejected.body.error));assert.equal(f.button('Retry saving and check ID').props.disabled,false);
 assert.equal(localStorage.getItem('emg-collection-queue'),queued,'queued bytes and original identity unchanged');assert.equal(localStorage.getItem('emg-study-session'),savedSession,'do not adopt the typed participant');
 const attempts=f.writes.filter(q=>q.url.endsWith('/collection'));assert.ok(attempts.length>0);for(const q of attempts)assert.deepEqual(q.body,{id:f.p.id,items:[item]},'retry must preserve the original participant/session/generation and relative store endpoint');
 assert.equal(f.writes.filter(q=>q.url.endsWith('/join')).length,0);
});

const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
const enter=async(f,id)=>{await f.settle(()=>f.renderer.root.findByProps({id:'participant-id'}).props.onChange({target:{value:id}}));await f.settle(()=>f.renderer.root.findByType('form').props.onSubmit({preventDefault(){}}));};
test('a transport failure retries original bytes and permits ID entry only after the real complete acknowledgement',async t=>{
 const f=await mount(t,'button',false,{mock:false});const item={kind:'checkpoint',record:JSON.parse(localStorage.getItem('emg-study-session'))};
 const deliver=globalThis.fetch,attempts=[];let offline=true;
 globalThis.fetch=async(url,init)=>{if(url.endsWith('/collection')){attempts.push(JSON.parse(init.body));if(offline)throw new Error('Synthetic network unavailable');}return deliver(url,init);};
 await f.settle(()=>f.enqueue([item]));const queued=localStorage.getItem('emg-collection-queue');await f.showGate();f.writes.length=0;await enter(f,f.p.id);
 assert.match(text(f.renderer.toJSON()),/Synthetic network unavailable/);assert.equal(f.writes.filter(q=>q.url.endsWith('/join')).length,0);assert.equal(localStorage.getItem('emg-collection-queue'),queued);
 offline=false;await f.settle(()=>f.button('Retry saving and check ID').props.onClick({preventDefault(){}}));
 assert.deepEqual(JSON.parse(localStorage.getItem('emg-collection-queue')),[]);assert.equal(globalThis.__captureNavigation,'/session');assert.equal(f.writes.filter(q=>q.url.endsWith('/join')).length,1);
 assert.ok(attempts.length>=2);for(const request of attempts)assert.deepEqual(request,{id:f.p.id,items:[item]});
 const joined=(await f.call('POST','/join',{id:f.p.id})).body;assert.equal(joined.restored.sessionId,item.record.sessionId);
});
test('an unreceived actual acknowledgement bounds UI waiting, preserves the queue and cannot cause late automatic entry',async t=>{
 const f=await mount(t,'button',false,{mock:false}),held=deferred();t.after(()=>held.resolve());
 const item={kind:'checkpoint',record:JSON.parse(localStorage.getItem('emg-study-session'))},deliver=globalThis.fetch;
 globalThis.fetch=async(url,init)=>{const response=await deliver(url,init);if(url.endsWith('/collection'))await held.promise;return response;};
 await f.settle(()=>{void f.enqueue([item]);});let originalBarrierResolved=false;void f.whenSaved().then(()=>{originalBarrierResolved=true;});const queued=localStorage.getItem('emg-collection-queue');await f.showGate();f.writes.length=0;await enter(f,f.p.id);
 assert.ok(f.button('Waiting for earlier saves'));assert.equal(f.renderer.root.findByProps({id:'participant-id'}).props.disabled,true);
 await f.advance(10100);assert.match(text(f.renderer.toJSON()),/still waiting for a save acknowledgement/);assert.equal(f.button('Retry saving and check ID').props.disabled,false);assert.equal(f.button('Continue').props.disabled,false);
 assert.equal(originalBarrierResolved,false,'UI timeout must not release other original ACK waiters');assert.equal(localStorage.getItem('emg-collection-queue'),queued);assert.equal(f.writes.filter(q=>q.url.endsWith('/join')).length,0);
 await f.settle(()=>held.resolve());assert.equal(originalBarrierResolved,true,'original barrier resolves only after the real ACK');assert.deepEqual(JSON.parse(localStorage.getItem('emg-collection-queue')),[],'only the actual delayed ACK releases data');assert.notEqual(globalThis.__captureNavigation,'/session','timed-out waiter must not resume ID entry');
 await f.settle(()=>f.button('Retry saving and check ID').props.onClick({preventDefault(){}}));assert.equal(globalThis.__captureNavigation,'/session');assert.equal(f.writes.filter(q=>q.url.endsWith('/join')).length,1);
});
test('fresh v2 ID entry still works without a queued save',async t=>{
 const f=await mount(t,'button',false,{v2:true,freshV2:true,mock:false});await f.showGate();f.writes.length=0;await enter(f,f.p.id);assert.equal(globalThis.__captureNavigation,'/session');assert.equal(f.writes.filter(q=>q.url.endsWith('/join')).length,1);
});
test('leaving entry fences a late real ID response from changing storage or navigation',async t=>{
 const f=await mount(t,'button',false,{v2:true,freshV2:true,mock:false}),held=deferred();t.after(()=>held.resolve());await f.showGate();
 const deliver=globalThis.fetch;globalThis.fetch=async(url,init)=>{const response=await deliver(url,init);if(url.endsWith('/join'))await held.promise;return response;};
 const saved=localStorage.getItem('emg-study-session');await enter(f,f.p.id);assert.ok(f.button('Checking ID'));await f.unmount();await f.settle(()=>held.resolve());
 assert.equal(localStorage.getItem('emg-study-session'),saved);assert.notEqual(globalThis.__captureNavigation,'/session');
});
