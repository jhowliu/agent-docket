import { render } from 'ink';
import { createWorkbenchClient } from './workbench-client.js';
import { connectWorkbench } from './workbench-daemon.js';
import { workbenchOrigin } from './workbench-protocol.js';
import { WorkbenchApp } from './tui-app.js';
import { terminalText } from './tui-input.js';

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log(
      'npm run tui                 Connect or start the local workbench\n  Press n to choose a Git project and starting branch, or Fixture for a demo.\nnpm run tui -- --connect     Connect only; do not start a server\nnpm run daemon:stop         Stop the server and clean up its Runs\nWORKBENCH_LAUNCH=/absolute/config.json WORKBENCH_PORT=4180 npm run tui\n  Optional trusted provider settings; local mode has no OS isolation.',
    );
    return;
  }
  if (args.some((arg) => arg !== '--connect' && arg !== '--stop'))
    throw new Error('Unknown option; use --help');
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
  const app = render(
    <WorkbenchApp
      client={client}
      initial={initial}
      projectPath={process.cwd()}
    />,
    {
      alternateScreen: process.env['INK_SCREEN_READER'] !== 'true',
      maxFps: 20,
      kittyKeyboard: {
        mode: 'auto',
        flags: ['disambiguateEscapeCodes', 'reportEventTypes'],
      },
    },
  );
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
