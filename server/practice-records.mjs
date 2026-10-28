import { restCalibration, sameCalibration } from '../src/app/study/frozenCalibration.mjs';
import { PRACTICE_REST_MS, validatePracticePoints, withPracticeTiming } from '../src/app/study/practice.mjs';

const token = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const reject = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };

export function sanitizePracticeRecord(input, participant, records = []) {
  if (!input || !token(input.id) || !token(input.attemptId) || !token(input.sessionId)) reject('Invalid practice identity.');
  if (input.participantId !== participant.id || input.experimentId !== participant.experiment_id
    || input.condition !== participant.condition || input.generation !== (Number(participant.generation) || 1)
    || input.round !== Number(participant.current_round) || participant.status !== 'in_progress') reject('Practice belongs to an inactive session or round.', 409);
  if (!['mock', 'live'].includes(input.signalSource) || !Number.isInteger(input.channelIndex) || input.channelIndex < 0 || input.channelIndex > 3 || !finite(input.createdAt)) reject('Invalid practice source.');
  const settings = input.settings;
  if (!settings || !finite(settings.segmentDurationMs) || settings.segmentDurationMs < 200 || settings.segmentDurationMs > 5000
    || !finite(settings.preTriggerWindowMs) || settings.preTriggerWindowMs < 0 || settings.preTriggerWindowMs > 2000
    || !finite(settings.countdownMs) || settings.countdownMs < 0 || settings.countdownMs > 10000
    || !finite(settings.activityThreshold) || settings.activityThreshold < 0.05 || settings.activityThreshold > 1) reject('Invalid practice settings.');
  const output = {
    id: input.id, attemptId: input.attemptId, kind: input.kind, participantId: participant.id,
    experimentId: participant.experiment_id, sessionId: input.sessionId, generation: input.generation,
    condition: input.condition, round: input.round, signalSource: input.signalSource, channelIndex: input.channelIndex,
    createdAt: input.createdAt, settings: { segmentDurationMs: settings.segmentDurationMs, preTriggerWindowMs: settings.preTriggerWindowMs, countdownMs: settings.countdownMs, activityThreshold: settings.activityThreshold }, archivalOnly: true,
    points: [],
  };
  if (input.flowVersion !== undefined && input.flowVersion !== 2) reject('Unsupported practice flow version.');
  if (input.flowVersion === 2) output.flowVersion = 2;
  const related = records.filter(record => record.attemptId === input.attemptId && record.sessionId === input.sessionId
    && record.participantId === input.participantId && record.generation === input.generation && record.round === input.round
    && record.condition === input.condition && record.flowVersion === input.flowVersion
    && (input.flowVersion === 2 || (record.signalSource === input.signalSource && record.channelIndex === input.channelIndex
      && canonicalPractice(record.settings) === canonicalPractice(output.settings))));
  if (input.kind === 'rest') {
    if (!validatePracticePoints(input.points, PRACTICE_REST_MS)) reject('Practice rest needs a complete, continuous finite signal window.');
    if (input.calibration !== undefined) {
      let expected;
      try { expected = restCalibration(input); } catch (error) { reject(error.message); }
      if (!sameCalibration(input.calibration, expected)) reject('Invalid rest calibration.');
      output.calibration = expected;
    }
  } else if (input.kind === 'capture') {
    const rest = related.find(record => record.id === input.restId && record.kind === 'rest');
    if (!rest || rest.attemptId !== input.attemptId || rest.generation !== input.generation || rest.round !== input.round
      || rest.condition !== input.condition || (!input.calibration && (rest.signalSource !== input.signalSource || rest.channelIndex !== input.channelIndex
        || canonicalPractice(rest.settings) !== canonicalPractice(settings)))) reject('Practice capture needs this attempt’s saved resting reference.');
    const cuedRest = input.flowVersion === 2 && input.gestureId === 'relax';
    if (input.flowVersion === 2 && input.captureProcedure !== (cuedRest ? 'cued_rest' : input.condition)) reject('Incorrect capture procedure.');
    if (!['pinch', 'squeeze', 'relax'].includes(input.gestureId) || input.triggerMode !== (cuedRest ? 'button' : input.condition)
      || !finite(input.triggeredAt) || !finite(input.completedAt) || input.completedAt - input.triggeredAt < settings.segmentDurationMs
      || !Number.isInteger(input.preTriggerPointCount) || input.preTriggerPointCount < 0
      || !validatePracticePoints(input.points, settings.segmentDurationMs)
      || input.preTriggerPointCount >= input.points.length || input.points[input.preTriggerPointCount].time !== input.triggeredAt
      || input.points.at(-1).time !== input.completedAt) reject('Practice capture needs a complete recorder window and matching trigger metadata.');
    Object.assign(output, { restId: input.restId, gestureId: input.gestureId,
      gestureName: { pinch: 'Pinch', squeeze: 'Squeeze', relax: 'Relax' }[input.gestureId],
      triggerMode: input.triggerMode, triggeredAt: input.triggeredAt, completedAt: input.completedAt, preTriggerPointCount: input.preTriggerPointCount,
      ...(input.flowVersion === 2 ? { captureProcedure: input.captureProcedure } : {}) });
  } else if (input.flowVersion === 2 && ['training', 'game', 'reviewed', 'event'].includes(input.kind)) {
    if (!Array.isArray(input.points) || input.points.length) reject('Practice metadata must not contain waveforms.');
    const retained = retainedCaptures(related);
    if (input.kind === 'reviewed') {
      if (!retained.some(record => record.id === input.referenceId)) reject('Review needs a retained sample.');
      output.referenceId = input.referenceId;
    } else if (input.kind === 'event') {
      if (!['capture_started', 'capture_completed', 'capture_cancelled', 'capture_error', 'sample_replaced'].includes(input.type)) reject('Invalid practice event.');
      Object.assign(output, { type: input.type, sampleId: token(input.sampleId) ? input.sampleId : null,
        replacementSampleId: token(input.replacementSampleId) ? input.replacementSampleId : null,
        detail: typeof input.detail === 'string' ? input.detail.slice(0, 1000) : '' });
    } else {
      if (!sameIds(input.sampleIds, retained.map(record => record.id)) || retained.length !== 3
        || !['pinch', 'squeeze', 'relax'].every(id => retained.some(record => record.gestureId === id))) reject('Training/game needs all retained practice samples.');
      output.sampleIds = [...input.sampleIds];
      if (input.kind === 'training') {
        if (!['success', 'failure'].includes(input.status) || input.classifier !== 'knn'
          || !finite(input.startedAt) || !finite(input.finishedAt) || input.finishedAt < input.startedAt) reject('Invalid practice training.');
        Object.assign(output, { status: input.status, classifier: 'knn', startedAt: input.startedAt, finishedAt: input.finishedAt,
          error: typeof input.error === 'string' ? input.error.slice(0, 1000) : '' });
      } else {
        const training = related.find(record => record.id === input.trainingId && record.kind === 'training' && record.status === 'success');
        if (!training || !sameIds(training.sampleIds, input.sampleIds) || !finite(input.gameScore) || input.gameScore < 0
          || typeof input.difficulty !== 'string' || !Array.isArray(input.outcomes) || input.outcomes.length > 1000
          || !input.outcomes.every(validOutcome) || new Set(input.outcomes.map(item => item.attemptId)).size !== input.outcomes.length) reject('Invalid practice game lineage or outcomes.');
        Object.assign(output, { trainingId: input.trainingId, gameScore: input.gameScore, difficulty: input.difficulty.slice(0, 80),
          outcomes: input.outcomes.map(item => ({ attemptId: item.attemptId, expectedGestureId: item.expectedGestureId,
            expectedGestureName: item.expectedGestureName, result: item.result,
            predictedGestureId: item.predictedGestureId, predictedGestureName: item.predictedGestureName })),
          obstacleSuccess: typeof input.obstacleSuccess === 'boolean' ? input.obstacleSuccess : null });
      }
    }
  } else if (input.kind === 'removed') {
    if (!Array.isArray(input.points) || input.points.length || !related.some(record => record.id === input.referenceId && record.kind === 'capture')
      || related.some(record => record.kind === 'removed' && record.id !== input.id && (input.flowVersion === 2 ? record.referenceId === input.referenceId : true))) reject('Practice removal needs a saved example from this attempt.');
    output.referenceId = input.referenceId;
  } else if (input.kind === 'completed') {
    const removed = related.filter(record => record.kind === 'removed');
    const retained = related.filter(record => record.kind === 'capture' && !removed.some(item => item.referenceId === record.id));
    if (!Array.isArray(input.points) || input.points.length || !related.some(record => record.id === input.restId && record.kind === 'rest')
      || (input.flowVersion === 2 ? !removed.some(record => record.id === input.removedId) : removed.length !== 1 || removed[0].id !== input.removedId) || retained.length !== 3
      || !['pinch', 'squeeze', 'relax'].every(id => retained.filter(record => record.gestureId === id).length === 1)
      || !Array.isArray(input.sampleIds) || input.sampleIds.length !== 3 || new Set(input.sampleIds).size !== 3
      || !retained.every(record => input.sampleIds.includes(record.id)) || !input.sampleIds.includes(input.reviewedId)) reject('Complete rest, all gesture examples, and guided review/removal/replacement before beginning collection.');
    if (input.flowVersion === 2) {
      const training = related.find(record => record.id === input.trainingId && record.kind === 'training' && record.status === 'success');
      const game = related.find(record => record.id === input.gameId && record.kind === 'game');
      if (!training || !sameIds(training.sampleIds, input.sampleIds) || !game || game.trainingId !== training.id
        || !sameIds(game.sampleIds, input.sampleIds) || !game.outcomes.some(item => item.result !== 'recording_failure')
        || !related.some(record => record.kind === 'reviewed' && record.referenceId === input.reviewedId)) reject('Finish saved review, training and an actual scored game before collection.');
      Object.assign(output, { trainingId: training.id, gameId: game.id });
    }
    Object.assign(output, { restId: input.restId, sampleIds: [...input.sampleIds], reviewedId: input.reviewedId, removedId: input.removedId });
  } else reject('Invalid practice record type.');
  if (input.kind === 'rest' || input.kind === 'capture') output.points = input.points.map(point => ({ time: point.time, value: point.value, ...(point.activityEnvelope === undefined ? {} : { activityEnvelope: point.activityEnvelope }) }));
  if (input.kind === 'capture' && input.calibration !== undefined) {
    if (input.calibration !== null) {
      const reference = records.find(record => record.kind === 'rest' && record.id === input.calibration.restId);
      if (!reference || !sameCalibration(input.calibration, reference.calibration)
        || !['participantId', 'experimentId', 'sessionId', 'generation', 'round', 'condition', 'signalSource', 'channelIndex'].every(key => input[key] === reference[key])) reject('Capture calibration scope mismatch.');
    } else if (input.condition === 'threshold' && input.gestureId !== 'relax') reject('Threshold capture requires calibration.');
    output.calibration = input.calibration;
    if (input.condition === 'threshold' && input.gestureId !== 'relax' && (!finite(input.firstCrossingAt) || input.triggeredAt - input.firstCrossingAt < 100)) reject('Invalid confirmed threshold anchor.');
    output.firstCrossingAt = input.firstCrossingAt ?? null;
  }
  return withPracticeTiming(output);
}

function sameIds(left, right) {
  return Array.isArray(left) && left.length === right.length && new Set(left).size === left.length && right.every(id => left.includes(id));
}
function retainedCaptures(records) {
  return records.filter(record => record.kind === 'capture' && !records.some(item => item.kind === 'removed' && item.referenceId === record.id));
}
function validOutcome(item) {
  const gestures = ['pinch', 'squeeze', 'relax'];
  return item && typeof item.attemptId === 'string' && /^[a-zA-Z0-9_:-]{1,120}$/.test(item.attemptId) && gestures.includes(item.expectedGestureId)
    && typeof item.expectedGestureName === 'string' && item.expectedGestureName.length < 80
    && ['correct', 'wrong', 'unknown', 'recording_failure'].includes(item.result)
    && (item.predictedGestureId === null || item.predictedGestureId === 'unknown' || gestures.includes(item.predictedGestureId))
    && (item.predictedGestureName === null || (typeof item.predictedGestureName === 'string' && item.predictedGestureName.length < 80))
    && (item.result === 'correct' ? item.predictedGestureId === item.expectedGestureId
      : item.result === 'wrong' ? gestures.includes(item.predictedGestureId) && item.predictedGestureId !== item.expectedGestureId
      : item.result === 'unknown' ? item.predictedGestureId === null || item.predictedGestureId === 'unknown'
      : item.predictedGestureId === null);
}

export function canonicalPractice(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalPractice).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalPractice(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
