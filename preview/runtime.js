(() => {
  'use strict';
  const root = document.querySelector('#agent-workbench-preview');
  const $ = (query) => root.querySelector(query);
  const $$ = (query) => [...root.querySelectorAll(query)];
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
  const token = document.querySelector('meta[name="workbench-token"]').content;
  const state = {
    runs: [],
    attention: [],
    events: [],
    cursor: 0,
    selected: null,
    tab: 'timeline',
    filter: 'active',
    connected: false,
    busy: false,
    composing: false,
    source: 'fixtures/project',
    launch: { provider: 'fixture', kind: 'trusted-fixture-directory' },
    drafts: {},
    work: undefined,
    defaultWork: undefined,
    defaultSource: 'fixtures/project',
    projects: [],
    defaultProjectId: null,
    sessionOptions: null,
    instanceId: null,
  };
  let sessionView = null;
  async function updateSessionOptions(snapshot) {
    state.projectInitialization =
      snapshot.features?.projectInitialization === true;
    state.sessionOptions = snapshot.features?.newSession
      ? snapshot.sessionOptions
      : null;
    if (state.sessionOptions && !sessionView) {
      const module = await import('./runtime-session.js');
      sessionView = module.createSessionView({
        root,
        token,
        read: () => state,
        command,
      });
    }
  }
  const projectForRun = (id) =>
    state.projects.find((project) => project.runIds.includes(id)) ??
    state.projects.find((project) => project.id === state.defaultProjectId);
  function selectProject() {
    const project = projectForRun(state.selected);
    state.work = project?.work ?? state.defaultWork;
    state.source = project?.source ?? state.defaultSource;
  }
  let roadmap = null;
  let roadmapModule = null;
  async function updateRoadmap(input, projects, defaultProjectId) {
    if (input === undefined) {
      state.work = undefined;
      state.defaultWork = undefined;
      state.projects = [];
      state.defaultProjectId = null;
      return;
    }
    try {
      // Old daemons read current assets from disk but do not allowlist the new module.
      // Keep their ordinary Run controls working without requesting unsupported assets.
      roadmapModule ??= import('./runtime-work.js');
      const module = await roadmapModule;
      state.defaultWork = module.parseWorkSnapshot(input);
      state.defaultProjectId = defaultProjectId;
      state.projects =
        Array.isArray(projects) && projects.length <= 65
          ? projects
              .filter(
                (project) =>
                  project &&
                  /^[a-f0-9]{64}$/.test(project.id) &&
                  typeof project.source === 'string' &&
                  Array.isArray(project.runIds) &&
                  project.runIds.length <= 64 &&
                  project.runIds.every((id) => /^run-[a-zA-Z0-9-]+$/.test(id)),
              )
              .map((project) => ({
                ...project,
                work: module.parseWorkSnapshot(project.work),
              }))
          : [];
      selectProject();
      roadmap ??= module.createRoadmapView({
        root,
        read: () => state,
        command: (input) => command(input),
        selectRun: (id) => selectRun(id),
        feedback: (text, error) => feedback(text, error),
      });
    } catch {
      state.work = undefined;
      feedback(
        'Roadmap controls are unavailable; reload to retry. Ordinary Run controls remain connected.',
        true,
      );
    }
  }
  const lastHtml = new WeakMap();
  let polling = false;
  let panelKey = '';
  let receiptKey = '';
  let timer;
  let needsReload = false;
  let offlineMessage = 'Not connected to the fixture server';
  function html(element, content) {
    if (lastHtml.get(element) === content) return;
    const active = document.activeElement;
    const focusKey =
      element.contains(active) && active instanceof HTMLElement
        ? ['run', 'choice', 'tab'].find((key) => active.dataset[key])
        : null;
    const focusValue = focusKey ? active.dataset[focusKey] : null;
    const focusAttention =
      focusKey === 'choice' ? active.dataset.attention : null;
    const disclosures = new Map(
      [...element.querySelectorAll('details[data-disclosure]')].map((node) => [
        node.dataset.disclosure,
        node.open,
      ]),
    );
    element.innerHTML = content;
    lastHtml.set(element, content);
    if (focusKey)
      [...element.querySelectorAll(`[data-${focusKey}]`)]
        .find(
          (node) =>
            node.dataset[focusKey] === focusValue &&
            (!focusAttention || node.dataset.attention === focusAttention),
        )
        ?.focus({ preventScroll: true });
    element.querySelectorAll('details[data-disclosure]').forEach((node) => {
      if (disclosures.has(node.dataset.disclosure))
        node.open = disclosures.get(node.dataset.disclosure);
    });
  }
  const pending = (id) =>
    state.attention.filter(
      (item) => item.status === 'pending' && (!id || item.runId === id),
    );
  const selectedRun = () => state.runs.find((run) => run.id === state.selected);
  const stamp = (at) =>
    new Date(at).toLocaleTimeString('en-GB', { hour12: false });
  const terminal = (run) =>
    ['cancelled', 'closed', 'failed', 'interrupted'].includes(run.state.kind);
  const workspaceNeedsAction = (run) =>
    ['commit-required', 'retained'].includes(run?.worktree?.status.kind);
  const runLabel = (run) =>
    'Run ' + (state.runs.findIndex((item) => item.id === run.id) + 1);
  const visibleRuns = () =>
    state.runs.filter((run) =>
      state.filter === 'attention'
        ? pending(run.id).length > 0
        : !terminal(run) || workspaceNeedsAction(run),
    );
  function changeFilter(filter) {
    state.filter = filter;
    if (!visibleRuns().some((run) => run.id === state.selected))
      selectRun(visibleRuns()[0]?.id ?? null, false);
    render();
  }
  function status(run) {
    const open = pending(run.id);
    if (open.some((item) => item.kind !== 'agent-request'))
      return ['Awaiting approval', 'aw-wait'];
    if (open.length) return ['Needs you', 'aw-wait'];
    if (workspaceNeedsAction(run))
      return [
        run.worktree.status.kind === 'commit-required'
          ? 'Commit required'
          : 'Worktree retained',
        'aw-wait',
      ];
    const statuses = {
      starting: ['Starting', 'aw-wait'],
      idle: ['Idle', 'aw-muted'],
      running: ['Running', 'aw-running'],
      cancelling: ['Cancelling', 'aw-wait'],
      cancelled: ['Cancelled', 'aw-muted'],
      closed: ['Closed', 'aw-muted'],
      interrupted: ['Interrupted', 'aw-blocked'],
      failed: ['Start failed', 'aw-blocked'],
      'authentication-required': ['Sign-in required', 'aw-wait'],
    };
    return statuses[run.state.kind] ?? [run.state.kind, 'aw-muted'];
  }
  function feedback(text, error = false) {
    statusText($('[data-feedback]'), text);
    $('[data-feedback]').classList.toggle('aw-blocked', error);
  }
  function statusText(element, text) {
    if (element.textContent !== text) element.textContent = text;
  }
  function permissionDetail(item) {
    try {
      const tool = JSON.parse(item.detail);
      if (tool && typeof tool === 'object' && tool.kind === 'edit')
        return 'Edits this Run copy. No pre-edit diff was provided; open Diff after completion.';
    } catch {
      /* Plain-text details remain valid. */
    }
    return item.detail;
  }
  /** Something the agent asked the person to do or answer; marking it done tells the agent nothing. */
  function agentRequestHtml(item) {
    return (
      '<section class="aw-prompt" aria-label="' +
      (item.request === 'question' ? 'Question for you' : 'Needs you') +
      '"><div class="aw-prompt-title"><span>' +
      (item.request === 'question' ? 'Question for you · ' : 'Needs you · ') +
      escape(item.title) +
      '</span></div>' +
      (item.steps.length
        ? '<ol class="aw-request-steps">' +
          item.steps.map((step) => '<li>' + escape(step) + '</li>').join('') +
          '</ol>'
        : '') +
      '<div class="aw-actions"><button type="button" class="aw-button aw-primary" data-complete="' +
      escape(item.id) +
      '" data-attention="' +
      escape(item.id) +
      '"' +
      (!state.connected || state.busy ? ' disabled' : '') +
      '>Mark done</button></div><p class="aw-note">The agent is not told. Reply in the message box if it should continue.</p></section>'
    );
  }
  function eventText(event) {
    switch (event.type) {
      case 'run.state':
        return (
          event.state.kind +
          (event.state.reason ? ' · ' + event.state.reason : '')
        );
      case 'agent.message':
        return event.text;
      case 'agent.progress':
        return 'Progress · ' + event.summary;
      case 'turn.start':
        return 'Request · ' + event.text;
      case 'tool':
        return event.title + ' · ' + event.status;
      case 'attention':
        return 'Decision · ' + event.status;
      case 'turn.end':
        return 'Turn ended · ' + event.reason + ' (not task acceptance)';
      case 'diff':
        return 'File changed · ' + event.path;
      case 'capabilities':
        return event.capabilities.agent + ' ' + event.capabilities.version;
      case 'diagnostic':
        return event.message;
      case 'check.start':
        return 'Checks started · ' + event.command;
      case 'check.end':
        return (
          'Checks ended · ' +
          (event.outcome === 'exited'
            ? 'exit ' + event.exitCode
            : event.outcome) +
          ' (use the TUI for whether they still apply)'
        );
      default:
        return event.type;
    }
  }
  function renderPanel(run) {
    const events = state.events.filter((event) => event.runId === run.id);
    let content;
    if (state.tab === 'diff') {
      const diffs = events.filter((event) => event.type === 'diff');
      content = diffs.length
        ? '<p class="aw-note">' +
          (run.provider === 'fixture'
            ? 'Actual fixture file content, showing the full before and after text.'
            : 'Provider-reported changes. Use the Run path to inspect the workspace.') +
          '</p>' +
          diffs
            .map(
              (diff) =>
                '<div><strong class="aw-repo-path">' +
                escape(diff.path) +
                '</strong><span class="aw-diff-label">Before</span><pre class="aw-diff"><span class="aw-remove">' +
                escape(diff.oldText) +
                '</span></pre><span class="aw-diff-label">After</span><pre class="aw-diff"><span class="aw-add">' +
                escape(diff.newText) +
                '</span></pre></div>',
            )
            .join('')
        : '<p class="aw-note">No changes yet. Request an edit and allow it to see a diff; rejecting leaves the file unchanged.</p>';
    } else {
      const visible =
        state.tab === 'live'
          ? events.filter((event) =>
              [
                'agent.message',
                'agent.progress',
                'turn.start',
                'tool',
                'diagnostic',
                'turn.end',
              ].includes(event.type),
            )
          : events;
      content = visible.length
        ? visible
            .slice(-200)
            .map(
              (event) =>
                '<div class="aw-event"><time class="aw-time">' +
                escape(stamp(event.at)) +
                '</time><span class="aw-event-kind">' +
                escape(event.type) +
                '</span><span class="aw-event-text">' +
                escape(eventText(event)) +
                '</span></div>',
            )
            .join('')
        : '<p class="aw-note">' +
          (run.provider === 'fixture'
            ? 'Fixture ready. Choose a scenario to see messages and tool activity.'
            : 'Waiting for agent activity. Send a prompt when idle.') +
          '</p>';
      if (state.tab === 'timeline')
        content +=
          '<details class="aw-diagnostics" data-disclosure="diagnostics"><summary>Technical details</summary><dl><dt>Agent</dt><dd>' +
          escape(
            run.capabilities
              ? run.capabilities.agent + ' ' + run.capabilities.version
              : 'Not connected',
          ) +
          '</dd><dt>Run ID</dt><dd>' +
          escape(run.id) +
          '</dd><dt>Process state</dt><dd>' +
          escape(
            run.state.kind + (run.state.reason ? ' · ' + run.state.reason : ''),
          ) +
          '</dd><dt>Environment</dt><dd>' +
          escape(run.environment.kind) +
          (run.environment.kind === 'local'
            ? ' · local process, no OS isolation'
            : run.provider === 'fixture'
              ? ' · trusted fixture, not an OS sandbox'
              : '') +
          '</dd></dl></details>';
    }
    const panel = $('[data-panel]');
    const nextPanelKey = run.id + ':' + state.tab;
    const changedView = nextPanelKey !== panelKey;
    panelKey = nextPanelKey;
    const atEnd =
      panel.scrollHeight - panel.scrollTop - panel.clientHeight < 35;
    html(panel, content);
    if ((atEnd || changedView) && ['live', 'timeline'].includes(state.tab))
      panel.scrollTop = panel.scrollHeight;
    else if (changedView) panel.scrollTop = 0;
  }
  function render() {
    selectProject();
    roadmap?.render();
    sessionView?.render();
    const current = selectedRun();
    const launch = current
      ? { provider: current.provider, kind: current.environment.kind }
      : state.launch;
    statusText(
      $('[data-connection]'),
      state.connected
        ? launch.provider === 'fixture'
          ? 'DEMO · connected · no model'
          : launch.kind === 'local'
            ? 'LOCAL · no OS isolation'
            : 'CONTAINER · connected'
        : offlineMessage,
    );
    $('[data-connection]').classList.toggle('aw-running', state.connected);
    $('[data-offline]').hidden = state.connected || polling;
    $('[data-run-count]').textContent =
      (state.projects.length
        ? state.projects.filter((project) => project.runIds.length).length +
          ' projects'
        : '1 project') +
      ' · ' +
      state.runs.length +
      ' Runs';
    $('[data-project-name]').textContent =
      launch.provider === 'fixture'
        ? 'Built-in fixture project'
        : state.source.split('/').filter(Boolean).at(-1) ||
          launch.provider + ' project';
    $('[data-project-description]').textContent =
      launch.provider === 'fixture'
        ? 'Deterministic fixture; no model connection.'
        : launch.kind === 'local'
          ? 'Local process; no OS isolation. Clean worktrees are collected when closed.'
          : 'Configured worker environment.';
    $('[data-reconnect]').textContent = needsReload
      ? 'Reload page'
      : 'Reconnect';
    $('[data-total]').textContent = state.runs.filter(
      (run) => !terminal(run) || workspaceNeedsAction(run),
    ).length;
    $('[data-pending]').textContent = pending().length;
    $('[data-source]').textContent = state.source;
    $('[data-start]').disabled = !state.connected || state.busy;
    $$('[data-filter]').forEach((button) =>
      button.setAttribute(
        'aria-pressed',
        String(button.dataset.filter === state.filter),
      ),
    );
    const runs = visibleRuns();
    html(
      $('[data-roster]'),
      runs.length
        ? runs
            .map((run) => {
              const [text, color] = status(run);
              return (
                '<button type="button" class="aw-run" data-run="' +
                escape(run.id) +
                '" aria-pressed="' +
                (run.id === state.selected) +
                '"><span class="aw-run-title">' +
                escape(
                  runLabel(run) +
                    (roadmap?.title(run.id)
                      ? ' · ' + roadmap.title(run.id)
                      : ''),
                ) +
                '</span><span class="aw-state ' +
                color +
                '"><span class="aw-dot"></span>' +
                escape(text) +
                '</span></button>'
              );
            })
            .join('')
        : '<p class="aw-empty">' +
            (state.filter === 'attention'
              ? 'No pending approvals. Switch to Active to select a Run.'
              : 'Press n for a new Run.') +
            '</p>',
    );
    const run = selectedRun();
    $('[data-view-name]').textContent = state.tab;
    $('[data-compose-toggle]').disabled = !run;
    $('[data-compose-toggle]').setAttribute(
      'aria-expanded',
      String(state.composing && !!run),
    );
    $('[data-run-options]').hidden = !run;
    $('[data-composer]').hidden = !run || !state.composing;
    $$('[data-tab]').forEach((button) => {
      const active = button.dataset.tab === state.tab;
      button.setAttribute('aria-selected', String(active));
      button.tabIndex = active ? 0 : -1;
    });
    $('[data-panel]').setAttribute('aria-labelledby', 'rt-tab-' + state.tab);
    if (!run) {
      $('[data-title]').textContent = '';
      $('[data-state]').textContent = '';
      html(
        $('[data-panel]'),
        '<p class="aw-note">Select an agent to view its activity.</p>',
      );
      html($('[data-decisions]'), '');
      return;
    }
    const [text, color] = status(run);
    $('[data-title]').textContent =
      runLabel(run) +
      (roadmap?.title(run.id) ? ' · ' + roadmap.title(run.id) : '');
    $('[data-state]').textContent = text;
    $('[data-state]').className = 'aw-state ' + color;
    html(
      $('[data-meta]'),
      '<span>' +
        (run.provider === 'fixture'
          ? 'Built-in fixture · a separate copy for each Run'
          : run.environment.kind === 'local'
            ? run.worktree
              ? 'Local worktree · branch ' + escape(run.worktree.branch)
              : 'Local process · code copy retained after cancellation'
            : 'Configured worker environment') +
        '</span>',
    );
    $('[data-environment]').textContent =
      run.environment.location || 'Creating copy…';
    renderPanel(run);
    const canPrompt =
      state.connected && !state.busy && run.state.kind === 'idle';
    $$('[data-scenario]').forEach((button) => {
      button.disabled = !canPrompt;
      button.hidden = run.provider !== 'fixture';
    });
    $('[data-send]').disabled = !canPrompt;
    // Drafts remain editable while a Run is busy or disconnected.
    // Cancelling removes the Run, committing what its worktree still holds.
    $('[data-cancel]').disabled =
      !state.connected || state.busy || run.state.kind === 'cancelling';
    $('[data-cancel]').textContent = terminal(run)
      ? 'Remove Run'
      : 'Cancel Run';
    $('[data-compose-note]').textContent = !state.connected
      ? 'Disconnected. Draft kept; reconnect before sending.'
      : terminal(run)
        ? 'This Run has ended. Create a new Run to try again.'
        : run.state.kind === 'idle'
          ? 'Run is idle and ready for another prompt. A turn ending is not task acceptance.'
          : 'While running, answer approvals or cancel. Your draft is kept until idle.';
    html(
      $('[data-decisions]'),
      pending(run.id)
        .map((item) =>
          item.kind === 'agent-request'
            ? agentRequestHtml(item)
            : '<section class="aw-prompt" aria-label="Pending approval"><div class="aw-prompt-title"><span>' +
              escape(item.title) +
              '</span></div><div class="aw-actions">' +
              item.choices
                .map(
                  (choice) =>
                    '<button type="button" class="aw-button ' +
                    (choice.kind.startsWith('allow') ? 'aw-primary' : '') +
                    '" data-choice="' +
                    escape(choice.id) +
                    '" data-attention="' +
                    escape(item.id) +
                    '"' +
                    (!state.connected || state.busy ? ' disabled' : '') +
                    '>' +
                    escape(choice.label) +
                    '</button>',
                )
                .join('') +
              '</div><details class="aw-decision-detail" data-disclosure="' +
              escape(item.id) +
              '"><summary>Details</summary><pre class="aw-command">' +
              escape(permissionDetail(item)) +
              '</pre></details></section>',
        )
        .join('') +
        (workspaceNeedsAction(run)
          ? '<section class="aw-prompt" aria-label="Worktree cleanup"><div class="aw-prompt-title">' +
            (run.worktree.status.kind === 'commit-required'
              ? 'Commit required'
              : 'Worktree retained') +
            '</div><p class="aw-note">' +
            (run.worktree.status.kind === 'commit-required'
              ? 'The agent has stopped. Commit all non-ignored changes to the local branch, then remove this worktree. No remote push.'
              : escape(run.worktree.status.reason)) +
            '</p><button type="button" class="aw-button aw-primary" data-worktree-commit' +
            (!state.connected || state.busy ? ' disabled' : '') +
            '>Commit and close</button></section>'
          : ''),
    );
    const latest = state.attention
      .filter((item) => item.runId === run.id && item.status !== 'pending')
      .at(-1);
    const receipt = latest
      ? {
          accepted: 'Response accepted · sending',
          delivered: 'Response sent · see Live / Timeline for the outcome',
          stale:
            (latest.kind === 'agent-request'
              ? 'Request expired · '
              : 'Approval expired · ') + (latest.reason || 'Run ended'),
          done: 'Marked done · the agent was not told',
        }[latest.status]
      : '';
    const nextReceiptKey = latest
      ? run.id + ':' + latest.id + ':' + latest.status
      : '';
    if (nextReceiptKey && nextReceiptKey !== receiptKey)
      feedback(runLabel(run) + ' · ' + receipt);
    receiptKey = nextReceiptKey;
  }
  async function refresh() {
    clearTimeout(timer);
    if (needsReload) {
      render();
      return;
    }
    if (polling) return;
    polling = true;
    try {
      if (!/^https?:$/.test(location.protocol) || token === 'WORKBENCH_TOKEN')
        throw new Error('Start npm run ui');
      const response = await fetch('/api/state?after=' + state.cursor, {
        cache: 'no-store',
        signal: AbortSignal.timeout(4000),
      });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const snapshot = await response.json();
      if (
        !Array.isArray(snapshot.runs) ||
        !Array.isArray(snapshot.attention) ||
        !Array.isArray(snapshot.events) ||
        !Number.isSafeInteger(snapshot.cursor)
      )
        throw new Error('Unexpected snapshot');
      if (
        state.instanceId &&
        snapshot.instanceId &&
        state.instanceId !== snapshot.instanceId
      ) {
        state.runs = [];
        state.attention = [];
        state.events = [];
        state.projects = [];
        state.defaultWork = undefined;
        state.sessionOptions = null;
        state.connected = false;
        needsReload = true;
        offlineMessage = 'Server restarted · reload the page';
        sessionView?.reset();
        return;
      }
      state.instanceId = snapshot.instanceId ?? state.instanceId;
      state.runs = snapshot.runs;
      state.attention = snapshot.attention;
      state.events = (
        snapshot.reset ? snapshot.events : [...state.events, ...snapshot.events]
      ).slice(-2000);
      state.cursor = snapshot.cursor;
      state.defaultSource = snapshot.source;
      state.launch = snapshot.launch ?? {
        provider: 'fixture',
        kind: 'trusted-fixture-directory',
      };
      await updateRoadmap(
        snapshot.work,
        snapshot.projects,
        snapshot.defaultProjectId,
      );
      await updateSessionOptions(snapshot);
      if (!visibleRuns().some((run) => run.id === state.selected))
        selectRun(visibleRuns()[0]?.id ?? null, false);
      if (!state.connected) feedback('Connected · press n for a new Run');
      state.connected = true;
    } catch {
      state.connected = false;
      offlineMessage = 'Disconnected · actions paused';
    } finally {
      polling = false;
      render();
      timer = setTimeout(refresh, document.hidden ? 2000 : 600);
    }
  }
  async function command(input) {
    if (!state.connected || state.busy) return false;
    const project = projectForRun(input.runId ?? state.selected);
    if (input.kind.startsWith('work.') && project)
      input = { kind: 'project-work', projectId: project.id, command: input };
    state.busy = true;
    render();
    try {
      const response = await fetch('/api/commands', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-workbench-token': token,
        },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(15_000),
      });
      const result = await response.json();
      if (response.status === 403) {
        needsReload = true;
        state.connected = false;
        offlineMessage = 'Session expired · reload the page';
        throw new Error('Session expired; reload the page');
      }
      if (!response.ok)
        throw new Error(
          result.error || result.result || 'Action not completed',
        );
      if (result.runId) {
        state.filter = 'active';
        selectRun(result.runId, false);
      }
      const targetId =
        input.runId ??
        state.attention.find((item) => item.id === input.id)?.runId;
      const target = state.runs.find((run) => run.id === targetId);
      const label = target ? runLabel(target) : '';
      feedback(
        (label ? label + ' · ' : '') +
          (input.kind === 'start' || input.kind === 'new-session'
            ? 'Session created · i prompt when idle'
            : input.kind === 'answer'
              ? 'Response accepted · awaiting transport delivery'
              : input.kind === 'cancel'
                ? !result.removed
                  ? 'Run stopped · its changes still need a commit'
                  : result.branch && !result.workspaceRemoved
                    ? 'Run removed · its worktree stays on disk'
                    : result.branch
                      ? 'Run removed · its work is on ' + result.branch
                      : 'Run removed'
                : input.kind === 'commit-workspace'
                  ? result.branch
                    ? 'Saved ' +
                      result.branch +
                      ' · worktree ' +
                      (result.workspaceRemoved ? 'removed' : 'retained')
                    : 'Changes saved to local branch · worktree cleanup checked'
                  : input.kind.startsWith('work.') ||
                      input.kind === 'project-work'
                    ? 'Roadmap updated'
                    : 'Last message accepted'),
      );
      return true;
    } catch (error) {
      feedback(
        (error instanceof Error ? error.message : 'Action failed') +
          '; check Timeline before retrying.',
        true,
      );
      return false;
    } finally {
      state.busy = false;
      await refresh();
    }
  }
  function selectRun(id, shouldRender = true) {
    if (state.selected) state.drafts[state.selected] = $('#rt-message').value;
    state.selected = id;
    $('#rt-message').value = state.drafts[id] ?? '';
    if (shouldRender) {
      const run = selectedRun();
      if (run && !visibleRuns().includes(run)) state.filter = 'active';
      render();
    }
  }
  function newSession() {
    if (!state.connected || state.busy) return;
    if (state.sessionOptions && sessionView?.open(state.sessionOptions)) return;
    void command({ kind: 'start' });
  }
  root.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button || button.disabled) return;
    if (button.hasAttribute('data-start')) newSession();
    else if (button.hasAttribute('data-compose-toggle')) {
      state.composing = !state.composing;
      render();
      if (state.composing) $('#rt-message').focus();
      else focusNavigation();
    } else if (button.dataset.run) selectRun(button.dataset.run);
    else if (button.dataset.filter) {
      changeFilter(button.dataset.filter);
    } else if (button.dataset.tab) {
      state.tab = button.dataset.tab;
      render();
    } else if (button.dataset.scenario && state.selected)
      void command({
        kind: 'prompt',
        runId: state.selected,
        text: button.dataset.scenario,
      });
    else if (button.hasAttribute('data-worktree-commit') && state.selected) {
      $('[data-command-form]').hidden = false;
      $('#rt-command').value = 'commit ';
      $('#rt-command').focus();
    } else if (button.hasAttribute('data-cancel') && state.selected)
      void command({ kind: 'cancel', runId: state.selected });
    else if (button.dataset.complete)
      void command({ kind: 'complete-request', id: button.dataset.complete });
    else if (button.dataset.choice)
      void command({
        kind: 'answer',
        id: button.dataset.attention,
        choiceId: button.dataset.choice,
      });
    else if (button.hasAttribute('data-reconnect')) {
      if (needsReload) location.reload();
      else void refresh();
    } else if (button.hasAttribute('data-theme')) {
      const light = document.documentElement.style.colorScheme !== 'light';
      document.documentElement.style.colorScheme = light ? 'light' : 'dark';
      button.textContent = light ? 'Dark' : 'Light';
    }
  });
  $('[data-composer]').addEventListener('submit', async (event) => {
    event.preventDefault();
    const run = selectedRun(),
      draft = $('#rt-message').value,
      text = draft.trim();
    if (
      !run ||
      !text ||
      run.state.kind !== 'idle' ||
      !state.connected ||
      state.busy
    )
      return;
    const sent = await command({
      kind: 'prompt',
      runId: run.id,
      text: run.provider === 'fixture' ? 'reply:' + text : text,
    });
    if (sent) {
      if (state.drafts[run.id] === draft) state.drafts[run.id] = '';
      if (state.selected === run.id && $('#rt-message').value === draft) {
        $('#rt-message').value = '';
        state.composing = false;
        render();
        focusNavigation();
      }
    }
  });
  $('.aw-tabs').addEventListener('keydown', (event) => {
    const tabs = $$('[data-tab]');
    const index = tabs.indexOf(event.target);
    if (
      index < 0 ||
      !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)
    )
      return;
    event.preventDefault();
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? tabs.length - 1
          : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) %
            tabs.length;
    state.tab = tabs[next].dataset.tab;
    render();
    tabs[next].focus();
  });
  function closeCommand() {
    $('[data-command-form]').hidden = true;
    if ($('[data-session]').hidden) focusNavigation();
  }
  function focusNavigation() {
    const button =
      $$('[data-roster] [data-run]').find(
        (button) => button.dataset.run === state.selected,
      ) ?? $('[data-start]');
    button.focus({ preventScroll: true });
  }
  function selectTab(tab) {
    state.tab = tab;
    render();
  }
  async function executeCommand(text) {
    const parts = text.trim().replace(/^:/, '').split(/\s+/);
    const name = parts[0];
    if (!name) return true;
    if (name === 'new') {
      newSession();
      return true;
    }
    if (['live', 'diff', 'timeline'].includes(name)) {
      selectTab(name);
      return true;
    }
    if (['active', 'inbox'].includes(name)) {
      changeFilter(name === 'inbox' ? 'attention' : name);
      return true;
    }
    if (name === 'help') {
      $('[data-shortcuts]').open = true;
      return true;
    }
    if (name === 'use' && /^\d+$/.test(parts[1] ?? '')) {
      const run = state.runs[Number(parts[1]) - 1];
      if (run && (!terminal(run) || workspaceNeedsAction(run))) {
        selectRun(run.id);
        return true;
      }
    }
    const run = selectedRun();
    if (name === 'commit' && run && parts.slice(1).join(' ').trim())
      return command({
        kind: 'commit-workspace',
        runId: run.id,
        message: parts.slice(1).join(' '),
      });
    if (
      name === 'cancel' &&
      run &&
      (!terminal(run) || workspaceNeedsAction(run))
    )
      return command({ kind: 'cancel', runId: run.id });
    if (
      ['fix', 'question', 'wait', 'crash', 'permissions'].includes(name) &&
      run &&
      run.state.kind === 'idle'
    )
      return command({
        kind: 'prompt',
        runId: run.id,
        text: name === 'permissions' ? 'two-permissions' : name,
      });
    feedback(
      'Command unavailable. Press ? for commands; scenarios need a selected idle Run.',
      true,
    );
    return false;
  }
  $('[data-command-form]').addEventListener('submit', async (event) => {
    event.preventDefault();
    const input = $('#rt-command');
    input.disabled = true;
    const handled = await executeCommand(input.value);
    input.disabled = false;
    if (handled) {
      input.value = '';
      closeCommand();
    } else input.focus();
  });
  document.addEventListener('keydown', (event) => {
    if (
      event.defaultPrevented ||
      event.isComposing ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey
    )
      return;
    const typing =
      event.target instanceof HTMLInputElement ||
      event.target instanceof HTMLTextAreaElement ||
      event.target instanceof HTMLSelectElement ||
      event.target.isContentEditable;
    if (event.key === 'Escape') {
      if (roadmap?.escape()) {
        event.preventDefault();
        return;
      }
      if (typing || state.composing || !$('[data-command-form]').hidden) {
        event.preventDefault();
        state.composing = false;
        render();
        closeCommand();
      } else $('[data-shortcuts]').open = false;
      return;
    }
    if (typing) return;
    if (event.repeat && !['j', 'k', 'h', 'l'].includes(event.key)) return;
    const keys = [
      'j',
      'k',
      'h',
      'l',
      '1',
      '2',
      '3',
      'a',
      'r',
      'i',
      'n',
      'w',
      'p',
      's',
      '?',
      ':',
      'o',
    ];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    if (event.key === 'o') {
      if (roadmap) roadmap.open();
      else feedback('Roadmap controls need a new server on another port.');
      return;
    }
    if (event.key === 'n') {
      $('[data-start]').click();
      return;
    }
    if (event.key === '?') {
      $('[data-shortcuts]').open = !$('[data-shortcuts]').open;
      return;
    }
    if (event.key === 'p') {
      $('.aw-project-nav').open = !$('.aw-project-nav').open;
      return;
    }
    if (event.key === 's') {
      if (selectedRun())
        $('[data-run-options]').open = !$('[data-run-options]').open;
      return;
    }
    if (event.key === ':') {
      $('[data-command-form]').hidden = false;
      $('#rt-command').focus();
      return;
    }
    if (event.key === 'i') {
      if (selectedRun()) {
        state.composing = true;
        render();
        $('#rt-message').focus();
      } else feedback('Press n for a new Run.');
      return;
    }
    if (['h', 'l', '1', '2', '3'].includes(event.key)) {
      const tabs = ['live', 'diff', 'timeline'];
      const index = tabs.indexOf(state.tab);
      selectTab(
        tabs[
          /^[1-3]$/.test(event.key)
            ? Number(event.key) - 1
            : (index + (event.key === 'l' ? 1 : 2)) % 3
        ],
      );
      return;
    }
    if (event.key === 'w') {
      const waiting = state.runs.filter((run) => pending(run.id).length);
      if (!waiting.length) {
        feedback('No Runs are awaiting approval.');
        return;
      }
      const next =
        waiting[
          (waiting.findIndex((run) => run.id === state.selected) + 1) %
            waiting.length
        ];
      state.filter = 'attention';
      selectRun(next.id);
      return;
    }
    if (['j', 'k'].includes(event.key)) {
      const runs = visibleRuns(),
        index = runs.findIndex((run) => run.id === state.selected);
      const next =
        runs[
          Math.max(
            0,
            Math.min(runs.length - 1, index + (event.key === 'j' ? 1 : -1)),
          )
        ];
      if (next) {
        selectRun(next.id);
        focusNavigation();
      }
      return;
    }
    const run = selectedRun();
    if (!run) return;
    const focusedId = document.activeElement?.dataset?.attention;
    const items = pending(run.id);
    const item = items.find((item) => item.id === focusedId) ?? items[0];
    if (item?.kind === 'agent-request') {
      feedback('a/r answer approvals. Use Mark done for this request.');
      return;
    }
    const choice = item?.choices.find(
      (choice) =>
        choice.kind === (event.key === 'a' ? 'allow-once' : 'reject-once'),
    );
    if (item && choice)
      void command({ kind: 'answer', id: item.id, choiceId: choice.id });
    else
      feedback(
        'No matching once-only choice. Use the options shown for this request.',
      );
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void refresh();
  });
  void refresh();
})();
