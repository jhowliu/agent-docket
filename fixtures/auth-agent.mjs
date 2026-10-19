import {
  agent,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
} from '@agentclientprotocol/sdk';
import { Readable, Writable } from 'node:stream';

// Deterministic sign-in peer. It never contacts an identity provider or model.
let authenticated = false;
agent({ name: 'workbench-auth-fixture' })
  .onRequest(methods.agent.initialize, () => ({
    protocolVersion: PROTOCOL_VERSION,
    agentInfo: { name: 'workbench-auth-fixture', version: '1.0.0' },
    authMethods: [{ id: 'test-auth', name: 'Test sign-in' }],
  }))
  .onRequest(methods.agent.authenticate, ({ params }) => {
    if (params.methodId !== 'test-auth')
      throw new Error('Unexpected sign-in method');
    authenticated = true;
    return {};
  })
  .onRequest(methods.agent.session.new, () => {
    if (!authenticated) throw RequestError.authRequired();
    return { sessionId: 'native-auth-session' };
  })
  .onRequest(methods.agent.session.prompt, async ({ client }) => {
    await client.notify(methods.client.session.update, {
      sessionId: 'native-auth-session',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Native sign-in and prompt received.' },
      },
    });
    return { stopReason: 'end_turn' };
  })
  .onNotification(methods.agent.session.cancel, () => {})
  .connect(
    ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)),
  );
