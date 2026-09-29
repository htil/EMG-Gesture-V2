import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const EXPERIMENT_HEADERS = ['id', 'name', 'repetitions', 'captures_per_round', 'status', 'notes', 'created_at'];
const PARTICIPANT_HEADERS = ['id', 'experiment_id', 'condition', 'status', 'current_round', 'created_at'];
const ROUND_HEADERS = ['participant_id', 'experiment_id', 'round', 'trial_count', 'usable_count', 'completed_at'];

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

function summarizeExperiment(experiment, participants) {
  const mine = participants.filter((participant) => participant.experiment_id === experiment.id);
  return {
    id: experiment.id,
    name: experiment.name,
    repetitions: Number(experiment.repetitions),
    capturesPerRound: Number(experiment.captures_per_round),
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

function presentParticipant(participant, repetitions) {
  const currentRound = Number(participant.current_round) || 1;
  const roundsCompleted = participant.status === 'completed'
    ? Number(repetitions) || 0
    : Math.max(0, currentRound - 1);
  return {
    id: participant.id,
    experimentId: participant.experiment_id,
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

  const saveExperiments = (records) => writeTable(experimentsPath, EXPERIMENT_HEADERS, records);
  const saveParticipants = (records) => writeTable(participantsPath, PARTICIPANT_HEADERS, records);
  const saveRounds = (records) => writeTable(roundsPath, ROUND_HEADERS, records);

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
        if (participant.status === 'completed') {
          return {
            status: 200,
            body: {
              participantId: participant.id,
              experimentId: experiment.id,
              experimentName: experiment.name,
              repetitions: Number(experiment.repetitions),
              capturesPerRound: Number(experiment.captures_per_round),
              round: Number(experiment.repetitions),
              status: 'completed',
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
            experimentName: experiment.name,
            repetitions: Number(experiment.repetitions),
            capturesPerRound: Number(experiment.captures_per_round),
            round: Number(participant.current_round) || 1,
            manualTrigger: participant.condition === 'button',
            status: 'in_progress',
          },
        };
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
        const usableCount = trials.filter((trial) => trial?.quality === 'usable').length;
        state.rounds.push({
          participant_id: participant.id,
          experiment_id: experiment.id,
          round: String(round),
          trial_count: String(trials.length),
          usable_count: String(usableCount),
          completed_at: nowIso(),
        });
        saveRounds(state.rounds);
        fs.mkdirSync(sessionsDir, { recursive: true });
        fs.writeFileSync(path.join(sessionsDir, `${participant.id}-round-${round}.json`), `${JSON.stringify({
          participantId: participant.id,
          experimentId: experiment.id,
          condition: participant.condition,
          round,
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
        const capturesPerRound = integerInRange(body.capturesPerRound ?? 3, 1, 20, 'Captures per round');
        const experiment = {
          id: randomId(6, 'EXP-'),
          name,
          repetitions: String(repetitions),
          captures_per_round: String(capturesPerRound),
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
        if (body.status !== undefined) {
          if (body.status !== 'active' && body.status !== 'closed') {
            throw Object.assign(new Error('Status must be active or closed.'), { status: 400 });
          }
          experiment.status = body.status;
        }
        if (body.repetitions !== undefined || body.capturesPerRound !== undefined) {
          if (started) {
            throw Object.assign(new Error('Reset participants before changing the round count or captures per round.'), { status: 409 });
          }
          if (body.repetitions !== undefined) {
            experiment.repetitions = String(integerInRange(body.repetitions, 1, 30, 'Repetitions'));
          }
          if (body.capturesPerRound !== undefined) {
            experiment.captures_per_round = String(integerInRange(body.capturesPerRound, 1, 20, 'Captures per round'));
          }
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
            rounds: state.rounds
              .filter((round) => round.experiment_id === experimentId)
              .map((round) => ({
                participantId: round.participant_id,
                round: Number(round.round),
                trialCount: Number(round.trial_count),
                usableCount: Number(round.usable_count),
                completedAt: round.completed_at,
              })),
          },
        };
      }

      if (route === 'POST /participants/generate') {
        const experiment = findExperiment(state, String(body.experimentId ?? ''));
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
        saveParticipants(state.participants);
        saveRounds(state.rounds.filter((round) => round.participant_id !== id));
        if (fs.existsSync(sessionsDir)) {
          for (const fileName of fs.readdirSync(sessionsDir)) {
            if (fileName.startsWith(`${id}-round-`)) fs.unlinkSync(path.join(sessionsDir, fileName));
          }
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

      const exportMatch = pathname.match(/^\/export\/([^/]+)$/);
      if (exportMatch && method === 'GET') {
        const experiment = findExperiment(state, decodeURIComponent(exportMatch[1]));
        const rows = state.participants
          .filter((participant) => participant.experiment_id === experiment.id)
          .map((participant) => {
            const view = presentParticipant(participant, experiment.repetitions);
            return {
              id: view.id,
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
          text: toCsv(['id', 'condition', 'status', 'current_round', 'rounds_completed', 'created_at'], rows),
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
      if (result.text !== undefined) {
        for (const [key, value] of Object.entries(result.headers ?? {})) res.setHeader(key, value);
        res.end(result.text);
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
