import { spawn, execFile } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, cp, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { Launch, RunId, Worker } from '../index.js';
import { launchLocal } from './local.js';

const execFileAsync = promisify(execFile);
export interface ManagedProcess {
  child: ChildProcessWithoutNullStreams;
  cwd: string;
  environment: {
    kind: 'trusted-fixture-directory' | 'local' | 'docker' | 'ssh';
    location: string;
  };
  stop(): Promise<void>;
}
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
function command(
  worker: Exclude<Worker, { transport: 'local' }>,
  args: readonly string[],
): { file: string; args: string[] } {
  return worker.transport === 'docker'
    ? { file: 'docker', args: [...args] }
    : {
        file: 'ssh',
        args: [
          '-T',
          '-o',
          'BatchMode=yes',
          '-o',
          'ConnectTimeout=5',
          '-o',
          'ServerAliveInterval=5',
          '-o',
          'ServerAliveCountMax=2',
          '--',
          worker.host,
          ['docker', ...args].map(quote).join(' '),
        ],
      };
}
async function run(
  worker: Exclude<Worker, { transport: 'local' }>,
  args: readonly string[],
): Promise<string> {
  const cmd = command(worker, args);
  const result = await execFileAsync(cmd.file, cmd.args, {
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
  });
  return result.stdout.trim();
}
function fixtureAgentPath(): string {
  for (const relative of [
    '../../../fixtures/agent.mjs',
    '../../../../fixtures/agent.mjs',
  ]) {
    const path = fileURLToPath(new URL(relative, import.meta.url));
    if (existsSync(path)) return path;
  }
  throw new Error('Bundled fixture agent missing');
}
async function kill(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 500);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGTERM');
  });
}
export async function launchManaged(
  input: Launch,
  id: RunId,
): Promise<ManagedProcess> {
  if (input.provider === 'fixture') {
    const base = await mkdtemp(join(tmpdir(), 'workbench-fixture-'));
    const cwd = join(base, 'repo');
    try {
      const agentPath = fixtureAgentPath();
      await cp(join(dirname(agentPath), 'project'), cwd, { recursive: true });
      await mkdir(join(base, 'home'));
      const child = spawn(process.execPath, [agentPath], {
        cwd,
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          HOME: join(base, 'home'),
        },
        stdio: 'pipe',
      });
      return {
        child,
        cwd,
        environment: { kind: 'trusted-fixture-directory', location: cwd },
        async stop() {
          await kill(child);
          await rm(base, { recursive: true, force: true });
        },
      };
    } catch (error) {
      await rm(base, { recursive: true, force: true });
      throw error;
    }
  }
  if (input.worker.transport === 'local')
    return launchLocal(
      input.worker,
      input.source,
      id,
      join(dirname(fixtureAgentPath()), 'project'),
    );
  if (input.source.kind === 'directory')
    throw new Error('Directory sources require explicit local mode');
  const worker = input.worker;
  const name = `aw-${id}`;
  const network = `${name}-net`;
  let created = false;
  let networkCreated = false;
  try {
    const networkId = await run(worker, [
      'network',
      'create',
      '--label',
      `workbench.run=${id}`,
      network,
    ]);
    networkCreated = true;
    if (!/^[a-f0-9]{64}$/.test(networkId))
      throw new Error('Worker did not confirm creation of the private network');
    const containerId = await run(worker, [
      'run',
      '--detach',
      '--name',
      name,
      '--network',
      network,
      '--label',
      `workbench.run=${id}`,
      '--init',
      '--read-only',
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
      '--pids-limit',
      '256',
      '--memory',
      '2g',
      '--cpus',
      '2',
      '--user',
      '1000:1000',
      '--tmpfs',
      '/workspace:rw,exec,nosuid,uid=1000,gid=1000,mode=0700',
      '--tmpfs',
      '/home/node:rw,exec,nosuid,uid=1000,gid=1000,mode=0700',
      '--tmpfs',
      '/tmp:rw,exec,nosuid,mode=1777',
      ...(worker.envFile ? ['--env-file', worker.envFile] : []),
      '--env',
      'HOME=/home/node',
      worker.image,
      'sleep',
      'infinity',
    ]);
    created = true;
    if (!/^[a-f0-9]{64}$/.test(containerId))
      throw new Error(
        'Worker did not confirm creation of the private container',
      );
    if (input.source.kind === 'fixture') {
      await run(worker, [
        'exec',
        name,
        'sh',
        '-c',
        'mkdir -p /workspace/repo && cp -R /opt/workbench-fixture/. /workspace/repo/ && git -C /workspace/repo init -q && git -C /workspace/repo add . && git -C /workspace/repo -c user.name=Workbench -c user.email=fixture@example.invalid commit -qm fixture',
      ]);
    } else {
      await run(worker, [
        'exec',
        name,
        'git',
        '-c',
        'core.hooksPath=/dev/null',
        'clone',
        '--no-checkout',
        '--',
        input.source.url,
        '/workspace/repo',
      ]);
      await run(worker, [
        'exec',
        name,
        'git',
        '-C',
        '/workspace/repo',
        '-c',
        'core.hooksPath=/dev/null',
        'checkout',
        '--detach',
        input.source.revision,
      ]);
    }
    const cmd = command(worker, [
      'exec',
      '-i',
      '--workdir',
      '/workspace/repo',
      name,
      input.provider === 'codex' ? 'codex-acp' : 'claude-agent-acp',
    ]);
    const child = spawn(cmd.file, cmd.args, { stdio: 'pipe' });
    let stopped = false;
    return {
      child,
      cwd: '/workspace/repo',
      environment: {
        kind: worker.transport,
        location: `${worker.transport === 'ssh' ? worker.host : 'docker'}/${name}:/workspace/repo`,
      },
      async stop() {
        if (stopped) return;
        await kill(child);
        if (created) {
          await run(worker, ['rm', '--force', name]);
          created = false;
        }
        if (networkCreated) {
          await run(worker, ['network', 'rm', network]);
          networkCreated = false;
        }
        stopped = true;
      },
    };
  } catch (error) {
    if (created) {
      try {
        await run(worker, ['rm', '--force', name]);
      } catch {
        throw new Error(
          `Launch failed; cleanup also failed for ${name}. Inspect this managed container on the worker.`,
          { cause: error },
        );
      }
    }
    if (networkCreated) {
      try {
        await run(worker, ['network', 'rm', network]);
      } catch {
        throw new Error(
          `Launch failed; private network cleanup failed for ${network}.`,
          { cause: error },
        );
      }
    }
    throw error;
  }
}
