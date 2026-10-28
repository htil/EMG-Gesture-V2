import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, Module } from 'node:module';
import fs from 'node:fs';
import { build } from 'esbuild';
import { fixture } from './support/practice-fixture.mjs';
import { restCalibration } from '../src/app/study/frozenCalibration.mjs';

const require = createRequire(import.meta.url);
const React = require('react');
const { act, create } = require('react-test-renderer');
const root = new URL('../', import.meta.url).pathname;
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const storage = () => { const data = new Map(); return { getItem: k => data.get(k) ?? null, setItem: (k,v) => data.set(k,String(v)), removeItem: k => data.delete(k) }; };
const text = n => typeof n === 'string' ? n : (n.children ?? []).map(text).join('');

// Only hardware/recording inputs, router, and visual leaves are substituted.
// StudySession, conditionTraining, pipeline, collection, PracticeArchive and the
// strict server dispatcher all execute their actual implementations.
async function mount(t, mode, phase) {
  const f = await fixture(t);
  const state = { segment: null, timers: [], writes: [], persisted: null, archive: null, navigated: [], blocked: deferred(), gate: false, holdTraining: false, trainingGate: deferred(), fail: false };
  globalThis.__lifecycle = state;
  globalThis.localStorage = storage(); globalThis.sessionStorage = storage();
  globalThis.window = {
    addEventListener() {}, removeEventListener() {}, clearTimeout(id) { state.timers = state.timers.filter(x => x !== id); },
    setTimeout(fn, ms) { const timer = { fn, ms }; state.timers.push(timer); return timer; },
    setInterval() { return 0; }, clearInterval() {},
  };
  const session = { participantId: f.participant.id, experimentId: f.experiment.id, experimentName: 'Synthetic lifecycle fixture', sessionId: f.record.sessionId,
    generation: f.record.generation, isTestParticipant: true, updatedAt: 1, repetitions: 1, capturesMin: 1, capturesMax: 1, capturesPerRound: 1,
    obstacleCount: 2, startingLives: 3, round: 1, condition: 'button', manualTrigger: true, status: 'in_progress', stage: 'capture', unlockedThrough: 'review',
    modelRevisionId: null, trials: [], runs: [], pendingReplacements: [], openCapture: null, trainingRun: null };
  localStorage.setItem('emg-study-session', JSON.stringify(session));
  globalThis.fetch = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : {};
    if (init?.method === 'POST') {
      state.writes.push({ url, body });
      if (state.gate && ((url === '/api/study/practice' && body.record.kind === 'reviewed') || url === '/api/study/collection')) await state.blocked.promise;
      if (state.holdTraining && ((body.record?.kind === 'training') || body.items?.some(x => x.kind === 'training'))) await state.trainingGate.promise;
      if (state.fail === body.record?.kind) return { ok: false, json: async () => ({ error: 'synthetic save failure' }) };
    }
    const res = await f.call(init?.method ?? 'GET', url.replace('/api/study', ''), body);
    return { ok: res.status < 400, json: async () => res.body, text: async () => JSON.stringify(res.body) };
  };
  const bundle = await build({ stdin: { contents: `export { default as StudySession } from './src/app/study/StudySession'; export * from './src/app/study/conditionTraining'; export * from './src/app/study/practiceArchive';`, resolveDir: root },
    bundle: true, platform: 'node', format: 'cjs', write: false, jsx: 'automatic', logLevel: 'silent', plugins: [{ name: 'lifecycle-inputs', setup(b) {
      if (process.env.LIFECYCLE_SOURCE) b.onLoad({filter:/\/StudySession\.tsx$/},()=>({contents:fs.readFileSync(process.env.LIFECYCLE_SOURCE,'utf8'),loader:'tsx',resolveDir:root+'src/app/study'}));
      b.onResolve({ filter: /^react(?:\/jsx-runtime)?$/ }, a => ({ path: require.resolve(a.path), external: true }));
      b.onResolve({ filter: /^(react-router|lucide-react|recharts)$|\/(useSignalSource|useGestureRecorder|GameScreen|DarkSelect|SampleGraphPanel|ResultsPanel|GuidedPractice)$/ }, a => ({ path: a.path, namespace: 'fixture' }));
      b.onLoad({ filter: /.*/, namespace: 'fixture' }, a => {
        if (a.path === 'react-router') return { contents: `export const useNavigate=()=>globalThis.__lifecycle.navigate ??= ((...a)=>globalThis.__lifecycle.navigated.push(a));` };
        if (a.path.endsWith('useGestureRecorder')) return { contents: `const ack=()=>{globalThis.__lifecycle.segment=null}; export const useGestureRecorder=()=>({recorderState:'idle',isRecording:false,recordingStartTime:null,recordingProgress:0,completedSegment:globalThis.__lifecycle.segment,acknowledgeCompletedSegment:ack});` };
        if (a.path.endsWith('useSignalSource')) return { contents: `const noop=()=>{};export const useSignalSource=()=>({signalData:[],recordingSignalData:[],isStreaming:true,streamEpoch:1,selectSignalSourceMode:noop,startStreamForMode:noop,stopStream:noop,liveConnectionStatus:'idle',liveConnectionMessage:'',liveDeviceName:null,liveSampleRateHz:20,isBluetoothAvailable:false,isDisplayScaleFrozen:false,freezeDisplayScale:noop,getDisplayValueForNormalizedActivity:x=>x});` };
        if (a.path === 'lucide-react' || a.path === 'recharts') return { contents: `import React from 'react'; const Leaf=({children})=>React.createElement('visual-fixture',null,children); export {Leaf as Activity,Leaf as ArrowRight,Leaf as Check,Leaf as CircleDot,Leaf as Hand,Leaf as Pause,Leaf as Play,Leaf as Radio,Leaf as Trash2,Leaf as Waves,Leaf as Area,Leaf as AreaChart,Leaf as CartesianGrid,Leaf as Line,Leaf as LineChart,Leaf as ReferenceArea,Leaf as ReferenceLine,Leaf as ResponsiveContainer,Leaf as XAxis,Leaf as YAxis};` };
        return { contents: `import React from 'react';export default p=>React.createElement('${a.path.split('/').at(-1).toLowerCase()}-fixture',p);` };
      });
    }}] });
  const mod = new Module(root + 'tests/lifecycle-fixture.cjs'); mod.paths = require.resolve.paths('react'); mod._compile(bundle.outputFiles[0].text, root + 'tests/lifecycle-fixture.cjs');
  const api = mod.exports;
  // Capture the real archive instance without replacing its methods/behavior.
  const originalCollect = api.PracticeArchive.prototype.collect;
  api.PracticeArchive.prototype.collect = function(items) { state.archive = this; return originalCollect.call(this,items); };
  let renderer;
  const settle = async (fn = () => {}) => { await act(async () => { await fn(); for (let i=0;i<20;i++) await Promise.resolve(); }); };
  await settle(() => { renderer = create(React.createElement(api.StudySession)); });
  const button = label => renderer.root.findAllByType('button').find(n => text(n).trim() === label || n.props['aria-label'] === label);
  const redraw = () => renderer.update(React.createElement(api.StudySession));
  if (mode === 'practice') {
    // This synthetic fixture archives Mock samples; select that source explicitly.
    await settle(() => renderer.root.findByType('guidedpractice-fixture').props.onSource('mock'));
    const rest = { ...f.record, flowVersion: 2, calibration: restCalibration(f.record) };
    assert.equal((await f.call('POST', '/practice', { id: f.participant.id, record: rest })).status,200);
    await settle(() => renderer.root.findByType('guidedpractice-fixture').props.onComplete(rest));
  } else {
    // Begin measured capture without introducing any synthetic practice lineage.
    // The empty session starts in setup; emulate a restored measured capture.
    await settle(() => renderer.unmount());
    session.trials = [makeTrial('pinch', f.capture('pinch').points)];
    localStorage.setItem('emg-study-session',JSON.stringify(session));
    await settle(() => { renderer = create(React.createElement(api.StudySession)); });
  }
  function makeTrial(id, points) { return { id: 'practice-'+id, gestureId:id, gestureName:id, pairIndex:1, capturedAt:20000, triggeredAt:10200, completedAt:11400, preTriggerPointCount:4, points, quality:'usable', metrics:{durationMs:1200,rms:0.1,peak:0.2,range:0.1} }; }
  for (const id of mode === 'practice' ? ['pinch','squeeze','relax'] : ['squeeze','relax']) {
    await settle(() => renderer.root.findAllByType('darkselect-fixture').find(n=>n.props.label==='Gesture').props.onChange(id));
    const points = f.capture(id).points;
    await settle(() => { state.segment = {points,triggeredAt:10200,completedAt:11400,preTriggerPointCount:4,triggerMode:'button'}; redraw(); });
  }
  const reopen = mode === 'measured' ? button('Reopen guided practice').props.onClick : null;
  await settle(() => button('Review captures').props.onClick());
  const back = button('Back to capture').props.onClick;
  const remove = renderer.root.findAllByType('button').find(n=>n.props['aria-label']?.startsWith('Delete ')).props.onClick;
  if (mode === 'practice') await state.archive.barrier();
  if (phase === 'barrier') {
    state.gate = true;
    if (mode === 'practice') void state.archive.enqueue(state.archive.record('reviewed',{referenceId:state.archive.saved.find(x=>x.kind==='capture').id}));
    else { // A real measured queue item must drain before model construction.
      await settle(() => { redraw(); });
      const checkpoint = state.timers.find(x=>x.ms===300); if (checkpoint) await settle(() => checkpoint.fn());
    }
  }
  const start = button('Train model').props.onClick;
  await settle(() => start());
  const fireConstruction = async () => { const timer = state.timers.find(x=>x.ms===250); if(timer) { state.timers=state.timers.filter(x=>x!==timer); await settle(()=>timer.fn()); } };
  const release = async () => { state.gate=false; await settle(()=>state.blocked.resolve()); await fireConstruction(); await settle(); };
  t.after(async () => { state.fail=false; state.gate=false; state.blocked.resolve(); state.trainingGate.resolve(); await settle(()=>renderer.unmount()); fs.rmSync(f.data,{recursive:true,force:true}); });
  const diskTraining = () => fs.readdirSync(f.data,{recursive:true}).filter(p=>p.endsWith('.json')).map(p=>JSON.parse(fs.readFileSync(f.data+'/'+p,'utf8'))).filter(r=>r.revisionId && r.classifier==='knn');
  return { ...f, api, state, renderer, button, back, reopen, remove, start, settle, release, fireConstruction, diskTraining, session:()=>JSON.parse(localStorage.getItem('emg-study-session')), unmount:()=>settle(()=>renderer.unmount()) };
}

for (const phase of ['barrier','construction']) {
  test(`practice Delete is handler-guarded throughout training ${phase}; strict lineage and queue recover`, async t => {
    const h = await mount(t,'practice',phase);
    const before = h.state.archive.saved.filter(x=>x.kind==='capture').map(x=>x.id).sort();
    await h.settle(()=>h.remove()); // Deliberately bypass disabled DOM, using a pre-training callback.
    await h.release();
    const trainings = h.state.archive.saved.filter(x=>x.kind==='training');
    assert.equal(h.state.archive.error,'');
    assert.equal(h.state.archive.pending.length,0);
    assert.equal(trainings.length,1);
    assert.equal(trainings[0].status,'success');
    assert.deepEqual(trainings[0].sampleIds.slice().sort(),before);
    assert.equal(h.state.archive.saved.some(x=>x.kind==='removed'),false);
    assert.equal(h.api.isModelReady(h.state.archive.scope,'button',before),true);
    const del = h.renderer.root.findAllByType('button').find(n=>n.props['aria-label']?.startsWith('Delete '));
    assert.equal(!!del.props.disabled,false,'Delete recovers after completion');
    await h.settle(()=>del.props.onClick()); await h.state.archive.barrier();
    assert.equal(h.state.archive.saved.filter(x=>x.kind==='removed').length,1);
    assert.equal(h.state.archive.pending.length,0,'later valid writes are not stranded');
  });
  test(`measured training ${phase} guards Back/reopen handlers and archives before ready revision`, async t => {
    const h = await mount(t,'measured',phase);
    await h.settle(()=>{ h.back(); h.reopen(); });
    await h.release();
    const trainings = h.state.writes.flatMap(x=>x.body.items??[]).filter(x=>x.kind==='training');
    assert.equal(trainings.length,1,'exact measured destination receives training, never setup no-op');
    assert.equal(h.session().stage,'review','conflicting mode navigation is guarded, even stale handlers');
    assert.equal(h.renderer.root.findAllByType('guidedpractice-fixture').length,0);
    assert.equal(h.session().modelRevisionId,trainings[0].record.revisionId);
    assert.equal(trainings[0].record.status,'success');
    assert.equal(h.diskTraining().filter(r=>r.revisionId===h.session().modelRevisionId).length,1,'published revision exists on strict server disk');
    assert.equal(h.api.isModelReady(h.participant.id,'button',h.session().trials.map(x=>x.id)),true);
    await h.settle(()=>h.button('Back to capture').props.onClick());
    await h.settle(()=>h.button('Reopen guided practice').props.onClick());
    assert.equal(h.renderer.root.findAllByType('guidedpractice-fixture').length,1,'navigation recovers');
  });
}

for (const mode of ['practice','measured']) {
  test(`${mode} keeps destructive/navigation controls locked until training archive is persisted`, async t => {
    const h = await mount(t,mode,'construction');
    h.state.holdTraining=true;
    await h.fireConstruction();
    if(mode==='measured') assert.equal(h.session().modelRevisionId,null,'no premature ready revision');
    assert.equal(h.button('Play').props.disabled,true);
    assert.equal(h.button('Back to capture').props.disabled,true);
    assert.equal(h.renderer.root.findAllByType('button').find(n=>n.props['aria-label']?.startsWith('Delete ')).props.disabled,true);
    assert.equal(!!h.button('Leave').props.disabled,false,'Leave remains available');
    const graph = h.button('Graph'); assert.equal(!!graph.props.disabled,false,'safe inspection remains available');
    await h.settle(()=>graph.props.onClick());
    assert.equal(h.renderer.root.findAllByType('samplegraphpanel-fixture').length,1);
    await h.settle(()=>{h.state.holdTraining=false;h.state.trainingGate.resolve();});
    if(mode==='practice') await h.state.archive.barrier();
    assert.equal(h.button('Back to capture').props.disabled,false);
    assert.equal(h.button('Play').props.disabled,false);
  });
  for (const phase of ['barrier','construction']) {
    test(`${mode} unmount during ${phase} cancels continuation, archive writes and model publication`, async t => {
      const h = await mount(t,mode,phase);
      const scope=mode==='practice'?h.state.archive.scope:h.participant.id;
      const ids=mode==='practice'?h.state.archive.saved.filter(r=>r.kind==='capture').map(r=>r.id):h.session().trials.map(r=>r.id);
      await h.unmount();
      await h.release();
      assert.equal(h.state.writes.filter(x=>x.body.record?.kind==='training'||x.body.items?.some(i=>i.kind==='training')).length,0,'no async post-unmount training write');
      assert.equal(h.api.isModelReady(scope,'button',ids),false,'canceled construction cannot leak a ready engine');
      assert.equal(h.session().modelRevisionId,null);
    });
  }
}

for (const phase of ['barrier','construction']) {
  test(`practice ${phase} save failure releases guards; immutable queue retries without poisoning`, async t => {
    const h = await mount(t,'practice',phase);
    h.state.fail=phase==='barrier'?'reviewed':'training';
    await h.release();
    assert.equal(h.button('Back to capture').props.disabled,false,'finally releases navigation');
    assert.equal(h.renderer.root.findAllByType('button').find(n=>n.props['aria-label']?.startsWith('Delete ')).props.disabled,false);
    assert.equal(h.button('Play').props.disabled,true,'save failure cannot publish a playable model');
    assert.equal(h.state.archive.error,'synthetic save failure');
    const head=structuredClone(h.state.archive.pending[0]);
    h.state.fail=false;
    await h.settle(()=>h.state.archive.barrier());
    const saved=h.state.archive.saved.find(r=>r.id===head.id);
    assert.deepEqual(Object.fromEntries(Object.keys(head).map(k=>[k,saved[k]])),head,'every failed immutable field retained exactly (server may append diagnostics)');
    assert.ok(h.state.writes.filter(x=>x.body.record?.id===head.id).every(x=>JSON.stringify(x.body.record)===JSON.stringify(head)),'Retry sends byte-equivalent immutable records');
    await h.settle(()=>h.button('Train model').props.onClick());
    await h.fireConstruction();
    assert.equal(h.state.archive.pending.length,0);
    assert.equal(h.state.archive.error,'');
    assert.equal(h.button('Play').props.disabled,false,'training can be retried');
  });
}
