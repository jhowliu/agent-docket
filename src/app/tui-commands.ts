/** Terminal command discovery only; domain validation stays with each command's owner. */
export const commands = [
  ['help', '', 'Show commands and keyboard shortcuts (:h also works)'],
  ['new', '', 'Choose a project and start a new Run'],
  ['use', '<number>', 'Select a Run by its displayed number'],
  ['active', '', 'Show all Runs'],
  ['inbox', '', 'Show Runs waiting for approval'],
  ['prompt', '<message>', 'Send a message to the selected Run'],
  ['timeline', '', 'Return to the main workspace'],
  ['live', '', 'Open raw conversation and tool diagnostics; Esc returns'],
  ['map', '', 'Open the selected Run’s Change map in the browser'],
  ['check', '[command]', 'Show or set the project’s Check command'],
  ['verify', '', 'Freeze a Candidate and run its Check on a clean checkout'],
  ['reviewer', '[codex|claude|same]', 'Show or choose the project’s reviewer'],
  ['accept', '', 'Accept the tracked Task with passing Checks'],
  ['changes', '<notes>', 'Send the tracked Task back for changes'],
  ['roadmap', '[title]', 'Show the Roadmap or create a project plan'],
  ['phase', '<title>', 'Add a Phase to the Roadmap'],
  ['task', '<phase number> <title>', 'Add a Task to a Phase'],
  ['focus', '<phase number>', 'Set the Roadmap’s focused Phase'],
  ['track', '<phase.task>', 'Attach this Run to a Task, e.g. :track 1.1'],
  ['direct', '', 'Detach this Run from its Task'],
  ['spec', '<requirements>', 'Update the tracked Task’s requirements'],
  ['confirm', '', 'Confirm the tracked Task’s current spec'],
  [
    'stage',
    '<stage>',
    'Set clarification, development, agent-review or human-review',
  ],
  [
    'answer',
    '<choice number>',
    'Answer the focused approval using a listed choice',
  ],
  ['auth', '<method ID>', 'Use a sign-in method advertised by the agent'],
  [
    'commit',
    '<message>',
    'Commit all changes on the Run branch and remove the Run',
  ],
  ['cancel', '', 'Stop and remove the Run, saving its work to its own branch'],
  ['quit', '', 'Detach from the workspace; Runs keep running'],
] as const;

export function commandMatches(text: string) {
  if (/\s/.test(text)) return [];
  return commands.filter(([name]) => name.startsWith(text));
}

/** Once arguments begin, keep the selected command’s usage visible. */
export function commandHints(text: string) {
  if (!/\s/.test(text)) return commandMatches(text);
  const name = text.split(/\s/, 1)[0];
  return commands.filter(([command]) => command === name);
}

export const commandHelp = [
  'Commands · :h / :help · Esc close',
  '↑↓ scroll · Ctrl+U/D or PgUp/PgDn page · g/G top/end',
  'Type : and a command prefix; Tab completes, Shift+Tab cycles back. Enter runs.',
  '',
  ...commands.flatMap(([name, args, description]) => [
    `:${name}${args ? ` ${args}` : ''}`,
    `  ${description}`,
  ]),
  '',
  'Keyboard shortcuts',
  'j/k select Run · w waiting/unread · Tab next request',
  'Enter/i reply · Space read reply · Esc keep draft / close',
  'a/r allow/deny · y mark agent request done (send a reply to continue)',
  '↑↓ Timeline rows · Ctrl+U/D or PgUp/PgDn page · g/G top/end',
  'n new Run · m Change map · v verify · x cancel and remove',
  'o Roadmap · [/] Phase · {/} Tasks · s actions · d request details',
  '? help · :live diagnostics · :timeline main workspace',
  'q / Ctrl+C detach; Runs keep running',
];
