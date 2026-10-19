import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';

function fixtureShell() {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', resolve('src/app/cli.ts'), 'fixture'],
    { stdio: 'pipe' },
  );
  let output = '';
  let errors = '';
  child.stdout.on('data', (chunk) => {
    output += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    errors += String(chunk);
  });
  const exited = new Promise<number | null>((done, reject) => {
    child.once('error', reject);
    child.once('close', done);
  });
  async function waitFor(predicate: (output: string) => boolean) {
    const end = Date.now() + 6000;
    while (Date.now() < end) {
      if (predicate(output)) return;
      await new Promise((done) => setTimeout(done, 10));
    }
    throw new Error('CLI condition timed out: ' + output + ' / ' + errors);
  }
  const location = () => {
    const match = output.match(/environment (\{[^\n]+\})/);
    assert.ok(match?.[1]);
    const env: unknown = JSON.parse(match[1]);
    assert.ok(
      env &&
        typeof env === 'object' &&
        'location' in env &&
        typeof env.location === 'string',
    );
    return env.location;
  };
  return {
    child,
    exited,
    waitFor,
    location,
    output: () => output,
    errors: () => errors,
  };
}

test('own CLI accepts decisions and follow-up prompts without entering provider CLI', async (t) => {
  const shell = fixtureShell();
  t.after(() => {
    shell.child.kill('SIGKILL');
  });
  await shell.waitFor((output) => output.includes('Selected Run 1'));
  const path = shell.location();
  shell.child.stdin.write('prompt fix\n');
  await shell.waitFor((output) => output.includes('Item 1] pending'));
  shell.child.stdin.write('answer 1 2\n');
  await shell.waitFor(
    (output) => (output.match(/"kind":"idle"/g) || []).length === 2,
  );
  shell.child.stdin.write('prompt question\n');
  await shell.waitFor((output) =>
    output.includes('What name should this check'),
  );
  await shell.waitFor(
    (output) => (output.match(/"kind":"idle"/g) || []).length === 3,
  );
  shell.child.stdin.write('prompt reply:cli-check\n');
  await shell.waitFor((output) => output.includes('cli-check'));
  shell.child.stdin.write('quit\n');
  assert.equal(await shell.exited, 0, shell.errors());
  assert.match(shell.output(), /delivered/);
  await assert.rejects(access(path));
});

test('CLI SIGTERM closes its own Run and removes its temporary environment', async (t) => {
  const shell = fixtureShell();
  t.after(() => {
    shell.child.kill('SIGKILL');
  });
  await shell.waitFor((output) => output.includes('Selected Run 1'));
  const path = shell.location();
  shell.child.kill('SIGTERM');
  assert.equal(await shell.exited, 0, shell.errors());
  await assert.rejects(access(path));
});
