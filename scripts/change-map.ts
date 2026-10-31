import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { describeChange, type ChangeMap } from '../src/delivery/index.js';

// A Change map as Markdown for a PR body: the checkout's working tree against
// the merge base with --base. Read-only, like the TUI's `m`; flows are static
// and may miss dynamic calls, so this is a reading aid, not a review.
const exec = promisify(execFile);
const usage = 'Usage: npm run -s change-map -- [--base main] [directory]';
const args = process.argv.slice(2);
const at = args.indexOf('--base');
const baseRef = at < 0 ? 'main' : args[at + 1];
const rest =
  at < 0 ? args : args.filter((_, index) => index !== at && index !== at + 1);
if (!baseRef || rest.length > 1) throw new Error(usage);
// npm runs scripts from this package; INIT_CWD is where it was invoked.
const directory = resolve(process.env.INIT_CWD ?? '.', rest[0] ?? '.');
const git = async (...command: string[]) =>
  (await exec('git', ['-C', directory, ...command])).stdout.trim();
const top = await git('rev-parse', '--show-toplevel');
const base = await git('merge-base', baseRef, 'HEAD');
const map = await describeChange({ directory: top, base });

const code = (text: string) => '`' + text.replaceAll('`', "'") + '`';
const list = (names: string[]) => names.map(code).join(', ');

function markdown(map: ChangeMap, baseRef: string) {
  const lines = [
    `${code(baseRef)} (${map.base.slice(0, 7)}) → working tree · ${map.totals.files} files · +${map.totals.plus} −${map.totals.minus}`,
  ];
  if (map.truncated.length)
    lines.push(`Truncated: ${map.truncated.join(', ')}`);
  if (map.analysis.kind === 'files-only') {
    lines.push('', `No code analysis: ${map.analysis.reason}`);
  } else {
    lines.push('', '**Interface changes**');
    if (!map.interfaces.length)
      lines.push(`None (${list(map.analysis.interfaceModules)} unchanged)`);
    for (const change of map.interfaces)
      lines.push(
        `- ${code(change.module)}` +
          (['added', 'removed', 'changed'] as const)
            .filter((kind) => change[kind].length)
            .map((kind) => ` · ${kind} ${list(change[kind])}`)
            .join(''),
      );

    lines.push('', '**Flows**');
    if (!map.flows.length) lines.push('None reach a module Interface');
    for (const flow of map.flows) {
      const triggers = flow.triggers.map(
        (trigger) => `${trigger.entry.kind} ${code(trigger.entry.label)}`,
      );
      if (flow.moreTriggers) triggers.push(`+${flow.moreTriggers} more`);
      lines.push(
        `- ${code(flow.operation)}` +
          (triggers.length ? ` ← ${triggers.join(', ')}` : '') +
          (flow.kind === 'unresolved' ? ' (no static sender)' : ''),
      );
      for (const member of flow.members) {
        const below = member.below
          .filter((entry) => entry.step.changed)
          .map((entry) => entry.step.name);
        lines.push(
          `  - ${code(`${member.module}.${member.step.name}`)}${member.step.changed ? ' (changed)' : ''}` +
            (below.length ? ` → ${list(below)}` : ''),
        );
      }
      if (flow.helpers.length)
        lines.push(`  - ${flow.helpers.length} changed helpers`);
    }

    lines.push('', '**Other changed functions**');
    if (!map.otherChanges.length) lines.push('None');
    const byFile = new Map<string, string[]>();
    for (const change of map.otherChanges)
      byFile.set(change.file, [
        ...(byFile.get(change.file) ?? []),
        change.name,
      ]);
    for (const [file, names] of byFile)
      lines.push(`- ${code(file)}: ${list(names)}`);
  }

  lines.push(
    '',
    '<details><summary>Files</summary>',
    '',
    '| Status | +/− | Path |',
    '| --- | --- | --- |',
    ...map.files.map(
      (file) =>
        `| ${file.status} | +${file.plus} −${file.minus} | ${code(file.previousPath ? `${file.previousPath} → ${file.path}` : file.path)} |`,
    ),
    '',
    '</details>',
  );
  return lines.join('\n');
}

process.stdout.write(markdown(map, baseRef) + '\n');
