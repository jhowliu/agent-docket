import test from 'node:test';
import assert from 'node:assert/strict';
import { workbenchOrigin } from '../src/app/workbench-protocol.js';
import { createWorkbenchClient } from '../src/app/workbench-client.js';

test('Fetch-blocked ports cannot be configured or used by a workbench client', () => {
  for (const port of [
    4190, 1719, 1720, 1723, 2049, 3659, 4045, 5060, 5061, 6000, 6566, 6665,
    6666, 6667, 6668, 6669, 6679, 6697, 10080,
  ]) {
    assert.throws(() => workbenchOrigin(String(port)), /blocked.*4182/);
    assert.throws(
      () => createWorkbenchClient(`http://127.0.0.1:${port}`),
      /blocked.*4182/,
    );
  }
  for (const port of ['1024', '4177', '4180', '4182', '6001', '65535']) {
    const origin = workbenchOrigin(port);
    assert.equal(origin, `http://127.0.0.1:${port}`);
    assert.doesNotThrow(() => createWorkbenchClient(origin));
  }
});
