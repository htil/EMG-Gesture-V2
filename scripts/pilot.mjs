import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { 'data-dir': { type: 'string' }, host: { type: 'string', default: '127.0.0.1' }, port: { type: 'string', default: '5215' }, production: { type: 'boolean', default: false }, smoke: { type: 'boolean', default: false }, help: { type: 'boolean', default: false } } });
if (values.help) {
  console.log('Persistent pilot server: --data-dir <external folder> [--production] [--host 127.0.0.1] [--port 5215] [--smoke]. Run npm run build before --production (minified production preview); otherwise serves development mode. Records are not deleted on shutdown. This is NOT disposable review mode. Physical/participant-process readiness must be verified separately.');
} else {
  let server;
  let closing = false;
  async function close() {
    if (closing) return;
    closing = true;
    if (server) {
      if (values.production) await new Promise((resolve, reject) => server.httpServer.close(error => error ? reject(error) : resolve()));
      else await server.close();
    }
    // Intentionally never remove the selected persistent record directory.
  }
  try {
    if (!values['data-dir']) throw new Error('An explicit --data-dir is required. Use --help; never select the source checkout data directory.');
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const data = path.resolve(values['data-dir']);
    // Resolve existing symlink parents before deciding whether records are external.
    let parent = data;
    const suffix = [];
    while (!fs.existsSync(parent)) {
      suffix.unshift(path.basename(parent));
      const next = path.dirname(parent);
      if (next === parent) break;
      parent = next;
    }
    const realData = path.resolve(fs.realpathSync(parent), ...suffix);
    const relative = path.relative(fs.realpathSync(root), realData);
    if (!relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) {
      throw new Error('Pilot records must be outside the source checkout. Select a separate persistent folder.');
    }
    const portValue = Number(values.port);
    if (!Number.isInteger(portValue) || portValue < 0 || portValue > 65535) throw new Error('Port must be a whole number from 0 to 65535.');
    let port = portValue;
    if (port === 0) port = await new Promise((resolve, reject) => {
      const probe = net.createServer();
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', () => { const selected = probe.address().port; probe.close(() => resolve(selected)); });
    });
    fs.mkdirSync(data, { recursive: true });
    if (values.production && !fs.existsSync(path.join(root, 'dist', 'index.html'))) throw new Error('Production build missing. Run npm run build before launching --production.');
    const { createServer, preview, loadConfigFromFile } = await import('vite');
    const { studyApiPlugin } = await import('../server/study-api.mjs');
    const config = await loadConfigFromFile({ command: values.production ? 'build' : 'serve', mode: values.production ? 'production' : 'development' }, path.join(root, 'vite.config.ts'));
    if (!config) throw new Error('Application Vite configuration could not be loaded.');
    const shared = { ...config.config, root, configFile: false, cacheDir: path.join(data, '.vite-cache'),
      plugins: [studyApiPlugin(data), ...config.config.plugins.filter(plugin => plugin?.name !== 'study-api')],
    };
    if (values.production) server = await preview({ ...shared, preview: { host: values.host, port, strictPort: true, open: false } });
    else server = await createServer({ ...shared, server: { host: values.host, port, strictPort: true, open: false } });
    process.once('SIGINT', async () => { await close(); process.exit(0); });
    process.once('SIGTERM', async () => { await close(); process.exit(0); });
    if (!values.production) await server.listen();
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    console.log(`Pilot server: ${origin}`);
    console.log(values.production ? 'Mode: minified production preview' : 'Mode: development');
    console.log(`Persistent record folder: ${data}`);
    console.log('Records are NOT deleted on shutdown. Back up this folder after each pilot.');
    console.log('No participant IDs are seeded. Configure the approved pilot through the researcher admin screen.');
    console.log('Software startup is not physical Ganglion or participant-process validation.');
    if (values.smoke) {
      const page = await fetch(origin);
      const html = await page.text();
      if (!page.ok || (values.production ? !html.includes('/assets/') || html.includes('/src/main') || html.includes('/@vite/client') : !html.includes('src/main'))) throw new Error('Actual selected UI mode did not load.');
      const api = await fetch(origin + '/api/study/experiments');
      if (![200, 401].includes(api.status) || typeof await api.json() !== 'object') throw new Error('Actual study API did not respond.');
      if (!values.production) {
        await server.warmupRequest('/src/main.tsx');
        await server.waitForRequestsIdle();
      }
      await close();
      console.log(`PILOT SMOKE PASS: actual ${values.production ? 'production preview' : 'development'} UI/API; external records retained. Not a browser or hardware validation.`);
    }
  } catch (error) {
    await close();
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
