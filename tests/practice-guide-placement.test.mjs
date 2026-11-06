import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire, Module } from 'node:module';
const require=createRequire(import.meta.url),React=require('react'),{act,create}=require('react-test-renderer');
const root=new URL('../',import.meta.url).pathname;
test('actual guide keeps the explanation and its action beside the highlighted graph within the viewport',async()=>{
 const box={top:180,left:40,width:700,height:300,right:740,bottom:480};
 const element={isConnected:true,getBoundingClientRect:()=>box,scrollIntoView(){}};
 globalThis.document={querySelector:()=>element};globalThis.window={innerWidth:1200,innerHeight:800,addEventListener(){},removeEventListener(){}};globalThis.ResizeObserver=class{observe(){}disconnect(){}};
 const bundle=await build({stdin:{contents:`export {default} from './src/app/study/PracticeGuide'`,resolveDir:root},bundle:true,platform:'node',format:'cjs',jsx:'automatic',write:false,plugins:[{name:'react',setup(b){b.onResolve({filter:/^react(?:\/jsx-runtime)?$/},a=>({path:require.resolve(a.path),external:true}));}}]});
 const m=new Module(root+'tests/guide-placement.cjs');m.paths=require.resolve.paths('react');m._compile(bundle.outputFiles[0].text,root+'tests/guide-placement.cjs');let renderer,clicked=0;
 await act(()=>{renderer=create(React.createElement(m.exports.default,{step:{id:'graph',title:'Watch the blue line',body:'Make a comfortable movement. Then rest your hand.',target:'[data-practice-target="signal"]',action:{label:'I’m ready to rest',onClick:()=>clicked++}}}),{createNodeMock:n=>n.type==='section'?{getBoundingClientRect:()=>({width:360,height:180})}:null});});
 try {const guide=renderer.root.findByProps({'aria-label':'Practice guidance'});assert.equal(guide.props.style?.position,'fixed','instruction is attached to the target, not a distant sticky header');assert.ok(guide.props.style.left>=box.right+8);assert.ok(guide.props.style.left+360<=1200-8);assert.ok(guide.props.style.top>=8&&guide.props.style.top+180<=792);const button=guide.findAllByType('button').find(b=>b.children.join('')==='I’m ready to rest');assert.ok(button,'continuation action lives inside the nearby guide');await act(()=>button.props.onClick());assert.equal(clicked,1);}finally{await act(()=>renderer.unmount());delete globalThis.document;delete globalThis.ResizeObserver;}
});
