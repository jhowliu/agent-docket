import { spawn } from 'node:child_process';
import { mkdir, open } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createWorkbenchClient, WorkbenchError } from './workbench-client.js';
import { loadLaunchConfig } from './launch-config.js';

/** Process bootstrap only. An existing listener is never stopped or replaced. */
export async function connectWorkbench(
  origin: string,
  options: { autostart: boolean; logDirectory?: string },
) {
  const client = createWorkbenchClient(origin);
  const launchFile = process.env['WORKBENCH_LAUNCH'];
  const expected = launchFile
    ? (await loadLaunchConfig(launchFile)).configurationId
    : undefined;
  try {
    const initial = await client.connect();
    if (expected && initial.configurationId !== expected)
      throw new Error(
        'This port runs a different launch configuration. Select another WORKBENCH_PORT; the existing server was left unchanged.',
      );
    return { client, initial };
  } catch (error: unknown) {
    if (
      !(error instanceof WorkbenchError) ||
      error.kind !== 'unavailable' ||
      !options.autostart
    )
      throw error;
  }
  const directory = resolve(options.logDirectory ?? '.workbench');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const port = new URL(origin).port;
  const log = resolve(directory, `daemon-${port}.log`);
  const output = await open(log, 'a', 0o600);
  const source = import.meta.url.endsWith('.ts');
  const entry = fileURLToPath(
    new URL(source ? './web.ts' : './web.js', import.meta.url),
  );
  try {
    const child = spawn(
      process.execPath,
      [...(source ? ['--import', import.meta.resolve('tsx')] : []), entry],
      {
        detached: true,
        stdio: ['ignore', output.fd, output.fd],
        env: { ...process.env, WORKBENCH_PORT: port },
      },
    );
    await new Promise<void>((done, reject) => {
      child.once('spawn', done);
      child.once('error', reject);
    });
    child.unref();
  } finally {
    await output.close();
  }
  const until = Date.now() + 8000;
  while (Date.now() < until) {
    await new Promise((done) => setTimeout(done, 100));
    try {
      const initial = await client.connect();
      if (expected && initial.configurationId !== expected)
        throw new Error(
          'This port runs a different launch configuration; its server was left unchanged.',
        );
      return { client, initial };
    } catch (error: unknown) {
      if (!(error instanceof WorkbenchError)) throw error;
      if (error instanceof WorkbenchError && error.kind === 'protocol')
        throw error;
    }
  }
  throw new Error('Server could not start; see ' + log);
}
