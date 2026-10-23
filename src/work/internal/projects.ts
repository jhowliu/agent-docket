import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { inspectLocalProject } from '../../execution/index.js';
import type { RunId, RunSnapshot } from '../../execution/index.js';
import type { AttentionItem } from '../../attention/index.js';
import type {
  NextAction,
  ProjectWorkspaces,
  ProjectWorkspacesOptions,
  Work,
} from '../index.js';
import { nextActionSchema } from './contract.js';
import { createWork } from './work.js';

const rank = (next: NextAction) => nextActionSchema.options.indexOf(next);
// Prompt, working and ended rank alike for ordering: none asks for a decision.
const urgency = (next: NextAction) => Math.min(rank(next), rank('prompt'));

function nextAction(
  run: RunSnapshot,
  items: readonly AttentionItem[],
): NextAction {
  const pending = items.filter(
    (item) => item.runId === run.id && item.status === 'pending',
  );
  // An approval blocks the agent; an agent request only waits on the person.
  if (pending.some((item) => item.kind === 'permission')) return 'approve';
  if (pending.length) return 'respond';
  if (run.state.kind === 'authentication-required') return 'sign-in';
  if (run.worktree?.status.kind === 'commit-required') return 'commit';
  if (run.worktree?.status.kind === 'retained') return 'worktree';
  if (run.state.kind === 'idle') return 'prompt';
  if (['starting', 'running', 'cancelling'].includes(run.state.kind))
    return 'working';
  return 'ended';
}

/** Owns project plan selection and prevents cross-project Run/Task attachment. */
export function createProjectWorkspaces(
  options: ProjectWorkspacesOptions,
): ProjectWorkspaces {
  const projects = new Map<string, { source: string; work: Work }>();
  const runs = new Map<RunId, string>();
  let closed = false;
  function project(id: string) {
    const found = projects.get(id);
    if (closed || !found)
      throw new Error('Project is unavailable; refresh the workbench');
    return found;
  }
  const workspaces: ProjectWorkspaces = {
    register(projectKey, source) {
      if (closed) throw new Error('Project workspaces are closed');
      const id = createHash('sha256').update(projectKey).digest('hex');
      if (!projects.has(id)) {
        if (projects.size >= 65)
          throw new Error('Project limit reached for this process');
        projects.set(id, {
          source,
          work: createWork({ ...options, projectKey }),
        });
      }
      return id;
    },
    associate(id, runId) {
      project(id);
      options.execution.snapshot(runId);
      const previous = runs.get(runId);
      if (previous && previous !== id)
        throw new Error('Run already belongs to another project');
      runs.set(runId, id);
    },
    async startSession(launch, projectId) {
      let id = projectId;
      let input = launch;
      if (id === undefined) {
        if (
          launch.provider === 'fixture' ||
          launch.source.kind !== 'directory' ||
          !launch.source.base
        )
          throw new Error('Choose a Git project and starting branch');
        const local = await inspectLocalProject(
          launch.source.path,
          launch.source.base,
        );
        id = workspaces.register(
          `directory:${local.identityPath}`,
          local.identityPath,
        );
        input = {
          ...launch,
          source: { ...launch.source, path: local.path },
          label: launch.label ?? basename(local.identityPath),
        };
      } else project(id);
      const run =
        input.provider === 'fixture'
          ? await options.execution.start(input)
          : options.execution.launch(input);
      workspaces.associate(id, run.id);
      return { projectId: id, run };
    },
    async snapshot() {
      return Promise.all(
        [...projects].map(async ([id, { source, work }]) => ({
          id,
          source,
          runIds: [...runs]
            .filter(([, value]) => value === id)
            .map(([runId]) => runId),
          work: await work.snapshot(),
        })),
      );
    },
    overview() {
      const items = options.attention.list();
      const ranked = options.execution
        .list()
        .flatMap((run) => {
          const projectId = runs.get(run.id);
          return projectId
            ? [{ projectId, runId: run.id, next: nextAction(run, items) }]
            : [];
        })
        // Array sort is stable, so equal urgency keeps launch order.
        .sort((a, b) => urgency(a.next) - urgency(b.next));
      const order = [
        ...new Set([...ranked.map((run) => run.projectId), ...projects.keys()]),
      ];
      return order.map((projectId) => {
        const own = ranked
          .filter((run) => run.projectId === projectId)
          .map(({ runId, next }) => ({ runId, next }));
        const next = [...own].sort((a, b) => rank(a.next) - rank(b.next))[0];
        return { projectId, next: next ?? null, runs: own };
      });
    },
    apply(id, command) {
      const target = project(id);
      if ('runId' in command && command.runId) {
        options.execution.snapshot(command.runId);
        if (runs.get(command.runId) !== id)
          return Promise.reject(
            new Error('This Run belongs to another project'),
          );
      }
      return target.work.apply(command);
    },
    submit(runId, text) {
      const id = runs.get(runId);
      if (!id)
        return Promise.reject(new Error('Run has no project association'));
      return project(id).work.submit(runId, text);
    },
    async close() {
      closed = true;
      await Promise.all([...projects.values()].map(({ work }) => work.close()));
      runs.clear();
    },
  };
  return workspaces;
}
