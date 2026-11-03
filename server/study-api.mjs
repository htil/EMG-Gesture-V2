import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { zipStore } from './zip-store.mjs';
import { sanitizePracticeRecord, canonicalPractice } from './practice-records.mjs';
import { withPracticeTiming, validatePracticePoints } from '../src/app/study/practice.mjs';
import { sameCalibration } from '../src/app/study/frozenCalibration.mjs';

const ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const EXPERIMENT_HEADERS = ['id', 'name', 'repetitions', 'captures_per_round', 'captures_min', 'captures_max', 'obstacle_count', 'starting_lives', 'status', 'notes', 'created_at'];
const DEFAULT_OBSTACLE_COUNT = 20;
const DEFAULT_STARTING_LIVES = 3;
const PARTICIPANT_HEADERS = ['id', 'experiment_id', 'condition', 'status', 'current_round', 'created_at', 'generation', 'is_test_participant'];
const ROUND_HEADERS = ['participant_id', 'experiment_id', 'round', 'trial_count', 'saved_count', 'usable_count', 'completed_at'];
const EVENT_TYPES = new Set(['capture_started', 'capture_completed', 'capture_cancelled', 'capture_error', 'sample_deleted', 'sample_replaced']);
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
  fs.writeFileSync(temporary, toCsv(headers, records));
  fs.renameSync(temporary, filePath);
}

function readSettings(filePath) {
  if (!fs.existsSync(filePath)) {
    const settings = { adminPin: 'emg-admin' };
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

export function createStudyDesk(dataDir) {
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
    if (checkpoint && Number(checkpoint.round) !== round) checkpoint = null;
    let sessionId = checkpoint ? safeToken(checkpoint.sessionId, '') : '';
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
      .filter((event) => event.type === 'sample_deleted' && Number(event.round) === round && event.sampleId)
      .map((event) => event.sampleId));
    const replaced = new Set(events
      .filter((event) => event.type === 'sample_replaced' && Number(event.round) === round && event.sampleId)
      .map((event) => event.sampleId));
    const checkpointTrials = (Array.isArray(checkpoint.trials) ? checkpoint.trials : [])
      .map(sanitizeTrial)
      .filter((trial) => trial && !deleted.has(trial.id));
    const seen = new Set(checkpointTrials.map((trial) => trial.id));
    const extras = samples
      .filter((sample) => Number(sample.round) === round && !deleted.has(sample.sampleId) && !seen.has(sample.sampleId))
      .map(trialFromSample)
      .filter(Boolean);
    const pendingFromEvents = events
      .filter((event) => event.type === 'sample_deleted' && Number(event.round) === round && event.sampleId && !replaced.has(event.sampleId))
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
      modelRevisionId: checkpoint.modelRevisionId ? safeToken(checkpoint.modelRevisionId, '') : null,
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

  return {
    handle({ method, pathname, searchParams, headers, body }) {
      const state = load();
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
        const bounds = sampleBounds(experiment);
        const game = gameLimits(experiment);
        if (participant.status === 'completed') {
          return {
            status: 200,
            body: {
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

      if (route === 'POST /practice') {
        const participant = state.participants.find(entry => entry.id === normalizeId(body.id));
        if (!participant) throw Object.assign(new Error('That ID was not recognized.'), { status: 404 });
        const directory = path.join(collectionDir(sessionsDir, participant.id, body.record?.sessionId), 'practice');
        const record = { ...sanitizePracticeRecord(body.record, participant, readJsonFiles(directory)), isTestParticipant: isTestParticipant(participant) };
        const previous = readJsonFiles(directory).find(entry => entry.id === record.id);
        // Compare legacy archives with the authoritative label without rewriting them.
        if (previous && canonicalPractice({ ...withPracticeTiming(previous), isTestParticipant: isTestParticipant(participant) }) !== canonicalPractice(record)) throw Object.assign(new Error('Practice record is immutable.'), { status: 409 });
        if (!previous) writeJsonAtomic(path.join(directory, `${record.id}.json`), record);
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
        const stored = sanitizeStoredRun(body.run, participant);
        if (!stored) throw Object.assign(new Error('That game result does not belong to this session.'), { status: 400 });
        const runs = readRuns(participant.id).filter((entry) => entry.id !== stored.id);
        runs.push(stored);
        writeRuns(participant.id, runs);
        return { status: 200, body: { ok: true } };
      }

      if (route === 'POST /collection') {
        const id = normalizeId(body.id);
        const participant = state.participants.find((entry) => entry.id === id);
        if (!participant) throw Object.assign(new Error('That ID was not recognized.'), { status: 404 });
        const items = Array.isArray(body.items) ? body.items : [];
        for (const item of items) {
          const record = item?.record;
          if (!record || !sameGeneration(record, participant)) {
            if (record && (record.calibration !== undefined || record.trials?.some(trial => trial.calibration !== undefined))) throw Object.assign(new Error('Calibration belongs to an inactive generation.'), { status: 409 });
            continue;
          }
          if (item?.kind === 'checkpoint') {
            const sessionId = safeToken(record.sessionId, '');
            if (!sessionId) continue;
            validateTrialCalibration(record.trials, participant);
            const trials = (Array.isArray(record.trials) ? record.trials : []).slice(0, 200).map(sanitizeTrial).filter(Boolean);
            writeJsonAtomic(checkpointFile(participant.id), {
              sessionId,
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
              if (!validatePracticePoints(record.points, record.settings?.segmentDurationMs)
                || !Number.isInteger(record.preTriggerPointCount) || record.preTriggerPointCount < 0
                || record.points[record.preTriggerPointCount]?.time !== record.triggeredAt
                || record.points[0].time !== record.recordingStartedAt || record.points.at(-1).time !== record.recordingEndedAt
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
          } else if (item?.kind === 'training' && record) {
            const sessionId = safeToken(record.sessionId, '');
            const revisionId = safeToken(record.revisionId, '');
            if (!sessionId || !revisionId) continue;
            const filePath = path.join(collectionDir(sessionsDir, participant.id, sessionId), 'training', `${revisionId}.json`);
            if (fs.existsSync(filePath)) continue;
            writeJsonAtomic(filePath, {
              revisionId,
              sessionId,
              participantId: participant.id,
              isTestParticipant: isTestParticipant(participant),
              condition: participant.condition,
              round: finiteNumber(record.round, 1),
              sampleIds: Array.isArray(record.sampleIds) ? record.sampleIds.map((sampleId) => safeToken(sampleId, '')).filter(Boolean) : [],
              classifier: 'knn',
              settings: sanitizeSettings(record.settings),
              startedAt: finiteNumber(record.startedAt, null),
              finishedAt: finiteNumber(record.finishedAt, null),
              status: record.status === 'success' ? 'success' : 'failure',
              error: String(record.error || '').slice(0, 500),
            });
          } else if (item?.kind === 'run') {
            const stored = sanitizeStoredRun(record, participant);
            if (!stored) continue;
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
        return { status: 200, body: { ok: true } };
      }

      if (route === 'POST /progress') {
        const id = normalizeId(body.id);
        const participant = state.participants.find((entry) => entry.id === id);
        if (!participant) throw Object.assign(new Error('That ID was not recognized.'), { status: 404 });
        const experiment = findExperiment(state, participant.experiment_id);
        const round = integerInRange(body.round, 1, Number(experiment.repetitions), 'Round');
        if (participant.status === 'completed') {
          throw Object.assign(new Error('This session is already finished.'), { status: 409 });
        }
        if (Number(participant.current_round) !== round) {
          throw Object.assign(new Error('This round is no longer the active one.'), { status: 409 });
        }
        const trials = Array.isArray(body.trials) ? body.trials : [];
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
        saveParticipants(state.participants);
        return {
          status: 200,
          body: {
            status: participant.status,
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
        const repetitions = integerInRange(body.repetitions ?? 3, 1, 30, 'Repetitions');
        const capturesMin = integerInRange(body.capturesMin ?? body.capturesPerRound ?? 3, 1, 20, 'Minimum samples');
        const capturesMax = integerInRange(body.capturesMax ?? body.capturesPerRound ?? capturesMin, 1, 20, 'Maximum samples');
        const obstacleCount = integerInRange(body.obstacleCount ?? DEFAULT_OBSTACLE_COUNT, 1, 200, 'Obstacle count');
        const startingLives = integerInRange(body.startingLives ?? DEFAULT_STARTING_LIVES, 1, 10, 'Lives');
        if (capturesMin > capturesMax) {
          throw Object.assign(new Error('The minimum cannot be higher than the maximum.'), { status: 400 });
        }
        const experiment = {
          id: randomId(6, 'EXP-'),
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
          if (started) {
            throw Object.assign(new Error('Reset participants before changing the round count or sample limits.'), { status: 409 });
          }
          if (body.repetitions !== undefined) {
            experiment.repetitions = String(integerInRange(body.repetitions, 1, 30, 'Repetitions'));
          }
          const current = sampleBounds(experiment);
          const capturesMin = body.capturesMin !== undefined
            ? integerInRange(body.capturesMin, 1, 20, 'Minimum samples')
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
          const buttonCount = Math.ceil(count / 2);
          for (let index = 0; index < count; index += 1) conditions.push(index < buttonCount ? 'button' : 'threshold');
        }
        const created = [];
        for (const condition of shuffle(conditions)) {
          let id = randomId(6);
          while (existing.has(id)) id = randomId(6);
          existing.add(id);
          const participant = {
            id,
            experiment_id: experiment.id,
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
        const runs = [];
        const practice = [];
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
              events.push(...labelRecords(readJsonFiles(path.join(dir, 'events'))));
              training.push(...labelRecords(readJsonFiles(path.join(dir, 'training'))));
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
                condition: participant.condition,
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
          .filter((event) => event.type === 'sample_deleted' && event.sampleId)
          .map((event) => event.sampleId));
        const sampleRows = samples.map((sample) => ({
          sample_id: sample.sampleId,
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
        const archive = zipStore([
          { name: 'participants.csv', data: toCsv(['participant_id', 'experiment_id', 'condition', 'is_test_participant'], mine.map(participant => ({ participant_id: participant.id, experiment_id: participant.experiment_id, condition: participant.condition, is_test_participant: isTestParticipant(participant) }))) },
          { name: 'sessions.csv', data: labeledCsv(['session_id', 'participant_id', 'experiment_id', 'condition', 'round', 'phase', 'signal_source', 'channel', 'sample_rate_hz', 'device_name', 'segment_duration_ms', 'pre_trigger_window_ms', 'countdown_ms', 'activity_threshold', 'cooldown_ms', 'captures_min', 'captures_max', 'feature_set_id', 'classifier', 'updated_at'], sessionRows) },
          { name: 'samples.csv', data: labeledCsv(['sample_id', 'session_id', 'participant_id', 'condition', 'round', 'gesture_id', 'gesture_label', 'captured_at', 'recording_started_at', 'recording_ended_at', 'triggered_at', 'first_crossing_at', 'calibration_revision', 'calibration_json', 'pre_trigger_point_count', 'point_count', 'signal_source', 'channel', 'kept', 'replaced_by', 'segment_duration_ms', 'pre_trigger_window_ms', 'countdown_ms', 'activity_threshold', 'cooldown_ms', 'feature_set_id', 'classifier'], sampleRows) },
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
    return desk.handle(request);
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
