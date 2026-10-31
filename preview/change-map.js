// Change map page for one Run. Every value from the server is rendered as text, never HTML.
const token = document.querySelector('meta[name="workbench-token"]').content;
const runId = new URLSearchParams(location.search).get('run') ?? '';
const $ = (id) => document.getElementById(id);

/** Small element builder: props become attributes or listeners; children become text. */
function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat())
    if (child !== undefined && child !== null && child !== false)
      node.append(child instanceof Node ? child : String(child));
  return node;
}
const last = (name) => name.split(' › ').at(-1) ?? name;
const count = (n) => n.toLocaleString('en-US');

let map = null;
let current = null;

function fail(message) {
  $('change-map').setAttribute('aria-busy', 'false');
  $('cm-ref').replaceChildren(h('span', { class: 'cm-error' }, message));
}

async function load() {
  if (!/^run-[0-9A-Za-z-]{1,80}$/.test(runId))
    return fail('Open a Change map from the TUI: select a Run and press m.');
  let response;
  try {
    response = await fetch(`/api/changes?${new URLSearchParams({ runId })}`, {
      headers: { 'x-workbench-token': token },
      cache: 'no-store',
    });
  } catch {
    return fail(
      'The workbench service is not reachable; start it with npm run tui, then reload.',
    );
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok)
    return fail(
      typeof body.error === 'string'
        ? body.error
        : 'Change map is unavailable; reload to retry.',
    );
  if (!body || !Array.isArray(body.files) || !Array.isArray(body.flows))
    return fail(
      'The service sent an unexpected Change map; update and restart it.',
    );
  map = body;
  $('change-map').setAttribute('aria-busy', 'false');
  renderHeader();
  // Open on the HTTP flow that touches the most changed functions.
  const changed = (flow) =>
    flow.members.reduce(
      (n, member) => n + Number(member.step.changed) + member.below.length,
      flow.triggers
        .flatMap((trigger) => trigger.chain)
        .filter((step) => step.changed).length,
    );
  const best = map.flows.reduce(
    (top, flow, index) =>
      flow.kind === 'http' &&
      (top < 0 || changed(flow) > changed(map.flows[top]))
        ? index
        : top,
    -1,
  );
  current = map.flows.length
    ? { kind: 'flow', index: Math.max(0, best) }
    : map.interfaces.length
      ? { kind: 'interfaces' }
      : { kind: 'rest' };
  render();
}

function renderHeader() {
  const time = new Date(map.generatedAt).toLocaleTimeString();
  $('cm-ref').replaceChildren(
    `${runId} · base ${map.base.slice(0, 8)} · working tree · ${count(map.totals.files)} files · `,
    h('span', { class: 'plus' }, `+${count(map.totals.plus)}`),
    ' ',
    h('span', { class: 'minus' }, `−${count(map.totals.minus)}`),
    ` · read at ${time}`,
  );
  const notes = [];
  if (map.analysis.kind === 'files-only')
    notes.push(`Files and hunks only: ${map.analysis.reason}.`);
  if (map.truncated.length)
    notes.push(
      `Left out to stay within size limits: ${map.truncated.join(', ')}. Open the files in an editor for the rest.`,
    );
  $('cm-note').hidden = notes.length === 0;
  $('cm-note').textContent = notes.join(' ');
}

/* ---------- Section list ---------- */
function flowTitle(flow) {
  return flow.operation
    .replace(/^HTTP /, '')
    .replace(/ · sender not found statically$/, '')
    .replace(/^direct call · /, 'called from ');
}
function keysOf(flow) {
  const keys = [
    ...new Set(
      flow.triggers.flatMap((trigger) => trigger.chain[0]?.tags ?? []),
    ),
  ].slice(0, 4);
  return keys.length
    ? h(
        'span',
        { class: 'cm-keys' },
        keys.map((key) => h('kbd', {}, key)),
      )
    : null;
}
function navButton(target, ...children) {
  const selected = JSON.stringify(target) === JSON.stringify(current);
  return h(
    'button',
    {
      type: 'button',
      'aria-current': selected ? 'true' : 'false',
      onclick: () => {
        current = target;
        render();
        $('cm-panel').focus({ preventScroll: true });
      },
    },
    ...children,
  );
}
function renderNav() {
  const nav = $('cm-nav');
  nav.replaceChildren();
  const groups = [
    ['http', 'Flows'],
    ['unresolved', 'Sender not found'],
    ['direct', 'Other entry points'],
  ];
  for (const [kind, title] of groups) {
    const flows = map.flows
      .map((flow, index) => ({ flow, index }))
      .filter(({ flow }) => flow.kind === kind);
    if (!flows.length) continue;
    nav.append(h('h2', {}, title));
    for (const { flow, index } of flows)
      nav.append(
        navButton(
          { kind: 'flow', index },
          h('span', { class: 'cm-op' }, flowTitle(flow)),
          keysOf(flow),
        ),
      );
  }
  nav.append(h('h2', {}, 'More'));
  if (map.interfaces.length)
    nav.append(navButton({ kind: 'interfaces' }, 'Interface changes'));
  nav.append(navButton({ kind: 'rest' }, `All other changes`));
}

/* ---------- Steps ---------- */
function symbolAt(file, line) {
  return (file?.symbols ?? [])
    .filter((symbol) => symbol.line <= line && line <= symbol.endLine)
    .sort((a, b) => a.endLine - a.line - (b.endLine - b.line))[0];
}
function delta(step) {
  const file = map.files.find((candidate) => candidate.path === step.file);
  if (!step.changed || !file) return null;
  if (file.status === 'added') return h('span', { class: 'plus' }, 'new');
  const symbol = symbolAt(file, step.line);
  return symbol
    ? h(
        'span',
        {},
        h('span', { class: 'plus' }, `+${symbol.plus}`),
        ' ',
        h('span', { class: 'minus' }, `−${symbol.minus}`),
      )
    : null;
}
function stepButton(step, label = step.name) {
  return h(
    'button',
    {
      type: 'button',
      class: `cm-step${step.changed ? '' : ' unchanged'}`,
      title: `${step.file}:${step.line}${step.changed ? '' : ' · unchanged'}`,
      onclick: () => openDiff(step.file, step.line, step.name),
    },
    label,
  );
}
const ENTRY_LABEL = {
  key: 'key press',
  effect: 'effect',
  server: 'server',
  'ui-event': 'UI event',
  component: 'component',
  'process-start': 'process start',
  'no-static-caller': 'no static caller',
};
function triggerRow(trigger) {
  const parts = [];
  trigger.chain.forEach((step, i) => {
    if (i) parts.push(h('span', { class: 'cm-arrow' }, '→'));
    parts.push(stepButton(step));
    if (i === 0) parts.push(...step.tags.map((tag) => h('kbd', {}, tag)));
  });
  return h(
    'div',
    { class: 'cm-row' },
    h('div', { class: 'cm-trigger' }, ...parts),
    h(
      'span',
      { class: 'cm-kind' },
      `${ENTRY_LABEL[trigger.entry.kind] ?? trigger.entry.kind} · ${trigger.chain[0]?.file ?? ''}`,
    ),
  );
}
function interfaceBadge(module, name) {
  const change = map.interfaces.find((entry) => entry.module === module);
  if (!change) return null;
  const matches = (list) =>
    list.some((entry) => entry === name || entry.endsWith(`.${name}`));
  if (matches(change.added)) return h('span', { class: 'cm-badge' }, 'New');
  if (matches(change.changed))
    return h('span', { class: 'cm-badge' }, 'Changed');
  return null;
}
function memberRow(member) {
  const name = last(member.step.name);
  return h(
    'div',
    { class: 'cm-row' },
    h(
      'div',
      { class: 'cm-line1' },
      stepButton(member.step, `${member.module}.${name}`),
      interfaceBadge(member.module, name),
      h(
        'span',
        { class: 'cm-file' },
        `${member.step.file}:${member.step.line}`,
      ),
      delta(member.step),
    ),
  );
}
function belowRow(item) {
  const row = h(
    'div',
    { class: 'cm-row cm-below' },
    h(
      'div',
      { class: 'cm-line1' },
      item.gap
        ? h(
            'span',
            { class: 'cm-gap', title: 'Unchanged calls in between' },
            '… →',
          )
        : null,
      stepButton(item.step),
      item.hidden
        ? h('span', { class: 'cm-sub' }, `+${item.hidden} deeper`)
        : null,
      h(
        'span',
        { class: 'cm-file' },
        `${item.step.file.split('/').pop()}:${item.step.line}`,
      ),
      delta(item.step),
    ),
  );
  row.style.setProperty('--depth', String(item.depth));
  return row;
}

/* ---------- Sections ---------- */
const KIND_NOTE = {
  http: 'From the key or event that starts it, over the local HTTP route, to the changed code.',
  unresolved:
    'This route branch is chosen by the shape of the request, so its sender cannot be found statically.',
  direct:
    'Called without the HTTP service: a CLI command or the service’s own lifecycle.',
};
function renderFlow(flow) {
  const route = flow.operation.split(' · ')[0].replace(/^HTTP /, '');
  const chain = h('div', { class: 'cm-chain' });
  if (flow.triggers.length) {
    const band = h(
      'section',
      { class: 'cm-band ui' },
      h('h3', {}, flow.kind === 'unresolved' ? 'Route' : 'Started by'),
    );
    for (const trigger of flow.triggers) band.append(triggerRow(trigger));
    if (flow.moreTriggers)
      band.append(
        h('p', { class: 'cm-helpers' }, `${flow.moreTriggers} more triggers`),
      );
    chain.append(band);
  }
  chain.append(
    flow.kind === 'http'
      ? h(
          'p',
          { class: 'cm-via' },
          // Separate items: adjacent text would merge into one flex item and lose the gap.
          h('span', {}, '↓'),
          h('span', {}, `HTTP ${route}`),
          flow.server.length ? h('span', {}, '→') : null,
          ...flow.server.map((step) => stepButton(step)),
        )
      : h('p', { class: 'cm-via' }, '↓'),
  );
  const api = h(
    'section',
    { class: 'cm-band api' },
    h('h3', {}, 'Public Interface'),
  );
  for (const member of flow.members) api.append(memberRow(member));
  chain.append(api);
  const inside = flow.members.filter((member) => member.below.length);
  if (inside.length || flow.helpers.length) {
    chain.append(h('p', { class: 'cm-via' }, '↓'));
    const band = h(
      'section',
      { class: 'cm-band int' },
      h('h3', {}, 'Inside the module'),
    );
    for (const member of inside) {
      if (inside.length > 1)
        band.append(
          h(
            'p',
            { class: 'cm-row cm-sub' },
            `below ${member.module}.${last(member.step.name)}`,
          ),
        );
      for (const item of member.below) band.append(belowRow(item));
    }
    if (flow.helpers.length)
      band.append(
        h(
          'p',
          { class: 'cm-helpers' },
          `Also changed: ${flow.helpers.join(', ')}`,
        ),
      );
    chain.append(band);
  }
  return [
    h('h2', {}, flowTitle(flow)),
    h(
      'p',
      { class: 'cm-sub' },
      `${KIND_NOTE[flow.kind]} Traced statically; dynamic calls can be missing.`,
    ),
    chain,
  ];
}
function renderInterfaces() {
  return [
    h('h2', {}, 'Interface changes'),
    h(
      'p',
      { class: 'cm-sub' },
      'Exports of each module’s index.ts compared with the base. A changed comment can mean changed behavior.',
    ),
    h(
      'div',
      { class: 'cm-list' },
      map.interfaces.map((entry) =>
        h(
          'div',
          {},
          h('h3', {}, `${entry.module} · ${entry.file}`),
          ...[
            ['added', entry.added],
            ['changed', entry.changed],
            ['removed', entry.removed],
          ].flatMap(([kind, names]) =>
            names.map((name) =>
              h(
                'button',
                {
                  type: 'button',
                  class: 'cm-item',
                  onclick: () => openDiff(entry.file, null, entry.file),
                },
                h('span', { class: `cm-badge ${kind}` }, kind),
                h('span', { class: 'cm-name' }, name),
              ),
            ),
          ),
        ),
      ),
    ),
  ];
}
function fileDelta(file) {
  if (file.binary) return h('span', { class: 'cm-delta' }, 'binary');
  return h(
    'span',
    { class: 'cm-delta' },
    h('span', { class: 'plus' }, `+${file.plus}`),
    ' ',
    h('span', { class: 'minus' }, `−${file.minus}`),
  );
}
function renderRest() {
  const byFile = new Map();
  for (const change of map.otherChanges)
    byFile.set(change.file, [...(byFile.get(change.file) ?? []), change]);
  const functions = [...byFile].map(([path, changes]) =>
    h(
      'div',
      {},
      h('h3', {}, path),
      changes.map((change) =>
        h(
          'button',
          {
            type: 'button',
            class: 'cm-item',
            onclick: () => openDiff(change.file, change.line, change.name),
          },
          h('span', { class: 'cm-name' }, change.name),
          delta({ file: change.file, line: change.line, changed: true }),
        ),
      ),
    ),
  );
  const files = h(
    'div',
    {},
    h('h3', {}, `All changed files (${map.files.length})`),
    map.files.map((file) =>
      h(
        'button',
        {
          type: 'button',
          class: 'cm-item',
          onclick: () => openDiff(file.path, null, file.path),
        },
        h(
          'span',
          { class: 'cm-name' },
          file.previousPath ? `${file.previousPath} → ${file.path}` : file.path,
        ),
        file.status === 'added' || file.status === 'deleted'
          ? h('span', { class: 'cm-sub' }, file.status)
          : null,
        fileDelta(file),
      ),
    ),
  );
  return [
    h('h2', {}, 'All other changes'),
    h(
      'p',
      { class: 'cm-sub' },
      'Changed functions that no flow reaches, usually screen code, then every changed file.',
    ),
    h('div', { class: 'cm-list' }, ...functions, files),
  ];
}
function render() {
  renderNav();
  const panel = $('cm-panel');
  panel.setAttribute('tabindex', '-1');
  panel.replaceChildren(
    ...(current.kind === 'flow'
      ? renderFlow(map.flows[current.index])
      : current.kind === 'interfaces'
        ? renderInterfaces()
        : renderRest()),
  );
}

/* ---------- Diff drawer: one function unless the whole file is asked for ---------- */
function parseDiff(text) {
  const rows = [];
  let next = 0;
  for (const raw of text.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      next = Number(hunk[1]);
      rows.push({ kind: 'hunk' });
    } else if (raw.startsWith('+'))
      rows.push({ kind: 'add', n: next++, text: raw.slice(1) });
    else if (raw.startsWith('-'))
      rows.push({ kind: 'del', at: next, text: raw.slice(1) });
    else if (raw.startsWith(' '))
      rows.push({ kind: 'ctx', n: next++, text: raw.slice(1) });
  }
  return rows;
}
let open = null;
let returnFocus = null;
function drawDiff() {
  const { file, symbol, whole } = open;
  const code = $('cm-d-code');
  $('cm-d-whole').hidden = !symbol || file.diff === null;
  $('cm-d-whole').textContent = whole
    ? 'Show this function only'
    : 'Show whole file';
  if (file.diff === null) {
    code.replaceChildren(
      h(
        'p',
        { class: 'cm-empty' },
        file.binary
          ? 'Binary file; there is no text diff.'
          : 'Diff left out: this file is larger than the Change map size limit.',
      ),
    );
    return;
  }
  const inside = (row) => {
    const line = row.n ?? row.at;
    return (
      whole ||
      !symbol ||
      (row.kind !== 'hunk' && line >= symbol.line && line <= symbol.endLine)
    );
  };
  const rows = [];
  let gap = false;
  for (const row of parseDiff(file.diff)) {
    if (row.kind === 'hunk' || !inside(row)) {
      gap = rows.length > 0;
      continue;
    }
    if (gap)
      rows.push(
        h(
          'div',
          { class: 'cm-ln gap' },
          h('span', { class: 'n' }),
          h('span', { class: 'm' }),
          h('span', {}, '⋯'),
        ),
      );
    gap = false;
    rows.push(
      h(
        'div',
        { class: `cm-ln ${row.kind}` },
        h('span', { class: 'n' }, row.n ?? ''),
        h(
          'span',
          { class: 'm' },
          row.kind === 'add' ? '+' : row.kind === 'del' ? '−' : '',
        ),
        h('span', {}, row.text || ' '),
      ),
    );
  }
  code.replaceChildren(
    ...(rows.length
      ? rows
      : [h('p', { class: 'cm-empty' }, 'No changed lines in this function.')]),
  );
  code.scrollTop = 0;
}
function openDiff(path, line, title) {
  const file = map.files.find((candidate) => candidate.path === path);
  returnFocus = document.activeElement;
  $('cm-d-title').textContent = title ?? path;
  if (!file) {
    open = null;
    $('cm-d-file').textContent = path;
    $('cm-d-whole').hidden = true;
    $('cm-d-code').replaceChildren(
      h(
        'p',
        { class: 'cm-empty' },
        'This file did not change, so there is no diff to show.',
      ),
    );
  } else {
    const symbol = line ? symbolAt(file, line) : null;
    open = { file, symbol, whole: !symbol };
    $('cm-d-file').textContent = `${file.path} · +${file.plus} −${file.minus}`;
    drawDiff();
  }
  $('cm-scrim').hidden = false;
  $('cm-drawer').hidden = false;
  document.body.style.overflow = 'hidden';
  $('cm-d-close').focus({ preventScroll: true });
}
function closeDiff() {
  $('cm-scrim').hidden = true;
  $('cm-drawer').hidden = true;
  document.body.style.overflow = '';
  returnFocus?.focus?.({ preventScroll: true });
}
$('cm-d-whole').addEventListener('click', () => {
  if (!open) return;
  open.whole = !open.whole;
  drawDiff();
});
$('cm-d-close').addEventListener('click', closeDiff);
$('cm-scrim').addEventListener('click', closeDiff);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !$('cm-drawer').hidden) closeDiff();
});

void load();
