import { createHash } from 'node:crypto';
import type { RunId } from '../../execution/index.js';
import type { ProjectWorkspaces, Work, WorkOptions } from '../index.js';
import { createWork } from './work.js';

/** Owns project plan selection and prevents cross-project Run/Task attachment. */
export function createProjectWorkspaces(
  options: Omit<WorkOptions, 'projectKey'>,
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
  return {
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
}
