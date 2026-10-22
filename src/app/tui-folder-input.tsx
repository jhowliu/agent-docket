import { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import stringWidth from 'string-width';
import type { ProjectFolders } from '../execution/index.js';
import type { WorkbenchClient } from './workbench-client.js';
import { PromptInput, terminalText } from './tui-input.js';

type Candidates =
  | { kind: 'closed' }
  | { kind: 'loading' }
  | { kind: 'ready'; result: ProjectFolders; index: number }
  | { kind: 'error'; message: string };

const folderRows = 3;
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function folderName(name: string, width: number): string {
  const text = terminalText(name);
  if (stringWidth(text) <= width) return text;
  let result = '';
  for (const { segment } of graphemes.segment(text)) {
    if (stringWidth(result + segment) > width - 1) break;
    result += segment;
  }
  return result + '…';
}

export function resolveProjectPath(value: string, base: string): string {
  const path =
    value === '~'
      ? homedir()
      : value.startsWith('~/')
        ? resolve(homedir(), value.slice(2))
        : resolve(base, value);
  // Keep an explicitly typed dot prefix available for hidden-folder completion.
  return value.endsWith('/.') ? path + '/.' : path;
}

/** One small, read-only folder picker. Changing input/focus invalidates pending reads. */
export function FolderInput({
  client,
  value,
  base,
  width,
  active,
  supported,
  onChange,
  onSubmit,
  onEscape,
}: {
  client: WorkbenchClient;
  value: string;
  base: string;
  width: number;
  active: boolean;
  supported: boolean;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onEscape: () => void;
}) {
  const [candidates, setCandidates] = useState<Candidates>({ kind: 'closed' });
  const [version, setVersion] = useState(0);
  const generation = useRef(0);
  const reading = useRef(false);
  const current = useRef({ active, value });
  current.current = { active, value };
  function clear() {
    generation.current++;
    reading.current = false;
    setCandidates({ kind: 'closed' });
  }
  useEffect(() => {
    if (!active) clear();
  }, [active]);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  function choose(entry: ProjectFolders['entries'][number]) {
    clear();
    onChange(entry.path + '/');
    setVersion((value) => value + 1);
  }
  function move(direction: 'up' | 'down' | 'left' | 'right') {
    setCandidates((state) => {
      if (state.kind !== 'ready' || !state.result.entries.length) return state;
      const length = state.result.entries.length;
      const column = Math.floor(state.index / folderRows);
      const row = state.index % folderRows;
      let index = state.index;
      if (direction === 'up' && row > 0) index--;
      if (direction === 'down' && row < folderRows - 1 && index + 1 < length)
        index++;
      if (direction === 'left' && column > 0) index -= folderRows;
      if (direction === 'right' && (column + 1) * folderRows < length)
        index = Math.min(length - 1, index + folderRows);
      return { ...state, index };
    });
  }
  async function complete() {
    if (reading.current || !active) return;
    if (!supported) {
      setCandidates({
        kind: 'error',
        message: 'Folder completion needs an updated server',
      });
      return;
    }
    if (candidates.kind === 'ready' && candidates.result.entries.length) {
      setCandidates({
        ...candidates,
        index: (candidates.index + 1) % candidates.result.entries.length,
      });
      return;
    }
    const epoch = ++generation.current;
    reading.current = true;
    setCandidates({ kind: 'loading' });
    try {
      const result = await client.folders(resolveProjectPath(value, base));
      if (
        epoch !== generation.current ||
        !current.current.active ||
        current.current.value !== value
      )
        return;
      const only = result.entries[0];
      if (result.entries.length === 1 && !result.truncated && only)
        choose(only);
      else setCandidates({ kind: 'ready', result, index: 0 });
    } catch (error) {
      if (
        epoch === generation.current &&
        current.current.active &&
        current.current.value === value
      )
        setCandidates({
          kind: 'error',
          message: terminalText(
            error instanceof Error
              ? error.message
              : 'Folders are unavailable; retry the path',
          ),
        });
    } finally {
      if (epoch === generation.current) reading.current = false;
    }
  }
  useInput(
    (_input, key) => {
      if (
        !active ||
        key.eventType === 'release' ||
        key.ctrl ||
        key.meta ||
        key.super ||
        key.hyper
      )
        return;
      if (key.tab && !key.shift && key.eventType !== 'repeat') void complete();
      else if (key.upArrow || key.downArrow)
        move(key.downArrow ? 'down' : 'up');
    },
    { isActive: active },
  );
  const items = candidates.kind === 'ready' ? candidates.result.entries : [];
  const index = candidates.kind === 'ready' ? candidates.index : 0;
  const available = Math.max(1, Math.floor(width));
  // Cap the preferred cell width so one long name does not flatten the grid.
  const preferred = Math.min(
    22,
    Math.max(
      14,
      ...items.map((entry) => stringWidth(terminalText(entry.name)) + 4),
    ),
  );
  const columns = Math.max(
    1,
    Math.min(
      Math.ceil(items.length / folderRows),
      Math.floor((available + 2) / (preferred + 2)),
    ),
  );
  const cellWidth = Math.floor((available - (columns - 1) * 2) / columns);
  const pageSize = columns * folderRows;
  const start = Math.floor(index / pageSize) * pageSize;
  return (
    <Box flexDirection="column" height={5} overflow="hidden">
      <Box height={1}>
        <Text {...(active ? { color: 'cyan' } : {})}>&gt; </Text>
        {active ? (
          <PromptInput
            id={`project-path-${version}`}
            active
            value={value}
            maxLength={4096}
            width={Math.max(1, width - 3)}
            {...(items.length ? { onHorizontalArrow: move } : {})}
            onChange={(next) => {
              clear();
              onChange(next);
            }}
            onSubmit={() => {
              if (candidates.kind === 'loading') return;
              if (candidates.kind === 'ready') {
                const entry = items[index];
                if (entry) choose(entry);
                else clear();
              } else {
                clear();
                onSubmit();
              }
            }}
            onEscape={() => {
              if (candidates.kind === 'closed') onEscape();
              else clear();
            }}
          />
        ) : (
          <Text wrap="truncate-middle">{terminalText(value)}</Text>
        )}
      </Box>
      <Box flexDirection="column" height={3} overflow="hidden">
        {candidates.kind === 'loading' && (
          <Text dimColor>Reading folders…</Text>
        )}
        {candidates.kind === 'error' && (
          <Text color="yellow" wrap="truncate-end">
            {candidates.message}
          </Text>
        )}
        {candidates.kind === 'ready' && !items.length && (
          <Text dimColor>
            {candidates.result.truncated
              ? 'More folders may exist · type a prefix'
              : 'No matching folders'}
          </Text>
        )}
        {items.length > 0 &&
          Array.from({ length: folderRows }, (_, row) => (
            <Box key={row} height={1} flexShrink={0}>
              {Array.from({ length: columns }, (_, column) => {
                const offset = start + column * folderRows + row;
                const entry = items[offset];
                const selected = offset === index;
                const suffix = entry?.kind === 'directory-link' ? '@/' : '/';
                const label = entry
                  ? `${selected ? '> ' : '  '}${folderName(entry.name, cellWidth - 2 - suffix.length)}${suffix}`
                  : '';
                return (
                  <Box
                    key={column}
                    width={cellWidth}
                    flexShrink={0}
                    marginRight={column < columns - 1 ? 2 : 0}
                  >
                    <Text
                      color={
                        selected
                          ? 'cyan'
                          : entry?.kind === 'directory-link'
                            ? 'magenta'
                            : 'blue'
                      }
                      bold={selected}
                      inverse={selected}
                      wrap="truncate-end"
                    >
                      {label}
                      {' '.repeat(Math.max(0, cellWidth - stringWidth(label)))}
                    </Text>
                  </Box>
                );
              })}
            </Box>
          ))}
      </Box>
      <Text dimColor wrap="truncate-end">
        {!active
          ? ''
          : candidates.kind === 'ready' && items.length
            ? `${start + 1}–${Math.min(start + pageSize, items.length)}/${items.length}${candidates.result.truncated ? '+' : ''} · ↑↓←→/Tab · Enter use · Esc${candidates.result.truncated ? ' · type to narrow' : ''}`
            : candidates.kind !== 'closed'
              ? 'Esc back · Tab retry folders'
              : 'Tab folders · Enter list branches'}
      </Text>
    </Box>
  );
}
