import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Module,createRequire} from 'node:module';
const require=createRequire(import.meta.url),root=new URL('../',import.meta.url).pathname;
const storage=()=>{const m=new Map();return {getItem:k=>m.get(k)??null,setItem:(k,v)=>m.set(k,String(v)),removeItem:k=>m.delete(k)}};
test('actual durable collection queue retains complete batch after partial/missing acknowledgement and retries the exact immutable records',async()=>{
 globalThis.localStorage=storage();globalThis.sessionStorage=storage();globalThis.window={setTimeout(){return 0},clearTimeout(){}};
 const result=await build({entryPoints:[root+'src/app/study/collection.ts'],bundle:true,platform:'node',format:'cjs',write:false,logLevel:'silent'});
 const mod=new Module(root+'tests/core-queue.cjs');mod.paths=require.resolve.paths('react');mod._compile(result.outputFiles[0].text,root+'tests/core-queue.cjs');
 let mode='partial';const requests=[];globalThis.fetch=async(url,init)=>{const body=JSON.parse(init.body);requests.push(body);return {ok:true,text:async()=>JSON.stringify(mode==='missing'?{ok:true}:{ok:true,acceptedCount:mode==='partial'?body.items.length-1:body.items.length})}};
 const api=mod.exports,observed=[];api.subscribeCollectionStatus(s=>observed.push(s));
 const record={sessionId:'queue-scope',condition:'button',generation:1,round:1,context:{contextId:'queued-context',points:[{time:123,raw:4.56,consumptionId:1}]}};
 await api.recordCollection('QUEUETEST',[{kind:'context',record}]);record.context.points[0].raw=999;
 let pending=JSON.parse(localStorage.getItem('emg-collection-queue'));assert.equal(pending.length,1);assert.equal(pending[0].item.record.context.points[0].raw,4.56);assert.match(observed.at(-1).error,/acknowledg/i);
 mode='missing';await api.retryCollectionSave();assert.equal(JSON.parse(localStorage.getItem('emg-collection-queue')).length,1);
 mode='complete';await api.retryCollectionSave();await api.whenCollectionSaved();assert.deepEqual(JSON.parse(localStorage.getItem('emg-collection-queue')),[]);assert.equal(observed.at(-1).pending,0);assert.deepEqual(requests[0],requests[2]);
});
