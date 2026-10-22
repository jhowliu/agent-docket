const escape = (text) =>
  String(text).replace(
    /[&<>"']/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        char
      ],
  );

/** Disclosed session form. Editing a path invalidates its previous branch lookup. */
export function createSessionView({ root, token, read, command }) {
  const $ = (query) => root.querySelector(query);
  const panel = $('[data-session]');
  const presetInput = $('[data-session-preset]');
  const pathInput = $('[data-session-path]');
  const branchInput = $('[data-session-branch]');
  let options = null,
    project = null,
    initialization = null,
    generation = 0,
    inspecting = false,
    initializing = false;
  const preset = () =>
    options?.presets.find((item) => item.id === presetInput.value);
  const error = (message = '') => {
    $('[data-session-error]').textContent = message;
  };
  function render() {
    const local = preset()?.kind === 'local';
    $('[data-session-project]').hidden = !local;
    $('[data-session-inspect]').hidden = !local;
    $('[data-session-base]').hidden = !local || !project;
    $('[data-session-initialize]').hidden = !local || !initialization;
    if (initialization) {
      $('[data-session-init-question]').textContent =
        initialization.state === 'not-git'
          ? 'This folder has no Git repository. Initialize Git and create the first commit?'
          : 'This Git repository has no commits. Create the first commit?';
      $('[data-session-init-yes]').textContent =
        initialization.state === 'not-git' ? 'Yes, initialize' : 'Yes, commit';
    }
    for (const input of [
      pathInput,
      presetInput,
      branchInput,
      $('[data-session-close]'),
      $('[data-session-init-no]'),
      $('[data-session-init-yes]'),
    ])
      input.disabled = !read().connected || read().busy || initializing;
    $('[data-session-inspect]').disabled =
      !read().connected || read().busy || inspecting || initializing;
    $('[data-session-create]').disabled =
      !read().connected ||
      read().busy ||
      inspecting ||
      initializing ||
      (local && !project);
    $('[data-session-note]').textContent = initializing
      ? 'Initializing Git and creating the first commit…'
      : inspecting
        ? 'Reading project branches…'
        : local
          ? 'New branch and worktree · local process, no OS isolation. Source edits stay in place.'
          : preset()?.kind === 'fixture'
            ? 'Built-in sample project · no model connection.'
            : 'Uses the configured project and worker.';
  }
  function invalidate() {
    generation++;
    project = null;
    initialization = null;
    inspecting = false;
    branchInput.replaceChildren();
    error();
    render();
  }
  function close() {
    if (read().busy || initializing) return;
    generation++;
    inspecting = false;
    panel.hidden = true;
    $('[data-start]').focus();
  }
  async function inspect() {
    if (
      inspecting ||
      initializing ||
      !read().connected ||
      read().busy ||
      preset()?.kind !== 'local'
    )
      return;
    const path = pathInput.value.trim();
    if (!path.startsWith('/')) {
      error('Enter an absolute path to a Git project folder.');
      pathInput.focus();
      return;
    }
    const epoch = ++generation;
    project = null;
    initialization = null;
    inspecting = true;
    error();
    render();
    try {
      const response = await fetch('/api/project', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-workbench-token': token,
        },
        body: JSON.stringify({ path }),
        signal: AbortSignal.timeout(5000),
      });
      const result = await response.json();
      if (epoch !== generation) return;
      if (!response.ok) {
        const candidate = result?.initialization;
        if (
          response.status === 409 &&
          read().projectInitialization &&
          candidate &&
          typeof candidate.path === 'string' &&
          candidate.path.startsWith('/') &&
          candidate.path.length <= 4096 &&
          !/[\u0000-\u001f\u007f-\u009f]/u.test(candidate.path) &&
          ['not-git', 'no-commit'].includes(candidate.state) &&
          typeof candidate.directoryId === 'string' &&
          /^\d+:\d+$/.test(candidate.directoryId) &&
          candidate.directoryId.length <= 100
        ) {
          initialization = {
            path: candidate.path,
            state: candidate.state,
            directoryId: candidate.directoryId,
          };
          pathInput.value = candidate.path;
          render();
          $('[data-session-init-no]').focus();
          return;
        }
        throw new Error(result.error || 'Choose an existing Git project root.');
      }
      useProject(result);
    } catch (failure) {
      if (epoch === generation)
        error(
          failure instanceof Error
            ? failure.message
            : 'Project is unavailable; retry the folder.',
        );
    } finally {
      if (epoch === generation) {
        inspecting = false;
        render();
      }
    }
  }
  function useProject(result) {
    if (
      !result ||
      typeof result.path !== 'string' ||
      !/^[a-f0-9]{40,64}$/.test(result.head) ||
      !Array.isArray(result.branches) ||
      result.branches.length > 256 ||
      result.branches.some(
        (branch) =>
          typeof branch.name !== 'string' ||
          !/^[a-f0-9]{40,64}$/.test(branch.revision),
      )
    )
      throw new Error(
        'Invalid project response; reconnect before creating a Session.',
      );
    project = result;
    pathInput.value = result.path;
    const branches = result.branches
      .slice()
      .sort(
        (a, b) =>
          Number(b.name === result.currentBranch) -
          Number(a.name === result.currentBranch),
      );
    branchInput.innerHTML =
      (!result.currentBranch
        ? `<option value="">Current commit · ${result.head.slice(0, 7)}</option>`
        : '') +
      branches
        .map(
          (branch) =>
            `<option value="${escape(branch.name)}">${escape(branch.name)} · ${branch.revision.slice(0, 7)}</option>`,
        )
        .join('');
    if (result.truncated)
      error(
        'Showing the first 256 local branches, including the current branch.',
      );
    render();
    branchInput.focus();
  }
  async function initialize() {
    if (
      !initialization ||
      initializing ||
      inspecting ||
      read().busy ||
      !read().connected
    )
      return;
    const approved = initialization;
    const epoch = ++generation;
    initializing = true;
    error();
    render();
    try {
      const response = await fetch('/api/project/initialize', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-workbench-token': token,
        },
        body: JSON.stringify({ project: approved, confirm: true }),
        signal: AbortSignal.timeout(120000),
      });
      const result = await response.json();
      if (epoch !== generation) return;
      if (!response.ok)
        throw new Error(
          result.error ||
            'Git initialization failed. Reload the folder before retrying.',
        );
      if (result.path !== approved.path)
        throw new Error('Unexpected project response. Reload the folder.');
      initialization = null;
      useProject(result);
    } catch (failure) {
      if (epoch === generation) {
        initialization = null;
        error(
          failure instanceof Error
            ? failure.message
            : 'Initialization result is uncertain. Reload the folder before retrying.',
        );
      }
    } finally {
      if (epoch === generation) {
        initializing = false;
        render();
        if (project) branchInput.focus();
      }
    }
  }
  $('[data-session-init-yes]').addEventListener('click', () => {
    void initialize();
  });
  $('[data-session-init-no]').addEventListener('click', () => {
    invalidate();
    pathInput.focus();
  });
  $('[data-session-close]').addEventListener('click', close);
  $('[data-session-inspect]').addEventListener('click', () => {
    void inspect();
  });
  pathInput.addEventListener('input', invalidate);
  presetInput.addEventListener('change', invalidate);
  panel.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (initializing) return;
      if (initialization) {
        invalidate();
        pathInput.focus();
      } else close();
    }
  });
  $('[data-session-form]').addEventListener('submit', async (event) => {
    event.preventDefault();
    const agent = preset();
    if (
      !agent ||
      inspecting ||
      initializing ||
      initialization ||
      read().busy ||
      !read().connected
    )
      return;
    if (agent.kind === 'local' && !project) {
      await inspect();
      return;
    }
    const branch = branchInput.value;
    const revision = branch
      ? project?.branches.find((item) => item.name === branch)?.revision
      : project?.head;
    if (agent.kind === 'local' && !revision) {
      error('Reload branches and choose a starting branch.');
      return;
    }
    const accepted = await command({
      kind: 'new-session',
      presetId: agent.id,
      ...(agent.kind === 'local'
        ? {
            project: {
              path: project.path,
              base: { ...(branch ? { branch } : {}), revision },
            },
          }
        : {}),
    });
    if (accepted) close();
    else
      error(
        'Session was not created. Reload branches if the starting branch changed.',
      );
    render();
  });
  return {
    reset() {
      generation++;
      inspecting = false;
      initializing = false;
      initialization = null;
      project = null;
      panel.hidden = true;
    },
    open(input) {
      if (initializing) return true;
      if (
        !input ||
        !Array.isArray(input.presets) ||
        input.presets.length < 1 ||
        input.presets.length > 3 ||
        !input.presets.every(
          (item) =>
            ['local', 'fixture', 'fixed'].includes(item.kind) &&
            typeof item.id === 'string' &&
            typeof item.label === 'string',
        ) ||
        typeof input.defaultPath !== 'string'
      )
        return false;
      options = input;
      invalidate();
      presetInput.innerHTML = input.presets
        .map(
          (item) =>
            `<option value="${escape(item.id)}">${escape(item.label)}</option>`,
        )
        .join('');
      presetInput.value = input.defaultPreset;
      pathInput.value = input.defaultPath;
      panel.hidden = false;
      render();
      (preset()?.kind === 'local'
        ? pathInput
        : $('[data-session-create]')
      ).focus();
      return true;
    },
    render,
  };
}
