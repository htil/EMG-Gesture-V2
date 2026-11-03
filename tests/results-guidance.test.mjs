import test from 'node:test';import assert from 'node:assert/strict';import {createRequire,Module} from 'node:module';import {build} from 'esbuild';
const require=createRequire(import.meta.url),React=require('react'),{act,create}=require('react-test-renderer');
const text=n=>typeof n==='string'?n:(n.children??[]).map(text).join('');
test('Results explains score versus recognition, Unknown, failed recordings and actual replay/review/continue actions',async()=>{
 const root=new URL('../',import.meta.url).pathname;
 const b=await build({stdin:{contents:"export {default} from './src/app/study/ResultsPanel'",resolveDir:root},bundle:true,platform:'node',format:'cjs',jsx:'automatic',write:false,plugins:[{name:'externals',setup(b){b.onResolve({filter:/^react(?:\/jsx-runtime)?$/},a=>({path:require.resolve(a.path),external:true}));b.onResolve({filter:/^lucide-react$/},()=>({path:'icons',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export const ArrowRight=()=>null;export const X=()=>null;'}));}}]});
 const m=new Module(root+'tests/results.cjs');m.paths=require.resolve.paths('react');m._compile(b.outputFiles[0].text,root+'tests/results.cjs');let replay=0,review=0,continued=0,r;
 await act(()=>{r=create(React.createElement(m.exports.default,{runs:[],currentRun:null,gestures:[{id:'wrist-up',name:'Wrist up'},{id:'wrist-down',name:'Wrist down'}],onTryAgain(){replay++;},onReview(){review++;},onContinue(){continued++;},tryAgainEnabled:true,continueEnabled:true,continueLabel:'Begin collection',saving:false,saveError:''}));});
 try{const guide=r.root.findByProps({'aria-label':'Results guidance'}),copy=text(guide);assert.match(copy,/score.*not.*accuracy/i);assert.match(copy,/Unknown.*unsuccessful/i);assert.match(copy,/recording failures.*separate/i);assert.match(copy,/same.*samples.*model/i);assert.match(copy,/Review Samples.*retrain/i);assert.match(copy,/Begin collection/i);
 const button=label=>r.root.findAllByType('button').find(b=>text(b)===label);assert.ok(button('Replay game'));assert.equal(button('Try Again'),undefined);await act(()=>button('Replay game').props.onClick());assert.equal(replay,1);assert.equal(review,0);assert.equal(continued,0);
 }finally{await act(()=>r.unmount());}
});
