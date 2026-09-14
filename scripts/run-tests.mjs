import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const temp = await mkdtemp(join(tmpdir(), 'emg-pilot-tests-'));
try {
  const output = join(temp, 'pilot.test.cjs');
  await build({ entryPoints: ['tests/pilot.test.ts'], outfile: output, bundle: true, platform: 'node', format: 'cjs' });
  const result = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), output], { stdio: 'inherit' });
  process.exitCode = result.status ?? 1;
} finally {
  await rm(temp, { recursive: true, force: true });
}
