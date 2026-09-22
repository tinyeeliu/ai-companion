/**
 * The SM3-restart failure: a 401 during the handshake is treated as terminal.
 *
 * When SM3 restarts, the Companion reconnects while the server is still booting.
 * The datastore is not ready yet, so the hub answers 401. `CloudLink` classifies
 * any pre-open failure as a permanent rejection and stops for good — even though
 * the identical token succeeds seconds later.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { CloudLink } from '../src/cloud/link';

const sockets: CloudLink[] = [];

function makeLink(url: string, onTerminalClose: (code: number) => void): CloudLink {
  const link = new CloudLink({
    connectionId: 'conn-1',
    channel: 'whatsapp',
    url,
    token: 'tok',
    account: () => undefined,
    session: () => undefined,
    onTerminalClose,
  });
  sockets.push(link);
  return link;
}

afterEach(() => {
  for (const link of sockets.splice(0)) link.stop();
});

describe('server restart while a link is live', () => {
  test('an abrupt server death is a transport drop, not a terminal rejection', async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req, srv) {
        if (srv.upgrade(req)) return undefined;
        return new Response('no', { status: 400 });
      },
      websocket: {
        open(ws) {
          ws.send(JSON.stringify({ v: 1, type: 'hello' }));
        },
        message() {},
      },
    });

    const terminal: number[] = [];
    const link = makeLink(`ws://127.0.0.1:${server.port}/`, (code) => terminal.push(code));
    link.start();
    await Bun.sleep(300);
    expect(link.state()).toBe('connected');

    server.stop(true);
    await Bun.sleep(400);

    expect(terminal).toEqual([]);
    expect(['connecting', 'retrying']).toContain(link.state());
  });

  test('a 401 that later clears must not park the link permanently', async () => {
    // Stands in for SM3 still booting: it refuses the upgrade, then accepts it.
    let ready = false;
    const server = Bun.serve({
      port: 0,
      fetch(req, srv) {
        if (!ready) return new Response('Unauthorized', { status: 401 });
        if (srv.upgrade(req)) return undefined;
        return new Response('no', { status: 400 });
      },
      websocket: {
        open(ws) {
          ws.send(JSON.stringify({ v: 1, type: 'hello' }));
        },
        message() {},
      },
    });

    const terminal: number[] = [];
    const link = makeLink(`ws://127.0.0.1:${server.port}/`, (code) => terminal.push(code));
    link.start();
    await Bun.sleep(200);

    // The server finishes booting. A transient refusal must not have latched.
    ready = true;
    await Bun.sleep(2_500);

    expect(link.state()).toBe('connected');
    server.stop(true);
  });
});
