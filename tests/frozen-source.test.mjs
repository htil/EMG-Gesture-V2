import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, Module } from 'node:module';
import { build } from 'esbuild';
const require=createRequire(import.meta.url),React=require('react'),{act,create}=require('react-test-renderer');
const root=new URL('../',import.meta.url).pathname;
test('actual source invalidates its stream epoch at a stop request before transport shutdown resolves',async()=>{
 globalThis.window=globalThis;let release;const gate=new Promise(r=>{release=r;});
 globalThis.__frozenTransport={stopStreaming:()=>gate,disconnect(){},startStreaming:async()=>{},onSample(){},onDisconnected(){},deviceName:'synthetic transport'};
 const bundle=await build({stdin:{contents:`export {useSignalSource} from './src/app/useSignalSource'`,resolveDir:root},bundle:true,platform:'node',format:'cjs',write:false,plugins:[{name:'transport',setup(b){b.onResolve({filter:/^react$/},a=>({path:require.resolve(a.path),external:true}));b.onResolve({filter:/\/ganglion$/},()=>({path:'transport',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:`export const isWebBluetoothAvailable=()=>true;export const connectGanglion=async()=>globalThis.__frozenTransport;`}));}}]});
 const m=new Module(root+'tests/source.cjs');m.paths=require.resolve.paths('react');m._compile(bundle.outputFiles[0].text,root+'tests/source.cjs');let value,renderer;const gen=()=>.1;
 function Probe(){value=m.exports.useSignalSource(gen);return null;}
 await act(()=>{renderer=create(React.createElement(Probe));});await act(()=>value.startStreamForMode('live'));assert.equal(value.isStreaming,true);const epoch=value.streamEpoch;let stop;
 await act(()=>{stop=value.stopStream();});
 try{assert.ok(value.streamEpoch>epoch,'old calibration must be invalid before awaited shutdown');}finally{release();await act(()=>stop);await act(()=>renderer.unmount());}
});
