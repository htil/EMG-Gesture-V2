import fs from 'node:fs';
import {readFinalization,writeFinalization,commitFinalization} from './finalization-journal.mjs';
import { PILOT_PROTOCOL, PREVIOUS_PILOT_PROTOCOL, HISTORICAL_PILOT_PROTOCOL, PILOT_GESTURES, isPilot, pilotRepetitions, conditionOrder, protocolSequence } from './core-protocol.mjs';
import path from 'node:path';
import crypto from 'node:crypto';
import { validateContextRecord, persistContextRecord, readContextRecords, setContextDisposition } from './context-records.mjs';
import { zipStore } from './zip-store.mjs';
import { sanitizePracticeRecord, canonicalPractice } from './practice-records.mjs';
import { withPracticeTiming, validatePracticePoints } from '../src/app/study/practice.mjs';
import { restCalibration, sameCalibration } from '../src/app/study/frozenCalibration.mjs';

const ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const EXPERIMENT_HEADERS = ['id', 'name', 'repetitions', 'captures_per_round', 'captures_min', 'captures_max', 'obstacle_count', 'starting_lives', 'status', 'notes', 'created_at', 'protocol_version'];
const DEFAULT_OBSTACLE_COUNT = 20;
const DEFAULT_STARTING_LIVES = 3;
const PARTICIPANT_HEADERS = ['id', 'experiment_id', 'condition', 'status', 'current_round', 'created_at', 'generation', 'is_test_participant', 'protocol_version', 'condition_order', 'frozen_settings', 'official_sequence', 'group_code', 'member_code'];
const ROUND_HEADERS = ['participant_id', 'experiment_id', 'round', 'trial_count', 'saved_count', 'usable_count', 'completed_at'];
const EVENT_TYPES = new Set(['capture_started', 'capture_completed', 'capture_cancelled', 'capture_error', 'sample_deleted', 'sample_rejected', 'sample_replaced']);
const ATTEMPT_RESULTS = new Set(['correct', 'wrong', 'unknown', 'recording_failure']);

function nowIso() {
  return new Date().toISOString();
}

function randomId(length, prefix = '') {
  const bytes = crypto.randomBytes(length);
  let value = prefix;
  for (let index = 0; index < length; index += 1) {
    value += ID_ALPHABET[bytes[index] % ID_ALPHABET.length];
  }
  return value;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += character;
      }
      continue;
    }
    if (character === '"') {
      quoted = true;
    } else if (character === ',') {
      row.push(cell);
      cell = '';
    } else if (character === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (character !== '\r') {
      cell += character;
    }
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }

  return rows.filter((entry) => entry.some((value) => value.trim() !== ''));
}

function escapeCell(value) {
  const text = String(value ?? '');
  if (/[",\n\r]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

function toCsv(headers, records) {
  const lines = [headers.join(',')];
  for (const record of records) {
    lines.push(headers.map((header) => escapeCell(record[header])).join(','));
  }
  return `${lines.join('\n')}\n`;
}

function readTable(filePath, headers) {
  if (!fs.existsSync(filePath)) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${headers.join(',')}\n`);
    return [];
  }
  const rows = parseCsv(fs.readFileSync(filePath, 'utf8'));
  if (rows.length === 0) return [];
  const [headerRow, ...body] = rows;
  return body.map((row) => {
    const record = {};
    headerRow.forEach((header, index) => {
      record[header] = row[index] ?? '';
    });
    return record;
  });
}

function writeTable(filePath, headers, records) {
  const temporary = `${filePath}.tmp`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const preservedHeaders = [...new Set([...headers, ...records.flatMap(record => Object.keys(record))])];
  fs.writeFileSync(temporary, toCsv(preservedHeaders, records));
  fs.renameSync(temporary, filePath);
}

function readSettings(filePath) {
  if (!fs.existsSync(filePath)) {
    const adminPin = process.env.EMG_ADMIN_PIN?.trim();
    if (!adminPin) throw new Error('Set EMG_ADMIN_PIN locally before first startup with a fresh record directory.');
    const settings = { adminPin };
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(settings, null, 2)}\n`);
    return settings;
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function pinsMatch(provided, expected) {
  const left = Buffer.from(String(provided ?? ''));
  const right = Buffer.from(String(expected ?? ''));
  if (left.length !== right.length) {
    crypto.timingSafeEqual(right, right);
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

function integerInRange(value, minimum, maximum, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw Object.assign(new Error(`${label} must be a whole number from ${minimum} to ${maximum}.`), { status: 400 });
  }
  return parsed;
}

function normalizeId(value) {
  return String(value ?? '').trim().toUpperCase().replace(/\s+/g, '');
}

function sampleBounds(experiment) {
  const legacy = Number(experiment.captures_per_round) || 3;
  const minimum = Number(experiment.captures_min) || legacy;
  const maximum = Number(experiment.captures_max) || legacy;
  const min = Math.min(minimum, maximum);
  const max = Math.max(minimum, maximum);
  return {
    min: Number.isFinite(min) && min > 0 ? min : legacy,
    max: Number.isFinite(max) && max > 0 ? max : legacy,
  };
}

function gameLimits(experiment) {
  const obstacles = Number(experiment?.obstacle_count);
  const lives = Number(experiment?.starting_lives);
  return {
    obstacleCount: Number.isInteger(obstacles) && obstacles >= 1 && obstacles <= 200
      ? obstacles
      : DEFAULT_OBSTACLE_COUNT,
    startingLives: Number.isInteger(lives) && lives >= 1 && lives <= 10
      ? lives
      : DEFAULT_STARTING_LIVES,
  };
}

function withSampleLimits(experiment) {
  const bounds = sampleBounds(experiment);
  const game = gameLimits(experiment);
  return {
    ...experiment,
    captures_min: String(bounds.min),
    captures_max: String(bounds.max),
    captures_per_round: String(bounds.max),
    obstacle_count: String(game.obstacleCount),
    starting_lives: String(game.startingLives),
  };
}

function safeToken(value, fallback = '') {
  const text = String(value ?? '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
  return text || fallback;
}

function finiteNumber(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporary, filePath);
}

function collectionDir(sessionsDir, participantId, sessionId) {
  return path.join(sessionsDir, safeToken(participantId, 'participant'), 'collection', safeToken(sessionId, 'session'));
}

function readJsonFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function sanitizePoints(points) {
  if (!Array.isArray(points)) return [];
  return points.slice(0, 20000).map((point) => ({
    time: finiteNumber(point?.time, 0),
    value: finiteNumber(point?.value, 0),
  }));
}

function sanitizeSettings(settings) {
  const source = settings && typeof settings === 'object' ? settings : {};
  return {
    segmentDurationMs: finiteNumber(source.segmentDurationMs, null),
    preTriggerWindowMs: finiteNumber(source.preTriggerWindowMs, null),
    activityThreshold: finiteNumber(source.activityThreshold, null),
    cooldownMs: finiteNumber(source.cooldownMs, null),
    countdownMs: finiteNumber(source.countdownMs, null),
    capturesMin: finiteNumber(source.capturesMin, null),
    capturesMax: finiteNumber(source.capturesMax, null),
    featureSetId: String(source.featureSetId || ''),
    classifier: 'knn',
  };
}

function sanitizeStoredRun(run, participant) {
  if (!run || run.condition !== participant.condition || !Number.isFinite(Number(run.gameScore)) || !Array.isArray(run.outcomes)) {
    return null;
  }
  return {
    ...(isPilot(participant) ? { runKind: run.runKind, completionStatus: run.completionStatus, runId: run.runId || run.id, invalidationReason: run.invalidationReason ?? null, startedAt: run.startedAt ?? null, endedAt: run.endedAt ?? null, generation: participantGeneration(participant), signalSource: run.signalSource, streamReady: run.streamReady, evidenceKind: isTestParticipant(participant) ? 'synthetic-test' : 'measured-live', officialSequence: run.officialSequence } : {}),
    id: safeToken(run.id, randomId(8, 'RUN-')),
    sessionId: safeToken(run.sessionId, ''),
    round: Number(run.round) || Number(participant.current_round) || 1,
    recordedAt: Number(run.recordedAt) || Date.now(),
    condition: participant.condition,
    difficulty: String(run.difficulty || 'standard'),
    isTestParticipant: isTestParticipant(participant),
    gameScore: Number(run.gameScore),
    modelRevisionId: run.modelRevisionId ? safeToken(run.modelRevisionId, '') : null,
    obstacleSuccess: run.obstacleSuccess === true ? true : run.obstacleSuccess === false ? false : null,
    outcomes: run.outcomes.filter((outcome) => outcome && ATTEMPT_RESULTS.has(outcome.result)).map((outcome) => ({
      ...(outcome.trialIndex !== undefined ? { trialIndex: outcome.trialIndex, cueAt: outcome.cueAt ?? null, recordingStartedAt: outcome.recordingStartedAt ?? null, recordingEndedAt: outcome.recordingEndedAt ?? null, sampleCount: outcome.sampleCount ?? null, startedAt: outcome.startedAt ?? null, endedAt: outcome.endedAt ?? null, inferenceStartedAt: outcome.inferenceStartedAt ?? null, inferenceEndedAt: outcome.inferenceEndedAt ?? null } : {}),
      attemptId: String(outcome.attemptId || ''),
      expectedGestureId: String(outcome.expectedGestureId || ''),
      expectedGestureName: String(outcome.expectedGestureName || ''),
      result: outcome.result,
      predictedGestureId: outcome.predictedGestureId == null ? null : String(outcome.predictedGestureId),
      predictedGestureName: outcome.predictedGestureName == null ? null : String(outcome.predictedGestureName),
    })),
  };
}

function summarizeExperiment(experiment, participants) {
  const mine = participants.filter((participant) => participant.experiment_id === experiment.id);
  const bounds = sampleBounds(experiment);
  const game = gameLimits(experiment);
  return {
    id: experiment.id,
    protocolVersion: experiment.protocol_version || 'legacy-fixed-v1',
    name: experiment.name,
    repetitions: Number(experiment.repetitions),
    capturesMin: bounds.min,
    capturesMax: bounds.max,
    capturesPerRound: bounds.max,
    obstacleCount: game.obstacleCount,
    startingLives: game.startingLives,
    status: experiment.status,
    notes: experiment.notes,
    createdAt: experiment.created_at,
    participantCount: mine.length,
    buttonCount: mine.filter((participant) => participant.condition === 'button').length,
    thresholdCount: mine.filter((participant) => participant.condition === 'threshold').length,
    completedCount: mine.filter((participant) => participant.status === 'completed').length,
    inProgressCount: mine.filter((participant) => participant.status === 'in_progress').length,
  };
}

// Missing legacy assignments remain study participants; never infer from source or ID.
function isTestParticipant(participant) {
  return participant?.is_test_participant === 'true';
}

function participantGeneration(participant) {
  const value = Number(participant?.generation);
  return Number.isInteger(value) && value > 0 ? value : 1;
}

function sameGeneration(record, participant) {
  const incoming = Number(record?.generation);
  const current = participantGeneration(participant);
  if (!Number.isInteger(incoming) || incoming <= 0) return current === 1;
  return incoming === current;
}

function presentParticipant(participant, repetitions) {
  const currentRound = Number(participant.current_round) || 1;
  const roundsCompleted = participant.status === 'completed'
    ? Number(repetitions) || 0
    : Math.max(0, currentRound - 1);
  return {
    id: participant.id,
    protocolVersion: participant.protocol_version || 'legacy-fixed-v1',
    conditionOrder: isPilot(participant) ? conditionOrder(participant) : [participant.condition],
    groupCode: participant.group_code || null,
    memberCode: participant.member_code || null,
    experimentId: participant.experiment_id,
    isTestParticipant: isTestParticipant(participant),
    condition: participant.condition,
    status: participant.status,
    currentRound,
    roundsCompleted,
    createdAt: participant.created_at,
  };
}

function shuffle(list) {
  const copy = [...list];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = crypto.randomInt(index + 1);
    [copy[index], copy[swap]] = [copy[swap], copy[index]];
  }
  return copy;
}

export function createStudyDesk(dataDir, {finalizationFault = () => {}} = {}) {
  const experimentsPath = path.join(dataDir, 'experiments.csv');
  const participantsPath = path.join(dataDir, 'participants.csv');
  const roundsPath = path.join(dataDir, 'rounds.csv');
  const settingsPath = path.join(dataDir, 'settings.json');
  const sessionsDir = path.join(dataDir, 'sessions');

  const load = () => ({
    experiments: readTable(experimentsPath, EXPERIMENT_HEADERS),
    participants: readTable(participantsPath, PARTICIPANT_HEADERS),
    rounds: readTable(roundsPath, ROUND_HEADERS),
    settings: readSettings(settingsPath),
  });

  const saveExperiments = (records) => writeTable(experimentsPath, EXPERIMENT_HEADERS, records.map(withSampleLimits));
  const saveParticipants = (records) => writeTable(participantsPath, PARTICIPANT_HEADERS, records.map((participant) => ({
    ...participant,
    generation: String(participantGeneration(participant)),
    is_test_participant: String(isTestParticipant(participant)),
  })));
  const saveRounds = (records) => writeTable(roundsPath, ROUND_HEADERS, records.map((round) => ({
    ...round,
    saved_count: round.saved_count || round.trial_count || '0',
  })));
  const runsFile = (participantId) => path.join(sessionsDir, `${participantId}-runs.json`);
  const readRuns = (participantId) => {
    const filePath = runsFile(participantId);
    if (!fs.existsSync(filePath)) return [];
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  };
  const writeRuns = (participantId, runs) => {
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(runsFile(participantId), `${JSON.stringify(runs, null, 2)}\n`);
  };
  const participantRoot = (participantId) => path.join(sessionsDir, safeToken(participantId, 'participant'));
  const checkpointFile = (participantId) => path.join(participantRoot(participantId), 'checkpoint.json');
  const alertFile = (participantId) => path.join(participantRoot(participantId), 'save-alert.json');
  const readJson = (filePath) => {
    if (!fs.existsSync(filePath)) return null;
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      return null;
    }
  };
  const validateTrialCalibration = (trials, participant) => {
    const root = path.join(sessionsDir, participant.id, 'collection');
    for (const trial of Array.isArray(trials) ? trials : []) {
      if (trial?.calibration === undefined) continue; // Read legacy data without inventing a calibration.
      const id = safeToken(trial.id, '');
      const sample = id && fs.existsSync(root) ? fs.readdirSync(root).map(name => readJson(path.join(root, name, 'samples', `${id}.json`))).find(Boolean) : null;
      if (!sample || canonicalPractice(sample.calibration) !== canonicalPractice(trial.calibration)
        || (sample.firstCrossingAt ?? null) !== (trial.firstCrossingAt ?? null)) throw Object.assign(new Error('Trial calibration does not match its archived sample.'), { status: 400 });
    }
  };
  const sanitizeTrial = (trial) => {
    if (!trial || typeof trial !== 'object') return null;
    const id = safeToken(trial.id, '');
    if (!id) return null;
    const points = sanitizePoints(trial.points);
    return {
      id,
      ...(trial.condition ? { condition: trial.condition } : {}),
      ...(trial.centerDurationMs !== undefined ? { centerDurationMs: trial.centerDurationMs } : {}),
      ...(trial.attemptId ? { attemptId: trial.attemptId } : {}),
      gestureId: String(trial.gestureId || ''),
      gestureName: String(trial.gestureName || ''),
      pairIndex: finiteNumber(trial.pairIndex, 1),
      capturedAt: finiteNumber(trial.capturedAt, Date.now()),
      triggeredAt: finiteNumber(trial.triggeredAt, 0),
      completedAt: finiteNumber(trial.completedAt, 0),
      preTriggerPointCount: finiteNumber(trial.preTriggerPointCount, 0),
      ...(trial.calibration !== undefined ? { calibration: trial.calibration, firstCrossingAt: trial.firstCrossingAt ?? null } : {}),
      points,
      quality: trial.quality === 'review' ? 'review' : 'usable',
      metrics: {
        rms: finiteNumber(trial.metrics?.rms, 0),
        peak: finiteNumber(trial.metrics?.peak, 0),
        range: finiteNumber(trial.metrics?.range, 0),
        durationMs: finiteNumber(trial.metrics?.durationMs, 0),
      },
    };
  };
  const trialFromSample = (sample) => sanitizeTrial({
    id: sample.sampleId,
    condition: sample.condition,
    centerDurationMs: sample.centerDurationMs,
    attemptId: sample.attemptId,
    gestureId: sample.gestureId,
    gestureName: sample.gestureLabel,
    pairIndex: 1,
    capturedAt: sample.capturedAt,
    triggeredAt: sample.triggeredAt,
    completedAt: sample.recordingEndedAt,
    preTriggerPointCount: sample.preTriggerPointCount,
    ...(sample.calibration !== undefined ? { calibration: sample.calibration, firstCrossingAt: sample.firstCrossingAt ?? null } : {}),
    points: sample.points,
    quality: 'usable',
    metrics: {
      rms: 0,
      peak: 0,
      range: 0,
      durationMs: Math.max(0, Number(sample.recordingEndedAt) - Number(sample.recordingStartedAt) || 0),
    },
  });
  const buildRestore = (participant) => {
    const round = Number(participant.current_round) || 1;
    let checkpoint = readJson(checkpointFile(participant.id));
    if (checkpoint && !sameGeneration(checkpoint, participant)) return null;
    if (checkpoint && (Number(checkpoint.round) !== round || (isPilot(participant) && checkpoint.condition !== participant.condition))) checkpoint = null;
    const locked = isPilot(participant) ? protocolState(participant).lock : null;
    let sessionId = locked?.sessionId || (isPilot(participant) ? protocolState(participant).sessionId : '') || (checkpoint ? safeToken(checkpoint.sessionId, '') : '');
    if(sessionId && !checkpoint) checkpoint={sessionId,round,stage:locked?'review':'capture',unlockedThrough:locked?'review':'capture',trials:[],pendingReplacements:[],updatedAt:0};
    if (!sessionId) {
      const root = path.join(participantRoot(participant.id), 'collection');
      if (!fs.existsSync(root)) return null;
      const candidates = fs.readdirSync(root)
        .map((name) => {
          const dir = path.join(root, name);
          if (!fs.statSync(dir).isDirectory()) return null;
          const meta = readJson(path.join(dir, 'meta.json'));
          if (!meta || Number(meta.round) !== round) return null;
          return { sessionId: safeToken(meta.sessionId || name, ''), updatedAt: fs.statSync(dir).mtimeMs };
        })
        .filter((entry) => entry?.sessionId)
        .sort((left, right) => right.updatedAt - left.updatedAt);
      sessionId = candidates[0]?.sessionId || '';
      if (!sessionId) return null;
      checkpoint = {
        sessionId,
        round,
        stage: 'capture',
        unlockedThrough: 'capture',
        trials: [],
        pendingReplacements: [],
        updatedAt: 0,
      };
    }
    const dir = collectionDir(sessionsDir, participant.id, sessionId);
    const samples = readJsonFiles(path.join(dir, 'samples'));
    const events = readJsonFiles(path.join(dir, 'events'));
    const deleted = new Set(events
      .filter((event) => ['sample_deleted','sample_rejected'].includes(event.type) && Number(event.round) === round && event.sampleId)
      .map((event) => event.sampleId));
    const replaced = new Set(events
      .filter((event) => event.type === 'sample_replaced' && Number(event.round) === round && event.sampleId)
      .map((event) => event.sampleId));
    const checkpointTrials = (isPilot(participant) ? [] : Array.isArray(checkpoint.trials) ? checkpoint.trials : [])
      .map(sanitizeTrial)
      .filter((trial) => trial && !deleted.has(trial.id));
    const seen = new Set(checkpointTrials.map((trial) => trial.id));
    const extras = samples
      .filter((sample) => Number(sample.round) === round && (!isPilot(participant) || sample.condition===participant.condition && Number(sample.generation)===participantGeneration(participant)) && !deleted.has(sample.sampleId) && !seen.has(sample.sampleId))
      .map(trialFromSample)
      .filter(Boolean);
    const pendingFromEvents = events
      .filter((event) => ['sample_deleted','sample_rejected'].includes(event.type) && Number(event.round) === round && event.sampleId && !replaced.has(event.sampleId))
      .sort((left, right) => Number(left.at) - Number(right.at))
      .map((event) => ({
        round,
        sampleId: event.sampleId,
        gestureId: samples.find((sample) => sample.sampleId === event.sampleId)?.gestureId
          || (Array.isArray(checkpoint.pendingReplacements) ? checkpoint.pendingReplacements : [])
            .find((item) => item?.sampleId === event.sampleId)?.gestureId
          || '',
      }));
    const pendingIds = new Set(pendingFromEvents.map((item) => item.sampleId));
    const pendingFromCheckpoint = (Array.isArray(checkpoint.pendingReplacements) ? checkpoint.pendingReplacements : [])
      .filter((item) => Number(item?.round) === round && item?.sampleId && !replaced.has(item.sampleId) && !pendingIds.has(item.sampleId))
      .map((item) => ({
        round,
        sampleId: safeToken(item.sampleId, ''),
        gestureId: String(item.gestureId || ''),
      }))
      .filter((item) => item.sampleId);
    const contexts = readJsonFiles(path.join(dir,'contexts')).filter(envelope=>envelope.context && envelope.generation===participantGeneration(participant) && envelope.round===round && envelope.condition===participant.condition);
    const dispositionEvents=readJsonFiles(path.join(dir,'contexts')).filter(event=>event.contextId && event.eventId && event.disposition).sort((a,b)=>a.at-b.at);
    const stage = ['capture', 'review', 'game', 'results'].includes(checkpoint.stage) ? checkpoint.stage : 'capture';
    const unlockedThrough = ['capture', 'review', 'game', 'results'].includes(checkpoint.unlockedThrough)
      ? checkpoint.unlockedThrough
      : stage;
    return {
      sessionId,
      round,
      stage,
      unlockedThrough,
      trials: [...checkpointTrials, ...extras],
      contexts: contexts.map(envelope=>({...envelope,derivedDisposition:dispositionEvents.filter(event=>event.contextId===envelope.context.contextId).at(-1)?.disposition??envelope.context.disposition})),
      pendingReplacements: [...pendingFromEvents, ...pendingFromCheckpoint],
      openCapture: checkpoint.openCapture && Number(checkpoint.openCapture.round) === round && safeToken(checkpoint.openCapture.sampleId, '') ? {
        sampleId: safeToken(checkpoint.openCapture.sampleId, ''),
        gestureId: String(checkpoint.openCapture.gestureId || ''),
        gestureName: String(checkpoint.openCapture.gestureName || ''),
        round,
        phase: checkpoint.openCapture.phase === 'recording' ? 'recording' : 'countdown',
      } : null,
      trainingRun: checkpoint.trainingRun && Number(checkpoint.trainingRun.round) === round ? {
        revisionId: safeToken(checkpoint.trainingRun.revisionId, ''),
        startedAt: finiteNumber(checkpoint.trainingRun.startedAt, Date.now()),
        round,
        sampleIds: Array.isArray(checkpoint.trainingRun.sampleIds)
          ? checkpoint.trainingRun.sampleIds.map((sampleId) => safeToken(sampleId, '')).filter(Boolean)
          : [],
      } : null,
      modelRevisionId: locked?.revisionId || (checkpoint.modelRevisionId ? safeToken(checkpoint.modelRevisionId, '') : null),
      runs: readRuns(participant.id).filter((run) => Number(run.round) === round),
      updatedAt: finiteNumber(checkpoint.updatedAt, 0),
      generation: participantGeneration(participant),
    };
  };
  const readAlert = (participant) => {
    const alert = readJson(alertFile(participant.id));
    if (!alert?.active || !sameGeneration(alert, participant)) return null;
    return {
      participantId: participant.id,
      message: String(alert.message || 'Study data is still not saving.'),
      pending: finiteNumber(alert.pending, 0),
      at: String(alert.at || ''),
    };
  };

  const requireAdmin = (headers, state) => {
    const pin = headers['x-admin-pin'] ?? headers['X-Admin-Pin'];
    if (!pinsMatch(pin, state.settings.adminPin)) {
      throw Object.assign(new Error('Admin sign-in required.'), { status: 401 });
    }
  };

  const findExperiment = (state, id) => {
    const experiment = state.experiments.find((entry) => entry.id === id);
    if (!experiment) throw Object.assign(new Error('Experiment not found.'), { status: 404 });
    return experiment;
  };

  const protocolFile = participant => path.join(participantRoot(participant.id), `visit-${participant.current_round}.json`);
  const protocolState = participant => {
    const state=readJson(protocolFile(participant)) ?? {generation:participantGeneration(participant),visit:Number(participant.current_round),condition:participant.condition,survey:null,lock:null};
    state.trainingStatus=state.lock ? readJson(path.join(collectionDir(sessionsDir,participant.id,state.lock.sessionId),'training',`${state.lock.revisionId}.json`))?.status??null : null;
    return state;
  };
  const conflict = message => { throw Object.assign(new Error(message), { status: 409 }); };
  const assertScope = (record, participant) => {
    if (record?.participantId !== undefined && record.participantId !== participant.id) conflict('Participant scope mismatch.');
    if (Number(record?.generation) !== participantGeneration(participant)) conflict('Inactive generation. Rejoin before saving.');
    if (participant.status === 'completed' || Number(record?.round) !== Number(participant.current_round) || record.condition !== participant.condition) conflict('Inactive visit/condition scope. Rejoin before saving.');
    if (!record.sessionId || safeToken(record.sessionId) !== record.sessionId) conflict('Invalid session scope.');
    const bound=isPilot(participant) ? protocolState(participant).sessionId : null;
    if(bound && bound!==record.sessionId) conflict('This visit is bound to another dataset session. Rejoin to restore its scope.');
  };
  const assertPracticeDecision = (participant, sessionId) => {
    if(participant.protocol_version!==PILOT_PROTOCOL) return;
    const decision=protocolState(participant).practice;
    if(!decision || !['completed','skipped'].includes(decision.status) || decision.sessionId!==sessionId
      || decision.generation!==participantGeneration(participant) || decision.round!==Number(participant.current_round)
      || decision.condition!==participant.condition) conflict('Complete Practice or record a researcher-controlled skip before measured collection.');
  };
  const assertBeforeMeasured = (participant, sessionId) => {
    const visit=protocolState(participant), dir=collectionDir(sessionsDir,participant.id,sessionId);
    if(visit.lock || ['samples','events','contexts','training','runs'].some(name=>readCriticalArchive(path.join(dir,name),name).length)
      || readRuns(participant.id).some(run=>run.generation===participantGeneration(participant) && run.round===Number(participant.current_round)))
      conflict('Practice decision must precede measured collection, lock and game.');
  };
  const assertContextSample = (context, sample) => {
    const center=context.center && context.points.slice(context.center.startIndex,context.center.endIndexExclusive).map(p=>({time:p.time,value:p.raw}));
    if(context.status!=='captured'
      || context.attempt.attemptId!==sample.attemptId
      || context.attempt.gestureId!==sample.gestureId
      || context.scope.source!==sample.signalSource
      || context.scope.channel!==(sample.channelIndex??0)
      || canonicalPractice(center)!==canonicalPractice(sample.points)) conflict('Context/sample center lineage mismatch.');
  };
  // Acceptance gates must not silently discard corrupt authoritative archives.
  // Only published JSON is authoritative; interrupted *.tmp writes stay ignored.
  const readCriticalArchive = (directory, label) => {
    let names;
    try { names=fs.readdirSync(directory); }
    catch(error) { if(error.code==='ENOENT')return []; conflict(`Unreadable ${label} archive.`); }
    return names.filter(name=>name.endsWith('.json')).map(name=>{
      try {
        const record=JSON.parse(fs.readFileSync(path.join(directory,name),'utf8'));
        if(!record || typeof record!=='object' || Array.isArray(record))throw new Error('Expected archive object');
        return {name,record};
      } catch { conflict(`Invalid or unreadable ${label} archive: ${name}.`); }
    });
  };
  const retainedSamples = (participant, sessionId) => {
    const dir = collectionDir(sessionsDir, participant.id, sessionId);
    const events = readCriticalArchive(path.join(dir,'events'),'sample event').map(({name,record})=>{
      if(!EVENT_TYPES.has(record.type)
        || (['sample_deleted','sample_rejected'].includes(record.type)
          && (typeof record.sampleId!=='string' || !record.sampleId || safeToken(record.sampleId)!==record.sampleId))) conflict(`Invalid sample event archive: ${name}.`);
      return record;
    });
    const deleted = new Set(events.filter(e => ['sample_deleted','sample_rejected'].includes(e.type)).map(e=>e.sampleId));
    return readCriticalArchive(path.join(dir,'samples'),'sample').map(({record})=>record).filter(s=>s.condition===participant.condition && Number(s.round)===Number(participant.current_round) && Number(s.generation)===participantGeneration(participant) && !deleted.has(s.sampleId));
  };
  const assertDataset = (participant, sessionId, ids) => {
    const samples = retainedSamples(participant, sessionId);
    const quota = sampleBounds(JSON.parse(participant.frozen_settings)).max;
    if (!Array.isArray(ids) || new Set(ids).size!==ids.length || ids.length!==quota*2 || samples.length!==ids.length || samples.some(s=>!ids.includes(s.sampleId)) || PILOT_GESTURES.some(g=>samples.filter(s=>s.gestureId===g).length!==quota)) conflict('Exact retained quota and archived sample lineage required.');
    const lock=protocolState(participant).lock;
    if(lock && (lock.sessionId!==sessionId || canonicalPractice([...ids].sort())!==canonicalPractice([...lock.sampleIds].sort()))) conflict('Frozen locked sample lineage required.');
    const directory=path.join(collectionDir(sessionsDir,participant.id,sessionId),'contexts');
    const records=readCriticalArchive(directory,'context').map(({name,record})=>{
      if(name.endsWith('.disposition.json')) {
        const validId=value=>typeof value==='string' && /^[A-Za-z0-9][A-Za-z0-9:_-]{0,159}$/.test(value);
        const keys=['contextId','disposition','at','eventId'];
        if(Object.keys(record).length!==keys.length || !keys.every(key=>Object.hasOwn(record,key))
          || !validId(record.contextId) || !validId(record.eventId)
          || !['retained','deleted','rejected'].includes(record.disposition)
          || !Number.isSafeInteger(record.at) || record.at<0) conflict(`Invalid context disposition archive: ${name}.`);
      } else {
        try { validateContextRecord(record.context ?? record); }
        catch { conflict(`Invalid archived context: ${name}.`); }
      }
      return record;
    });
    for(const sample of samples) {
      assertScope(sample,participant);
      if(sample.sessionId!==sessionId) conflict('Retained sample session scope mismatch.');
      const matches=records.filter(envelope=>envelope.context?.sampleId===sample.sampleId);
      if(matches.length!==1) conflict('One archived captured raw context per retained sample required.');
      const envelope=matches[0], context=envelope.context;
      if(envelope.generation!==participantGeneration(participant) || envelope.round!==Number(participant.current_round) || envelope.condition!==participant.condition
        || context.scope.participantId!==participant.id || context.scope.sessionId!==sessionId || context.scope.condition!==participant.condition) conflict('Retained context scope mismatch.');
      const hash=crypto.createHash('sha256').update(context.contextId).digest('hex');
      const raw=readJson(path.join(directory,`${hash}.context.json`));
      if(!raw || canonicalPractice(raw)!==canonicalPractice(context)) conflict('Durably archived matching raw context required.');
      try { validateContextRecord(raw); } catch { conflict('Invalid archived raw context.'); }
      const disposition=records.filter(event=>event.contextId===context.contextId && event.eventId && event.disposition)
        .sort((a,b)=>a.at-b.at || a.eventId.localeCompare(b.eventId)).at(-1)?.disposition ?? context.disposition;
      if(disposition!=='retained') conflict('Deleted or rejected context cannot enter the retained dataset.');
      assertContextSample(context,sample);
    }
    return samples;
  };

  const validateSampleCalibration = (record, participant) => {
    if(participant.protocol_version===PILOT_PROTOCOL && !record.calibration)
      throw Object.assign(new Error('V2 measured sample requires saved rest calibration.'),{status:400});
    if (record.calibration === undefined) return;
    const explicitCenter = record.centerDurationMs === 2000;
    const validWindow = explicitCenter
      ? validatePracticePoints(record.points, 1900) && record.settings?.segmentDurationMs===2000 && record.preTriggerPointCount===0 && record.recordingEndedAt===record.triggeredAt+2000 && record.points.every(p=>p.time>=record.triggeredAt && p.time<record.recordingEndedAt)
      : validatePracticePoints(record.points, record.settings?.segmentDurationMs) && record.points.at(-1).time===record.recordingEndedAt;
    if (!validWindow || !Number.isInteger(record.preTriggerPointCount) || record.preTriggerPointCount < 0
      || record.points[record.preTriggerPointCount]?.time !== record.triggeredAt
      || record.points[0].time !== record.recordingStartedAt
      || record.recordingEndedAt - record.triggeredAt < record.settings.segmentDurationMs)
      throw Object.assign(new Error('Invalid calibrated sample waveform or anchors.'), {status:400});
    if (record.calibration !== null) {
      const reference=readJsonFiles(path.join(collectionDir(sessionsDir,participant.id,record.sessionId),'practice')).find(rest=>rest.kind==='rest' && rest.id===record.calibration.restId);
      if (!reference || !sameCalibration(record.calibration,reference.calibration)
        || !['participantId','experimentId','sessionId','generation','round','condition','signalSource','channelIndex'].every(key=>record[key]===reference[key]))
        throw Object.assign(new Error('Sample calibration scope mismatch.'),{status:400});
      if(participant.protocol_version===PILOT_PROTOCOL) validateSavedRest(reference,participant);
    } else if(participant.condition==='threshold' && record.gestureId!=='relax') throw Object.assign(new Error('Threshold sample requires calibration.'),{status:400});
    if(participant.condition==='threshold' && record.gestureId!=='relax' && (!Number.isFinite(record.firstCrossingAt) || record.triggeredAt-record.firstCrossingAt<100))
      throw Object.assign(new Error('Invalid confirmed threshold anchor.'),{status:400});
  };

  const validateSavedRest = (rest, participant) => {
    try {
      sanitizePracticeRecord(rest,{...participant,status:'in_progress'},[]);
      if(rest.kind!=='rest' || !sameCalibration(rest.calibration,restCalibration(rest)))throw new Error('Invalid calibration');
    } catch { conflict('Valid saved resting reference and calibration required.'); }
  };
  const assertSavedRest = (participant, scope) => {
    const records=readCriticalArchive(path.join(collectionDir(sessionsDir,participant.id,scope.sessionId),'practice'),'Practice').map(({record})=>record);
    const rests=records.filter(record=>record.kind==='rest' && record.participantId===participant.id
      && record.experimentId===participant.experiment_id && record.sessionId===scope.sessionId
      && record.generation===participantGeneration(participant) && record.round===Number(participant.current_round) && record.condition===participant.condition);
    if(!rests.length)conflict('Valid saved resting reference and calibration required before Practice skip.');
    for(const rest of rests)validateSavedRest(rest,participant);
  };

  // Recover the archive-first publication gap without asking a fresh client to replay.
  // Never infer completion from file presence alone: revalidate the full saved chain.
  const recoverPracticeDecision = participant => {
    if(participant.protocol_version!==PILOT_PROTOCOL)return;
    const root=path.join(participantRoot(participant.id),'collection');
    const candidates=[];
    for(const session of fs.existsSync(root)?fs.readdirSync(root):[]) {
      const entries=readCriticalArchive(path.join(root,session,'practice'),'Practice');
      const records=entries.map(({record})=>record);
      const completed=records.filter(record=>record.kind==='completed' && record.generation===participantGeneration(participant)
        && record.round===Number(participant.current_round));
      for(const record of completed) {
        if(record.sessionId!==session || record.condition!==participant.condition)conflict('Completed Practice archive scope conflict.');
        const related=records.filter(entry=>entry.generation===record.generation && entry.round===record.round && entry.attemptId===record.attemptId);
        if(new Set(related.map(entry=>entry.id)).size!==related.length)conflict('Ambiguous Practice archive identity.');
        for(const entry of related) {
          if(entry.sessionId!==session)conflict('Practice archive session scope conflict.');
          const sanitized={...sanitizePracticeRecord(entry,{...participant,status:'in_progress'},records),isTestParticipant:isTestParticipant(participant)};
          const {practiceDecisionAt,...evidence}=entry;
          if(canonicalPractice(sanitized)!==canonicalPractice(withPracticeTiming(evidence)))conflict('Invalid completed Practice archive chain.');
        }
        validateSavedRest(records.find(entry=>entry.id===record.restId && entry.kind==='rest'),participant);
        candidates.push(record);
      }
    }
    if(candidates.length>1)conflict('Ambiguous conflicting completed Practice archives.');
    const current=protocolState(participant),record=candidates[0];
    if(!record) {
      if(current.practice?.status==='completed')conflict('Completed Practice decision lacks its archive chain.');
      return;
    }
    if(current.practice) {
      if(current.practice.status!=='completed' || current.sessionId!==record.sessionId
        || ['sessionId','generation','round','condition'].some(key=>current.practice[key]!==record[key])
        || record.practiceDecisionAt!==undefined && current.practice.at!==record.practiceDecisionAt)conflict('Practice decision conflicts with completed archive.');
      return; // In particular, never replace a published decision timestamp.
    }
    if(current.sessionId && current.sessionId!==record.sessionId)conflict('Completed Practice session conflicts with visit.');
    assertBeforeMeasured(participant,record.sessionId);
    const at=record.practiceDecisionAt ?? record.createdAt; // Deterministic historical fallback, not recovery time.
    if(!Number.isFinite(at))conflict('Invalid completed Practice decision timestamp.');
    current.sessionId=record.sessionId;
    current.practice={status:'completed',at,sessionId:record.sessionId,generation:record.generation,round:record.round,condition:record.condition};
    writeJsonAtomic(protocolFile(participant),current);
  };

  const sanitizeTraining = (record,participant) => ({
    revisionId:record.revisionId,trainingAttemptId:record.trainingAttemptId??record.revisionId,generation:participantGeneration(participant),sessionId:record.sessionId,participantId:participant.id,isTestParticipant:isTestParticipant(participant),condition:participant.condition,round:finiteNumber(record.round,1),sampleIds:Array.isArray(record.sampleIds)?record.sampleIds.map(id=>safeToken(id,'')).filter(Boolean):[],classifier:'knn',settings:sanitizeSettings(record.settings),startedAt:finiteNumber(record.startedAt,null),finishedAt:finiteNumber(record.finishedAt,null),status:record.status==='success'?'success':'failure',error:String(record.error||'').slice(0,500),
  });

  const assertReadyTraining = (participant, lock) => {
    const training=readJson(path.join(collectionDir(sessionsDir,participant.id,lock.sessionId),'training',`${lock.revisionId}.json`));
    if(training?.status!=='success' || training.revisionId!==lock.revisionId || training.sessionId!==lock.sessionId
      || !Array.isArray(training.sampleIds) || canonicalPractice([...training.sampleIds].sort())!==canonicalPractice([...lock.sampleIds].sort())) conflict('Successful archived training with frozen sample lineage required.');
    assertScope(training,participant);
    return training;
  };
  const validatePilotRun = (run, participant, verifyStored = false) => {
    if (!isPilot(participant)) return;
    assertScope(run,participant);
    const lock=protocolState(participant).lock;
    const training=lock && readJson(path.join(collectionDir(sessionsDir,participant.id,lock.sessionId),'training',`${lock.revisionId}.json`));
    if (!lock || run.sessionId!==lock.sessionId || run.modelRevisionId!==lock.revisionId || training?.status!=='success') conflict('Ready archived official model required.');
    assertDataset(participant,lock.sessionId,lock.sampleIds);
    assertReadyTraining(participant,lock);
    if (!['official','replay'].includes(run.runKind)) conflict('Explicit official/replay run kind required.');
    const runs=readRuns(participant.id);
    const previous=runs.find(r=>r.id===run.id);
    if (previous && !verifyStored) {
      if(canonicalPractice(previous)!==canonicalPractice(sanitizeStoredRun(run,participant))) conflict('Saved run is immutable.');
      return;
    }
    if(!['complete','incomplete'].includes(run.completionStatus)) conflict('Explicit complete/incomplete result required.');
    if (!run.id || safeToken(run.id)!==run.id || run.runId!==run.id) conflict('Run identity metadata must match the immutable run ID.');
    const sequence=JSON.parse(participant.official_sequence);
    if(canonicalPractice(run.officialSequence)!==canonicalPractice(sequence)) conflict('Saved sequence required for official and replay.');
    if(!Number.isFinite(run.startedAt) || !Number.isFinite(run.endedAt) || run.endedAt<run.startedAt || !Array.isArray(run.outcomes) || run.outcomes.length>20 || (run.completionStatus==='complete' && run.outcomes.length!==20)) conflict('Complete indexed run metadata required.');
    if (run.outcomes.some((o,i)=>o.trialIndex!==i+1 || o.attemptId!==`${run.runId}:${i+1}` || o.expectedGestureId!==sequence[i] || !ATTEMPT_RESULTS.has(o.result)
      || !Number.isFinite(o.cueAt) || !Number.isFinite(o.recordingStartedAt) || !Number.isFinite(o.recordingEndedAt)
      || o.cueAt<run.startedAt || o.recordingStartedAt<o.cueAt || o.recordingEndedAt-o.recordingStartedAt!==2000 || o.recordingEndedAt>run.endedAt
      || !Number.isInteger(o.sampleCount) || o.sampleCount<2 || !Number.isFinite(o.inferenceStartedAt) || !Number.isFinite(o.inferenceEndedAt)
      || o.inferenceStartedAt<o.recordingEndedAt || o.inferenceEndedAt<o.inferenceStartedAt || o.inferenceEndedAt>run.endedAt)) conflict('Indexed attempt identity and sample-backed 2000ms window metadata required.');
    if (run.outcomes.some(o => {
      const predicted = o.predictedGestureId ?? null;
      if (o.result === 'correct') return predicted !== o.expectedGestureId;
      if (o.result === 'wrong') return !PILOT_GESTURES.includes(predicted) || predicted === o.expectedGestureId;
      if (o.result === 'unknown') return predicted !== null && predicted !== 'unknown';
      return o.result === 'recording_failure' && predicted !== null;
    })) conflict('Recognition result contradicts the recorded prediction.');
    if (run.completionStatus==='complete' && (run.streamReady!==true || (run.signalSource!=='live' && !isTestParticipant(participant)))) conflict('Official/replay game requires actively streaming live EMG.');
    if(run.runKind==='official' && run.completionStatus==='complete') {
      if(!verifyStored && runs.some(r=>r.generation===participantGeneration(participant) && r.condition===participant.condition && r.runKind==='official' && r.completionStatus==='complete')) conflict('One official run per condition; use replay.');
      if(run.streamReady!==true || (run.signalSource!=='live' && !isTestParticipant(participant))) conflict('Official game requires actively streaming live EMG.');
      const sequence=JSON.parse(participant.official_sequence);
      if(canonicalPractice(run.officialSequence)!==canonicalPractice(sequence) || run.outcomes?.length!==20 || run.outcomes.some((o,i)=>o.trialIndex!==i+1 || o.expectedGestureId!==sequence[i] || !ATTEMPT_RESULTS.has(o.result))) conflict('Official game requires the saved balanced20 sequence and ordered outcomes.');
    }
  };

  const finalizationFile = (participant, round = participant.current_round) => path.join(participantRoot(participant.id), `finalization-${participantGeneration(participant)}-${round}.json`);
  const finalizationRequest = body => ({
    participantId: normalizeId(body.id), generation:Number(body.generation), round:Number(body.round),
    condition:body.condition, sessionId:body.sessionId,
    sampleIds:(Array.isArray(body.trials)?body.trials:[]).map(t=>t.id).sort(),
  });
  const completionEvidence = (participant, sessionId, ids) => {
    const protocol=protocolState(participant);
    if(!protocol.lock || protocol.lock.sessionId!==sessionId) conflict('Locked session scope required.');
    const samples=assertDataset(participant,sessionId,ids);
    const training=assertReadyTraining(participant,protocol.lock);
    // Freeze all raw points/metadata, not just the center projected into samples.
    // assertDataset already requires exactly one envelope and an identical raw copy.
    const rawContexts=readCriticalArchive(path.join(collectionDir(sessionsDir,participant.id,sessionId),'contexts'),'context')
      .map(({record})=>record.context).filter(context=>context && ids.includes(context.sampleId))
      .sort((a,b)=>a.sampleId.localeCompare(b.sampleId));
    const runs=readRuns(participant.id).filter(r=>r.generation===participantGeneration(participant) && r.round===Number(participant.current_round) && r.condition===participant.condition && r.sessionId===sessionId && r.runKind==='official' && r.completionStatus==='complete' && r.modelRevisionId===protocol.lock.revisionId);
    if(runs.length!==1) conflict('One completed official run with frozen model/session lineage required before finalization.');
    validatePilotRun(runs[0],participant,true);
    return {bindingVersion:1,samples,rawContexts,training,officialRun:runs[0]};
  };
  const publishFinalization = (file, journal, state) => {
    const p=journal.payload, before=p.participantBefore;
    // Old pending intents lack an original raw/training binding. Never bless
    // today's archive as their historical evidence or rewrite their checksum.
    // Already committed historical intents remain read-only via recovery/retry.
    if(p.evidence?.bindingVersion!==1) conflict('Finalization evidence has no immutable raw/training binding; manual recovery required.');
    const index=state.participants.findIndex(entry=>entry.id===before.id);
    if(index<0 || ![p.participantBefore,p.participantAfter].some(expected=>canonicalPractice(expected)===canonicalPractice(state.participants[index]))) conflict('Finalization participant changed; manual recovery required.');
    const visitFile=protocolFile(before), visit=readJson(visitFile);
    if(![p.visitBefore,p.visitAfter].some(expected=>canonicalPractice(expected)===canonicalPractice(visit))) conflict('Finalization visit changed; manual recovery required.');
    const evidence=completionEvidence(before,p.request.sessionId,p.request.sampleIds);
    if(canonicalPractice(evidence)!==canonicalPractice(p.evidence)) conflict('Finalization evidence changed; manual recovery required.');
    const resultFile=path.join(sessionsDir,`${before.id}-round-${p.request.round}.json`);
    if(fs.existsSync(resultFile) && canonicalPractice(readJson(resultFile))!==canonicalPractice(p.result)) conflict('Finalized result is immutable; manual recovery required.');
    const existing=state.rounds.filter(r=>r.participant_id===before.id && Number(r.round)===p.request.round);
    if(existing.length>1 || existing.some(r=>canonicalPractice(r)!==canonicalPractice(p.roundRecord))) conflict('Conflicting finalization round summary; manual recovery required.');
    if(!fs.existsSync(resultFile))writeJsonAtomic(resultFile,p.result);
    finalizationFault('after-result');
    if(!existing.length) {
      state.rounds.push(p.roundRecord);
      saveRounds(state.rounds);
    }
    finalizationFault('after-rounds');
    if(canonicalPractice(visit)!==canonicalPractice(p.visitAfter))writeJsonAtomic(visitFile,p.visitAfter);
    finalizationFault('after-visit');
    if(canonicalPractice(state.participants[index])!==canonicalPractice(p.participantAfter)) {
      state.participants[index]=p.participantAfter;
      saveParticipants(state.participants);
    }
    finalizationFault('after-participant');
    commitFinalization(file);
    finalizationFault('after-commit');
  };
  const recoverFinalizations = state => {
    for(const participant of state.participants) {
      const root=participantRoot(participant.id);
      if(!fs.existsSync(root))continue;
      for(const name of fs.readdirSync(root).filter(name=>/^finalization-\d+-\d+\.json$/.test(name))) {
        const file=path.join(root,name),journal=readFinalization(file);
        if(journal && !journal.committed)publishFinalization(file,journal,state);
      }
    }
  };

  return {
    handle({ method, pathname, searchParams, headers, body }) {
      const state = load();
      recoverFinalizations(state);
      const route = `${method} ${pathname}`;

      if (route === 'POST /auth') {
        if (!pinsMatch(body.pin, state.settings.adminPin)) {
          throw Object.assign(new Error('That pin is not recognized.'), { status: 401 });
        }
        return { status: 200, body: { ok: true } };
      }

      if (route === 'POST /join') {
        const id = normalizeId(body.id);
        if (!id) throw Object.assign(new Error('Enter the ID you were given.'), { status: 400 });
        const participant = state.participants.find((entry) => entry.id === id);
        if (!participant) throw Object.assign(new Error('That ID was not recognized.'), { status: 404 });
        const experiment = findExperiment(state, participant.experiment_id);
        if (experiment.status !== 'active') {
          throw Object.assign(new Error('This session is not open.'), { status: 403 });
        }
        const frozen = isPilot(participant) ? JSON.parse(participant.frozen_settings) : experiment;
        recoverPracticeDecision(participant);
        const bounds = sampleBounds(frozen);
        const game = gameLimits(frozen);
        const protocol = isPilot(participant) ? { protocolVersion: participant.protocol_version, conditionOrder: conditionOrder(participant), visit: Number(participant.current_round), officialSequence: JSON.parse(participant.official_sequence), groupCode: participant.group_code || null, memberCode: participant.member_code || null, protocolState: readJson(protocolFile(participant)) ? protocolState(participant) : null } : { protocolVersion: 'legacy-fixed-v1' };
        if (participant.status === 'completed') {
          return {
            status: 200,
            body: {
              ...protocol,
              participantId: participant.id,
              experimentId: experiment.id,
              isTestParticipant: isTestParticipant(participant),
              experimentName: experiment.name,
              repetitions: Number(experiment.repetitions),
              capturesMin: bounds.min,
              capturesMax: bounds.max,
              capturesPerRound: bounds.max,
              obstacleCount: game.obstacleCount,
              startingLives: game.startingLives,
              round: Number(experiment.repetitions),
              condition: participant.condition,
              generation: participantGeneration(participant),
              status: 'completed',
              runs: readRuns(participant.id),
              restored: null,
            },
          };
        }
        if (participant.status === 'assigned') {
          participant.status = 'in_progress';
          participant.current_round = '1';
          saveParticipants(state.participants);
        }
        return {
          status: 200,
          body: {
            ...protocol,
            participantId: participant.id,
            experimentId: experiment.id,
            isTestParticipant: isTestParticipant(participant),
            experimentName: experiment.name,
              repetitions: Number(experiment.repetitions),
              capturesMin: bounds.min,
              capturesMax: bounds.max,
              capturesPerRound: bounds.max,
              obstacleCount: game.obstacleCount,
              startingLives: game.startingLives,
              round: Number(participant.current_round) || 1,
            condition: participant.condition,
            generation: participantGeneration(participant),
            manualTrigger: participant.condition === 'button',
            status: 'in_progress',
            runs: readRuns(participant.id),
            restored: buildRestore(participant),
          },
        };
      }

      if (route === 'POST /protocol/practice/skip') {
        requireAdmin(headers,state);
        const participant=state.participants.find(p=>p.id===normalizeId(body.id));
        if(participant?.protocol_version!==PILOT_PROTOCOL) conflict('Practice skip requires pre/post v2.');
        recoverPracticeDecision(participant);
        assertScope(body,participant);
        const current=protocolState(participant);
        assertBeforeMeasured(participant,body.sessionId);
        assertSavedRest(participant,body);
        const collectionRoot=path.join(participantRoot(participant.id),'collection');
        const completed=fs.existsSync(collectionRoot) && fs.readdirSync(collectionRoot).some(session=>readJsonFiles(path.join(collectionRoot,session,'practice')).some(record=>record.kind==='completed'
          && record.generation===participantGeneration(participant) && record.round===Number(participant.current_round) && record.condition===participant.condition));
        if(completed || (current.practice && current.practice.status!=='skipped')) conflict('Completed Practice cannot be retroactively skipped.');
        current.sessionId=body.sessionId;
        current.practice ??= {status:'skipped',at:Date.now(),sessionId:body.sessionId,generation:participantGeneration(participant),round:Number(participant.current_round),condition:participant.condition};
        writeJsonAtomic(protocolFile(participant),current);
        return {status:200,body:current};
      }

      if (route === 'POST /protocol/survey' || route === 'POST /protocol/lock') {
        const participant = state.participants.find(p=>p.id===normalizeId(body.id));
        if (!participant || !isPilot(participant)) conflict('Within-person pilot participant required.');
        assertScope(body,participant);
        const current = protocolState(participant);
        if (route.endsWith('/survey')) {
          requireAdmin(headers,state);
          if(participant.protocol_version===PILOT_PROTOCOL) conflict('External Pre/Post surveys are not verified by the v2 app.');
          if (current.lock) conflict('Dataset already locked.');
          if (body.confirmed !== true) conflict('Researcher confirmation of external collection survey required.');
          const samples=retainedSamples(participant,body.sessionId);
          assertDataset(participant,body.sessionId,samples.map(s=>s.sampleId));
          current.survey = { confirmedAt: nowIso(), sessionId: body.sessionId, sampleIds: samples.map(s=>s.sampleId).sort(), method: 'researcher-confirmed-external-form' };
        } else {
          assertPracticeDecision(participant,body.sessionId);
          if (participant.protocol_version!==PILOT_PROTOCOL && (!current.survey || current.survey.sessionId!==body.sessionId)) conflict('Collection survey must be confirmed before Train.');
          const samples=assertDataset(participant,body.sessionId,body.sampleIds);
          const ids=samples.map(s=>s.sampleId).sort();
          if (participant.protocol_version!==PILOT_PROTOCOL && JSON.stringify(ids)!==JSON.stringify(current.survey.sampleIds)) conflict('Dataset changed after survey. Confirm the collection survey again.');
          if (!body.revisionId || safeToken(body.revisionId)!==body.revisionId) conflict('Valid model revision ID required.');
          const lock={ sessionId: body.sessionId, revisionId: body.revisionId, sampleIds: ids, settings: samples[0].settings };
          if(current.lock && canonicalPractice({...current.lock,lockedAt:undefined})!==canonicalPractice({...lock,lockedAt:undefined})) conflict('Official dataset/model already locked.');
          current.lock ??= {...lock,lockedAt:nowIso()};
        }
        writeJsonAtomic(protocolFile(participant),current);
        return {status:200,body:current};
      }

      if (route === 'POST /practice') {
        const participant = state.participants.find(entry => entry.id === normalizeId(body.id));
        if (!participant) throw Object.assign(new Error('That ID was not recognized.'), { status: 404 });
        if(participant.protocol_version===PILOT_PROTOCOL) assertScope(body.record,participant);
        const directory = path.join(collectionDir(sessionsDir, participant.id, body.record?.sessionId), 'practice');
        const previous = readJsonFiles(directory).find(entry => entry.id === body.record?.id);
        const record = { ...sanitizePracticeRecord(body.record, participant, readJsonFiles(directory)), isTestParticipant: isTestParticipant(participant),
          ...(participant.protocol_version===PILOT_PROTOCOL && body.record?.kind==='completed'
            ? {practiceDecisionAt:previous?.practiceDecisionAt ?? protocolState(participant).practice?.at ?? Date.now()} : {}) };
        // Compare legacy archives with the authoritative label without rewriting them.
        if (previous && canonicalPractice({ ...withPracticeTiming(previous), isTestParticipant: isTestParticipant(participant) }) !== canonicalPractice(record)) throw Object.assign(new Error('Practice record is immutable.'), { status: 409 });
        if(participant.protocol_version===PILOT_PROTOCOL && record.kind==='completed') {
          const savedRest=readJsonFiles(directory).find(rest=>rest.kind==='rest' && rest.id===record.restId);
          validateSavedRest(savedRest,participant);
          const current=protocolState(participant);
          if(current.practice?.status==='skipped') conflict('Researcher-skipped Practice cannot be retroactively completed.');
          if(!current.practice) {
            assertBeforeMeasured(participant,record.sessionId);
            current.sessionId=record.sessionId;
            current.practice={status:'completed',at:record.practiceDecisionAt,sessionId:record.sessionId,generation:record.generation,round:record.round,condition:record.condition};
          }
          // Publish the validated completion archive first; retries repair a missing decision.
          if(!previous) writeJsonAtomic(path.join(directory, `${record.id}.json`),record);
          writeJsonAtomic(protocolFile(participant),current);
        } else if (!previous) writeJsonAtomic(path.join(directory, `${record.id}.json`), record);
        return { status: 200, body: { ok: true, id: record.id } };
      }

      const practiceRead = pathname.match(/^\/practice\/([A-Z0-9]+)$/);
      if (practiceRead && method === 'GET') {
        const participant = state.participants.find(entry => entry.id === practiceRead[1]);
        if (!participant) throw Object.assign(new Error('That ID was not recognized.'), { status: 404 });
        const root = path.join(participantRoot(participant.id), 'collection');
        const records = fs.existsSync(root) ? fs.readdirSync(root).flatMap(name => readJsonFiles(path.join(root, name, 'practice')))
          .filter(record => record.participantId === participant.id && record.generation === participantGeneration(participant)) : [];
        return { status: 200, body: { records } };
      }

      if (route === 'POST /save-alert') {
        const id = normalizeId(body.id);
        const participant = state.participants.find((entry) => entry.id === id);
        if (!participant) throw Object.assign(new Error('That ID was not recognized.'), { status: 404 });
        if (!sameGeneration(body, participant)) return { status: 200, body: { ok: true } };
        if (body.active) {
          writeJsonAtomic(alertFile(participant.id), {
            generation: participantGeneration(participant),
            active: true,
            message: String(body.message || 'Study data is still not saving.').slice(0, 300),
            pending: finiteNumber(body.pending, 0),
            at: String(body.at || nowIso()),
          });
        } else if (fs.existsSync(alertFile(participant.id))) {
          fs.unlinkSync(alertFile(participant.id));
        }
        return { status: 200, body: { ok: true } };
      }

      if (route === 'POST /runs') {
        const id = normalizeId(body.id);
        const participant = state.participants.find((entry) => entry.id === id);
        if (!participant) throw Object.assign(new Error('That ID was not recognized.'), { status: 404 });
        validatePilotRun(body.run,participant);
        const stored = sanitizeStoredRun(body.run, participant);
        if (!stored) throw Object.assign(new Error('That game result does not belong to this session.'), { status: 400 });
        const runs = readRuns(participant.id).filter((entry) => entry.id !== stored.id);
        runs.push(stored);
        writeRuns(participant.id, runs);
        return { status: 200, body: { ok: true } };
      }

      if (route === 'POST /contexts/read') {
        // Participant ID is the existing bearer-code credential, as on /join.
        // The client cannot select a different person's scope inside the payload.
        const participant=state.participants.find(p=>p.id===normalizeId(body.id));
        if(!participant) throw Object.assign(new Error('Participant not found.'),{status:404});
        assertScope(body,participant);
        const directory=path.join(collectionDir(sessionsDir,participant.id,body.sessionId),'contexts');
        const envelopes=readJsonFiles(directory).filter(r=>r.context && r.generation===participantGeneration(participant) && r.round===Number(participant.current_round) && r.condition===participant.condition);
        return readContextRecords(directory).then(records=>({status:200,body:{records:envelopes.map(envelope=>({...envelope,derivedDisposition:records.find(r=>r.contextId===envelope.context.contextId)?.disposition??envelope.context.disposition}))}}));
      }

      if (route === 'POST /collection') {
        const id = normalizeId(body.id);
        const participant = state.participants.find((entry) => entry.id === id);
        if (!participant) throw Object.assign(new Error('That ID was not recognized.'), { status: 404 });
        const items = Array.isArray(body.items) ? body.items : [];
        // Read-only ACK for the proven late raw-context replay mechanism. This is
        // deliberately NOT a general inactive-scope bypass or a finalized writer.
        if(isPilot(participant) && participant.status==='completed') {
          const journal=readFinalization(finalizationFile(participant));
          if(!journal?.committed || canonicalPractice(journal.payload.participantAfter)!==canonicalPractice(participant))conflict('Committed completion required for archived retry.');
          const request=journal.payload.request;
          for(const item of items) {
            const record=item?.record,context=record?.context;
            if(item?.kind!=='context' || !record || Object.keys(record).some(key=>!['participantId','sessionId','generation','round','condition','context'].includes(key))
              || record.participantId!==undefined && record.participantId!==participant.id
              || record.sessionId!==request.sessionId || record.generation!==request.generation || record.round!==request.round || record.condition!==request.condition
              || context?.scope?.participantId!==participant.id || context.scope.sessionId!==request.sessionId || context.scope.condition!==request.condition)
              conflict('Archived context retry scope mismatch.');
            try { validateContextRecord(context); } catch { conflict('Invalid archived context retry.'); }
            const hash=crypto.createHash('sha256').update(context.contextId).digest('hex');
            const directory=path.join(collectionDir(sessionsDir,participant.id,record.sessionId),'contexts');
            const previous=readJson(path.join(directory,`${hash}.json`)),raw=readJson(path.join(directory,`${hash}.context.json`));
            const expected={generation:record.generation,round:record.round,condition:record.condition,context};
            if(!previous || !raw || canonicalPractice(previous)!==canonicalPractice(expected) || canonicalPractice(raw)!==canonicalPractice(context))
              conflict('Only canonical-exact already archived context retries are acknowledged.');
          }
          return {status:200,body:{ok:true,acceptedCount:items.length}};
        }
        // A checkpoint may precede its sample in this request. Populate this view
        // only after the complete pilot preflight has validated every sample.
        const validatedSamples = new Map();
        const validateCollectionTrials = (record) => {
          if (!isPilot(participant)) return validateTrialCalibration(record.trials, participant);
          if (record.trials !== undefined && !Array.isArray(record.trials)) conflict('Invalid checkpoint trials.');
          const seen = new Map();
          for (const trial of record.trials ?? []) {
            if (!trial || typeof trial.id !== 'string' || !trial.id || safeToken(trial.id) !== trial.id) conflict('Invalid checkpoint trial identity.');
            const canonical = canonicalPractice(sanitizeTrial(trial));
            if (seen.has(trial.id) && seen.get(trial.id) !== canonical) conflict('Conflicting checkpoint trial identity.');
            seen.set(trial.id, canonical);
            const sample = validatedSamples.get(trial.id) ?? readJson(path.join(collectionDir(sessionsDir, participant.id, record.sessionId), 'samples', `${trial.id}.json`));
            if (!sample || sample.sampleId !== trial.id || sample.participantId !== participant.id
              || sample.experimentId !== participant.experiment_id || sample.sessionId !== record.sessionId
              || Number(sample.generation) !== participantGeneration(participant) || Number(sample.round) !== Number(record.round)
              || sample.condition !== record.condition) conflict('Checkpoint sample scope mismatch.');
            if (canonicalPractice(sample.calibration) !== canonicalPractice(trial.calibration)
              || (sample.firstCrossingAt ?? null) !== (trial.firstCrossingAt ?? null))
              throw Object.assign(new Error('Trial calibration does not match its archived sample.'), {status:400});
          }
        };
        // Match the persisted, sanitized sample fields, not request-only metadata.
        const canonicalSample = (record, archived = false) => canonicalPractice({
          sampleId: record.sampleId, centerDurationMs: record.centerDurationMs, attemptId: record.attemptId,
          generation: Number(record.generation), sessionId: record.sessionId, participantId: record.participantId ?? participant.id,
          experimentId: record.experimentId ?? participant.experiment_id, condition: record.condition, round: Number(record.round),
          phase: String(record.phase || ''), gestureId: String(record.gestureId || ''), gestureLabel: String(record.gestureLabel || ''),
          capturedAt: finiteNumber(record.capturedAt, null), recordingStartedAt: finiteNumber(record.recordingStartedAt, null),
          recordingEndedAt: finiteNumber(record.recordingEndedAt, null), triggeredAt: finiteNumber(record.triggeredAt, null),
          preTriggerPointCount: finiteNumber(record.preTriggerPointCount, 0), points: sanitizePoints(record.points),
          signalSource: record.signalSource === 'live' ? 'live' : 'mock', channelIndex: finiteNumber(record.channelIndex, 0),
          sampleRateHz: archived ? record.sampleRateHz : finiteNumber(record.sampleRateHz, null),
          settings: archived ? record.settings : sanitizeSettings(record.settings),
          ...(record.calibration !== undefined ? {calibration: record.calibration, firstCrossingAt: record.firstCrossingAt ?? null} : {}),
        });
        // Never claim a complete acknowledgement for silently skipped legacy items.
        for (const item of items) {
          const record=item?.record;
          if(!record || !['meta','sample','event','training','run','checkpoint','context'].includes(item.kind)) conflict('Unsupported collection item; nothing was acknowledged.');
          if(!sameGeneration(record,participant)) conflict('Inactive generation; nothing was acknowledged.');
          if(!record.sessionId || safeToken(record.sessionId)!==record.sessionId) conflict('Invalid session scope; nothing was acknowledged.');
          const idKey={sample:'sampleId',event:'eventId',training:'revisionId',run:'id'}[item.kind];
          if(idKey && (!record[idKey] || safeToken(record[idKey])!==record[idKey])) conflict('Invalid record identity; nothing was acknowledged.');
          if(item.kind==='event' && !EVENT_TYPES.has(record.type)) conflict('Unsupported event type; nothing was acknowledged.');
          if(item.kind==='run' && !sanitizeStoredRun(record,participant)) conflict('Run condition scope mismatch; nothing was acknowledged.');
          if(item.kind==='sample') validateSampleCalibration(record,participant);
          if(item.kind==='checkpoint' && !isPilot(participant)) validateTrialCalibration(record.trials,participant);
        }
        // Validate run identity across the entire batch, not just persisted runs.
        // Do this before binding a visit or writing any family of collection item.
        const pendingRuns=new Map();
        for(const item of items.filter(item=>item.kind==='run')) {
          const record=item.record, canonical=canonicalPractice(record);
          if(pendingRuns.has(record.id) && pendingRuns.get(record.id)!==canonical) conflict('Run identity conflicts within the batch; saved runs are immutable.');
          pendingRuns.set(record.id,canonical);
        }
        if (isPilot(participant)) {
          if(new Set(items.map(item=>item.record.sessionId)).size>1) conflict('One dataset session per visit; nothing was acknowledged.');
          if(new Set(items.filter(item=>item.kind==='run' && item.record.runKind==='official' && item.record.completionStatus==='complete').map(item=>item.record.id)).size>1) conflict('One official run per condition; nothing was acknowledged.');
          const pendingSamples=new Map(), pendingContexts=new Map();
          const pendingDeletions=new Set(items.filter(item=>item.kind==='event' && ['sample_deleted','sample_rejected'].includes(item.record?.type)).map(item=>item.record.sampleId));
          for (const item of items) {
            const record=item?.record;
            assertScope(record,participant);
            if(['sample','event','context','training','run'].includes(item.kind) || (item.kind==='checkpoint' && record.trials?.length)) assertPracticeDecision(participant,record.sessionId);
            if (!['meta','sample','event','training','run','checkpoint','context'].includes(item.kind)) conflict('Unsupported collection item; nothing was acknowledged.');
            if(item.kind==='event' && !EVENT_TYPES.has(record.type)) conflict('Unsupported event type; nothing was acknowledged.');
            const state=protocolState(participant), lock=state.lock;
            const dir=collectionDir(sessionsDir,participant.id,record.sessionId);
            if(item.kind==='run') validatePilotRun(record,participant);
            if(item.kind==='context') {
              let context; try { context=validateContextRecord(record.context); } catch(error) { throw Object.assign(error,{status:400}); }
              if(context.scope.participantId!==participant.id || context.scope.sessionId!==record.sessionId || context.scope.condition!==participant.condition || (context.scope.source!=='live' && !isTestParticipant(participant))) conflict('Context participant/source/visit scope mismatch.');
              const key=`${record.sessionId}:${context.contextId}`;
              const previous=readJson(path.join(dir,'contexts',`${crypto.createHash('sha256').update(context.contextId).digest('hex')}.json`));
              const stored={generation:participantGeneration(participant),round:Number(participant.current_round),condition:participant.condition,context};
              if(previous && canonicalPractice(previous)!==canonicalPractice(stored) || pendingContexts.has(key) && canonicalPractice(pendingContexts.get(key))!==canonicalPractice(stored)) conflict('Context record is immutable.');
              pendingContexts.set(key,stored);
              const sample=context.sampleId && readJson(path.join(dir,'samples',`${safeToken(context.sampleId)}.json`));
              if(sample) assertContextSample(context,sample);
            }
            if (item.kind==='checkpoint' && record.trials !== undefined && !Array.isArray(record.trials)) conflict('Invalid checkpoint trials.');
            const idKey={sample:'sampleId',event:'eventId',training:'revisionId',run:'id'}[item.kind];
            if(idKey && (!record[idKey] || safeToken(record[idKey])!==record[idKey])) conflict('Valid immutable record ID required; nothing was acknowledged.');
            if (item.kind==='sample') {
              validateSampleCalibration(record,participant);
              if(record.calibration === undefined && record.firstCrossingAt != null) conflict('First crossing requires calibration; otherwise its anchor cannot be persisted.');
              // The legacy serializer caps arrays; pilot evidence must never be silently shortened.
              if(Array.isArray(record.points) && record.points.length>20000) conflict('Pilot center point limit exceeded; raw evidence was not saved.');
              for(const envelope of readJsonFiles(path.join(dir,'contexts'))) {
                if(envelope.context?.sampleId===record.sampleId) assertContextSample(envelope.context,record);
              }
              if(record.centerDurationMs!==2000 || !record.attemptId || safeToken(record.attemptId)!==record.attemptId || record.recordingStartedAt!==record.triggeredAt || record.recordingEndedAt!==record.triggeredAt+2000) conflict('Pilot sample requires explicit center boundaries and attempt lineage.');
              const previous=readJson(path.join(dir,'samples',`${safeToken(record.sampleId)}.json`));
              if(record.experimentId !== undefined && record.experimentId !== participant.experiment_id) conflict('Sample experiment scope mismatch.');
              if(pendingSamples.has(record.sampleId) && canonicalSample(pendingSamples.get(record.sampleId))!==canonicalSample(record)) conflict('Sample identity conflicts within the batch; raw lineage is immutable.');
              if(previous && canonicalSample(previous, true)!==canonicalSample({...record, capturedAt: record.capturedAt === undefined ? previous.capturedAt : record.capturedAt})) conflict('Sample ID and raw lineage are immutable.');
              if (!previous && !pendingSamples.has(record.sampleId)) {
                const retained=[...retainedSamples(participant,record.sessionId),...pendingSamples.values()].filter(sample=>!pendingDeletions.has(sample.sampleId));
                const quota=sampleBounds(JSON.parse(participant.frozen_settings)).max;
                if(retained.filter(sample=>sample.gestureId===record.gestureId).length>=quota) conflict('Exact retained quota reached; delete/reject before replacing.');
                pendingSamples.set(record.sampleId,record);
              }
              if (lock) {
                const previous=readJson(path.join(dir,'samples',`${safeToken(record.sampleId)}.json`));
                if (!previous || canonicalPractice(previous.points)!==canonicalPractice(record.points) || previous.gestureId!==record.gestureId) conflict('Official dataset is locked.');
              }
              if (!PILOT_GESTURES.includes(record.gestureId) || record.settings?.segmentDurationMs!==2000 || !Array.isArray(record.points) || record.points.length<2 || record.points.some(p=>!Number.isFinite(p.time)||!Number.isFinite(p.value)) || record.points.some((p,i)=>i>0 && p.time<record.points[i-1].time) || record.points[0].time!==record.triggeredAt || record.points.at(-1).time>=record.triggeredAt+2000 || record.points.at(-1).time-record.triggeredAt<1900 || Number(record.preTriggerPointCount||0)!==0) conflict('Pilot sample requires finite center-only 2000ms waveform; context must remain separate.');
              if (record.signalSource!=='live' && !isTestParticipant(participant)) conflict('Official participant samples require live EMG; Mock is test-only.');
              if(validatedSamples.has(record.sampleId) && canonicalSample(validatedSamples.get(record.sampleId))!==canonicalSample(record)) conflict('Sample identity conflicts within the batch; raw lineage is immutable.');
              validatedSamples.set(record.sampleId, {...record, participantId: participant.id, experimentId: participant.experiment_id});
            }
            if (lock && item.kind==='event' && ['sample_deleted','sample_replaced','sample_rejected','capture_started','capture_completed'].includes(record.type)) conflict('Official dataset is locked.');
            if (lock && item.kind==='checkpoint' && (record.trials?.length!==lock.sampleIds.length || record.trials?.some(t=>!lock.sampleIds.includes(t.id)))) conflict('Official dataset checkpoint is locked.');
            if (item.kind==='training') {
              if(!lock || lock.revisionId!==record.revisionId || record.sampleIds?.length!==lock.sampleIds.length || record.sampleIds?.some(id=>!lock.sampleIds.includes(id))) conflict('Training requires the locked official lineage.');
              assertDataset(participant,record.sessionId,record.sampleIds);
              const incoming=sanitizeTraining(record,participant),attemptId=incoming.trainingAttemptId;
              if(!attemptId || safeToken(attemptId)!==attemptId) conflict('Valid training attempt identity required.');
              const previousAttempt=readJson(path.join(dir,'training-attempts',`${attemptId}.json`));
              if(previousAttempt && canonicalPractice(previousAttempt)!==canonicalPractice(incoming)) conflict('Training attempt is immutable.');
              const ready=readJson(path.join(dir,'training',`${record.revisionId}.json`));
              if(ready?.status==='success' && !previousAttempt) conflict('Ready official model is frozen; restore it without a new training record.');
            }
          }
          for (const item of items.filter(item => item.kind === 'checkpoint')) validateCollectionTrials(item.record);
          // Join pending families only after all items are validated, independent of batch order.
          for(const {context} of pendingContexts.values()) {
            const sample=context.sampleId && (pendingSamples.get(context.sampleId) ?? readJson(path.join(collectionDir(sessionsDir,participant.id,context.scope.sessionId),'samples',`${safeToken(context.sampleId)}.json`)));
            if(sample) assertContextSample(context,sample);
          }
        }
        if(isPilot(participant) && items.length) {
          const visit=protocolState(participant);
          if(!visit.sessionId) { visit.sessionId=items[0].record.sessionId;writeJsonAtomic(protocolFile(participant),visit); }
        }
        const contextWrites=[];
        for (const item of items) {
          const record = item?.record;
          if (!record || !sameGeneration(record, participant)) {
            if (record && (record.calibration !== undefined || record.trials?.some(trial => trial.calibration !== undefined))) throw Object.assign(new Error('Calibration belongs to an inactive generation.'), { status: 409 });
            continue;
          }
          if(item?.kind==='context') {
            assertScope(record,participant);
            let context; try { context=validateContextRecord(record.context); } catch(error) { throw Object.assign(error,{status:400}); }
            if(context.scope.participantId!==participant.id || context.scope.sessionId!==record.sessionId || context.scope.condition!==participant.condition) conflict('Context participant/session scope mismatch.');
            const filePath=path.join(collectionDir(sessionsDir,participant.id,record.sessionId),'contexts',`${crypto.createHash('sha256').update(context.contextId).digest('hex')}.json`);
            const stored={generation:participantGeneration(participant),round:Number(participant.current_round),condition:participant.condition,context};
            const previous=readJson(filePath);
            if(previous && canonicalPractice(previous)!==canonicalPractice(stored)) conflict('Context record is immutable.');
            if(!previous) writeJsonAtomic(filePath,stored);
            const directory=path.dirname(filePath);
            contextWrites.push(persistContextRecord(directory,context).then(async () => {
              const event=readJsonFiles(path.join(collectionDir(sessionsDir,participant.id,record.sessionId),'events')).filter(e=>e.sampleId===context.sampleId && ['sample_deleted','sample_rejected'].includes(e.type)).sort((a,b)=>Number(a.at)-Number(b.at)).at(-1);
              if(event) { const disposition=event.type==='sample_deleted'?'deleted':'rejected'; const current=(await readContextRecords(directory)).find(r=>r.contextId===context.contextId); if(current?.disposition!==disposition) await setContextDisposition(directory,context.contextId,disposition); }
            }));
          } else if (item?.kind === 'checkpoint') {
            const sessionId = safeToken(record.sessionId, '');
            if (!sessionId) continue;
            if (!isPilot(participant)) validateTrialCalibration(record.trials, participant); // Pilot batch was fully checked before any writes.
            const trials = (Array.isArray(record.trials) ? record.trials : []).slice(0, 200).map(sanitizeTrial).filter(Boolean);
            writeJsonAtomic(checkpointFile(participant.id), {
              sessionId,
              condition: participant.condition,
              generation: participantGeneration(participant),
              round: finiteNumber(record.round, Number(participant.current_round) || 1),
              stage: String(record.stage || 'capture'),
              unlockedThrough: String(record.unlockedThrough || record.stage || 'capture'),
              modelRevisionId: record.modelRevisionId ? safeToken(record.modelRevisionId, '') : null,
              trials,
              pendingReplacements: Array.isArray(record.pendingReplacements) ? record.pendingReplacements.slice(0, 200) : [],
              openCapture: record.openCapture ?? null,
              trainingRun: record.trainingRun ?? null,
              updatedAt: Date.now(),
            });
          } else if (item?.kind === 'meta' && record) {
            const sessionId = safeToken(record.sessionId, '');
            if (!sessionId) continue;
            writeJsonAtomic(path.join(collectionDir(sessionsDir, participant.id, sessionId), 'meta.json'), {
              ...record,
              participantId: participant.id,
              isTestParticipant: isTestParticipant(participant),
              condition: participant.condition,
              updatedAt: nowIso(),
            });
          } else if (item?.kind === 'sample' && record) {
            const sessionId = safeToken(record.sessionId, '');
            const sampleId = safeToken(record.sampleId, '');
            if (!sessionId || !sampleId) continue;
            const filePath = path.join(collectionDir(sessionsDir, participant.id, sessionId), 'samples', `${sampleId}.json`);
            let calibrationFields = {};
            if (record.calibration !== undefined) {
              const explicitCenter = record.centerDurationMs === 2000;
              const validWindow = explicitCenter
                ? validatePracticePoints(record.points, 1900) && record.settings?.segmentDurationMs===2000 && record.preTriggerPointCount===0 && record.recordingEndedAt===record.triggeredAt+2000 && record.points.every(p=>p.time>=record.triggeredAt && p.time<record.recordingEndedAt)
                : validatePracticePoints(record.points, record.settings?.segmentDurationMs) && record.points.at(-1).time===record.recordingEndedAt;
              if (!validWindow
                || !Number.isInteger(record.preTriggerPointCount) || record.preTriggerPointCount < 0
                || record.points[record.preTriggerPointCount]?.time !== record.triggeredAt
                || record.points[0].time !== record.recordingStartedAt
                || record.recordingEndedAt - record.triggeredAt < record.settings.segmentDurationMs) throw Object.assign(new Error('Invalid calibrated sample waveform or anchors.'), { status: 400 });
              if (record.calibration !== null) {
                const reference = readJsonFiles(path.join(collectionDir(sessionsDir, participant.id, sessionId), 'practice')).find(rest => rest.kind === 'rest' && rest.id === record.calibration.restId);
                if (!reference || !sameCalibration(record.calibration, reference.calibration)
                  || !['participantId', 'experimentId', 'sessionId', 'generation', 'round', 'condition', 'signalSource', 'channelIndex'].every(key => record[key] === reference[key])) throw Object.assign(new Error('Sample calibration scope mismatch.'), { status: 400 });
              } else if (participant.condition === 'threshold' && record.gestureId !== 'relax') throw Object.assign(new Error('Threshold sample requires calibration.'), { status: 400 });
              const crossing = record.firstCrossingAt;
              if (participant.condition === 'threshold' && record.gestureId !== 'relax' && (!Number.isFinite(crossing) || record.triggeredAt - crossing < 100)) throw Object.assign(new Error('Invalid confirmed threshold anchor.'), { status: 400 });
              calibrationFields = { calibration: record.calibration, firstCrossingAt: crossing ?? null };
            }
            if (fs.existsSync(filePath)) continue;
            const points = sanitizePoints(record.points);
            writeJsonAtomic(filePath, {
              sampleId,
              ...(record.centerDurationMs !== undefined ? { centerDurationMs: record.centerDurationMs } : {}),
              ...(record.attemptId ? { attemptId: record.attemptId } : {}),
              generation: participantGeneration(participant),
              sessionId,
              participantId: participant.id,
              experimentId: participant.experiment_id,
              isTestParticipant: isTestParticipant(participant),
              condition: participant.condition,
              round: finiteNumber(record.round, Number(participant.current_round) || 1),
              phase: String(record.phase || ''),
              gestureId: String(record.gestureId || ''),
              gestureLabel: String(record.gestureLabel || ''),
              capturedAt: finiteNumber(record.capturedAt, Date.now()),
              recordingStartedAt: finiteNumber(record.recordingStartedAt, null),
              recordingEndedAt: finiteNumber(record.recordingEndedAt, null),
              triggeredAt: finiteNumber(record.triggeredAt, null),
              preTriggerPointCount: finiteNumber(record.preTriggerPointCount, 0),
              pointCount: points.length,
              points,
              signalSource: record.signalSource === 'live' ? 'live' : 'mock',
              channelIndex: finiteNumber(record.channelIndex, 0),
              sampleRateHz: finiteNumber(record.sampleRateHz, null),
              settings: sanitizeSettings(record.settings),
              ...calibrationFields,
            });
          } else if (item?.kind === 'event' && record && EVENT_TYPES.has(record.type)) {
            const sessionId = safeToken(record.sessionId, '');
            const eventId = safeToken(record.eventId, '');
            if (!sessionId || !eventId) continue;
            const filePath = path.join(collectionDir(sessionsDir, participant.id, sessionId), 'events', `${eventId}.json`);
            if (fs.existsSync(filePath)) continue;
            writeJsonAtomic(filePath, {
              eventId,
              generation: participantGeneration(participant),
              sessionId,
              participantId: participant.id,
              isTestParticipant: isTestParticipant(participant),
              condition: participant.condition,
              round: finiteNumber(record.round, 1),
              phase: String(record.phase || ''),
              type: record.type,
              at: finiteNumber(record.at, Date.now()),
              sampleId: record.sampleId ? safeToken(record.sampleId, '') : null,
              replacementSampleId: record.replacementSampleId ? safeToken(record.replacementSampleId, '') : null,
              detail: String(record.detail || '').slice(0, 500),
            });
            if(['sample_deleted','sample_rejected'].includes(record.type)) {
              const directory=path.join(collectionDir(sessionsDir,participant.id,sessionId),'contexts');
              contextWrites.push((async()=>{for(const context of await readContextRecords(directory)) if(context.sampleId===record.sampleId) await setContextDisposition(directory,context.contextId,record.type==='sample_deleted'?'deleted':'rejected');})());
            }
          } else if (item?.kind === 'training' && record) {
            const sessionId = safeToken(record.sessionId, '');
            const revisionId = safeToken(record.revisionId, '');
            if (!sessionId || !revisionId) continue;
            const filePath = path.join(collectionDir(sessionsDir, participant.id, sessionId), 'training', `${revisionId}.json`);
            const stored=sanitizeTraining(record,participant);
            if(isPilot(participant)) {
              const attemptPath=path.join(collectionDir(sessionsDir,participant.id,sessionId),'training-attempts',`${stored.trainingAttemptId}.json`);
              if(fs.existsSync(attemptPath)) continue;
              writeJsonAtomic(attemptPath,stored);
              if(readJson(filePath)?.status!=='success') writeJsonAtomic(filePath,stored);
            } else if(!fs.existsSync(filePath)) writeJsonAtomic(filePath,stored);
          } else if (item?.kind === 'run') {
            const stored = sanitizeStoredRun(record, participant);
            if (!stored || !pendingRuns.has(stored.id)) continue;
            pendingRuns.delete(stored.id); // Exact canonical duplicates are acknowledged, written once.
            const sessionId = stored.sessionId || 'session';
            writeJsonAtomic(path.join(collectionDir(sessionsDir, participant.id, sessionId), 'runs', `${stored.id}.json`), {
              ...stored,
              participantId: participant.id,
            });
            const runs = readRuns(participant.id).filter((entry) => entry.id !== stored.id);
            runs.push(stored);
            writeRuns(participant.id, runs);
          }
        }
        const acknowledgement={ status: 200, body: { ok: true, acceptedCount: items.length } };
        return contextWrites.length ? Promise.all(contextWrites).then(()=>acknowledgement) : acknowledgement;
      }

      if (route === 'POST /progress') {
        const id = normalizeId(body.id);
        const participant = state.participants.find((entry) => entry.id === id);
        if (!participant) throw Object.assign(new Error('That ID was not recognized.'), { status: 404 });
        const experiment = findExperiment(state, participant.experiment_id);
        if(isPilot(participant)) {
          const frozen=JSON.parse(participant.frozen_settings);
          if(body.participantId!==undefined && body.participantId!==participant.id) conflict('Participant scope mismatch.');
          const round=integerInRange(body.round,1,Number(frozen.repetitions),'Round');
          const file=finalizationFile(participant,round), prior=readFinalization(file);
          const request=finalizationRequest(body);
          if(prior) {
            if(canonicalPractice(request)!==canonicalPractice(prior.payload.request)) conflict('Finalization retry must preserve immutable scope and sample lineage.');
            return {status:200,body:prior.payload.response};
          }
          assertScope(body,participant);
          const evidence=completionEvidence(participant,body.sessionId,request.sampleIds);
          const trials=evidence.samples.map(trialFromSample);
          validateTrialCalibration(trials,participant);
          const completedAt=nowIso(),savedByGesture={};
          for(const trial of trials) {const label=String(trial.gestureName||trial.gestureId||'unknown');savedByGesture[label]=(savedByGesture[label]||0)+1;}
          const finished=round>=Number(frozen.repetitions);
          const after={...participant,status:finished?'completed':'in_progress',current_round:String(finished?round:round+1)};
          if(!finished)after.condition=conditionOrder(participant)[round];
          const visitBefore=readJson(protocolFile(participant));
          const payload={request,evidence,participantBefore:{...participant},participantAfter:after,visitBefore,
            visitAfter:{...protocolState(participant),completedAt},
            roundRecord:{participant_id:participant.id,experiment_id:experiment.id,round:String(round),trial_count:String(trials.length),saved_count:String(trials.length),usable_count:String(trials.filter(t=>t.quality==='usable').length),completed_at:completedAt},
            result:{participantId:participant.id,experimentId:experiment.id,isTestParticipant:isTestParticipant(participant),condition:participant.condition,round,savedCount:trials.length,savedByGesture,completedAt,trials},
            response:{status:after.status,condition:after.condition,round:Number(after.current_round),repetitions:Number(frozen.repetitions)},
          };
          const journal=writeFinalization(file,payload);
          finalizationFault('after-intent');
          publishFinalization(file,journal,state);
          return {status:200,body:payload.response};
        }
        const round = integerInRange(body.round, 1, Number(experiment.repetitions), 'Round');
        if (participant.status === 'completed') {
          throw Object.assign(new Error('This session is already finished.'), { status: 409 });
        }
        if (Number(participant.current_round) !== round) {
          throw Object.assign(new Error('This round is no longer the active one.'), { status: 409 });
        }
        let trials = Array.isArray(body.trials) ? body.trials : [];
        validateTrialCalibration(trials, participant);
        const usableCount = trials.filter((trial) => trial?.quality === 'usable').length;
        const savedByGesture = {};
        for (const trial of trials) {
          const label = String(trial?.gestureName || trial?.gestureId || 'unknown');
          savedByGesture[label] = (savedByGesture[label] || 0) + 1;
        }
        state.rounds.push({
          participant_id: participant.id,
          experiment_id: experiment.id,
          round: String(round),
          trial_count: String(trials.length),
          saved_count: String(trials.length),
          usable_count: String(usableCount),
          completed_at: nowIso(),
        });
        saveRounds(state.rounds);
        fs.mkdirSync(sessionsDir, { recursive: true });
        fs.writeFileSync(path.join(sessionsDir, `${participant.id}-round-${round}.json`), `${JSON.stringify({
          participantId: participant.id,
          experimentId: experiment.id,
          isTestParticipant: isTestParticipant(participant),
          condition: participant.condition,
          round,
          savedCount: trials.length,
          savedByGesture,
          completedAt: nowIso(),
          trials,
        }, null, 2)}\n`);

        const finished = round >= Number(experiment.repetitions);
        participant.status = finished ? 'completed' : 'in_progress';
        participant.current_round = finished ? String(round) : String(round + 1);
        if(isPilot(participant) && !finished) participant.condition=conditionOrder(participant)[round];
        saveParticipants(state.participants);
        return {
          status: 200,
          body: {
            status: participant.status,
            condition: participant.condition,
            round: Number(participant.current_round),
            repetitions: Number(experiment.repetitions),
          },
        };
      }

      requireAdmin(headers, state);

      if (route === 'GET /experiments') {
        return {
          status: 200,
          body: {
            experiments: state.experiments.map((experiment) => summarizeExperiment(experiment, state.participants)),
          },
        };
      }

      if (route === 'POST /experiments') {
        const name = String(body.name ?? '').trim();
        if (!name) throw Object.assign(new Error('Name the experiment.'), { status: 400 });
        const protocolVersion = body.protocolVersion ?? PILOT_PROTOCOL;
        if (![PILOT_PROTOCOL, PREVIOUS_PILOT_PROTOCOL, HISTORICAL_PILOT_PROTOCOL, 'legacy-fixed-v1'].includes(protocolVersion)) throw Object.assign(new Error('Unknown protocol version.'), { status: 400 });
        const pilot = isPilot({protocol_version:protocolVersion});
        const repetitions = pilot ? pilotRepetitions({protocol_version:protocolVersion}) : integerInRange(body.repetitions ?? 3, 1, 30, 'Repetitions');
        if(pilot && ((body.repetitions!==undefined && Number(body.repetitions)!==repetitions) || (body.obstacleCount!==undefined && Number(body.obstacleCount)!==20))) conflict('Pilot protocol requires protocol-specific visit count and balanced20 official trials.');
        const capturesMin = integerInRange(body.capturesMin ?? body.capturesPerRound ?? (pilot ? 8 : 3), 1, 20, 'Minimum samples');
        const capturesMax = integerInRange(body.capturesMax ?? body.capturesPerRound ?? capturesMin, 1, 20, 'Maximum samples');
        if (pilot && capturesMin !== capturesMax) throw Object.assign(new Error('Pilot requires an exact retained quota (minimum equals maximum).'), { status: 400 });
        const obstacleCount = pilot ? 20 : integerInRange(body.obstacleCount ?? DEFAULT_OBSTACLE_COUNT, 1, 200, 'Obstacle count');
        const startingLives = integerInRange(body.startingLives ?? DEFAULT_STARTING_LIVES, 1, 10, 'Lives');
        if (capturesMin > capturesMax) {
          throw Object.assign(new Error('The minimum cannot be higher than the maximum.'), { status: 400 });
        }
        const experiment = {
          id: randomId(6, 'EXP-'),
          protocol_version: protocolVersion,
          name,
          repetitions: String(repetitions),
          captures_per_round: String(capturesMax),
          captures_min: String(capturesMin),
          captures_max: String(capturesMax),
          obstacle_count: String(obstacleCount),
          starting_lives: String(startingLives),
          status: 'active',
          notes: String(body.notes ?? '').trim(),
          created_at: nowIso(),
        };
        state.experiments.push(experiment);
        saveExperiments(state.experiments);
        return { status: 201, body: summarizeExperiment(experiment, state.participants) };
      }

      const experimentMatch = pathname.match(/^\/experiments\/([^/]+)$/);
      if (experimentMatch && method === 'PATCH') {
        const experiment = findExperiment(state, decodeURIComponent(experimentMatch[1]));
        if(isPilot(experiment)) {
          const current=sampleBounds(experiment);
          const min=Number(body.capturesMin ?? body.capturesPerRound ?? current.min);
          const max=Number(body.capturesMax ?? body.capturesPerRound ?? current.max);
          if(min!==max || (body.repetitions!==undefined && Number(body.repetitions)!==pilotRepetitions(experiment)) || (body.obstacleCount!==undefined && Number(body.obstacleCount)!==20)) conflict('Pilot protocol requires exact retained quota, protocol-specific visit count and balanced20 official trials.');
        }
        const started = state.participants.some((participant) => (
          participant.experiment_id === experiment.id && participant.status !== 'assigned'
        ));
        if (body.name !== undefined) {
          const name = String(body.name).trim();
          if (!name) throw Object.assign(new Error('Name the experiment.'), { status: 400 });
          experiment.name = name;
        }
        if (body.notes !== undefined) experiment.notes = String(body.notes).trim();
        if (body.obstacleCount !== undefined) {
          experiment.obstacle_count = String(integerInRange(body.obstacleCount, 1, 200, 'Obstacle count'));
        }
        if (body.startingLives !== undefined) {
          experiment.starting_lives = String(integerInRange(body.startingLives, 1, 10, 'Lives'));
        }
        if (body.status !== undefined) {
          if (body.status !== 'active' && body.status !== 'closed') {
            throw Object.assign(new Error('Status must be active or closed.'), { status: 400 });
          }
          experiment.status = body.status;
        }
        if (body.repetitions !== undefined || body.capturesMin !== undefined || body.capturesMax !== undefined || body.capturesPerRound !== undefined) {
          if (started && !isPilot(experiment)) {
            throw Object.assign(new Error('Reset participants before changing the round count or sample limits.'), { status: 409 });
          }
          if (body.repetitions !== undefined) {
            experiment.repetitions = String(integerInRange(body.repetitions, 1, 30, 'Repetitions'));
          }
          const current = sampleBounds(experiment);
          const capturesMin = body.capturesMin !== undefined
            ? integerInRange(body.capturesMin, 1, 20, 'Minimum samples')
            : isPilot(experiment) && body.capturesPerRound !== undefined
              ? integerInRange(body.capturesPerRound, 1, 20, 'Minimum samples')
            : current.min;
          const capturesMax = body.capturesMax !== undefined
            ? integerInRange(body.capturesMax, 1, 20, 'Maximum samples')
            : body.capturesPerRound !== undefined
              ? integerInRange(body.capturesPerRound, 1, 20, 'Maximum samples')
              : current.max;
          if (capturesMin > capturesMax) {
            throw Object.assign(new Error('The minimum cannot be higher than the maximum.'), { status: 400 });
          }
          experiment.captures_min = String(capturesMin);
          experiment.captures_max = String(capturesMax);
          experiment.captures_per_round = String(capturesMax);
        }
        saveExperiments(state.experiments);
        return { status: 200, body: summarizeExperiment(experiment, state.participants) };
      }

      if (experimentMatch && method === 'DELETE') {
        const experimentId = decodeURIComponent(experimentMatch[1]);
        findExperiment(state, experimentId);
        const started = state.participants.some((participant) => (
          participant.experiment_id === experimentId && participant.status !== 'assigned'
        ));
        if (started) {
          throw Object.assign(new Error('This experiment has started sessions. Close it, or reset those IDs first.'), { status: 409 });
        }
        saveExperiments(state.experiments.filter((experiment) => experiment.id !== experimentId));
        saveParticipants(state.participants.filter((participant) => participant.experiment_id !== experimentId));
        return { status: 200, body: { ok: true } };
      }

      if (route === 'GET /participants') {
        const experimentId = searchParams.get('experimentId') ?? '';
        const experiment = findExperiment(state, experimentId);
        return {
          status: 200,
          body: {
            participants: state.participants
              .filter((participant) => participant.experiment_id === experimentId)
              .map((participant) => presentParticipant(participant, experiment.repetitions)),
            saveAlerts: state.participants
              .filter((participant) => participant.experiment_id === experimentId)
              .map(readAlert)
              .filter(Boolean),
            rounds: state.rounds
              .filter((round) => round.experiment_id === experimentId)
              .map((round) => ({
                participantId: round.participant_id,
                round: Number(round.round),
                trialCount: Number(round.trial_count),
                savedCount: Number(round.saved_count || round.trial_count),
                usableCount: Number(round.usable_count),
                completedAt: round.completed_at,
              })),
          },
        };
      }

      if (route === 'POST /participants/generate') {
        const experiment = findExperiment(state, String(body.experimentId ?? ''));
        if (Object.hasOwn(body, 'isTestParticipant') && typeof body.isTestParticipant !== 'boolean') {
          throw Object.assign(new Error('isTestParticipant must be a boolean.'), { status: 400 });
        }
        if(body.groupCode && !/^[A-Za-z0-9_-]{1,40}$/.test(body.groupCode)) throw Object.assign(new Error('Group code must be 1–40 letters, digits, underscores or hyphens; no names.'),{status:400});
        const testParticipant = body.isTestParticipant === true;
        const count = integerInRange(body.count, 1, 200, 'ID count');
        const assignment = body.assignment ?? 'balanced';
        if (!['balanced', 'button', 'threshold'].includes(assignment)) {
          throw Object.assign(new Error('Assignment must be balanced, button, or threshold.'), { status: 400 });
        }
        const existing = new Set(state.participants.map((participant) => participant.id));
        const conditions = [];
        if (assignment === 'button' || assignment === 'threshold') {
          for (let index = 0; index < count; index += 1) conditions.push(assignment);
        } else {
          let buttonCount=state.participants.filter(p=>p.experiment_id===experiment.id && (isPilot(p)?conditionOrder(p)[0]:p.condition)==='button').length;
          let thresholdCount=state.participants.filter(p=>p.experiment_id===experiment.id && (isPilot(p)?conditionOrder(p)[0]:p.condition)==='threshold').length;
          for(let index=0;index<count;index++) { const next=buttonCount<=thresholdCount?'button':'threshold';conditions.push(next); if(next==='button')buttonCount++; else thresholdCount++; }
        }
        const created = [];
        for (const condition of shuffle(conditions)) {
          let id = randomId(6);
          while (existing.has(id)) id = randomId(6);
          existing.add(id);
          const participant = {
            id,
            experiment_id: experiment.id,
            protocol_version: experiment.protocol_version || 'legacy-fixed-v1',
            condition_order: [PILOT_PROTOCOL,PREVIOUS_PILOT_PROTOCOL].includes(experiment.protocol_version) ? condition : condition === 'button' ? 'button,threshold' : 'threshold,button',
            frozen_settings: JSON.stringify(withSampleLimits(experiment)),
            official_sequence: JSON.stringify(protocolSequence()),
            group_code: String(body.groupCode || '').trim(),
            member_code: body.groupCode ? String(state.participants.filter(p=>p.experiment_id===experiment.id && p.group_code===String(body.groupCode).trim()).length+1) : '',
            is_test_participant: String(testParticipant),
            condition,
            status: 'assigned',
            current_round: '1',
            created_at: nowIso(),
          };
          state.participants.push(participant);
          created.push(presentParticipant(participant, experiment.repetitions));
        }
        saveParticipants(state.participants);
        return { status: 201, body: { participants: created } };
      }

      const resetMatch = pathname.match(/^\/participants\/([^/]+)\/reset$/);
      if (resetMatch && method === 'POST') {
        const id = normalizeId(decodeURIComponent(resetMatch[1]));
        const participant = state.participants.find((entry) => entry.id === id);
        if (!participant) throw Object.assign(new Error('Participant not found.'), { status: 404 });
        if(!isTestParticipant(participant)) conflict('Real participant records cannot be reset. Preserve historical evidence and the stable person.');
        if(isPilot(participant)) {
          const root=participantRoot(participant.id);
          if(fs.existsSync(root)) fs.renameSync(root, path.join(sessionsDir, `${participant.id}-archive-generation-${participantGeneration(participant)}-${Date.now()}`));
          const runs=readRuns(participant.id);
          if(runs.length) writeJsonAtomic(path.join(sessionsDir,`${participant.id}-archive-runs-${Date.now()}.json`),runs);
          participant.condition=conditionOrder(participant)[0];
        }
        participant.status = 'assigned';
        participant.current_round = '1';
        participant.generation = String(participantGeneration(participant) + 1);
        saveParticipants(state.participants);
        saveRounds(state.rounds.filter((round) => round.participant_id !== id));
        if (fs.existsSync(sessionsDir)) {
          for (const fileName of fs.readdirSync(sessionsDir)) {
            if (fileName.startsWith(`${id}-round-`) || fileName === `${id}-runs.json`) {
              fs.unlinkSync(path.join(sessionsDir, fileName));
            }
          }
          const collectionRoot = path.join(sessionsDir, id);
          if (fs.existsSync(collectionRoot)) fs.rmSync(collectionRoot, { recursive: true, force: true });
        }
        const experiment = findExperiment(state, participant.experiment_id);
        return { status: 200, body: presentParticipant(participant, experiment.repetitions) };
      }

      const participantMatch = pathname.match(/^\/participants\/([^/]+)$/);
      if (participantMatch && method === 'PATCH') {
        const id = normalizeId(decodeURIComponent(participantMatch[1]));
        const participant = state.participants.find((entry) => entry.id === id);
        if (!participant) throw Object.assign(new Error('Participant not found.'), { status: 404 });
        if (participant.status !== 'assigned') {
          throw Object.assign(new Error('Reset this ID before changing its assignment.'), { status: 409 });
        }
        if (body.condition !== 'button' && body.condition !== 'threshold') {
          throw Object.assign(new Error('Assignment must be button or threshold.'), { status: 400 });
        }
        participant.condition = body.condition;
        if(isPilot(participant)) participant.condition_order=[PILOT_PROTOCOL,PREVIOUS_PILOT_PROTOCOL].includes(participant.protocol_version) ? body.condition : body.condition==='button'?'button,threshold':'threshold,button';
        saveParticipants(state.participants);
        const experiment = findExperiment(state, participant.experiment_id);
        return { status: 200, body: presentParticipant(participant, experiment.repetitions) };
      }

      if (participantMatch && method === 'DELETE') {
        const id = normalizeId(decodeURIComponent(participantMatch[1]));
        const participant = state.participants.find((entry) => entry.id === id);
        if (!participant) throw Object.assign(new Error('Participant not found.'), { status: 404 });
        if (participant.status !== 'assigned') {
          throw Object.assign(new Error('Reset this ID before removing it.'), { status: 409 });
        }
        saveParticipants(state.participants.filter((entry) => entry.id !== id));
        return { status: 200, body: { ok: true } };
      }

      const collectionExportMatch = pathname.match(/^\/export\/([^/]+)\/collection$/);
      if (collectionExportMatch && method === 'GET') {
        const experiment = findExperiment(state, decodeURIComponent(collectionExportMatch[1]));
        const mine = state.participants.filter((participant) => participant.experiment_id === experiment.id);
        const sessions = [];
        const samples = [];
        const events = [];
        const training = [];
        const trainingAttempts = [];
        const runs = [];
        const practice = [];
        const contexts = [];
        const contextDispositions = [];
        for (const participant of mine) {
          const labelRecords = records => records.map(record => ({ ...record, participantId: participant.id, isTestParticipant: isTestParticipant(participant) }));
          const root = path.join(sessionsDir, participant.id, 'collection');
          if (fs.existsSync(root)) {
            for (const sessionName of fs.readdirSync(root)) {
              const dir = path.join(root, sessionName);
              if (!fs.statSync(dir).isDirectory()) continue;
              const metaPath = path.join(dir, 'meta.json');
              if (fs.existsSync(metaPath)) {
                try {
                  sessions.push(...labelRecords([JSON.parse(fs.readFileSync(metaPath, 'utf8'))]));
                } catch {
                  // Skip a session file that did not finish writing.
                }
              }
              samples.push(...labelRecords(readJsonFiles(path.join(dir, 'samples'))));
              practice.push(...labelRecords(readJsonFiles(path.join(dir, 'practice'))));
              contexts.push(...labelRecords(readJsonFiles(path.join(dir, 'contexts')).filter(record=>record.context)));
              contextDispositions.push(...labelRecords(readJsonFiles(path.join(dir,'contexts')).filter(record=>record.contextId && record.disposition && record.eventId)).map(record=>({...record,sessionId:sessionName})));
              events.push(...labelRecords(readJsonFiles(path.join(dir, 'events'))));
              training.push(...labelRecords(readJsonFiles(path.join(dir, 'training'))));
              trainingAttempts.push(...labelRecords(readJsonFiles(path.join(dir,'training-attempts'))));
              runs.push(...labelRecords(readJsonFiles(path.join(dir, 'runs'))));
            }
          }
          if (!fs.existsSync(sessionsDir)) continue;
          for (const fileName of fs.readdirSync(sessionsDir)) {
            if (!fileName.startsWith(`${participant.id}-round-`) || !fileName.endsWith('.json')) continue;
            const roundFile = readJson(path.join(sessionsDir, fileName));
            const known = new Set(samples.map((sample) => sample.sampleId));
            for (const trial of Array.isArray(roundFile?.trials) ? roundFile.trials : []) {
              const sampleId = safeToken(trial?.id, '');
              if (!sampleId || known.has(sampleId)) continue;
              known.add(sampleId);
              const points = sanitizePoints(trial.points);
              samples.push({
                sampleId,
                sessionId: '',
                participantId: participant.id,
                experimentId: experiment.id,
                isTestParticipant: isTestParticipant(participant),
                condition: roundFile.condition || participant.condition,
                round: finiteNumber(roundFile.round, 0),
                phase: 'review',
                gestureId: String(trial.gestureId || ''),
                gestureLabel: String(trial.gestureName || ''),
                capturedAt: finiteNumber(trial.capturedAt, 0),
                recordingStartedAt: points[0]?.time ?? null,
                recordingEndedAt: finiteNumber(trial.completedAt, null),
                triggeredAt: finiteNumber(trial.triggeredAt, null),
                preTriggerPointCount: finiteNumber(trial.preTriggerPointCount, 0),
                pointCount: points.length,
                points,
                signalSource: '',
                channelIndex: '',
                sampleRateHz: null,
                settings: roundFile.settings ?? {},
              });
            }
          }
        }
        const sessionRows = sessions.map((session) => ({
          session_id: session.sessionId,
          participant_id: session.participantId,
          experiment_id: session.experimentId,
          condition: session.condition,
          round: session.round,
          phase: session.phase,
          signal_source: session.signalSource,
          channel: session.channelIndex,
          sample_rate_hz: session.sampleRateHz ?? '',
          device_name: session.deviceName ?? '',
          segment_duration_ms: session.settings?.segmentDurationMs ?? '',
          pre_trigger_window_ms: session.settings?.preTriggerWindowMs ?? '',
          activity_threshold: session.settings?.activityThreshold ?? '',
          cooldown_ms: session.settings?.cooldownMs ?? '',
          countdown_ms: session.settings?.countdownMs ?? '',
          captures_min: session.settings?.capturesMin ?? '',
          captures_max: session.settings?.capturesMax ?? '',
          feature_set_id: session.settings?.featureSetId ?? '',
          classifier: session.settings?.classifier ?? '',
          updated_at: session.updatedAt ?? '',
        }));
        const replacedBy = new Map(events
          .filter((event) => event.type === 'sample_replaced' && event.sampleId)
          .map((event) => [event.sampleId, event.replacementSampleId || '']));
        const deletedIds = new Set(events
          .filter((event) => ['sample_deleted','sample_rejected'].includes(event.type) && event.sampleId)
          .map((event) => event.sampleId));
        const sampleRows = samples.map((sample) => ({
          sample_id: sample.sampleId,
          attempt_id: sample.attemptId ?? '',
          center_duration_ms: sample.centerDurationMs ?? '',
          status: events.some(event=>event.type==='sample_replaced' && event.sampleId===sample.sampleId) ? 'replaced' : events.some(event=>event.type==='sample_deleted' && event.sampleId===sample.sampleId) ? 'deleted' : events.some(event=>event.type==='sample_rejected' && event.sampleId===sample.sampleId) ? 'rejected' : 'retained',
          session_id: sample.sessionId,
          participant_id: sample.participantId,
          condition: sample.condition,
          round: sample.round,
          gesture_id: sample.gestureId,
          gesture_label: sample.gestureLabel,
          captured_at: sample.capturedAt,
          recording_started_at: sample.recordingStartedAt,
          recording_ended_at: sample.recordingEndedAt,
          triggered_at: sample.triggeredAt,
          first_crossing_at: sample.firstCrossingAt ?? '',
          calibration_revision: sample.calibration?.revision ?? '',
          calibration_json: sample.calibration ? JSON.stringify(sample.calibration) : '',
          pre_trigger_point_count: sample.preTriggerPointCount,
          point_count: sample.pointCount,
          signal_source: sample.signalSource,
          channel: sample.channelIndex,
          kept: deletedIds.has(sample.sampleId) ? 'no' : 'yes',
          replaced_by: replacedBy.get(sample.sampleId) ?? '',
          segment_duration_ms: sample.settings?.segmentDurationMs ?? '',
          pre_trigger_window_ms: sample.settings?.preTriggerWindowMs ?? '',
          countdown_ms: sample.settings?.countdownMs ?? '',
          activity_threshold: sample.settings?.activityThreshold ?? '',
          cooldown_ms: sample.settings?.cooldownMs ?? '',
          feature_set_id: sample.settings?.featureSetId ?? '',
          classifier: sample.settings?.classifier ?? '',
        }));
        const replacementRows = events
          .filter((event) => event.type === 'sample_replaced')
          .map((event) => ({
            round: event.round,
            session_id: event.sessionId,
            participant_id: event.participantId,
            deleted_sample_id: event.sampleId ?? '',
            replacement_sample_id: event.replacementSampleId ?? '',
            at: event.at,
          }));
        const eventRows = events.map((event) => ({
          event_id: event.eventId,
          session_id: event.sessionId,
          participant_id: event.participantId,
          condition: event.condition,
          round: event.round,
          phase: event.phase,
          type: event.type,
          at: event.at,
          sample_id: event.sampleId ?? '',
          replacement_sample_id: event.replacementSampleId ?? '',
          detail: event.detail ?? '',
        }));
        const trainingRows = training.map((revision) => ({
          revision_id: revision.revisionId,
          session_id: revision.sessionId,
          participant_id: revision.participantId,
          condition: revision.condition,
          round: revision.round,
          sample_ids: Array.isArray(revision.sampleIds) ? revision.sampleIds.join('|') : '',
          classifier: revision.classifier,
          feature_set_id: revision.settings?.featureSetId ?? '',
          segment_duration_ms: revision.settings?.segmentDurationMs ?? '',
          started_at: revision.startedAt ?? '',
          finished_at: revision.finishedAt ?? '',
          status: revision.status,
          error: revision.error ?? '',
        }));
        const runRows = runs.map((run) => ({
          run_id: run.id,
          session_id: run.sessionId ?? '',
          participant_id: run.participantId ?? '',
          condition: run.condition,
          round: run.round,
          difficulty: run.difficulty,
          model_revision_id: run.modelRevisionId ?? '',
          game_score: run.gameScore,
          obstacle_success: run.obstacleSuccess == null ? '' : run.obstacleSuccess,
          recorded_at: run.recordedAt,
        }));
        const attemptRows = runs.flatMap((run) => (Array.isArray(run.outcomes) ? run.outcomes : []).map((outcome) => ({
          run_id: run.id,
          participant_id: run.participantId,
          attempt_id: outcome.attemptId,
          expected_gesture_id: outcome.expectedGestureId,
          expected_gesture_name: outcome.expectedGestureName,
          result: outcome.result,
          predicted_gesture_id: outcome.predictedGestureId ?? '',
          predicted_gesture_name: outcome.predictedGestureName ?? '',
        })));
        const labeledCsv = (headers, rows) => toCsv([...headers, 'is_test_participant'], rows.map(row => ({
          ...row,
          is_test_participant: isTestParticipant(mine.find(participant => participant.id === row.participant_id)),
        })));
        const contextRows=contexts.flatMap(envelope=>envelope.context.points.map((point,index)=>({participant_id:envelope.participantId,session_id:envelope.context.scope.sessionId,condition:envelope.condition,round:envelope.round,context_id:envelope.context.contextId,sample_id:envelope.context.sampleId,index,region:envelope.context.center && index>=envelope.context.center.startIndex && index<envelope.context.center.endIndexExclusive?'center':envelope.context.center && index>=envelope.context.center.endIndexExclusive?'post':'pre',time:point.time,raw:point.raw,consumption_id:point.consumptionId})));
        const archive = zipStore([
          { name: 'protocol.json', data: JSON.stringify({schemaVersion:1,experiment,participants:mine.map(p=>({participantId:p.id,protocolVersion:p.protocol_version || 'legacy-fixed-v1',conditionOrder:isPilot(p)?conditionOrder(p):[p.condition],groupCode:p.group_code||null,memberCode:p.member_code||null,frozenSettings:p.frozen_settings?JSON.parse(p.frozen_settings):null,officialSequence:p.official_sequence?JSON.parse(p.official_sequence):null,visits:[readJson(path.join(participantRoot(p.id),'visit-1.json')),readJson(path.join(participantRoot(p.id),'visit-2.json'))].filter(Boolean),runs:readRuns(p.id)}))},null,2) },
          { name: 'context-dispositions.json', data: JSON.stringify({schemaVersion:1,records:contextDispositions},null,2) },
          { name: 'contexts.json', data: JSON.stringify({schemaVersion:1,records:contexts.map(envelope=>({...envelope,derivedDisposition:contextDispositions.filter(event=>event.contextId===envelope.context.contextId && event.participantId===envelope.participantId && event.sessionId===envelope.context.scope.sessionId).sort((a,b)=>a.at-b.at).at(-1)?.disposition ?? envelope.context.disposition}))},null,2) },
          { name: 'context-points.csv', data: labeledCsv(['participant_id','session_id','condition','round','context_id','sample_id','index','region','time','raw','consumption_id'],contextRows) },
          { name: 'models-and-runs.json', data: JSON.stringify({schemaVersion:1,training,runs},null,2) },
          { name: 'training-attempts.json', data: JSON.stringify({schemaVersion:1,records:trainingAttempts},null,2) },
          { name: 'participants.csv', data: toCsv(['participant_id', 'experiment_id', 'condition', 'is_test_participant'], mine.map(participant => ({ participant_id: participant.id, experiment_id: participant.experiment_id, condition: participant.condition, is_test_participant: isTestParticipant(participant) }))) },
          { name: 'sessions.csv', data: labeledCsv(['session_id', 'participant_id', 'experiment_id', 'condition', 'round', 'phase', 'signal_source', 'channel', 'sample_rate_hz', 'device_name', 'segment_duration_ms', 'pre_trigger_window_ms', 'countdown_ms', 'activity_threshold', 'cooldown_ms', 'captures_min', 'captures_max', 'feature_set_id', 'classifier', 'updated_at'], sessionRows) },
          { name: 'samples.csv', data: labeledCsv(['sample_id', 'attempt_id', 'center_duration_ms', 'status', 'session_id', 'participant_id', 'condition', 'round', 'gesture_id', 'gesture_label', 'captured_at', 'recording_started_at', 'recording_ended_at', 'triggered_at', 'first_crossing_at', 'calibration_revision', 'calibration_json', 'pre_trigger_point_count', 'point_count', 'signal_source', 'channel', 'kept', 'replaced_by', 'segment_duration_ms', 'pre_trigger_window_ms', 'countdown_ms', 'activity_threshold', 'cooldown_ms', 'feature_set_id', 'classifier'], sampleRows) },
          { name: 'replacements.csv', data: labeledCsv(['round', 'session_id', 'participant_id', 'deleted_sample_id', 'replacement_sample_id', 'at'], replacementRows) },
          { name: 'events.csv', data: labeledCsv(['event_id', 'session_id', 'participant_id', 'condition', 'round', 'phase', 'type', 'at', 'sample_id', 'replacement_sample_id', 'detail'], eventRows) },
          { name: 'training.csv', data: labeledCsv(['revision_id', 'session_id', 'participant_id', 'condition', 'round', 'sample_ids', 'classifier', 'feature_set_id', 'segment_duration_ms', 'started_at', 'finished_at', 'status', 'error'], trainingRows) },
          { name: 'runs.csv', data: labeledCsv(['run_id', 'session_id', 'participant_id', 'condition', 'round', 'difficulty', 'model_revision_id', 'game_score', 'obstacle_success', 'recorded_at'], runRows) },
          { name: 'attempts.csv', data: labeledCsv(['run_id', 'participant_id', 'attempt_id', 'expected_gesture_id', 'expected_gesture_name', 'result', 'predicted_gesture_id', 'predicted_gesture_name'], attemptRows) },
          { name: 'waveforms.json', data: JSON.stringify({ sessions, samples }, null, 2) },
          { name: 'practice.json', data: JSON.stringify({ schemaVersion: 1, archivalOnly: true, records: practice }, null, 2) },
        ]);
        return {
          status: 200,
          headers: {
            'Content-Type': 'application/zip',
            'Content-Disposition': `attachment; filename="${experiment.id}-study-data.zip"`,
          },
          buffer: archive,
        };
      }

      const exportMatch = pathname.match(/^\/export\/([^/]+)$/);
      if (exportMatch && method === 'GET') {
        const experiment = findExperiment(state, decodeURIComponent(exportMatch[1]));
        const rows = state.participants
          .filter((participant) => participant.experiment_id === experiment.id)
          .map((participant) => {
            const view = presentParticipant(participant, experiment.repetitions);
            return {
              id: view.id,
              is_test_participant: view.isTestParticipant,
              condition: view.condition,
              status: view.status,
              current_round: view.currentRound,
              rounds_completed: view.roundsCompleted,
              created_at: view.createdAt,
            };
          });
        return {
          status: 200,
          headers: {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': `attachment; filename="${experiment.id}-participants.csv"`,
          },
          text: toCsv(['id', 'condition', 'status', 'current_round', 'rounds_completed', 'created_at', 'is_test_participant'], rows),
        };
      }

      throw Object.assign(new Error('Not found.'), { status: 404 });
    },
  };
}

export async function dispatchStudyRequest(dataDir, request) {
  const desk = createStudyDesk(dataDir);
  try {
    return await desk.handle(request);
  } catch (error) {
    return {
      status: error.status || 500,
      body: { error: error.message || 'Study desk failed.' },
    };
  }
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('Send JSON.'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function attachStudyApi(middlewares, dataDir) {
  middlewares.use('/api/study', (req, res) => {
    const run = async () => {
      const rawUrl = req.url || '/';
      const parsed = new URL(rawUrl, 'http://localhost');
      const pathname = parsed.pathname.replace(/\/$/, '') || '/';
      const body = req.method === 'GET' || req.method === 'DELETE' ? {} : await readRequestBody(req);
      const result = await dispatchStudyRequest(dataDir, {
        method: req.method,
        pathname,
        searchParams: parsed.searchParams,
        headers: req.headers,
        body,
      });
      res.statusCode = result.status;
      if (result.text !== undefined || result.buffer !== undefined) {
        for (const [key, value] of Object.entries(result.headers ?? {})) res.setHeader(key, value);
        res.end(result.buffer ?? result.text);
        return;
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(result.body ?? {}));
    };

    run().catch((error) => {
      res.statusCode = error.status || 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: error.message || 'Study desk failed.' }));
    });
  });
}

export function studyApiPlugin(dataDir) {
  return {
    name: 'study-api',
    configureServer(server) {
      attachStudyApi(server.middlewares, dataDir);
    },
    configurePreviewServer(server) {
      attachStudyApi(server.middlewares, dataDir);
    },
  };
}
