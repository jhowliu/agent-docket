import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { RunId } from '../../execution/index.js';
import type { SpecRef } from '../../evidence/index.js';
import type {
  Work,
  WorkCommand,
  WorkOptions,
  WorkPlan,
  WorkSnapshot,
} from '../index.js';
import { planSchema, workCommandSchema } from './contract.js';

const limit = 512 * 1024;
const errorCode = (error: unknown) =>
  error instanceof Error && 'code' in error ? error.code : undefined;
const message = (error: unknown) =>
  error instanceof Error ? error.message : 'Roadmap is unavailable';

/** Project planning and process-local Run association. No Run output is stored here. */
export function createWork(options: WorkOptions): Work {
  return createTrackedWork(options);
}

/**
 * The same Work plus the Task spec a Run tracks, read from the plan loaded by
 * the last snapshot or write; call snapshot() first for a fresh answer.
 */
export function createTrackedWork(
  options: WorkOptions,
): Work & { specOf(runId: RunId): SpecRef } {
  if (
    !options.projectKey ||
    (options.directory && !isAbsolute(options.directory))
  )
    throw new Error(
      'Roadmap requires a source identity and an absolute storage directory',
    );
  const projectId = createHash('sha256')
    .update(options.projectKey)
    .digest('hex');
  const file = options.directory
    ? join(options.directory, `${projectId}.json`)
    : null;
  let plan: WorkPlan | null = null;
  let queue = Promise.resolve();
  let closed = false;
  const bindings = new Map<RunId, string>();

  async function load(): Promise<WorkPlan | null> {
    if (!file) return plan;
    let body: string;
    try {
      if ((await stat(file)).size > limit)
        throw new Error(
          'Roadmap file is too large; preserve it and repair the project plan',
        );
      body = await readFile(file, 'utf8');
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return null;
      throw error;
    }
    const input: unknown = JSON.parse(body);
    const parsed = planSchema.safeParse(input);
    if (!parsed.success || parsed.data.projectId !== projectId)
      throw new Error(
        'Roadmap file is invalid or belongs to another project; preserve it before repair',
      );
    return parsed.data;
  }
  function currentRun(id: RunId) {
    const run = options.execution.snapshot(id);
    if (
      ['cancelled', 'closed', 'failed', 'interrupted', 'cancelling'].includes(
        run.state.kind,
      )
    )
      throw new Error(
        'Attach a current Run; ended Runs cannot be resumed from a Roadmap',
      );
    return run;
  }
  function taskIn(draft: WorkPlan, id: string) {
    const task = draft.phases
      .flatMap((phase) => phase.tasks)
      .find((task) => task.id === id);
    if (!task) throw new Error('Task no longer exists; refresh the Roadmap');
    return task;
  }
  function phaseIn(draft: WorkPlan, id: string) {
    const phase = draft.phases.find((phase) => phase.id === id);
    if (!phase) throw new Error('Phase no longer exists; refresh the Roadmap');
    return phase;
  }
  async function save(draft: WorkPlan) {
    const body = JSON.stringify(planSchema.parse(draft), null, 2) + '\n';
    if (Buffer.byteLength(body) > limit)
      throw new Error('Roadmap has reached its size limit');
    if (!file) return;
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, body, { mode: 0o600, flag: 'wx' });
      await rename(temporary, file);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  function makeTask(title: string, text: string) {
    return {
      id: `task-${randomUUID()}`,
      title,
      spec: { revision: 1, text, confirmed: false },
      stage: 'clarification' as const,
      status: 'planned' as const,
    };
  }
  async function mutate(command: WorkCommand): Promise<void> {
    let lock: Awaited<ReturnType<typeof open>> | undefined;
    if (file && options.directory) {
      await mkdir(options.directory, { recursive: true, mode: 0o700 });
      try {
        lock = await open(file + '.lock', 'wx', 0o600);
      } catch (error) {
        if (errorCode(error) === 'EEXIST')
          throw new Error(
            'Roadmap is being updated by another writer; refresh before retrying. A leftover .lock file needs operator recovery.',
          );
        throw error;
      }
    }
    try {
      const current = await load();
      if ((current?.revision ?? 0) !== command.expectedRevision)
        throw new Error('Roadmap changed; refresh before applying this action');
      if ('runId' in command && command.runId) currentRun(command.runId);
      let draft: WorkPlan;
      let attach: { runId: RunId; taskId: string } | undefined;
      let detach: RunId | undefined;
      if (command.kind === 'work.create') {
        if (current)
          throw new Error(
            'This project already has a Roadmap; attach to an existing Task',
          );
        const phaseId = `phase-${randomUUID()}`;
        const task = makeTask(command.taskTitle, command.spec);
        draft = {
          version: 1,
          projectId,
          title: command.title,
          revision: 1,
          activePhaseId: phaseId,
          phases: [
            { id: phaseId, title: command.phaseTitle, goal: '', tasks: [task] },
          ],
        };
        if (command.runId) {
          taskIn(draft, task.id).status = 'active';
          attach = { runId: command.runId, taskId: task.id };
        }
      } else {
        if (!current)
          throw new Error('Create a Roadmap before tracking this work');
        draft = structuredClone(current);
        draft.revision++;
        switch (command.kind) {
          case 'work.add-phase':
            draft.phases.push({
              id: `phase-${randomUUID()}`,
              title: command.title,
              goal: command.goal,
              tasks: [],
            });
            break;
          case 'work.add-task': {
            const task = makeTask(command.title, command.spec);
            phaseIn(draft, command.phaseId).tasks.push(task);
            if (command.runId) {
              taskIn(draft, task.id).status = 'active';
              attach = { runId: command.runId, taskId: task.id };
            }
            break;
          }
          case 'work.attach':
            taskIn(draft, command.taskId).status = 'active';
            attach = { runId: command.runId, taskId: command.taskId };
            break;
          case 'work.detach':
            detach = command.runId;
            break;
          case 'work.spec': {
            const task = taskIn(draft, command.taskId);
            task.spec = {
              revision: task.spec.revision + 1,
              text: command.text,
              confirmed: false,
            };
            task.stage = 'clarification';
            break;
          }
          case 'work.confirm': {
            const task = taskIn(draft, command.taskId);
            if (!task.spec.text)
              throw new Error(
                'Write the requirements and acceptance conditions before confirming',
              );
            task.spec.confirmed = true;
            task.stage = 'development';
            task.status = 'active';
            break;
          }
          case 'work.stage': {
            const task = taskIn(draft, command.taskId);
            if (command.stage !== 'clarification' && !task.spec.confirmed)
              throw new Error(
                'Confirm the current requirements before tracking another stage',
              );
            task.stage = command.stage;
            task.status = 'active';
            break;
          }
          case 'work.focus':
            phaseIn(draft, command.phaseId);
            draft.activePhaseId = command.phaseId;
            break;
        }
      }
      if (attach && !bindings.has(attach.runId) && bindings.size >= 64)
        throw new Error('64 tracked Runs reached in this process');
      planSchema.parse(draft);
      await save(draft);
      plan = draft;
      if (attach) bindings.set(attach.runId, attach.taskId);
      if (detach) bindings.delete(detach);
    } finally {
      if (lock) {
        await lock.close();
        await rm(file + '.lock', { force: true });
      }
    }
  }
  return {
    specOf(runId) {
      const taskId = bindings.get(runId);
      const task = plan?.phases
        .flatMap((phase) => phase.tasks)
        .find((task) => task.id === taskId);
      return taskId && task ? { taskId, revision: task.spec.revision } : null;
    },
    async snapshot(): Promise<WorkSnapshot> {
      await queue;
      try {
        plan = await load();
        for (const [runId, taskId] of bindings) {
          try {
            currentRun(runId);
            if (!plan) throw new Error('No plan');
            taskIn(plan, taskId);
          } catch {
            bindings.delete(runId);
          }
        }
        return structuredClone({
          kind: 'ready',
          persistence: file ? 'project-file' : 'memory',
          plan,
          bindings: [...bindings].map(([runId, taskId]) => ({ runId, taskId })),
        });
      } catch (error) {
        return {
          kind: 'unavailable',
          reason: message(error).slice(0, 400),
          plan: null,
          bindings: [],
        };
      }
    },
    apply(input) {
      if (closed) return Promise.reject(new Error('Roadmap is closed'));
      const parsed = workCommandSchema.safeParse(input);
      if (!parsed.success)
        return Promise.reject(new Error('Invalid Roadmap action'));
      const result = queue.then(() => mutate(parsed.data));
      queue = result.catch(() => {});
      return result;
    },
    submit(runId, text) {
      if (closed) return Promise.reject(new Error('Roadmap is closed'));
      const result = queue.then(async () => {
        const taskId = bindings.get(runId);
        if (!taskId) {
          options.execution.submit(runId, text);
          return;
        }
        const latest = await load();
        if (!latest)
          throw new Error(
            'Roadmap is unavailable; repair the project plan before continuing this Task',
          );
        const task = taskIn(latest, taskId);
        const phase = latest.phases.find((phase) =>
          phase.tasks.some((item) => item.id === taskId),
        );
        const context = [
          'Workbench Task context (planning state, not evidence of completion):',
          `Roadmap: ${latest.title}`,
          `Phase: ${phase?.title ?? ''}`,
          `Task: ${task.title}`,
          `Working stage: ${task.stage}`,
          `Requirements revision ${task.spec.revision}: ${task.spec.confirmed ? 'confirmed by the user' : 'not yet confirmed'}`,
          task.spec.text || 'Requirements have not been written yet.',
          'Keep this Task scope. A turn ending or a stage label does not pass a review or accept the Task.',
        ].join('\n');
        options.execution.submit(runId, text, context);
      });
      queue = result.catch(() => {});
      return result;
    },
    async close() {
      closed = true;
      await queue;
      bindings.clear();
    },
  };
}
