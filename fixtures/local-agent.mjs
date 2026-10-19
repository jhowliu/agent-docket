import { writeFile, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

// Trusted native-launch acceptance peer. No model calls or real login material.
const observation = {
  home: process.env.HOME,
  codexHome: process.env.CODEX_HOME,
  temporary: process.env.TMPDIR,
  cwd: process.cwd(),
  injectedHostSetting: process.env.WORKBENCH_TEST_HOST_SETTING ?? null,
  mode: process.env.INITIAL_AGENT_MODE,
};
try {
  const auth = join(process.env.CODEX_HOME, 'auth.json');
  observation.auth = JSON.parse(await readFile(auth, 'utf8'));
  await writeFile(auth, JSON.stringify({ test: 'refreshed-copy' }));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
if (process.argv.includes('--descendants')) {
  const script = `
    const { spawn } = require('node:child_process');
    const { writeFileSync } = require('node:fs');
    const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    writeFileSync('descendants.json', JSON.stringify([process.pid, grandchild.pid]));
    setInterval(() => {}, 1000);
  `;
  spawn(process.execPath, ['-e', script], { stdio: 'ignore' });
}
await writeFile('launch-observed.json', JSON.stringify(observation));
await import('./agent.mjs');
