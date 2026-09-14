import test from 'node:test';
import assert from 'node:assert/strict';
import { RecorderMachine, type RecorderConfig } from '../src/app/recorder/recorderMachine';
import { advancePeriod, appendEvent, recordStudyEvent, createStudy, updateDataset, studyEventsCsv, studyStartIssue, type StudyConfig, type Sequence } from '../src/app/study/studySession';
import { neutralCaptureDue } from '../src/app/study/neutralTesting';
import { buildTrainingSession } from '../src/app/pipeline/mockTrainingData';
import { evaluateKnnModel } from '../src/app/pipeline/evaluateKnnModel';
import { createPredictionEngine } from '../src/app/pipeline/knnModel';
import { buildInferenceSample } from '../src/app/pipeline/buildInferenceSample';
import { calculateResultStats } from '../src/app/pipeline/resultStatsCalculator';
import { createPredictionRecord, calculateOverallConfidence } from '../src/app/pipeline/knnModel';
import type { TestingSessionData } from '../src/app/pipeline/types';
import { mockGestureSignal, cueMockTrial } from '../src/app/study/mockGestureSignal';
import { extractEmgFeatures, getFeatureSetKeys } from '../src/app/pipeline/featureExtraction';

test('Mock trial cues reset each trial including repeated gestures, never on rest or every tick', () => {
  const cued = new Set<number>();
  const emissions: string[] = [];
  const emit = (id: string) => emissions.push(id);
  const trial = { phase: 'trial' as const, trialIndex: 0, gestureId: 'p', startMs: 0, endMs: 3000 };
  cueMockTrial(undefined, cued, emit);
  cueMockTrial(trial, cued, emit);
  cueMockTrial(trial, cued, emit);
  cueMockTrial({ ...trial, phase: 'rest' }, cued, emit);
  cueMockTrial({ ...trial, trialIndex: 1 }, cued, emit);
  cueMockTrial({ ...trial, trialIndex: 2, gestureId: 's' }, cued, emit);
  assert.deepEqual(emissions, ['p', 'p', 's']);
  cued.clear();
  cueMockTrial(trial, cued, emit);
  assert.deepEqual(emissions, ['p', 'p', 's', 'p']);
});

test('Mock timing: both trigger models recognize delayed neutral captures through the real kNN', () => {
 for (const duration of [1200, 1500]) {
  const capture = (index: number, source: 'signal' | 'button' | 'scheduled', offset: number) => {
    const r = new RecorderMachine({ ...config, durationMs: duration, triggerMode: source === 'signal' ? 'signal' : 'manual' });
    r.enable(true, -Infinity, 'test', -50);
    r.feed([{ time: -50, raw: 0.08, normalizedActivity: 0.08 }]);
    for (let time = 0; time <= 7000; time += 50) {
      if (source !== 'signal' && time === offset) r.trigger(source, time);
      const raw = mockGestureSignal(index, time, duration);
      r.feed([{ time, raw, normalizedActivity: raw }]);
      if (r.completed.length) return r.completed[0];
    }
    throw new Error('Capture did not finish');
  };
  for (const source of ['button', 'signal'] as const) {
   for (const featureSetId of ['extended', 'educational'] as const) {
    const gestures = studyConfig.gestures;
    const trainingData = buildTrainingSession({ ...validSetup, segmentDurationMs: duration, featureSetId, gestureSamples: Object.fromEntries(gestures.map((g, index) => [g.id,
      [0, 1].map(id => ({ id, status: 'collected' as const, durationMs: duration,
        waveformData: capture(index, source, source === 'button' ? 250 + id * 50 : 0).points }))])) });
    const engine = createPredictionEngine(trainingData);
    const keys = getFeatureSetKeys(featureSetId);
    const features = trainingData.gestureData.flatMap(g => g.samples.map(s => s.features!));
    const std = keys.map(key => {
      const mean = features.reduce((sum, f) => sum + f[key], 0) / features.length;
      return Math.max(1e-6, Math.sqrt(features.reduce((sum, f) => sum + (f[key] - mean) ** 2, 0) / features.length));
    });
    for (const [index, gesture] of gestures.entries()) {
     for (const delay of [250, 300, 400, 650]) {
      const segment = capture(index, 'scheduled', delay);
      const sample = buildInferenceSample(segment.points.map(p => ({ time: p.time, raw: p.value })), duration)!;
      const result = engine.predict(sample);
      assert.equal(segment.triggerSource, 'scheduled');
      assert.equal(segment.triggeredAt, delay);
      assert.equal(sample.data.length, duration / 50);
      assert.equal(sample.duration, duration);
      assert.ok(sample.data.every(value => value > 0.5), 'neutral window must not include a synthetic quiet tail');
      assert.equal(result.predictedGestureId, gesture.id, `${source}/${featureSetId}/${duration}/${delay}: ${JSON.stringify(result.debug)}`);
      if (process.env.MOCK_TIMING_DIAGNOSTICS) console.log(JSON.stringify({ source, gesture: gesture.name, training: trainingData.gestureData[index].samples[0].features,
        test: extractEmgFeatures(sample.data), min: Math.min(...sample.data), max: Math.max(...sample.data),
        count: sample.data.length, start: segment.triggeredAt, std, prediction: result.predictedGestureId,
        confidence: result.confidence, debug: result.debug }));
     }
    }
   }
  }
 }
});
import { blocksCaptureShortcut, createButtonStartShortcut } from '../src/app/recorder/buttonStartShortcut';

test('Results never names an unrecognized gesture as most common', () => {
  for (const [ids, expected] of [
    [['unknown', 'unknown'], 'No recognized gesture'],
    [[], 'No recognized gesture'],
    [['unknown', 'p', 's', 's'], 'Squeeze'],
  ] as [string[], string][]) {
    const session: TestingSessionData = {
      id: 'results-regression', trainingSessionId: 'training-results-regression',
      startedAt: 100, completedAt: 1000, sessionDurationSeconds: 0.9, overallConfidence: 20,
      gestures: [{ id: 'p', name: 'Pinch' }, { id: 's', name: 'Squeeze' }],
      predictions: ids.map((id, index) => ({
        id: index, index, timestamp: '00:00:01', expectedGestureId: 'p', expectedGestureName: 'Pinch',
        predictedGestureId: id, predictedGestureName: id === 'p' ? 'Pinch' : id === 's' ? 'Squeeze' : 'Unknown',
        confidence: 20, confidenceStatus: 'low', matchStatus: id === 'p' ? 'match' : 'mismatch',
      })),
    };
    const original = structuredClone(session);
    const stats = calculateResultStats(session);
    assert.equal(stats.mostPredictedGesture, expected);
    assert.equal(stats.totalPredictions, ids.length);
    assert.deepEqual(stats.lastTenPredictions, [...session.predictions].reverse());
    assert.deepEqual(session, original);
  }
});

const config: RecorderConfig = { durationMs: 400, threshold: 0.6, triggerMode: 'signal', preTriggerMs: 0,
  cooldownMs: 350, hysteresisRatio: 0.7, minPoints: 6, maxGapMs: 250 };
const point = (time: number, activity = 0.1, sequence = time) => ({ time, raw: Math.sin(time) * 0.00002, normalizedActivity: activity, sequence });
const waveform = Array.from({ length: 9 }, (_, i) => point(100 + i * 50, i === 0 ? 0.9 : 0.05));
const machine = (triggerMode: 'signal' | 'manual' = 'signal') => {
  const recorder = new RecorderMachine({ ...config, triggerMode }, () => 'test');
  recorder.enable(true, -1, 'start', 0);
  recorder.feed([point(0)]);
  return recorder;
};
const studyConfig: StudyConfig = {
  gestures: [{ id: 'p', name: 'Pinch' }, { id: 's', name: 'Squeeze' }], segmentDurationMs: 400,
  threshold: 0.6, featureSetId: 'extended', sampleTarget: 2, selectedChannelIndex: 0,
  sourceMode: 'mock', displayWindowMs: 3000, sensitivity: 1, activityReference: { baseline: 0, upper: 1 },
  testingSettings: { trialPeriodMs: 1500, restPeriodMs: 1000, numberOfTrials: 4, predictionFrequencyMs: 150 },
};
const training = () => buildTrainingSession({ ...studyConfig, gestureSamples: Object.fromEntries(studyConfig.gestures.map((g, k) => [g.id,
  Array.from({ length: 3 }, (_, id) => ({ id, status: 'collected' as const, timestamp: 1000 + id, durationMs: 400,
    provenance: { attemptId: `${g.id}-${id}`, triggerSource: 'button', triggeredAt: 100, durationMs: 400 },
    waveformData: Array.from({ length: 80 }, (_, i) => ({ time: i * 5, value: (k + 1) * Math.sin(i * (k + 1)) * (1 + id * 0.01) })),
  }))])) });

const spaceEvent = (repeat = false) => ({ code: 'Space', repeat, target: null,
  defaultPrevented: false, isComposing: false, altKey: false, ctrlKey: false, metaKey: false,
  preventDefault() { this.defaultPrevented = true; },
});

const idleSetup = { isStreaming: false, isRecording: false, pointCount: 0 };
const validSetup: StudyConfig = { ...studyConfig, segmentDurationMs: 1200,
  testingSettings: { ...studyConfig.testingSettings, trialPeriodMs: 3000 } };

test('Study setup: valid idle Mock configuration enables Begin Pilot Session', () => {
  for (const sequence of ['AB', 'BA'] as const) {
    assert.equal(studyStartIssue('TEST_AB_01', sequence, validSetup, idleSetup), null);
    const session = createStudy('TEST_AB_01', sequence, validSetup);
    assert.equal(session.participantId, 'TEST_AB_01');
    assert.equal(session.periods[0].condition, sequence[0]);
    assert.equal(session.periods[0].dataset, null);
  }
});

test('Study setup: missing or invalid participant code disables start with a field reason', () => {
  for (const participant of ['', ' ', 'bad code', 'x'.repeat(33)]) {
    assert.match(studyStartIssue(participant, 'AB', validSetup, idleSetup)!, /Participant code/);
    assert.throws(() => createStudy(participant, 'AB', validSetup), /Participant code/);
  }
});

test('Study setup: missing or invalid sequence disables start and session creation', () => {
  for (const sequence of ['', 'AA', 'BB', 'ab', undefined] as string[]) {
    assert.match(studyStartIssue('TEST_AB_01', sequence, validSetup, idleSetup)!, /Order/);
    assert.throws(() => createStudy('TEST_AB_01', sequence as Sequence, validSetup), /Order/);
  }
});

test('Study setup: genuinely invalid settings stay disabled and cannot bypass validation', () => {
  const cases: [Partial<StudyConfig>, RegExp][] = [
    [{ gestures: validSetup.gestures.slice(0, 1) }, /Gesture Classes/],
    [{ gestures: [validSetup.gestures[0], validSetup.gestures[0]] }, /Gesture Classes/],
    [{ sampleTarget: 1 }, /Target Samples/],
    [{ sampleTarget: 2.5 }, /Target Samples/],
    [{ sampleTarget: NaN }, /Target Samples/],
    [{ segmentDurationMs: 0 }, /Segment Duration/],
    [{ segmentDurationMs: NaN }, /Segment Duration/],
    [{ threshold: Infinity }, /Threshold/],
    [{ threshold: 0.1 }, /Threshold/],
    [{ threshold: 1 }, /Threshold/],
    [{ sourceMode: 'invalid' as StudyConfig['sourceMode'] }, /Signal Source/],
    [{ selectedChannelIndex: 4 }, /Ganglion Channel/],
    [{ testingSettings: { ...validSetup.testingSettings, numberOfTrials: 0 } }, /Testing settings/],
    [{ testingSettings: { ...validSetup.testingSettings, trialPeriodMs: 1500 } }, /750 ms/],
  ];
  for (const [changes, message] of cases) {
    const config = { ...validSetup, ...changes };
    assert.match(studyStartIssue('TEST_AB_01', 'AB', config, idleSetup)!, message);
    assert.throws(() => createStudy('TEST_AB_01', 'AB', config), message);
  }
});

test('Study setup: active capture and Live preparation requirements remain enforced', () => {
  assert.match(studyStartIssue('TEST_AB_01', 'AB', validSetup, { ...idleSetup, isRecording: true })!, /Recording/);
  const live = { ...validSetup, sourceMode: 'live' as const };
  assert.match(studyStartIssue('TEST_AB_01', 'AB', live, idleSetup)!, /Start Stream/);
  assert.match(studyStartIssue('TEST_AB_01', 'AB', live, { ...idleSetup, isStreaming: true, pointCount: 6 })!, /7 decoded samples/);
  assert.equal(studyStartIssue('TEST_AB_01', 'AB', live, { ...idleSetup, isStreaming: true, pointCount: 7 }), null);
});

test('Pilot mock profiles are distinct, bounded, repeatable and include relaxation periods', () => {
  const duration = 1200;
  const profiles = [0, 1, 2, 3].map(index => Array.from({ length: 68 }, (_, i) => mockGestureSignal(index, i * 50, duration)));
  profiles.forEach((values, index) => {
    assert.deepEqual(values, values.map((_, i) => mockGestureSignal(index, i * 50 + 3400, duration)));
    assert.ok(values.every(value => value >= 0 && value <= 1));
    assert.ok(values.slice(0, 24).some(value => value > 0.6));
    assert.ok(values.slice(44).every(value => value < 0.2));
    for (let other = index + 1; other < profiles.length; other++) {
      const difference = values.reduce((sum, value, i) => sum + Math.abs(value - profiles[other][i]), 0) / values.length;
      assert.ok(difference > 0.01, `profiles ${index} and ${other} must differ`);
    }
  });
});

test('Spacebar and visible button callback produce the same raw fixed-duration capture', () => {
  const button = machine('manual'), keyboard = machine('manual');
  const trigger = (recorder: RecorderMachine) => recorder.trigger('button', 100);
  const shortcut = createButtonStartShortcut({ isAllowed: () => true, isBlocked: () => false, trigger: () => trigger(keyboard) });
  trigger(button);
  const event = spaceEvent(); shortcut.keydown(event);
  button.feed(waveform); keyboard.feed(waveform);
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(keyboard.completed, button.completed);
  assert.equal(keyboard.events.filter(event => event.type === 'capture_triggered').length, 1);
  assert.equal(keyboard.completed[0].triggerSource, 'button');
});

test('Each pilot mock profile drives the unchanged Signal Start recorder through one full capture', () => {
  for (const index of [0, 1, 2]) {
    const r = new RecorderMachine({ ...config, durationMs: 1200 });
    r.enable(true, -1, 'start', 0);
    r.feed(Array.from({ length: 93 }, (_, i) => {
      const time = i * 50;
      const value = mockGestureSignal(index, time, 1200);
      return { time, sequence: i, raw: value, normalizedActivity: value };
    }));
    assert.equal(r.completed.length, 1);
    assert.equal(r.completed[0].durationMs, 1200);
    assert.equal(r.completed[0].triggerSource, 'signal');
    assert.equal(r.completed[0].points.length, 24);
    assert.equal(r.state, 'cooldown');
  }
});

test('Spacebar cannot trigger outside allowed Button Start state or through editing/modal focus', () => {
  let count = 0;
  let allowed = false;
  let blocked = false;
  const shortcut = createButtonStartShortcut({ isAllowed: () => allowed, isBlocked: () => blocked, trigger: () => count++ });
  for (const state of ['Signal Start', 'stopped', 'Testing', 'full dataset', 'recording', 'cooldown']) {
    shortcut.keydown(spaceEvent()); shortcut.keyup({ code: 'Space' });
    assert.equal(count, 0, state);
  }
  allowed = true; blocked = true;
  shortcut.keydown(spaceEvent()); shortcut.keyup({ code: 'Space' });
  assert.equal(count, 0);
  assert.equal(blocksCaptureShortcut(null, true), true);
  assert.equal(blocksCaptureShortcut(null, false), false);
  const editingTarget = { closest: (selector: string) => {
    for (const tag of ['input', 'textarea', 'select', 'contenteditable', 'dialog']) assert.ok(selector.includes(tag));
    return {};
  } } as unknown as EventTarget;
  assert.equal(blocksCaptureShortcut(editingTarget, false), true);
  blocked = false;
  shortcut.keydown({ ...spaceEvent(), isComposing: true }); shortcut.keyup({ code: 'Space' });
  shortcut.keydown({ ...spaceEvent(), ctrlKey: true }); shortcut.keyup({ code: 'Space' });
  assert.equal(count, 0);
  shortcut.keydown(spaceEvent());
  assert.equal(count, 1);
});

test('Held Spacebar never retriggers, including after a recorder becomes ready again', () => {
  let count = 0;
  const shortcut = createButtonStartShortcut({ isAllowed: () => true, isBlocked: () => false, trigger: () => count++ });
  shortcut.keydown(spaceEvent());
  for (let i = 0; i < 100; i++) shortcut.keydown(spaceEvent(true));
  shortcut.keydown(spaceEvent(false));
  assert.equal(count, 1);
  shortcut.keyup({ code: 'Space' }); shortcut.keydown(spaceEvent());
  assert.equal(count, 2);
  shortcut.blur(); shortcut.keydown(spaceEvent(true));
  assert.equal(count, 2);
});

test('Repeated manual captures retain earlier samples, provenance and valid period state', () => {
  const r = machine('manual');
  let session = createStudy('REPEATED', 'AB', studyConfig);
  const dataset = training(); dataset.gestureData.forEach(g => { g.samples = []; });
  for (let i = 0; i < 8; i++) {
    const offset = i * 1000;
    assert.equal(r.trigger('button', offset + 100), true);
    r.feed(waveform.map(p => ({ ...p, time: p.time + offset, sequence: p.sequence + offset })));
    const segment = r.completed.shift()!;
    assert.equal(segment.durationMs, config.durationMs);
    const sample = buildInferenceSample(segment.points.map(p => ({ time: p.time, raw: p.value })), segment.durationMs)!;
    sample.gestureId = 'p'; sample.gestureName = 'Pinch';
    sample.provenance = { attemptId: segment.id, triggerSource: segment.triggerSource, triggeredAt: segment.triggeredAt, durationMs: segment.durationMs };
    dataset.gestureData[0].samples.push(sample);
    session = updateDataset(session, dataset);
    assert.equal(session.periods[0].dataset!.gestureData[0].samples.length, i + 1);
    assert.equal(session.periods[0].datasetVersion, i + 1);
    assert.equal(session.periods[1].dataset, null);
    r.feed(Array.from({ length: 10 }, (_, j) => point(offset + 550 + j * 50)));
    assert.equal(r.state, 'idle');
  }
  assert.equal(new Set(dataset.gestureData[0].samples.map(s => s.provenance!.attemptId)).size, 8);
  assert.equal(session.events.filter(event => event.type === 'sample_accepted').length, 8);
});

test('Button and Signal use identical fixed windows and preserve raw samples after a brief crossing', () => {
  const a = machine('manual'), b = machine();
  assert.equal(a.trigger('button', 100), true);
  a.feed(waveform); b.feed(waveform);
  assert.deepEqual(a.completed[0].points, b.completed[0].points);
  assert.equal(a.completed[0].durationMs, b.completed[0].durationMs);
  assert.equal(a.completed[0].completedAt - a.completed[0].triggeredAt, 400);
  assert.equal(a.completed[0].preTriggerPointCount, 0);
  assert.deepEqual(a.completed[0].points.map(p => p.value), waveform.slice(0, 8).map(p => p.raw));
});
test('Stopped capture cannot consume retained points or accept manual triggers', () => {
  const r = machine('manual'); r.enable(false, 500, 'stop', 500); r.feed(waveform);
  assert.equal(r.trigger('button', 600), false); assert.equal(r.completed.length, 0);
});
test('Manual capture stays disabled until a fresh point has arrived', () => {
  const r = new RecorderMachine({ ...config, triggerMode: 'manual' });
  r.enable(true, -1, 'start', 0);
  assert.equal(r.canTrigger('button', 0), false);
  r.feed([point(50)]);
  assert.equal(r.canTrigger('button', 50), true);
  assert.equal(r.canTrigger('button', 301), false);
});
test('Reset discards old buffers and logs an interrupted attempt exactly once', () => {
  const r = machine(); r.feed(waveform.slice(0, 3)); r.enable(false, 200, 'disconnect', 210);
  r.enable(true, 500, 'restart', 510); r.feed(waveform);
  assert.equal(r.completed.length, 0);
  assert.equal(r.events.filter(e => e.type === 'capture_failed').length, 1);
  assert.equal(r.events.find(e => e.type === 'capture_failed')?.reason, 'disconnect');
});
test('Sustained contraction only saves once; hysteresis and cooldown rearm Signal Start', () => {
  const r = machine(); r.feed(Array.from({ length: 25 }, (_, i) => point(100 + i * 50, 0.9)));
  assert.equal(r.completed.length, 1); r.completed.shift();
  r.feed([point(1400, 0.9)]); assert.equal(r.state, 'cooldown');
  r.feed([point(1450, 0.1), point(1500, 0.9)]); assert.equal(r.state, 'recording');
});
test('Manual cooldown does not depend on crossing a threshold', () => {
  const r = machine('manual'); r.trigger('button', 100); r.feed(waveform);
  r.completed.shift(); r.feed([point(700, 0.9), point(900, 0.9)]);
  assert.equal(r.trigger('button', 910), true);
});
test('Silent stall and mid-capture gap fail rather than save partial samples', () => {
  const r = machine(); r.feed(waveform.slice(0, 3)); r.checkStall(451);
  assert.equal(r.completed.length, 0); assert.equal(r.events.at(-1)?.reason, 'signal_stalled');
  const g = machine(); g.feed(waveform.slice(0, 2)); g.feed([point(500)]);
  assert.equal(g.completed.length, 0); assert.equal(g.events.at(-1)?.reason, 'signal_gap');
});
test('Batched samples with equal timestamps are retained once using sequence IDs', () => {
  const r = machine('manual'); r.trigger('button', 100);
  const points = [...Array.from({ length: 4 }, (_, i) => point(100, 0.1, i + 1)),
    ...Array.from({ length: 8 }, (_, i) => point(150 + i * 50, 0.1, i + 5))];
  r.feed(points); r.feed(points);
  assert.equal(r.completed.length, 1); assert.equal(r.completed[0].points.length, 11);
});
test('AB and BA start correctly and archive datasets without leakage into period 2', () => {
  for (const sequence of ['AB', 'BA'] as const) {
    const initial = createStudy('DRY_RUN', sequence, studyConfig);
    const collected = updateDataset(initial, training());
    const advanced = advancePeriod(collected);
    assert.equal(advanced.periods[0].condition, sequence[0]);
    assert.equal(advanced.periods[1].condition, sequence[1]);
    assert.equal(advanced.periods[1].dataset, null);
    assert.equal(advanced.periods[1].datasetVersion, 0);
    assert.equal(advanced.periods[1].modelDatasetVersion, null);
    assert.deepEqual(advanced.periods[1].testing, []);
    assert.equal(advanced.periods[0].dataset?.gestureData[0].samples.length, 3);
    assert.deepEqual(advanced.config, initial.config);
    assert.equal(initial.periods[0].dataset, null);
  }
});
test('Required sample provenance, append-only deletions and dataset versions survive exports', () => {
  let s = createStudy('P001', 'AB', studyConfig);
  s = appendEvent(s, 'capture_triggered', { attemptId: 'p-0', triggerSource: 'button' }, 100);
  const data = training(); s = updateDataset(s, data);
  assert.equal(s.periods[0].datasetVersion, 1);
  const oldEvents = s.events;
  const deleted = structuredClone(data); deleted.gestureData[0].samples.shift();
  s = updateDataset(s, deleted);
  assert.deepEqual(s.events.slice(0, oldEvents.length), oldEvents);
  assert.equal(s.periods[0].datasetVersion, 2);
  assert.equal(s.events.filter(e => e.type === 'sample_deleted').length, 1);
  const accepted = s.events.find(e => e.type === 'sample_accepted')!;
  assert.equal((accepted.detail.sample as any).provenance.attemptId, 'p-0');
  assert.equal(JSON.parse(JSON.stringify(s)).events.length, s.events.length);
  assert.match(studyEventsCsv(s), /participantId,sequence,period,condition,datasetVersion/);
  assert.equal(updateDataset(s, deleted), s);
});
test('Late cleanup events are attributed to their original period', () => {
  let s = advancePeriod(createStudy('P001', 'AB', studyConfig));
  s = appendEvent(s, 'capture_failed', { reason: 'period_ended' }, 100, 1);
  assert.equal(s.events.at(-1)?.period, 1); assert.equal(s.events.at(-1)?.condition, 'A');
});
test('Same leave-one-out evaluation and model ignore trigger provenance', () => {
  const a = training(); const b = structuredClone(a);
  b.gestureData.forEach(g => g.samples.forEach(s => { s.provenance!.triggerSource = 'signal'; }));
  assert.deepEqual(evaluateKnnModel(a), evaluateKnnModel(b));
  const sample = buildInferenceSample(waveform.map(p => ({ time: p.time, raw: p.raw })), 400)!;
  assert.deepEqual(createPredictionEngine(a).predict(sample), createPredictionEngine(b).predict(sample));
  assert.equal(sample.gestureId, 'inference');
});
test('Neutral Testing schedules the same capture without signal or condition input', () => {
  const trial = { phase: 'trial' as const, trialIndex: 0, gestureId: 'p', startMs: 0, endMs: 1500, durationMs: 1500 };
  assert.equal(neutralCaptureDue(trial, 200, 400), false);
  assert.equal(neutralCaptureDue(trial, 300, 400), true);
  assert.equal(neutralCaptureDue(trial, 1000, 400), false);
  assert.equal(neutralCaptureDue({ ...trial, phase: 'rest' }, 300, 400), false);
});

test('Model and Testing archives stay in their originating period; recollection invalidates the model', () => {
  const data = training();
  let study = updateDataset(createStudy('P001', 'BA', studyConfig), data);
  study = recordStudyEvent(study, 'model_built', { trainingSessionId: data.id });
  assert.equal(study.periods[0].modelDatasetVersion, 1);
  const engine = createPredictionEngine(data);
  const predictions = data.gestureData.map((g, i) => createPredictionRecord(engine.predict(g.samples[0]), g.gesture, i + 1, i));
  const testing = { id: 'test-1', startedAt: 100, completedAt: 1000, trainingSessionId: data.id,
    gestures: data.gestures, predictions, overallConfidence: calculateOverallConfidence(predictions), sessionDurationSeconds: 0.9 };
  const advanced = advancePeriod(study);
  const late = recordStudyEvent(advanced, 'testing_completed', { session: testing }, 1000, 1);
  assert.equal(late.periods[0].testing.length, 1);
  assert.equal(late.periods[1].testing.length, 0);
  assert.equal(late.periods[1].dataset, null);
  assert.equal(late.periods[1].modelDatasetVersion, null);
  assert.equal(calculateResultStats(late.periods[0].testing[0]).totalPredictions, predictions.length);
  const completed = advancePeriod(late);
  assert.equal(completed.status, 'complete');
  assert.equal(completed.events.at(-1)?.type, 'session_completed');
  assert.equal(completed.events.filter(e => e.type === 'period_completed').length, 2);
  const deleted = structuredClone(data); deleted.gestureData[0].samples.pop();
  study = updateDataset(study, deleted);
  assert.equal(study.periods[0].modelDatasetVersion, null);
  assert.equal(study.periods[0].datasetVersion, 2);
});

test('Serialized complete AB/BA archives preserve required event history and period provenance', () => {
  for (const sequence of ['AB', 'BA'] as const) {
    let study = createStudy('EXPORT_CHECK', sequence, studyConfig);
    for (const period of [1, 2] as const) {
      const source = sequence[period - 1] === 'A' ? 'button' : 'signal';
      const data = training();
      data.id = `training-${period}`;
      for (const gesture of data.gestureData) for (const sample of gesture.samples) {
        sample.id = `${period}-${sample.id}`;
        sample.provenance!.attemptId = `${period}-${sample.provenance!.attemptId}`;
        sample.provenance!.triggerSource = source;
        const detail = { ...sample.provenance, gestureId: gesture.gesture.id };
        study = recordStudyEvent(study, 'capture_triggered', detail, 100);
        study = recordStudyEvent(study, 'capture_completed', { ...detail, rawPointCount: sample.data.length }, 500);
      }
      study = recordStudyEvent(study, 'capture_failed', { attemptId: `${period}-failed`, triggerSource: source, reason: 'signal_stalled' });
      study = recordStudyEvent(study, 'signal_status', { isStreaming: false, liveConnectionStatus: 'error', liveConnectionMessage: 'Signal stalled' });
      study = recordStudyEvent(study, 'signal_status', { isStreaming: true, liveConnectionStatus: 'streaming', liveConnectionMessage: 'Reconnected' });
      study = updateDataset(study, data);
      study = recordStudyEvent(study, 'neutral_evaluation', { method: 'leave-one-out', summary: evaluateKnnModel(data) });
      study = recordStudyEvent(study, 'model_built', { trainingSessionId: data.id });
      study = recordStudyEvent(study, 'testing_started', { trainingSessionId: data.id, settings: studyConfig.testingSettings });
      const engine = createPredictionEngine(data);
      const predictions = data.gestureData.map((g, i) => createPredictionRecord(engine.predict(g.samples[0]), g.gesture, i + 1, i));
      predictions.forEach((record, i) => {
        const detail = { attemptId: `${period}-test-${i}`, triggerSource: 'scheduled', trialIndex: i };
        study = recordStudyEvent(study, 'testing_capture_triggered', detail);
        study = recordStudyEvent(study, 'testing_capture_completed', detail);
        study = recordStudyEvent(study, 'testing_prediction', { ...detail, record });
      });
      study = recordStudyEvent(study, 'testing_completed', { session: {
        id: `testing-${period}`, trainingSessionId: data.id, startedAt: 100, completedAt: 1000,
        gestures: data.gestures, predictions, overallConfidence: calculateOverallConfidence(predictions), sessionDurationSeconds: 0.9,
      } });
      study = advancePeriod(study);
      if (period === 1) {
        assert.equal(study.periods[1].dataset, null);
        assert.equal(study.periods[1].modelDatasetVersion, null);
        study = recordStudyEvent(study, 'capture_failed', { attemptId: 'late-period-one', reason: 'period_ended' }, 2000, 1);
      }
    }
    study = recordStudyEvent(study, 'study_exported', { format: 'json' });
    const payload = JSON.parse(JSON.stringify(study, null, 2));
    assert.equal(payload.status, 'complete');
    assert.equal(payload.participantId, 'EXPORT_CHECK');
    assert.equal(payload.sequence, sequence);
    assert.deepEqual(payload.events.map((e: any) => e.index), payload.events.map((_: any, i: number) => i + 1));
    for (const event of payload.events) {
      assert.equal(event.sessionId, payload.id);
      assert.equal(event.participantId, payload.participantId);
      assert.equal(event.condition, sequence[event.period - 1]);
      assert.equal(typeof event.time, 'number');
      assert.equal(typeof event.datasetVersion, 'number');
    }
    for (const type of ['session_started', 'period_started', 'capture_triggered', 'capture_completed', 'capture_failed',
      'sample_accepted', 'dataset_changed', 'signal_status', 'neutral_evaluation', 'model_built', 'testing_started',
      'testing_capture_triggered', 'testing_capture_completed', 'testing_prediction', 'testing_completed', 'period_completed', 'session_completed', 'study_exported']) {
      assert.ok(payload.events.some((e: any) => e.type === type), type);
      assert.ok(studyEventsCsv(study).includes(`"${type}"`), type);
    }
    assert.equal(payload.events.find((e: any) => e.detail.attemptId === 'late-period-one').period, 1);
    assert.ok(payload.events.some((e: any) => e.type === 'signal_status' && e.detail.liveConnectionStatus === 'error'));
    assert.ok(payload.events.some((e: any) => e.type === 'signal_status' && e.detail.liveConnectionMessage === 'Reconnected'));
    for (const [i, period] of payload.periods.entries()) {
      assert.equal(period.testing[0].trainingSessionId, period.dataset.id);
      assert.ok(period.dataset.gestureData.every((g: any) => g.samples.every((s: any) => s.id.startsWith(`${i + 1}-`))));
      assert.ok(period.dataset.gestureData.every((g: any) => g.samples.every((s: any) =>
        payload.events.some((e: any) => e.type === 'capture_triggered' && e.detail.attemptId === s.provenance.attemptId && e.period === i + 1))));
    }
  }
});
