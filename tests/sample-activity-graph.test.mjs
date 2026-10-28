import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire, Module} from 'node:module';
import {build} from 'esbuild';
const require=createRequire(import.meta.url), React=require('react'), {act,create}=require('react-test-renderer');
const root=new URL('../',import.meta.url).pathname;
const text=n=>typeof n==='string'?n:(n.children??[]).map(text).join('');
async function load(){
 const bundle=await build({stdin:{contents:"export {default} from './src/app/study/SampleGraphPanel'; export {displayEnvelopeWaveform} from './src/app/study/waveScale';",resolveDir:root},bundle:true,platform:'node',format:'cjs',jsx:'automatic',write:false,plugins:[{name:'visuals',setup(b){
 b.onResolve({filter:/^react(?:\/jsx-runtime)?$/},a=>({path:require.resolve(a.path),external:true}));
 b.onResolve({filter:/^(recharts|lucide-react)$/},a=>({path:a.path,namespace:'fixture'}));
 b.onLoad({filter:/.*/,namespace:'fixture'},a=>({contents:a.path==='lucide-react'?"export const X=()=>null;":`import React from 'react'; ${['Line','LineChart','ResponsiveContainer','XAxis','YAxis'].map(n=>`export const ${n}=p=>React.createElement('chart-${n.toLowerCase()}',p,p.children);`).join('\n')}`}));
 }}]});
 const m=new Module(root+'tests/sample-graph.cjs');m.paths=require.resolve.paths('react');m._compile(bundle.outputFiles[0].text,root+'tests/sample-graph.cjs');return m.exports;
}
test('expanded participant sample graph uses the existing positive activity display without changing raw data',async()=>{
 const module=await load();const points=[{time:1000,value:-3},{time:1025,value:4},{time:1025,value:-2},{time:1100,value:1}];const trial={id:'sample-1',gestureName:'Wrist up',capturedAt:2000,points};const original=structuredClone(trial);let renderer;
 await act(()=>{renderer=create(React.createElement(module.default,{trial,trials:[trial],onClose(){},onSelect(){}}));});
 try{
 const chart=renderer.root.findAllByType('chart-linechart')[0];
 assert.deepEqual(chart.props.data.map(p=>p.value),module.displayEnvelopeWaveform(points).map(p=>p.value),'main chart is the same display-only RMS envelope as the preview, not signed raw points');
 assert.ok(chart.props.data.every(p=>p.value>=0));
 assert.equal(chart.findByType('chart-yaxis').props.domain[0],0,'activity axis starts at zero');
 assert.equal(chart.findByType('chart-line').props.dot,false,'participant view is a clean trace rather than a dot for every source point');
 const details=renderer.root.findAllByType('details').find(n=>text(n.findByType('summary')).includes('Researcher details'));
 assert.ok(details,'raw trace and numerical data remain available as explicitly collapsed researcher details');assert.notEqual(details.props.open,true);
 assert.deepEqual(details.findByType('chart-linechart').props.data.map(p=>p.value),points.map(p=>p.value),'raw trace preserves signed values and tied source points');
 assert.match(text(details.findByType('pre')),/Wrist up,0,0,-3/,'CSV still contains original signed raw samples');
 assert.deepEqual(trial,original,'rendering never mutates archived samples');
 }finally{await act(()=>renderer.unmount());}
});
