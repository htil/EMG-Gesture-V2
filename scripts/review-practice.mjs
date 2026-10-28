import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createServer, loadConfigFromFile } from 'vite';
import { dispatchStudyRequest, studyApiPlugin } from '../server/study-api.mjs';

const { values } = parseArgs({ options: { host: { type: 'string', default: '127.0.0.1' }, port: { type: 'string', default: '5214' }, smoke: { type: 'boolean', default: false }, help: { type: 'boolean', default: false } } });
if (values.help) {
  console.log('Disposable guided-practice review: --host 127.0.0.1 --port 5214 [--smoke]. Never reads or writes repository data/. Ctrl-C removes temporary records.');
  process.exit(0);
}
let port = values.smoke ? 0 : Number(values.port);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Port must be a whole number from 0 to 65535.');
if (port === 0) port = await new Promise((resolve, reject) => {
  const probe = net.createServer(); probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => { const value = probe.address().port; probe.close(() => resolve(value)); });
});
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'emg-guided-review-'));
let server, closed = false;
async function close() {
  if (closed) return;
  closed = true;
  if (server) await server.close();
  fs.rmSync(data, { recursive: true, force: true });
}
process.once('SIGINT', async () => { await close(); process.exit(0); });
process.once('SIGTERM', async () => { await close(); process.exit(0); });
try {
  const config = await loadConfigFromFile({ command: 'serve', mode: 'development' }, path.join(root, 'vite.config.ts'));
  if (!config) throw new Error('App Vite configuration could not be loaded.');
  server = await createServer({ ...config.config, root, configFile: false, cacheDir: path.join(data, '.vite-cache'),
    plugins: [studyApiPlugin(data), ...config.config.plugins.filter(plugin => plugin?.name !== 'study-api')],
    server: { host: values.host, port, strictPort: true, open: false },
  });
  await server.listen();
  const call = async (pathname, body) => {
    const result = await dispatchStudyRequest(data, { method: 'POST', pathname, body, headers: { 'x-admin-pin': 'emg-admin' }, searchParams: new URLSearchParams() });
    if (result.status >= 400) throw new Error(JSON.stringify(result.body));
    return result.body;
  };
  const experiment = await call('/experiments', { name: 'Disposable guided Practice review', repetitions: 1, capturesMin: 1, capturesMax: 1 });
  const roster = await call('/participants/generate', { experimentId: experiment.id, count: 2, assignment: 'balanced', isTestParticipant: true });
  console.log('\nGuided Practice review — temporary records, not a real study.');
  console.log('Local URL: http://127.0.0.1:' + server.httpServer.address().port);
  for (const participant of roster.participants) console.log(`${participant.id} — ${participant.condition}`);
  console.log('Practice-only UI update. Detector settings remain those of the flow-based baseline.');
  console.log('Ctrl-C to stop and remove disposable data.');
  if (values.smoke) {
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    const html = await fetch(origin);
    if (!html.ok || !(await html.text()).includes('src/main')) throw new Error('Actual development UI did not load.');
    for (const participant of roster.participants) {
      const response = await fetch(origin + '/api/study/join', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: participant.id }) });
      if (!response.ok || (await response.json()).participantId !== participant.id) throw new Error('Actual fixture API join failed.');
    }
    await server.warmupRequest('/src/main.tsx');
    await server.waitForRequestsIdle();
    console.log('SMOKE PASS: actual UI and isolated API; not a browser or hardware validation.');
    await close();
  }
} catch (error) {
  await close();
  throw error;
}
