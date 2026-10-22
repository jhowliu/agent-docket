import { useEffect, useRef, useState } from 'react';
import type { ChangeMap } from '../delivery/index.js';
import type { RunId } from '../execution/index.js';
import type { WorkbenchClient } from './workbench-client.js';
import type { WorkbenchState } from './workbench-protocol.js';

/** What the Diff tab can show for the selected Run. */
export type WorktreeDiff =
  /** No readable worktree (fixture, remote, collected or an older server): reported edits only. */
  | Readonly<{ kind: 'none' }>
  | Readonly<{ kind: 'loading' }>
  | Readonly<{ kind: 'ready'; map: ChangeMap }>
  | Readonly<{ kind: 'unavailable'; reason: string }>;

const REFRESH_MS = 1500;
// Shared values keep the Diff tab's memoized lines stable between polls.
export const NO_WORKTREE: WorktreeDiff = { kind: 'none' };
const LOADING: WorktreeDiff = { kind: 'loading' };

/**
 * The selected Run's worktree against its base while the Diff tab is visible.
 * Reloads when the Run records new activity (at most every 1.5 s) and every
 * 5 s while visible; late replies
 * for an earlier request or another Run are dropped, and the last result stays
 * on screen while a refresh is in flight.
 */
export function useWorktreeDiff(
  client: WorkbenchClient,
  state: WorkbenchState,
  runId: RunId | null,
  visible: boolean,
): WorktreeDiff {
  const run = state.runs.find((item) => item.id === runId);
  const supported =
    state.features?.changeMap === true &&
    run?.worktree !== undefined &&
    run.worktree.status.kind !== 'removed';
  const key = `${state.instanceId ?? ''}:${runId ?? ''}`;
  // New events from this Run (tools, diffs, turn ends) can mean new edits.
  const activity = state.events.reduce(
    (latest, event) =>
      event.runId === runId ? Math.max(latest, event.sequence) : latest,
    0,
  );
  const [result, setResult] = useState<{ key: string; diff: WorktreeDiff }>({
    key: '',
    diff: LOADING,
  });
  const generation = useRef(0);
  const lastLoad = useRef(0);
  // Edits made by hand produce no Run events, so a visible tab also rechecks every 5 s.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!visible || !supported) return;
    const interval = setInterval(() => setTick((count) => count + 1), 5000);
    return () => clearInterval(interval);
  }, [visible, supported]);
  useEffect(() => {
    if (!visible || !supported || !runId) return;
    const wait = Math.max(0, REFRESH_MS - (Date.now() - lastLoad.current));
    const timer = setTimeout(() => {
      lastLoad.current = Date.now();
      const request = ++generation.current;
      client
        .changes(runId, true)
        .then((map) => {
          if (request === generation.current)
            setResult({ key, diff: { kind: 'ready', map } });
        })
        .catch((error: unknown) => {
          if (request === generation.current)
            setResult({
              key,
              diff: {
                kind: 'unavailable',
                reason:
                  error instanceof Error
                    ? error.message
                    : 'Worktree changes are unavailable',
              },
            });
        });
    }, wait);
    return () => clearTimeout(timer);
  }, [client, key, runId, visible, supported, activity, tick]);
  if (!supported) return NO_WORKTREE;
  return result.key === key ? result.diff : LOADING;
}
