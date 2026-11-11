import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { transformSync } from 'esbuild';
// Executes the actual production function, not a reimplementation. Controlled
// overlap coverage only; see the separate mounted legitimate-source-boundary test.
const source=fs.readFileSync(new URL('../src/app/study/StudySession.tsx',import.meta.url),'utf8');
const body=source.split('  const retryRawRecovery = async () => {')[1].split('\n  };')[0];
const compiled=transformSync(`async function retry(){${body}\n}`,{loader:'ts',target:'es2022'}).code;
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
function fixture(){
 const state={error:'ORIGINAL_ERROR',save:'ORIGINAL_ERROR',busy:false,ready:null,drains:0,saved:0};
 const env={recoveryCueOwner:{current:{recorder:{},attemptId:'old'}},cueHandoff:{current:Promise.resolve()},recoveryRetryOperation:{current:null},recoveryRetryScope:'scope-old',recoveryRetryScopeRef:{current:'scope-old'},recoveryError:'ORIGINAL_ERROR',setRetryingRecovery:v=>state.busy=v,setParentRecoveryError:v=>state.error=v,setSaveError:v=>state.save=v,setReadyCueId:v=>state.ready=v,reportRecoveryFailure:e=>{state.error=e.message;state.save=e.message;},whenCollectionSaved:async()=>{state.saved++;}};
 function start(gate,ack=Promise.resolve()){env.captureContextArchive={retryRecovery:()=>gate.promise,drain:async()=>{state.drains++;await ack;}};return new Function(...Object.keys(env),`${compiled};return retry();`)(...Object.values(env));}
 const replace=()=>{env.recoveryCueOwner.current={recorder:{},attemptId:'new'};env.cueHandoff.current=Promise.resolve();env.recoveryRetryScope='scope-new';env.recoveryRetryScopeRef.current='scope-new';env.recoveryError='NEW_OWNER_ERROR';state.error='NEW_OWNER_ERROR';state.save='NEW_OWNER_ERROR';};
 return {state,env,start,replace};
}
test('retired reject preserves new owner error and newer Retry busy flag',async()=>{
 const f=fixture(),old=deferred(),fresh=deferred(),ack=deferred();const a=f.start(old);f.replace();const b=f.start(fresh,ack.promise);old.reject(new Error('STALE_OLD_FAILURE'));await a;
 assert.equal(f.state.error,'NEW_OWNER_ERROR');assert.equal(f.state.save,'NEW_OWNER_ERROR');assert.equal(f.state.busy,true);assert.equal(f.state.ready,null);
 fresh.resolve();await Promise.resolve();assert.equal(f.state.busy,true);assert.equal(f.state.ready,null);ack.resolve();await b;assert.equal(f.state.ready,'new');assert.equal(f.state.busy,false);assert.equal(f.state.error,'');
});
test('retired resolve never drains or queues after owner replacement',async()=>{const f=fixture(),old=deferred();const a=f.start(old);f.replace();old.resolve();await a;assert.equal(f.state.drains,0);assert.equal(f.state.saved,0);assert.equal(f.state.error,'NEW_OWNER_ERROR');assert.equal(f.state.ready,null);});
test('same owner overlapping Retry uses operation identity',async()=>{const f=fixture(),old=deferred(),fresh=deferred();const a=f.start(old),b=f.start(fresh);old.reject(new Error('STALE_SAME_OWNER'));await a;assert.equal(f.state.error,'ORIGINAL_ERROR');assert.equal(f.state.busy,true);fresh.resolve();await b;assert.equal(f.state.ready,'old');assert.equal(f.state.busy,false);});
test('current failure stays visible and explicit current retry can recover',async()=>{const f=fixture(),bad=deferred();const a=f.start(bad);bad.reject(new Error('CURRENT_FAILURE'));await a;assert.equal(f.state.error,'CURRENT_FAILURE');assert.equal(f.state.busy,false);assert.equal(f.state.ready,null);const good=deferred();const b=f.start(good);good.resolve();await b;assert.equal(f.state.error,'');assert.equal(f.state.ready,'old');assert.equal(f.state.busy,false);});
for(const stage of ['drain','ACK'])for(const outcome of ['resolve','reject'])test(`retired ${stage} ${outcome} preserves newer operation and error`,async()=>{
 const f=fixture(),old=deferred(),held=deferred(),fresh=deferred();if(stage==='ACK')f.env.whenCollectionSaved=()=>{f.state.saved++;return held.promise;};
 const a=f.start(old,stage==='drain'?held.promise:Promise.resolve());old.resolve();for(let i=0;i<5;i++)await Promise.resolve();assert.equal(f.state.drains,1);if(stage==='ACK')assert.equal(f.state.saved,1);
 f.replace();f.env.whenCollectionSaved=async()=>{f.state.saved++;};const b=f.start(fresh);if(outcome==='resolve')held.resolve();else held.reject(new Error('STALE_LATE_FAILURE'));await a;
 assert.equal(f.state.error,'NEW_OWNER_ERROR');assert.equal(f.state.save,'NEW_OWNER_ERROR');assert.equal(f.state.busy,true);assert.equal(f.state.ready,null);if(stage==='drain')assert.equal(f.state.saved,0);fresh.resolve();await b;assert.equal(f.state.ready,'new');assert.equal(f.state.busy,false);
});
for(const boundary of ['scope','cue','handoff'])test(`retired ${boundary} continuation does not drain or clear errors`,async()=>{const f=fixture(),old=deferred();const a=f.start(old);if(boundary==='scope')f.env.recoveryRetryScopeRef.current='retired';if(boundary==='cue')f.env.recoveryCueOwner.current={...f.env.recoveryCueOwner.current,attemptId:'fresh'};if(boundary==='handoff')f.env.cueHandoff.current=Promise.resolve();f.state.error='NEW_ERROR';old.resolve();await a;assert.equal(f.state.drains,0);assert.equal(f.state.error,'NEW_ERROR');assert.equal(f.state.ready,null);});
