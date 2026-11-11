import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createRequire,Module} from 'node:module';
import {build} from 'esbuild';
import {roundFixture} from './support/round-api-fixture.mjs';
import {fixture} from './support/practice-fixture.mjs';
import {dispatchStudyRequest} from '../server/study-api.mjs';
const text=n=>typeof n==='string'?n:(n.children??[]).map(text).join('');
const hashes=dir=>Object.fromEntries(fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?Object.entries(hashes(path.join(dir,e.name))).map(([p,h])=>[path.join(e.name,p),h]):[[e.name,crypto.createHash('sha256').update(fs.readFileSync(path.join(dir,e.name))).digest('hex')]]));
async function admin(t,f){
 const require=createRequire(import.meta.url),React=require('react'),{act,create}=require('react-test-renderer'),root=fileURLToPath(new URL('../',import.meta.url));
 const old=Object.fromEntries(['window','localStorage','sessionStorage','fetch'].map(k=>[k,globalThis[k]]));const store=()=>{const m=new Map();return {getItem:k=>m.get(k)??null,setItem:(k,v)=>m.set(k,String(v)),removeItem:k=>m.delete(k)};};
 globalThis.localStorage=store();globalThis.sessionStorage=store();sessionStorage.setItem('emg-admin-pin',process.env.EMG_ADMIN_PIN);
 const intervals=new Map();let serial=0;globalThis.window={setInterval:fn=>{intervals.set(++serial,fn);return serial;},clearInterval:id=>intervals.delete(id)};
 const requests=[];globalThis.fetch=async(raw,init={})=>{const u=new URL(raw,'http://fixture'),method=init.method??'GET';requests.push({method,path:u.pathname});const q=await dispatchStudyRequest(f.data,{method,pathname:u.pathname.replace('/api/study',''),searchParams:u.searchParams,headers:Object.fromEntries(new Headers(init.headers).entries()),body:init.body?JSON.parse(init.body):{}});return {ok:q.status<400,status:q.status,text:async()=>JSON.stringify(q.body)};};
 const b=await build({entryPoints:[root+'src/app/admin/AdminApp.tsx'],bundle:true,platform:'node',format:'cjs',jsx:'automatic',write:false,external:['react','react/jsx-runtime'],plugins:[{name:'presentation',setup(p){p.onResolve({filter:/^(lucide-react)$|\/DarkSelect$/},a=>({path:a.path,namespace:'ui'}));p.onLoad({filter:/.*/,namespace:'ui'},a=>({contents:a.path==='lucide-react'?`import React from 'react';const L=()=>React.createElement('icon');export {L as Check,L as ClipboardCopy,L as Download,L as FlaskConical,L as Plus,L as RefreshCw,L as Trash2};`:`import React from 'react';export default p=>React.createElement('select-fixture',p);`}));}}]});
 const mod=new Module(root+'tests/admin-mounted.cjs');mod.paths=require.resolve.paths('react');mod._compile(b.outputFiles[0].text,root+'tests/admin-mounted.cjs');
 let renderer;const settle=async fn=>act(async()=>{await fn?.();for(let i=0;i<40;i++)await Promise.resolve();});await settle(()=>{renderer=create(React.createElement(mod.exports.default));});
 const select=renderer.root.findAllByType('button').find(n=>text(n).startsWith(f.experiment.name));assert.ok(select,'actual experiment selector');await settle(()=>select.props.onClick());
 t.after(async()=>{await settle(()=>renderer.unmount());for(const[k,value]of Object.entries(old))globalThis[k]=value;});
 return {renderer,requests,refresh:()=>settle(()=>{for(const fn of intervals.values())fn();}),byLabel:label=>renderer.root.findAll(n=>n.props['aria-label']===label)[0]};
}
test('admin renders actual completed/current rounds and full history across repeat rounds without writing data',async t=>{
 const f=await roundFixture(t),first=await f.complete();
 const advance=async(round,sessionId)=>f.call('POST','/protocol/next-round',{id:f.p.id,experimentId:f.experiment.id,generation:1,condition:'button',fromRound:round,fromSessionId:sessionId,requestId:'admin-view-'+round,finalizationReceiptDigest:(await f.join()).finalizationReceiptDigest});
 const second=await advance(1,first.s.sessionId);assert.equal(second.status,200);await f.complete(2,second.body.sessionId);
 const before=hashes(f.data),a=await admin(t,f),progress=()=>a.byLabel('Round progress for '+f.p.id),history=()=>a.byLabel('Round history for '+f.p.id);
 assert.ok(progress(),'admin must expose actual round progress, not repetitions');assert.match(text(progress()),/Current round 2/);assert.match(text(progress()),/2 completed/);assert.doesNotMatch(text(progress()),/1 \/ 1|2 \/ 1/);
 assert.ok(history());assert.match(text(history()),/Round 1/);assert.match(text(history()),/Round 2/);assert.match(text(history()),/checkpoint.json/);assert.match(text(history()),/checkpoints\/1-2.json/);assert.match(text(history()),/finalization-1-1.json/);assert.match(text(history()),/advance-1-1.json/);
 assert.match(text(a.byLabel('Recovery status for '+f.p.id)),/next round available/i);assert.deepEqual(hashes(f.data),before,'viewing backend history never repairs or rewrites evidence');
 const third=await advance(2,second.body.sessionId);assert.equal(third.status,200);const afterAdvance=hashes(f.data);await a.refresh();
 assert.match(text(progress()),/Current round 3/);assert.match(text(progress()),/2 completed/);assert.match(text(history()),/Round 3/);assert.match(text(a.byLabel('Recovery status for '+f.p.id)),/capture/i);assert.deepEqual(hashes(f.data),afterAdvance);
 assert.ok(a.requests.every(q=>q.method==='GET'),'admin visibility adds no state-changing actions');
});
test('admin recovery cell shows existing server save warning without claiming browser queues are drained',async t=>{
 const f=await fixture(t);assert.equal((await f.call('POST','/save-alert',{id:f.participant.id,generation:1,active:true,pending:3,message:'Synthetic pending saves'})).status,200);
 const before=hashes(f.data),a=await admin(t,f),cell=a.byLabel('Recovery status for '+f.participant.id);assert.ok(cell);assert.match(text(cell),/Save warning/);assert.match(text(cell),/3/);assert.match(text(a.renderer.toJSON()),/browser.*not visible/i);assert.deepEqual(hashes(f.data),before);
});
