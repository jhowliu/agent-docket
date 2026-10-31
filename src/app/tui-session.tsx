import { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput, usePaste } from 'ink';
import { ProjectInitializationRequired } from '../execution/index.js';
import type {
  LocalProject,
  ProjectInitialization,
} from '../execution/index.js';
import type { WorkbenchClient } from './workbench-client.js';
import type { WorkbenchCommand, WorkbenchState } from './workbench-protocol.js';
import { PromptInput, terminalText } from './tui-input.js';
import { FolderInput, resolveProjectPath } from './tui-folder-input.js';

const runBranch =
  /^(workbench\/run-[0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Display only: a saved Run branch keeps its first ID block; Enter uses the full name. */
const branchLabel = (name: string) =>
  name ? name.replace(runBranch, '$1…') : 'Current commit';

/** A foreground form. Project inspection is read-only; Enter explicitly creates. */
export function NewSession({
  client,
  options,
  initialPath,
  base = initialPath,
  width,
  maxHeight,
  enabled,
  folderCompletion,
  onCreate,
  onClose,
}: {
  client: WorkbenchClient;
  options: NonNullable<WorkbenchState['sessionOptions']>;
  initialPath: string;
  /** Relative paths and folder completion resolve from here: the TUI's launch folder. */
  base?: string;
  width: number;
  /** Most rows the modal offers; the branch list grows into them. */
  maxHeight: number;
  enabled: boolean;
  folderCompletion: boolean;
  onCreate: (command: WorkbenchCommand) => Promise<boolean>;
  onClose: () => void;
}) {
  const [presetIndex, setPresetIndex] = useState(
    Math.max(
      0,
      options.presets.findIndex(
        (preset) => preset.id === options.defaultPreset,
      ),
    ),
  );
  const preset = options.presets[presetIndex] ?? options.presets[0];
  const [focus, setFocus] = useState<'field' | 'agent'>('field');
  const [path, setPath] = useState(initialPath);
  const [project, setProject] = useState<LocalProject | null>(null);
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [initialization, setInitialization] =
    useState<ProjectInitialization | null>(null);
  const [initializeChoice, setInitializeChoice] = useState(false);
  const generation = useRef(0);
  const pending = useRef(false);
  const creating = useRef(false);
  // Keep paste off the confirmation key channel when the text field is replaced.
  usePaste(() => {});
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  const branches = project
    ? [
        ...(project.currentBranch
          ? []
          : [{ name: '', revision: project.head }]),
        ...project.branches
          .slice()
          .sort(
            (a, b) =>
              Number(b.name === project.currentBranch) -
              Number(a.name === project.currentBranch),
          ),
      ].filter((branch) =>
        (branch.name || 'Current commit')
          .toLowerCase()
          .includes(query.toLowerCase()),
      )
    : [];
  const selected = branches[index] ?? branches[0];
  async function submit() {
    if (!preset || pending.current || !enabled) return;
    pending.current = true;
    setBusy(true);
    setError('');
    const epoch = ++generation.current;
    try {
      if (preset.kind === 'local' && !project) {
        const expanded = resolveProjectPath(path, base);
        const inspected = await client.project(expanded);
        if (epoch !== generation.current) return;
        setProject(inspected);
        setPath(inspected.path);
        setIndex(0);
        return;
      }
      if (preset.kind === 'local' && (!project || !selected))
        throw new Error('Choose a starting branch');
      creating.current = true;
      const accepted = await onCreate({
        kind: 'new-session',
        presetId: preset.id,
        ...(preset.kind === 'local' && project && selected
          ? {
              project: {
                path: project.path,
                base: {
                  ...(selected.name ? { branch: selected.name } : {}),
                  revision: selected.revision,
                },
              },
            }
          : {}),
      });
      if (epoch === generation.current) {
        if (accepted) onClose();
        else
          setError(
            'Session was not created; see the status below. Esc to close.',
          );
      }
    } catch (failure) {
      if (epoch === generation.current) {
        if (failure instanceof ProjectInitializationRequired) {
          setInitialization(failure.project);
          setInitializeChoice(false);
          setPath(failure.project.path);
          return;
        }
        setError(
          terminalText(
            failure instanceof Error
              ? failure.message
              : 'Project is unavailable; choose a Git root',
          ),
        );
      }
    } finally {
      if (epoch === generation.current) {
        pending.current = false;
        creating.current = false;
        setBusy(false);
      }
    }
  }
  async function initialize() {
    if (!initialization || pending.current || !enabled) return;
    setInitializeChoice(true);
    pending.current = true;
    creating.current = true;
    setBusy(true);
    setError('');
    const epoch = ++generation.current;
    try {
      const inspected = await client.initializeProject(initialization);
      if (epoch !== generation.current) return;
      setProject(inspected);
      setPath(inspected.path);
      setInitialization(null);
      setIndex(0);
    } catch (failure) {
      if (epoch === generation.current) {
        setInitialization(null);
        setError(
          terminalText(
            failure instanceof Error
              ? failure.message
              : 'Git initialization failed; reload the folder',
          ),
        );
      }
    } finally {
      if (epoch === generation.current) {
        pending.current = false;
        creating.current = false;
        setBusy(false);
      }
    }
  }
  function declineInitialization() {
    setInitialization(null);
    setInitializeChoice(false);
    setError('');
  }
  const inputActive =
    enabled &&
    !busy &&
    !initialization &&
    focus === 'field' &&
    preset?.kind === 'local';
  useInput(
    (input, key) => {
      if (key.eventType === 'release') return;
      if (key.escape && !creating.current) {
        if (initialization) declineInitialization();
        else if (!inputActive) onClose();
        return;
      }
      if (pending.current || !enabled) return;
      if (key.meta || key.super || key.hyper) return;
      if (key.ctrl) {
        if (project && input === 'b') {
          setProject(null);
          setQuery('');
          setError('');
          declineInitialization();
        }
        return;
      }
      if (key.tab && key.shift && key.eventType !== 'repeat') {
        setFocus((value) => (value === 'agent' ? 'field' : 'agent'));
        return;
      }
      if (focus === 'agent') {
        if (key.tab || (key.return && preset?.kind === 'local'))
          setFocus('field');
        else if (
          key.leftArrow ||
          key.rightArrow ||
          key.upArrow ||
          key.downArrow
        ) {
          setPresetIndex(
            (value) =>
              (value +
                (key.leftArrow || key.upArrow
                  ? options.presets.length - 1
                  : 1)) %
              options.presets.length,
          );
          setError('');
          declineInitialization();
        } else if (key.return && key.eventType !== 'repeat') void submit();
        return;
      }
      if (initialization) {
        if (key.eventType === 'repeat') return;
        if (
          key.leftArrow ||
          key.rightArrow ||
          key.upArrow ||
          key.downArrow ||
          key.tab
        )
          setInitializeChoice((value) => !value);
        else if (input.toLowerCase() === 'y') void initialize();
        else if (input.toLowerCase() === 'n') declineInitialization();
        else if (key.return) {
          if (initializeChoice) void initialize();
          else declineInitialization();
        }
        return;
      }
      if (
        key.return &&
        preset?.kind !== 'local' &&
        key.eventType !== 'repeat'
      ) {
        void submit();
      } else if (key.tab && key.eventType !== 'repeat') {
        if (project || preset?.kind !== 'local') setFocus('agent');
      } else if (project && (key.upArrow || key.downArrow)) {
        setIndex((value) =>
          Math.max(
            0,
            Math.min(branches.length - 1, value + (key.downArrow ? 1 : -1)),
          ),
        );
      }
    },
    { isActive: enabled },
  );
  // Title, agent, project, branch field, key hint and status take six rows.
  // Sized by every branch, not the filtered ones, so typing does not resize it.
  const branchRows = Math.max(
    1,
    Math.min(
      maxHeight - 6,
      (project?.branches.length ?? 0) + (project?.currentBranch ? 0 : 1),
    ),
  );
  const start = Math.max(
    0,
    Math.min(index - Math.floor(branchRows / 2), branches.length - branchRows),
  );
  return (
    <Box flexDirection="column" overflow="hidden">
      <Text wrap="truncate-end">
        <Text color="cyan" bold>
          New Session
        </Text>
        <Text dimColor> · Shift+Tab Agent · Esc close</Text>
      </Text>
      <Text
        {...(focus === 'agent' ? { color: 'cyan', bold: true } : {})}
        wrap="truncate-end"
      >
        Agent {focus === 'agent' ? '> ' : ''}
        {preset?.label ?? 'Unavailable'}
        {preset?.kind === 'local' ? ' · no OS isolation' : ''}
      </Text>
      {preset?.kind === 'local' ? (
        <>
          <Text wrap="truncate-middle">
            Project{' '}
            {project
              ? terminalText(project.path)
              : initialization
                ? terminalText(initialization.path)
                : ''}
          </Text>
          {initialization ? (
            <Box flexDirection="column" height={5} overflow="hidden">
              <Text color="yellow" wrap="truncate-end">
                {initialization.state === 'not-git'
                  ? 'This folder has no Git repository.'
                  : 'This Git repository has no commits.'}
              </Text>
              <Text wrap="truncate-end">
                {initialization.state === 'not-git'
                  ? 'Initialize Git and commit current files?'
                  : 'Create the first commit of current files?'}
              </Text>
              <Text dimColor wrap="truncate-end">
                Existing .gitignore is respected · local commit
              </Text>
              <Text>
                <Text inverse={focus === 'field' && !initializeChoice}>
                  {' '}
                  No{' '}
                </Text>
                {'  '}
                <Text
                  color="cyan"
                  inverse={focus === 'field' && initializeChoice}
                >
                  {initialization.state === 'not-git'
                    ? ' Yes, initialize '
                    : ' Yes, commit '}
                </Text>
              </Text>
              <Text dimColor wrap="truncate-end">
                ←/→ choose · Enter confirm · y/n · Esc back
              </Text>
            </Box>
          ) : project ? (
            <>
              <Box>
                <Text color="cyan">Branch </Text>
                <PromptInput
                  id="new-branch"
                  active={inputActive}
                  value={query}
                  width={Math.max(1, width - 8)}
                  onChange={(value) => {
                    setQuery(value);
                    setIndex(0);
                  }}
                  onSubmit={() => {
                    void submit();
                  }}
                  onEscape={() => {
                    if (!pending.current) onClose();
                  }}
                />
                {!inputActive && (
                  <Text wrap="truncate-end">{terminalText(query)}</Text>
                )}
              </Box>
              <Box flexDirection="column" height={branchRows} flexShrink={0}>
                {branches
                  .slice(start, start + branchRows)
                  .map((branch, offset) => (
                    <Text
                      key={branch.name}
                      {...(start + offset === index ? { color: 'cyan' } : {})}
                      wrap="truncate-end"
                    >
                      {start + offset === index ? '> ' : '  '}
                      {terminalText(branchLabel(branch.name))} ·{' '}
                      {branch.revision.slice(0, 7)}
                    </Text>
                  ))}
                {!branches.length && (
                  <Text color="yellow">No matching branch</Text>
                )}
              </Box>
              <Text dimColor wrap="truncate-end">
                ↑/↓ select · Enter create · Ctrl+B folder
                {project.truncated ? ' · first 256 branches' : ''}
              </Text>
            </>
          ) : (
            <>
              <FolderInput
                client={client}
                value={path}
                base={base}
                width={width}
                active={inputActive}
                supported={folderCompletion}
                onChange={(value) => {
                  setPath(value);
                  setError('');
                }}
                onSubmit={() => {
                  void submit();
                }}
                onEscape={onClose}
              />
            </>
          )}
        </>
      ) : (
        <Text dimColor wrap="truncate-end">
          {preset?.kind === 'fixture'
            ? 'Built-in sample project · Enter create'
            : 'Configured project · Enter create'}
        </Text>
      )}
      <Text {...(error ? { color: 'yellow' } : {})} wrap="truncate-end">
        {busy
          ? initialization
            ? 'Initializing Git + first commit…'
            : project || preset?.kind !== 'local'
              ? 'Creating Session…'
              : 'Reading project branches…'
          : error || (focus === 'agent' ? '←/→ select agent · Tab back' : '')}
      </Text>
    </Box>
  );
}
