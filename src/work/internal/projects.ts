import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { inspectLocalProject, suggestCheck } from '../../execution/index.js';
import type { RunId, RunSnapshot } from '../../execution/index.js';
import type { AttentionItem } from '../../attention/index.js';
import type { Verification } from '../../evidence/index.js';
import type {
  NextAction,
  ProjectWorkspaces,
  ProjectWorkspacesOptions,
  TaskFlow,
} from '../index.js';
import { nextActionSchema } from './contract.js';
import { createTrackedWork } from './work.js';
import { CheckRequired, createCheckStore } from './checks.js';

/** Failed checks sent back to the agent before the flow stops for the person. */
const FIX_LIMIT = 2;
const errorText = (error: unknown) =>
  (error instanceof Error ? error.message : 'Checks could not start').slice(
    0,
    400,
  );
/** The end of a check's output, enough to fix it from. */
const tail = (output: string) =>
  output.trimEnd().split('\n').slice(-60).join('\n').slice(-3000);

const rank = (next: NextAction) => nextActionSchema.options.indexOf(next);
// Prompt, working and ended rank alike for ordering: none asks for a decision.
const urgency = (next: NextAction) => Math.min(rank(next), rank('prompt'));

function nextAction(
  run: RunSnapshot,
  items: readonly AttentionItem[],
  flow: TaskFlow | undefined,
  review: boolean,
): NextAction {
  const pending = items.filter(
    (item) => item.runId === run.id && item.status === 'pending',
  );
  // An approval blocks the agent; an agent request only waits on the person.
  if (pending.some((item) => item.kind === 'permission')) return 'approve';
  if (pending.length) return 'respond';
  if (run.state.kind === 'authentication-required') return 'sign-in';
  if (run.state.kind === 'idle' && flow?.step === 'stopped') return 'checks';
  if (run.state.kind === 'idle' && review) return 'accept';
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
  const projects = new Map<
    string,
    { source: string; work: ReturnType<typeof createTrackedWork> }
  >();
  const runs = new Map<RunId, string>();
  const checks = createCheckStore(options.directory);
  let closed = false;
  function project(id: string) {
    const found = projects.get(id);
    if (closed || !found)
      throw new Error('Project is unavailable; refresh the workbench');
    return found;
  }
  function owner(runId: RunId) {
    const id = runs.get(runId);
    if (!id) throw new Error('Run has no project association');
    return project(id);
  }
  /** Forgets Runs that execution removed after the person cancelled them. */
  function prune() {
    const live = new Set(options.execution.list().map((run) => run.id));
    for (const runId of runs.keys())
      if (!live.has(runId)) {
        runs.delete(runId);
        flows.delete(runId);
        finishing.delete(runId);
      }
  }

  // The Task flow: an agent's finished report on a confirmed Task starts its
  // checks; failures go back to the agent at most FIX_LIMIT times; a pass
  // moves the Task to Human Review. Steps run one at a time.
  const flows = new Map<RunId, TaskFlow>();
  const finishing = new Set<RunId>();
  let steps = Promise.resolve();
  const step = (task: () => Promise<void>) => {
    steps = steps.then(() => (closed ? undefined : task())).catch(() => {});
  };
  const unsubscribe = options.execution.subscribe((event) => {
    if (!runs.has(event.runId)) return;
    if (event.type === 'turn.start') finishing.delete(event.runId);
    else if (event.type === 'agent.progress' && event.finished)
      finishing.add(event.runId);
    else if (
      event.type === 'turn.end' &&
      finishing.delete(event.runId) &&
      event.reason !== 'cancelled'
    )
      step(() => finished(event.runId));
  });
  /** Starts the project's check on the Run's code; its result feeds the flow. */
  async function check(runId: RunId): Promise<void> {
    const id = runs.get(runId);
    if (!id) throw new Error('Run has no project association');
    const { work } = project(id);
    const command = checks.get(id);
    if (!command) {
      const path = options.execution.snapshot(runId).worktree?.path;
      throw new CheckRequired(path ? await suggestCheck(path) : null);
    }
    // A fresh plan read, so the check binds to the current spec revision.
    await work.snapshot();
    const { settled } = await options.evidence.verify({
      runId,
      command,
      spec: work.specOf(runId),
    });
    void settled.then((done) => step(() => checked(runId, done)));
  }
  async function finished(runId: RunId) {
    const { work } = owner(runId);
    await work.snapshot();
    const task = work.taskOf(runId);
    // Only a confirmed Task in Development, or back from Human Review, flows.
    if (
      !task?.spec.confirmed ||
      !['development', 'human-review'].includes(task.stage) ||
      !options.execution.snapshot(runId).worktree ||
      // An open agent request outranks a finished report.
      options.attention
        .list()
        .some((item) => item.runId === runId && item.status === 'pending')
    )
      return;
    const previous = flows.get(runId);
    const flow: TaskFlow = {
      runId,
      taskId: task.id,
      step: 'verifying',
      attempts: previous?.taskId === task.id ? previous.attempts : 0,
      reason: '',
    };
    flows.set(runId, flow);
    try {
      if (task.stage !== 'development' || task.status === 'accepted')
        await work.transition(task.id, {
          stage: 'development',
          status: 'active',
        });
      await check(runId);
    } catch (error) {
      flows.set(runId, {
        ...flow,
        step: 'stopped',
        reason:
          error instanceof CheckRequired
            ? `Set a check first: :check ${error.suggestion ?? '<command>'}`
            : errorText(error),
      });
    }
  }
  async function checked(runId: RunId, done: Verification | null) {
    const { work } = owner(runId);
    const flow = flows.get(runId);
    const automatic = flow?.step === 'verifying' ? flow : undefined;
    if (automatic) flows.delete(runId);
    await work.snapshot();
    const task = work.taskOf(runId);
    const run = options.execution.snapshot(runId);
    const judged = options.evidence.assess(runId, {
      tree: run.worktree?.tree,
      spec: work.specOf(runId),
    });
    // A newer check, another Task or changed code or requirements: nothing moves.
    if (
      !done?.result ||
      !task ||
      !judged ||
      judged.verification.candidate.sha !== done.candidate.sha
    )
      return;
    const { status, reason } = judged.assessment;
    if (status === 'passed') {
      if (task.stage === 'development' && task.status !== 'accepted')
        await work.transition(task.id, { stage: 'human-review' });
      return;
    }
    // Checks the person started are shown, never sent back.
    if (!automatic || run.state.kind !== 'idle' || status === 'stale') return;
    if (status !== 'failed' || automatic.attempts >= FIX_LIMIT) {
      flows.set(runId, {
        ...automatic,
        step: 'stopped',
        reason: (status === 'failed'
          ? `Checks still fail after ${FIX_LIMIT} fixes: ${reason}`
          : reason
        ).slice(0, 400),
      });
      return;
    }
    const attempts = automatic.attempts + 1;
    flows.set(runId, { ...automatic, step: 'fixing', attempts, reason });
    try {
      await work.submit(
        runId,
        [
          `Workbench checks failed on Candidate ${done.candidate.sha.slice(0, 7)} (automatic fix ${attempts} of ${FIX_LIMIT}).`,
          `Command: ${done.command}`,
          `Result: ${reason}`,
          'Last output:',
          tail(done.result.output) || '(no output)',
          '',
          'Fix the cause within this Task, then report finished again. The person sets the check command; do not change it.',
        ].join('\n'),
      );
    } catch (error) {
      flows.set(runId, {
        ...automatic,
        attempts,
        step: 'stopped',
        reason: errorText(error),
      });
    }
  }
  /** Human Review is due: the Task waits in its stage with passing checks. */
  function inReview(runId: RunId) {
    const id = runs.get(runId);
    const found = id ? projects.get(id) : undefined;
    const task = found?.work.taskOf(runId);
    if (!found || task?.stage !== 'human-review' || task.status === 'accepted')
      return false;
    return (
      options.evidence.assess(runId, {
        tree: options.execution.snapshot(runId).worktree?.tree,
        spec: found.work.specOf(runId),
      })?.assessment.status === 'passed'
    );
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
          work: createTrackedWork({
            execution: options.execution,
            projectKey,
            ...(options.directory ? { directory: options.directory } : {}),
          }),
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
      prune();
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
            ? [
                {
                  projectId,
                  runId: run.id,
                  next: nextAction(
                    run,
                    items,
                    flows.get(run.id),
                    inReview(run.id),
                  ),
                },
              ]
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
    checks: () => checks.list(),
    setCheck(id, command) {
      project(id);
      return checks.set(id, command);
    },
    verify: check,
    flows() {
      prune();
      return [...flows.values()].filter((flow) => runs.has(flow.runId));
    },
    async accept(runId) {
      const { work } = owner(runId);
      await work.snapshot();
      const task = work.taskOf(runId);
      if (!task) throw new Error('Attach this Run to a Task before accepting');
      if (task.status === 'accepted') return;
      const judged = options.evidence.assess(runId, {
        tree: options.execution.snapshot(runId).worktree?.tree,
        spec: work.specOf(runId),
      });
      if (judged?.assessment.status !== 'passed')
        throw new Error(
          `Accept needs checks passing on the current code and requirements (${judged ? `${judged.assessment.status}: ${judged.assessment.reason}` : 'not checked yet'}) · v verifies`,
        );
      await work.transition(task.id, {
        stage: 'human-review',
        status: 'accepted',
      });
      flows.delete(runId);
    },
    async requestChanges(runId, text) {
      const { work } = owner(runId);
      await work.snapshot();
      const task = work.taskOf(runId);
      if (task?.stage !== 'human-review')
        throw new Error('Request changes once the Task is in Human Review');
      await work.transition(task.id, {
        stage: 'development',
        status: 'active',
      });
      flows.delete(runId);
      await work.submit(
        runId,
        [
          'Workbench Human Review requested changes:',
          text,
          '',
          'Make these changes within this Task, then report finished again.',
        ].join('\n'),
      );
    },
    verifications() {
      prune();
      return [...runs].flatMap(([runId, id]) => {
        const found = projects.get(id);
        const judged = found
          ? options.evidence.assess(runId, {
              tree: options.execution.snapshot(runId).worktree?.tree,
              spec: found.work.specOf(runId),
            })
          : null;
        return judged
          ? [
              {
                runId,
                command: judged.verification.command,
                candidate: judged.verification.candidate.sha,
                ...judged.assessment,
                reason: judged.assessment.reason.slice(0, 400),
              },
            ]
          : [];
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
      // The person takes over: automatic fixes start counting again.
      flows.delete(runId);
      return project(id).work.submit(runId, text);
    },
    async close() {
      closed = true;
      unsubscribe();
      await steps;
      await Promise.all([...projects.values()].map(({ work }) => work.close()));
      runs.clear();
    },
  };
  return workspaces;
}
