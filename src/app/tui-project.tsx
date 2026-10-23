import { useEffect, useRef, useState } from 'react';
import { Box, Text } from './tui-text.js';
import wrapAnsi from 'wrap-ansi';
import type { DirectoryListing, RunId } from '../execution/index.js';
import type { WorkbenchClient } from './workbench-client.js';
import type { WorkbenchState } from './workbench-protocol.js';
import { terminalText } from './tui-input.js';

export type TreeRow = {
  path: string;
  name: string;
  depth: number;
  kind: 'directory' | 'file' | 'symlink' | 'other' | 'notice';
  expanded: boolean;
};
export type ProjectTreeView = {
  rows: readonly TreeRow[];
  selected: number;
  note: string;
};
type Cache = ReadonlyMap<string, DirectoryListing | { kind: 'loading' }>;
type TreeState = {
  key: string;
  cache: Cache;
  open: readonly string[];
  selected: string;
  note: string;
};

export function useProjectTree(
  client: WorkbenchClient,
  state: WorkbenchState,
  runId: RunId | null,
  active: boolean,
) {
  const run = state.runs.find((item) => item.id === runId);
  const key = `${state.instanceId ?? ''}:${runId ?? ''}:${run?.environment.location ?? ''}`;
  const [reload, setReload] = useState(0);
  const [tree, setTree] = useState<TreeState>({
    key,
    cache: new Map(),
    open: [],
    selected: '',
    note: '',
  });
  const generation = useRef(0);
  const current: TreeState =
    tree.key === key
      ? tree
      : { key, cache: new Map(), open: [], selected: '', note: '' };

  function load(path: string, epoch = generation.current) {
    if (!runId) return;
    setTree((old) => ({
      ...old,
      cache: new Map(old.cache).set(path, { kind: 'loading' }),
    }));
    void client
      .directory(runId, path)
      .then((listing) => {
        if (epoch !== generation.current) return;
        setTree((old) =>
          old.key === key
            ? { ...old, cache: new Map(old.cache).set(path, listing) }
            : old,
        );
      })
      .catch(() => {
        if (epoch !== generation.current) return;
        setTree((old) =>
          old.key === key
            ? {
                ...old,
                cache: new Map(old.cache).set(path, {
                  kind: 'unavailable',
                  runId,
                  path,
                  reason: 'Cannot load this folder; R retries',
                }),
              }
            : old,
        );
      });
  }
  useEffect(() => {
    const epoch = ++generation.current;
    const note = !runId
      ? 'Select a Run to browse files'
      : !state.features?.directoryTree
        ? 'New server needed. Use another port.'
        : '';
    setTree({ key, cache: new Map(), open: [], selected: '', note });
    if (active && runId && state.features?.directoryTree) load('', epoch);
    return () => {
      generation.current++;
    };
  }, [client, key, active, reload, state.features?.directoryTree]);

  const rows: TreeRow[] = [];
  const root = current.cache.get('');
  let note = current.note;
  if (root?.kind === 'ready') {
    rows.push({
      path: '',
      name: root.root.split('/').at(-1) || root.root,
      depth: 0,
      kind: 'directory',
      expanded: true,
    });
    const append = (path: string, depth: number) => {
      if (rows.length >= 1000) {
        note = 'Tree limit reached; collapse folders';
        return;
      }
      const listing = current.cache.get(path);
      if (!listing || listing.kind === 'loading') {
        rows.push({
          path: '@loading/' + path,
          name: 'Loading…',
          depth,
          kind: 'notice',
          expanded: false,
        });
        return;
      }
      if (listing.kind === 'unavailable') {
        rows.push({
          path: '@error/' + path,
          name: listing.reason,
          depth,
          kind: 'notice',
          expanded: false,
        });
        return;
      }
      for (const entry of listing.entries) {
        if (rows.length >= 1000) {
          note = 'Tree limit reached; collapse folders';
          return;
        }
        const expanded = current.open.includes(entry.path);
        rows.push({ ...entry, depth, expanded });
        if (entry.kind === 'directory' && expanded)
          append(entry.path, depth + 1);
      }
      if (rows.length >= 1000) return;
      if (!listing.entries.length)
        rows.push({
          path: '@empty/' + path,
          name: 'Empty folder',
          depth,
          kind: 'notice',
          expanded: false,
        });
      if (listing.truncated)
        rows.push({
          path: '@limit/' + path,
          name: 'More entries omitted (200 limit)',
          depth,
          kind: 'notice',
          expanded: false,
        });
    };
    append('', 1);
  } else if (root?.kind === 'unavailable') note = root.reason;
  else if (!note) note = 'Loading folders…';
  const selected = Math.max(
    0,
    rows.findIndex((row) => row.path === current.selected),
  );
  function select(row: TreeRow | undefined) {
    if (row && row.kind !== 'notice')
      setTree((old) => ({ ...old, selected: row.path }));
  }
  function setExpanded(row: TreeRow, expanded: boolean) {
    if (row.kind !== 'directory' || row.path === '') return;
    if (!expanded && !current.open.includes(row.path)) return;
    if (expanded && current.cache.size >= 32 && !current.cache.has(row.path)) {
      setTree((old) => ({
        ...old,
        note: '32 folders loaded; R refreshes the tree',
      }));
      return;
    }
    setTree((old) => ({
      ...old,
      open: expanded
        ? [...old.open.filter((path) => path !== row.path), row.path]
        : old.open.filter((path) => path !== row.path),
    }));
    if (expanded && !current.cache.has(row.path)) load(row.path);
  }
  return {
    view: { rows, selected, note } satisfies ProjectTreeView,
    move(direction: number) {
      const entries = rows.filter((row) => row.kind !== 'notice');
      const index = Math.max(
        0,
        entries.findIndex((row) => row.path === rows[selected]?.path),
      );
      select(
        entries[Math.max(0, Math.min(entries.length - 1, index + direction))],
      );
    },
    first() {
      select(rows.find((row) => row.kind !== 'notice'));
    },
    last() {
      select([...rows].reverse().find((row) => row.kind !== 'notice'));
    },
    right() {
      const row = rows[selected];
      if (!row || row.kind !== 'directory') return;
      if (!row.expanded) setExpanded(row, true);
      else {
        const child = rows
          .slice(selected + 1)
          .find((entry) => entry.kind !== 'notice');
        if (child && child.depth > row.depth) select(child);
      }
    },
    left() {
      const row = rows[selected];
      if (!row) return;
      if (row.kind === 'directory' && row.expanded && row.path !== '')
        setExpanded(row, false);
      else
        select(
          rows
            .slice(0, selected)
            .reverse()
            .find(
              (entry) => entry.kind === 'directory' && entry.depth < row.depth,
            ),
        );
    },
    toggle() {
      const row = rows[selected];
      if (row) setExpanded(row, !row.expanded);
    },
    refresh() {
      setReload((value) => value + 1);
    },
  };
}

export function ProjectPanel({
  tree,
  expanded,
  focused,
  width,
  height,
}: {
  tree: ProjectTreeView | undefined;
  expanded: boolean;
  focused: boolean;
  width: number;
  height: number;
}) {
  const view = tree ?? { rows: [], selected: 0, note: 'Loading folders…' };
  const capacity = Math.max(1, height - (expanded ? 4 : 3));
  const start = expanded
    ? Math.max(
        0,
        Math.min(view.rows.length - capacity, view.selected - capacity + 1),
      )
    : 0;
  const rows = view.rows.slice(start, start + capacity);
  const note = wrapAnsi(terminalText(view.note), Math.max(1, width - 4), {
    hard: true,
    trim: false,
  }).split('\n');
  return (
    <Box width={width} height={height} flexDirection="column" flexShrink={0}>
      <Text bold {...(focused ? { color: 'cyan' } : {})} wrap="truncate-end">
        Project ·{' '}
        {focused ? 'focus · p close' : expanded ? 'p focus' : 'p browse'}
      </Text>
      <Box
        height={height - 1}
        borderStyle="single"
        {...(focused ? { borderColor: 'cyan' } : {})}
        flexDirection="column"
        paddingX={1}
        overflow="hidden"
      >
        {rows.length
          ? rows.map((row, index) => (
              <Text
                key={row.kind + ':' + row.path}
                {...(focused && start + index === view.selected
                  ? { color: 'cyan' }
                  : {})}
                wrap="truncate-end"
              >
                {focused && start + index === view.selected ? '> ' : '  '}
                {' '.repeat(Math.min(row.depth, 12))}
                {row.kind === 'directory' ? (row.expanded ? 'v ' : '> ') : '  '}
                {terminalText(row.name).replace(/[\r\n\t]/g, ' ')}
                {row.kind === 'directory'
                  ? '/'
                  : row.kind === 'symlink'
                    ? '@'
                    : ''}
              </Text>
            ))
          : note.slice(0, capacity).map((line, index) => (
              <Text key={index} dimColor wrap="truncate-end">
                {line}
              </Text>
            ))}
        {expanded && (
          <>
            <Box flexGrow={1} />
            <Text dimColor wrap="truncate-end">
              {view.note ||
                (focused ? 'hjkl · Enter · R reload' : 'Ctrl+W h · p focus')}
            </Text>
          </>
        )}
      </Box>
    </Box>
  );
}
