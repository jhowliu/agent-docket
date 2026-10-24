import { render } from 'ink';
import { createWorkbenchClient } from './workbench-client.js';
import { connectWorkbench } from './workbench-daemon.js';
import { workbenchOrigin } from './workbench-protocol.js';
import { WorkbenchApp } from './tui-app.js';
import { terminalText } from './tui-input.js';

/**
 * Opt-in alerts outside the TUI for background notices: `bell` rings the
 * terminal bell, `osc9` asks terminals that support OSC 9 for a desktop
 * notification. The TUI's own notice shows either way.
 */
function terminalNotifier(
  setting: string | undefined,
): ((text: string) => void) | undefined {
  switch (setting || 'off') {
    case 'off':
      return undefined;
    case 'bell':
      return () => process.stdout.write('\u0007');
    case 'osc9':
      return (text) =>
        process.stdout.write(
          `\u001b]9;${text.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')}\u0007`,
        );
    default:
      throw new Error('WORKBENCH_NOTIFY must be off, bell or osc9');
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log(
      'npm run tui                 Connect or start the local workbench\n  Press n to choose a Git project and starting branch, or Fixture for a demo.\nnpm run tui -- --connect     Connect only; do not start a server\nnpm run daemon:stop         Stop the server and clean up its Runs\nWORKBENCH_LAUNCH=/absolute/config.json WORKBENCH_PORT=4180 npm run tui\n  Optional trusted provider settings; local mode has no OS isolation.\nWORKBENCH_NOTIFY=bell|osc9 npm run tui\n  Also alert outside the TUI when a background Run needs you or finishes a turn.',
    );
    return;
  }
  if (args.some((arg) => arg !== '--connect' && arg !== '--stop'))
    throw new Error('Unknown option; use --help');
  const notify = terminalNotifier(process.env['WORKBENCH_NOTIFY']);
  const origin = workbenchOrigin();
  if (args.includes('--stop')) {
    const client = createWorkbenchClient(origin);
    await client.connect();
    await client.command({ kind: 'shutdown' });
    console.log('Server shutdown requested; its Runs will be cleaned up.');
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error(
      'TUI requires an interactive terminal. Run npm run tui in a terminal, or use npm run dev -- fixture for the text CLI.',
    );
  const { client, initial } = await connectWorkbench(origin, {
    autostart: !args.includes('--connect'),
  });
  const alternateScreen = process.env['INK_SCREEN_READER'] !== 'true';
  const app = render(
    <WorkbenchApp
      client={client}
      initial={initial}
      projectPath={process.cwd()}
      notify={notify}
    />,
    {
      alternateScreen,
      maxFps: 20,
      kittyKeyboard: {
        mode: 'auto',
        flags: ['disambiguateEscapeCodes', 'reportEventTypes'],
      },
    },
  );
  if (alternateScreen) {
    // Alternate scroll: terminals that support it send the mouse wheel as
    // arrow keys, which scroll the pane. Mouse selection stays the terminal's.
    process.stdout.write('\u001b[?1007h');
    process.once('exit', () => process.stdout.write('\u001b[?1007l'));
  }
  await app.waitUntilExit();
  console.log(
    `Detached; Runs remain at ${origin}. Run npm run tui to reconnect.`,
  );
}
main().catch((error: unknown) => {
  console.error(
    terminalText(error instanceof Error ? error.message : String(error)),
  );
  process.exitCode = 1;
});
