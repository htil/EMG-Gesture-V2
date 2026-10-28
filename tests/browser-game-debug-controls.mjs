import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'vite';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/root/emg-review-tools/node_modules/playwright/index.mjs');
const evidence = process.env.EVIDENCE_DIR || '/workspace/EMG-Next-UI-Keyboard-Validation';
await mkdir(evidence, { recursive: true });
const cache = await mkdtemp(path.join(os.tmpdir(), 'emg-debug-keyboard-'));
const errors = [];
const consoleErrors = [];
const results = [];
let browser;
const entry = `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import GameScreen from '/src/app/GameScreen.tsx';
    import '/src/styles/index.css';
    window.inferenceCalls = 0;
    const root = createRoot(document.getElementById('root'));
    window.mountScreen = () => root.render(React.createElement(GameScreen, {
      onExit: () => root.render(null), startingLives: 10, obstacleCount: 20,
      predictWindow: () => { window.inferenceCalls++; return null; }
    }));
    window.mountScreen();
  `;
const serveHarness = async (_req, res) => {
  const html = await server.transformIndexHtml('/__debug_controls.html', '<!doctype html><html><body><div id="root"></div><script type="module" src="/__debug_controls_entry.jsx"></script></body></html>');
  res.setHeader('Content-Type', 'text/html');
  res.end(html);
};
const server = await createServer({
  cacheDir: cache,
  server: { host: '127.0.0.1', port: 0 },
  plugins: [{ name: 'debug-controls-harness',
    resolveId(id) { if (id === '/__debug_controls_entry.jsx') return id; },
    load(id) { if (id === '/__debug_controls_entry.jsx') return entry; },
    configureServer(server) {
      server.middlewares.use('/__debug_controls.html', serveHarness);
    }
  }],
});
try {
  await server.listen();
  const port = server.httpServer.address().port;
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  // Test-only state inspection: no production exports, movement, scores or predictions replaced.
  await page.route('**/game/main.js*', async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, body: `${await response.text()}\nexport const inspectDebugControls = () => ({laneIndex, isJumping, isSwitching, pendingGestureAction, mounted: !!activeRenderer});\n` });
  });
  await page.goto(`http://127.0.0.1:${port}/__debug_controls.html`);
  const toggle = page.getByRole('checkbox', { name: 'Debug keyboard controls' });
  await toggle.waitFor({ timeout: 15000 });
  assert.equal(await toggle.isChecked(), true);
  await page.waitForFunction(async () => {
    const game = await import('/game/main.js');
    return game.inspectDebugControls().mounted;
  });
  // Let real GLTF loads initialize character and jump animation.
  await page.waitForTimeout(1800);
  const state = () => page.evaluate(async () => (await import('/game/main.js')).inspectDebugControls());
  await page.keyboard.press('ArrowRight');
  assert.equal((await state()).laneIndex, 1);
  await page.waitForTimeout(400);
  results.push('Default-on ArrowRight changed lane in mounted real game');
  await toggle.uncheck();
  const canvas = await page.locator('canvas').elementHandle();
  const beforeCalls = await page.evaluate(() => window.inferenceCalls);
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowUp');
  const disabled = await state();
  assert.equal(disabled.laneIndex, 1);
  assert.equal(disabled.isJumping, false);
  assert.equal(disabled.pendingGestureAction, null);
  assert.equal(await page.locator('canvas').evaluate((element, original) => element === original, canvas), true);
  await page.screenshot({ path: path.join(evidence, 'debug-controls-off.png') });
  results.push('During existing run disabled arrows did not move/jump/queue; same canvas retained');
  await page.waitForFunction((before) => window.inferenceCalls > before, beforeCalls, { timeout: 12000 });
  assert.match(await page.locator('body').innerText(), /No usable prediction/);
  results.push('Real QTE processing still invoked predictWindow while debug arrows disabled (returned null; no fabricated prediction)');
  await toggle.check();
  await page.keyboard.press('ArrowLeft');
  assert.equal((await state()).laneIndex, 0);
  await page.screenshot({ path: path.join(evidence, 'debug-controls-on.png') });
  results.push('Re-enable applied in same run');
  await toggle.uncheck();
  await page.getByRole('button', { name: 'Back to training', exact: true }).click();
  assert.equal((await state()).mounted, false);
  const afterUnmount = await state();
  await page.keyboard.press('ArrowRight');
  assert.deepEqual(await state(), afterUnmount);
  await page.evaluate(() => window.mountScreen());
  assert.equal(await toggle.isChecked(), true);
  await page.waitForFunction(async () => (await import('/game/main.js')).inspectDebugControls().mounted);
  await page.keyboard.press('ArrowRight');
  assert.equal((await state()).laneIndex, 1);
  results.push('Unmount removed game/listener; remount reset toggle to default on');
  assert.deepEqual(errors, []);
  await writeFile(path.join(evidence, 'browser-results.json'), JSON.stringify({ passed: true, results, errors, consoleErrors }, null, 2));
  console.log(JSON.stringify({ passed: true, results, errors, consoleErrors }, null, 2));
} catch (error) {
  if (browser) await browser.contexts()[0]?.pages()[0]?.screenshot({ path: path.join(evidence, 'browser-failure.png') });
  await writeFile(path.join(evidence, 'browser-results.json'), JSON.stringify({ passed: false, results, errors, consoleErrors, failure: String(error) }, null, 2));
  throw error;
} finally {
  await browser?.close();
  await server.close();
  await rm(cache, { recursive: true, force: true });
}
