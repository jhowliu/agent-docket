const stages = ['clarification', 'development', 'agent-review', 'human-review'];
const labels = ['Clarify', 'Develop', 'Agent review', 'Human review'];
const fullLabels = [
  'Requirement clarification',
  'Development',
  'Agent Review',
  'Human Review',
];
const plain = (value, max) => typeof value === 'string' && value.length <= max;
const identifier = (value, prefix) =>
  typeof value === 'string' &&
  new RegExp(`^${prefix}-[a-f0-9-]{36}$`).test(value);

/** Validate network data before it is used for controls or command targets. */
export function parseWorkSnapshot(value) {
  if (value === undefined) return undefined;
  const invalid = {
    kind: 'unavailable',
    reason: 'Invalid Roadmap state; reconnect before editing.',
    plan: null,
    bindings: [],
  };
  if (!value || typeof value !== 'object') return invalid;
  if (value.kind === 'unavailable' && plain(value.reason, 400))
    return { ...invalid, reason: value.reason };
  if (
    value.kind !== 'ready' ||
    !['memory', 'project-file'].includes(value.persistence) ||
    !Array.isArray(value.bindings) ||
    value.bindings.length > 64
  )
    return invalid;
  const plan = value.plan;
  if (plan !== null) {
    if (
      !plan ||
      plan.version !== 1 ||
      !plain(plan.title, 120) ||
      !Number.isSafeInteger(plan.revision) ||
      plan.revision < 1 ||
      !/^[a-f0-9]{64}$/.test(plan.projectId) ||
      !Array.isArray(plan.phases) ||
      plan.phases.length < 1 ||
      plan.phases.length > 8
    )
      return invalid;
    const phaseIds = new Set(),
      taskIds = new Set();
    for (const phase of plan.phases) {
      if (
        !phase ||
        !identifier(phase.id, 'phase') ||
        phaseIds.has(phase.id) ||
        !plain(phase.title, 120) ||
        !plain(phase.goal, 1000) ||
        !Array.isArray(phase.tasks) ||
        phase.tasks.length > 16
      )
        return invalid;
      phaseIds.add(phase.id);
      for (const task of phase.tasks) {
        if (
          !task ||
          !identifier(task.id, 'task') ||
          taskIds.has(task.id) ||
          !plain(task.title, 120) ||
          !stages.includes(task.stage) ||
          !['planned', 'active', 'accepted'].includes(task.status) ||
          !task.spec ||
          !Number.isSafeInteger(task.spec.revision) ||
          task.spec.revision < 1 ||
          !plain(task.spec.text, 4000) ||
          typeof task.spec.confirmed !== 'boolean' ||
          (task.stage !== 'clarification' && !task.spec.confirmed)
        )
          return invalid;
        taskIds.add(task.id);
      }
    }
    if (
      !phaseIds.has(plan.activePhaseId) ||
      taskIds.size > 64 ||
      value.bindings.some(
        (binding) =>
          !binding ||
          !/^run-[a-zA-Z0-9-]+$/.test(binding.runId) ||
          !taskIds.has(binding.taskId),
      )
    )
      return invalid;
  } else if (value.bindings.length) return invalid;
  return value;
}

/** Browser projection only. All changes go through the authenticated work Interface. */
export function createRoadmapView({
  root,
  read,
  command,
  selectRun,
  feedback,
}) {
  const $ = (query) => root.querySelector(query);
  const escape = (value) =>
    String(value).replace(
      /[&<>"']/g,
      (c) =>
        ({
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&#39;',
        })[c],
    );
  const markup = new WeakMap();
  let previousRun = null,
    previousTask = null,
    inspectedPhase = null,
    inspectedStage = null;
  let editorRevision = 0,
    editorRun = null;
  function html(element, content) {
    if (markup.get(element) === content) return;
    const active = document.activeElement;
    const key = element.contains(active)
      ? [...active.attributes].find(
          (attribute) =>
            attribute.name.startsWith('data-work-') && attribute.value,
        )
      : null;
    element.innerHTML = content;
    markup.set(element, content);
    if (key)
      [...element.querySelectorAll(`[${key.name}]`)]
        .find((node) => node.getAttribute(key.name) === key.value)
        ?.focus({ preventScroll: true });
  }
  const currentRun = () =>
    read().runs.find((run) => run.id === read().selected);
  function currentTask(runId = read().selected) {
    const work =
      read().projects?.find((project) => project.runIds.includes(runId))
        ?.work ?? read().work;
    if (work?.kind !== 'ready' || !work.plan) return null;
    const id = work.bindings.find((binding) => binding.runId === runId)?.taskId;
    for (const phase of work.plan.phases) {
      const task = phase.tasks.find((task) => task.id === id);
      if (task) return { plan: work.plan, phase, task };
    }
    return null;
  }
  const available = () => read().connected && !read().busy;
  const activeRun = (run) =>
    !['cancelled', 'closed', 'failed', 'interrupted', 'cancelling'].includes(
      run.state.kind,
    );
  function close() {
    $('[data-roadmap]').open = false;
    $('[data-work-editor]').hidden = true;
    inspectedStage = null;
    $('[data-work-inspector]').hidden = true;
  }
  function renderMap(plan) {
    if (!plan.phases.some((phase) => phase.id === inspectedPhase))
      inspectedPhase = currentTask()?.phase.id ?? plan.activePhaseId;
    const phase = plan.phases.find((phase) => phase.id === inspectedPhase);
    $('[data-roadmap-title]').textContent = plan.title;
    html(
      $('[data-work-phases]'),
      plan.phases
        .map(
          (phase, index) =>
            `<button class="aw-work-phase" type="button" data-work-phase="${phase.id}" aria-pressed="${phase.id === inspectedPhase}"><span>Phase ${index + 1} · ${escape(phase.title)}</span><span>${phase.id === plan.activePhaseId ? 'Current' : ''}</span></button>`,
        )
        .join(''),
    );
    html(
      $('[data-work-tasks]'),
      phase.tasks.length
        ? phase.tasks
            .map((task, index) => {
              const run = read().runs.find(
                (run) =>
                  activeRun(run) &&
                  read().work.bindings.some(
                    (binding) =>
                      binding.runId === run.id && binding.taskId === task.id,
                  ),
              );
              return `<button class="aw-work-task" type="button" ${run ? `data-work-open-run="${run.id}"` : `data-work-choose-task="${task.id}"`}><span>${index + 1}. ${escape(task.title)}</span><span>${labels[stages.indexOf(task.stage)]}</span></button>`;
            })
            .join('')
        : '<p class="aw-note">No Tasks in this Phase yet.</p>',
    );
    $('[data-work-summary]').textContent =
      phase.goal ||
      `${phase.tasks.length} Task${phase.tasks.length === 1 ? '' : 's'} · ${phase.id === plan.activePhaseId ? 'Current Phase' : 'Viewing this Phase'}`;
    $('[data-work-focus]').hidden = phase.id === plan.activePhaseId;
    $('[data-work-focus]').disabled = !available();
  }
  function renderInspector(tracked) {
    const panel = $('[data-work-inspector]');
    panel.hidden = !tracked || inspectedStage === null;
    if (panel.hidden) return;
    const { task } = tracked;
    const index = stages.indexOf(inspectedStage);
    $('[data-work-stage-title]').textContent =
      `${fullLabels[index]} · ${task.stage === inspectedStage ? 'Current' : inspectedStage === 'clarification' && task.spec.confirmed ? 'Confirmed' : 'Not verified'}`;
    $('[data-work-stage-description]').textContent =
      inspectedStage === 'clarification'
        ? task.spec.text ||
          'Write the requirements and acceptance conditions to begin.'
        : inspectedStage === 'development'
          ? task.title
          : 'This is the working stage. No independent review or verification result has been recorded.';
    $('[data-work-stage-use]').hidden = task.stage === inspectedStage;
    $('[data-work-stage-use]').disabled =
      !available() ||
      (inspectedStage !== 'clarification' && !task.spec.confirmed);
  }
  function render() {
    const state = read(),
      run = currentRun(),
      work = state.work;
    if ((run?.id ?? null) !== previousRun) {
      close();
      inspectedPhase = null;
      previousRun = run?.id ?? null;
    }
    $('[data-project-roadmap]').hidden = !work;
    $('[data-project-roadmap]').disabled = !available();
    $('[data-work-options]').hidden = !run || !work;
    const tracked = currentTask();
    if ((tracked?.task.id ?? null) !== previousTask) {
      close();
      inspectedPhase = null;
      previousTask = tracked?.task.id ?? null;
    }
    html(
      $('[data-work-options]'),
      work
        ? `<button type="button" class="aw-button" data-work-open-editor>${tracked ? 'Task / Roadmap' : 'Use Roadmap'}</button>${tracked ? '<button type="button" class="aw-button" data-work-direct>Direct mode</button>' : ''}`
        : '',
    );
    $('[data-workflow]').hidden = !tracked;
    if (tracked) {
      html(
        $('[data-work-steps]'),
        stages
          .map(
            (stage, index) =>
              `<li><button type="button" class="aw-work-step" data-work-stage="${stage}" ${tracked.task.stage === stage ? 'aria-current="step"' : ''} aria-label="${fullLabels[index]}${tracked.task.stage === stage ? ' — current working stage' : ''}">${index + 1} <span class="aw-work-long">${labels[index]}</span><span class="aw-work-short">${['Req', 'Dev', 'Agent', 'Human'][index]}</span></button></li>`,
          )
          .join(''),
      );
      $('[data-roadmap-summary]').textContent =
        `Phase ${tracked.plan.phases.findIndex((phase) => phase.id === tracked.phase.id) + 1} / ${tracked.plan.phases.length} · Roadmap`;
    }
    if (work?.kind === 'ready' && work.plan) renderMap(work.plan);
    renderInspector(tracked);
    root
      .querySelectorAll(
        '[data-work-editor] button[type="submit"], [data-work-confirm], [data-work-direct]',
      )
      .forEach((button) => {
        button.disabled = !available();
      });
    const confirm = $('[data-work-confirm]');
    if (confirm && tracked)
      confirm.disabled =
        !available() ||
        $('[data-work-spec] textarea').value !== tracked.task.spec.text;
  }
  function openEditor(taskChoice) {
    const work = read().work;
    if (!work || work.kind !== 'ready') {
      feedback(work?.reason ?? 'This server does not support Roadmaps.', true);
      return;
    }
    editorRevision = work.plan?.revision ?? 0;
    editorRun = currentRun()?.id ?? null;
    $('[data-roadmap]').open = false;
    const plan = work.plan,
      tracked = currentTask();
    const caption =
      work.persistence === 'project-file'
        ? 'Project plan files are saved. Run sessions stay temporary.'
        : 'This plan is temporary for the current server.';
    let content = `<div class="aw-work-heading"><strong>${plan ? escape(plan.title) : 'Use Roadmap'}</strong><button class="aw-button" type="button" data-work-close-editor>Close</button></div><p class="aw-note">${caption}</p>`;
    if (!plan) {
      content +=
        '<form class="aw-work-form" data-work-create><label>Roadmap name<input name="title" class="aw-input" maxlength="120" required></label><label>First Phase<input name="phase" class="aw-input" maxlength="120" value="Implementation" required></label><label>First Task<input name="task" class="aw-input" maxlength="120" required></label><label class="aw-work-wide">Requirements and acceptance conditions<textarea name="spec" class="aw-input" rows="3" maxlength="4000"></textarea></label><button class="aw-button aw-primary" type="submit">Use Roadmap</button></form>';
    } else {
      content += `<p class="aw-note">Current Phase: ${escape(plan.phases.find((phase) => phase.id === plan.activePhaseId)?.title ?? '')}</p>`;
      if (editorRun)
        content += `<form class="aw-work-form" data-work-attach><label class="aw-work-wide">Task for this Run<select name="task" class="aw-input">${plan.phases.map((phase, p) => phase.tasks.map((task, t) => `<option value="${task.id}" ${task.id === (taskChoice ?? tracked?.task.id) ? 'selected' : ''}>${p + 1}.${t + 1} ${escape(task.title)}</option>`).join('')).join('')}</select></label><button class="aw-button" type="submit">Attach this Run</button></form>`;
      else
        content +=
          '<p class="aw-note">Start a Run to continue an existing Task.</p>';
      if (tracked)
        content += `<form class="aw-work-form" data-work-spec><label class="aw-work-wide">${escape(tracked.task.title)} · requirements v${tracked.task.spec.revision}${tracked.task.spec.confirmed ? ' · Confirmed' : ' · Draft'}<textarea class="aw-input" name="spec" rows="3" maxlength="4000" required>${escape(tracked.task.spec.text)}</textarea></label><button class="aw-button" type="submit">Save requirements</button><button class="aw-button" type="button" data-work-confirm ${!tracked.task.spec.text || tracked.task.spec.confirmed ? 'hidden' : ''}>Confirm saved requirements</button></form>`;
      content += `<details class="aw-work-add"><summary>Add Phase</summary><form class="aw-work-form" data-work-add-phase><label>Phase name<input class="aw-input" name="title" maxlength="120" required></label><label>Goal<input class="aw-input" name="goal" maxlength="1000"></label><button class="aw-button" type="submit">Add Phase</button></form></details><details class="aw-work-add"><summary>Add Task</summary><form class="aw-work-form" data-work-add-task><label>Phase<select class="aw-input" name="phase">${plan.phases.map((phase, index) => `<option value="${phase.id}" ${phase.id === (tracked?.phase.id ?? plan.activePhaseId) ? 'selected' : ''}>${index + 1}. ${escape(phase.title)}</option>`).join('')}</select></label><label>Task name<input class="aw-input" name="title" maxlength="120" required></label><label class="aw-work-wide">Requirements<textarea class="aw-input" name="spec" rows="2" maxlength="4000"></textarea></label>${editorRun ? '<label class="aw-work-wide"><input type="checkbox" name="attach"> Attach this Run to the new Task</label>' : ''}<button class="aw-button" type="submit">Add Task</button></form></details>`;
    }
    $('[data-work-editor]').innerHTML = content;
    $('[data-work-editor]').hidden = false;
    $(
      '[data-work-editor] input, [data-work-editor] select, [data-work-editor] textarea',
    )?.focus();
    render();
  }
  async function apply(input, closeEditor = true) {
    if (!available()) return false;
    const okay = await command(input);
    if (okay && closeEditor) $('[data-work-editor]').hidden = true;
    render();
    return okay;
  }
  root.addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest('button');
    if (!button || button.disabled) return;
    const work = read().work;
    if (
      button.hasAttribute('data-project-roadmap') ||
      button.hasAttribute('data-work-open-editor')
    ) {
      openEditor();
      return;
    }
    if (button.hasAttribute('data-work-close-editor')) {
      $('[data-work-editor]').hidden = true;
      return;
    }
    if (button.hasAttribute('data-work-close-map')) {
      $('[data-roadmap]').open = false;
      $('[data-roadmap-summary]').focus();
      return;
    }
    if (button.dataset.workPhase) {
      inspectedPhase = button.dataset.workPhase;
      if (work?.kind === 'ready' && work.plan) renderMap(work.plan);
      return;
    }
    if (button.dataset.workOpenRun) {
      selectRun(button.dataset.workOpenRun);
      return;
    }
    if (button.dataset.workChooseTask) {
      openEditor(button.dataset.workChooseTask);
      return;
    }
    if (button.dataset.workStage) {
      inspectedStage = button.dataset.workStage;
      renderInspector(currentTask());
      return;
    }
    if (button.hasAttribute('data-work-close-stage')) {
      inspectedStage = null;
      renderInspector(null);
      return;
    }
    if (work?.kind !== 'ready' || !work.plan) return;
    const expectedRevision = work.plan.revision;
    if (button.hasAttribute('data-work-direct') && currentRun())
      void apply({
        kind: 'work.detach',
        expectedRevision,
        runId: currentRun().id,
      });
    if (button.hasAttribute('data-work-focus') && inspectedPhase)
      void apply(
        { kind: 'work.focus', expectedRevision, phaseId: inspectedPhase },
        false,
      );
    if (
      button.hasAttribute('data-work-stage-use') &&
      currentTask() &&
      inspectedStage
    )
      void apply(
        {
          kind: 'work.stage',
          expectedRevision,
          taskId: currentTask().task.id,
          stage: inspectedStage,
        },
        false,
      );
    if (button.hasAttribute('data-work-confirm') && currentTask())
      void apply({
        kind: 'work.confirm',
        expectedRevision: editorRevision,
        taskId: currentTask().task.id,
      });
  });
  root.addEventListener('submit', (event) => {
    const form = event.target;
    if (
      !(form instanceof HTMLFormElement) ||
      !form.matches(
        '[data-work-create], [data-work-attach], [data-work-spec], [data-work-add-phase], [data-work-add-task]',
      )
    )
      return;
    event.preventDefault();
    const fields = new FormData(form),
      text = (name) => String(fields.get(name) ?? '').trim();
    const expectedRevision = editorRevision;
    if (form.hasAttribute('data-work-create'))
      void apply({
        kind: 'work.create',
        expectedRevision,
        ...(editorRun ? { runId: editorRun } : {}),
        title: text('title'),
        phaseTitle: text('phase'),
        taskTitle: text('task'),
        spec: text('spec'),
      });
    else if (form.hasAttribute('data-work-attach') && editorRun)
      void apply({
        kind: 'work.attach',
        expectedRevision,
        runId: editorRun,
        taskId: text('task'),
      });
    else if (form.hasAttribute('data-work-spec') && currentTask())
      void apply({
        kind: 'work.spec',
        expectedRevision,
        taskId: currentTask().task.id,
        text: text('spec'),
      });
    else if (form.hasAttribute('data-work-add-phase'))
      void apply({
        kind: 'work.add-phase',
        expectedRevision,
        title: text('title'),
        goal: text('goal'),
      });
    else if (form.hasAttribute('data-work-add-task'))
      void apply({
        kind: 'work.add-task',
        expectedRevision,
        phaseId: text('phase'),
        title: text('title'),
        spec: text('spec'),
        ...(editorRun && fields.has('attach') ? { runId: editorRun } : {}),
      });
  });
  root.addEventListener('input', (event) => {
    if (
      event.target instanceof HTMLTextAreaElement &&
      event.target.closest('[data-work-spec]')
    )
      render();
  });
  document.addEventListener('click', (event) => {
    if (!event.composedPath().includes($('[data-roadmap]')))
      $('[data-roadmap]').open = false;
  });
  return {
    render,
    title(runId) {
      return currentTask(runId)?.task.title ?? '';
    },
    open() {
      if (!currentTask()) {
        openEditor();
        return;
      }
      $('[data-roadmap]').open = !$('[data-roadmap]').open;
      $('[data-roadmap-summary]').focus();
    },
    escape() {
      if (
        !$('[data-work-editor]').hidden ||
        $('[data-roadmap]').open ||
        inspectedStage !== null
      ) {
        close();
        return true;
      }
      return false;
    },
  };
}
