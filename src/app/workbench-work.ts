import type { RunId } from '../execution/index.js';
import type { WorkCommand } from '../work/index.js';
import { stageSchema } from '../work/index.js';
import type { WorkbenchState } from './workbench-protocol.js';

/** Selected-Run projection; project ownership is authoritative in work. */
export function projectForRun(state: WorkbenchState, runId: RunId | null) {
  return (
    state.projects?.find(
      (project) => runId !== null && project.runIds.includes(runId),
    ) ??
    state.projects?.find((project) => project.id === state.defaultProjectId)
  );
}
export function stateForRun(
  state: WorkbenchState,
  runId: RunId | null,
): WorkbenchState {
  const project = projectForRun(state, runId);
  return project
    ? { ...state, source: project.source, work: project.work }
    : state;
}

export const stageLabels = {
  clarification: 'Clarify',
  development: 'Develop',
  'agent-review': 'Agent review',
  'human-review': 'Human review',
} as const;

export function trackedWork(state: WorkbenchState, runId: RunId | null) {
  const work = stateForRun(state, runId).work;
  if (work?.kind !== 'ready' || !work.plan) return null;
  const taskId = work.bindings.find(
    (binding) => binding.runId === runId,
  )?.taskId;
  for (const phase of work.plan.phases) {
    const task = phase.tasks.find((task) => task.id === taskId);
    if (task) return { plan: work.plan, phase, task };
  }
  return null;
}

/** Terminal syntax only. Work validates all identities, revisions and workflow rules. */
export function roadmapCommand(
  text: string,
  state: WorkbenchState,
  runId: RunId | null,
): WorkCommand | null {
  const [name = '', ...parts] = text.trim().split(/\s+/u);
  if (
    ![
      'roadmap',
      'phase',
      'task',
      'track',
      'direct',
      'spec',
      'confirm',
      'stage',
      'focus',
    ].includes(name)
  )
    return null;
  const work = stateForRun(state, runId).work;
  if (!work)
    throw new Error(
      'This server does not support Roadmaps; use a new server on another port',
    );
  if (work.kind === 'unavailable') throw new Error(work.reason);
  const plan = work.plan;
  const argument = text.trim().slice(name.length).trimStart();
  const expectedRevision = plan?.revision ?? 0;
  if (name === 'roadmap') {
    if (!argument) return null;
    return {
      kind: 'work.create',
      expectedRevision,
      ...(runId ? { runId } : {}),
      title: argument,
      phaseTitle: 'Implementation',
      taskTitle: argument,
      spec: '',
    };
  }
  if (!plan)
    throw new Error('Use :roadmap <title> to create a project plan first');
  if (name === 'phase' && argument)
    return {
      kind: 'work.add-phase',
      expectedRevision,
      title: argument,
      goal: '',
    };
  if (name === 'task' && /^\d+$/.test(parts[0] ?? '') && parts.length > 1) {
    const phase = plan.phases[Number(parts[0]) - 1];
    if (!phase) throw new Error('Phase number not found; o shows the Roadmap');
    return {
      kind: 'work.add-task',
      expectedRevision,
      phaseId: phase.id,
      title: parts.slice(1).join(' '),
      spec: '',
    };
  }
  if (name === 'focus' && /^\d+$/.test(argument)) {
    const phase = plan.phases[Number(argument) - 1];
    if (!phase) throw new Error('Phase number not found');
    return { kind: 'work.focus', expectedRevision, phaseId: phase.id };
  }
  if (name === 'track' && /^\d+\.\d+$/.test(argument)) {
    if (!runId) throw new Error('Select a current Run before attaching a Task');
    const [phaseNumber = 0, taskNumber = 0] = argument.split('.').map(Number);
    const task = plan.phases[phaseNumber - 1]?.tasks[taskNumber - 1];
    if (!task) throw new Error('Task not found; use :track <phase>.<task>');
    return { kind: 'work.attach', expectedRevision, runId, taskId: task.id };
  }
  if (name === 'direct' && !argument) {
    if (!runId) throw new Error('Select a current Run first');
    return { kind: 'work.detach', expectedRevision, runId };
  }
  const current = trackedWork(state, runId);
  if (!current)
    throw new Error('Attach this Run with :track <phase>.<task> first');
  const taskId = current.task.id;
  if (name === 'spec' && argument)
    return { kind: 'work.spec', expectedRevision, taskId, text: argument };
  if (name === 'confirm' && !argument)
    return { kind: 'work.confirm', expectedRevision, taskId };
  if (name === 'stage') {
    const stage = stageSchema.safeParse(argument);
    if (stage.success)
      return {
        kind: 'work.stage',
        expectedRevision,
        taskId,
        stage: stage.data,
      };
  }
  throw new Error(
    'Use :phase <title> / :task <phase> <title> / :track 1.1 / :spec <text> / :confirm / :stage development',
  );
}
