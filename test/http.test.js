// -----------------------------------------------------------------------------
// The real transport (src/alfen/http.js) and the real client against a real
// TLS server on the loopback, with a self-signed certificate made in the test
// (no file, no network): one connection per session, the certificate checked
// BEFORE the password is written, the logout, the bounds of the answers.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import tls from 'node:tls';
import { AlfenClient } from '../src/alfen/client.js';
import { AnswerParser, ERROR_KINDS, openConnection } from '../src/alfen/http.js';
import { selfSigned } from './fixtures/selfSigned.js';

const PASSWORD = 'correct horse';

/**
 * A tiny Alfen over TLS: a raw HTTP/1.1 server on each TLS socket (keep-alive),
 * which authenticates the CONNECTION at the login, as the charger does.
 */
async function alfenServer(t, { cert = selfSigned('alfen', 1), route } = {}) {
  const seen = { connections: 0, bytes: 0, requests: [], sockets: new Set() };
  const server = tls.createServer({ key: cert.key, cert: cert.cert }, (socket) => {
    seen.connections += 1;
    let loggedIn = false;
    let buffer = '';
    socket.on('data', (chunk) => {
      seen.bytes += chunk.length;
      buffer += chunk.toString('latin1');
      for (;;) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end === -1) return;
        const head = buffer.slice(0, end);
        const length = Number(/content-length: (\d+)/i.exec(head)?.[1] ?? 0);
        if (buffer.length < end + 4 + length) return;
        const body = buffer.slice(end + 4, end + 4 + length);
        buffer = buffer.slice(end + 4 + length);
        const [method, path] = head.split('\r\n')[0].split(' ');
        seen.requests.push({ method, path, body, socket });
        seen.sockets.add(socket);
        const reply = (status, payload = '', extra = '') => {
          const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
          socket.write(
            `HTTP/1.1 ${status} X\r\nContent-Type: alfen/json\r\nContent-Length: ${Buffer.byteLength(text)}\r\n${extra}\r\n${text}`,
          );
        };
        if (route && route({ method, path, body, reply, socket, loggedIn }) !== undefined) continue;
        if (path === '/api/info') reply(200, { Identity: 'ACE0123456', Model: 'NG910-60023' });
        else if (path === '/api/login') {
          loggedIn = JSON.parse(body).password === PASSWORD;
          reply(loggedIn ? 200 : 401);
        } else if (path === '/api/logout') {
          loggedIn = false;
          reply(200);
        } else if (!loggedIn) reply(401);
        else if (path.startsWith('/api/prop?cat=generic')) {
          const offset = Number(new URL(path, 'https://x').searchParams.get('offset'));
          const all = [
            { id: '2062_0', value: 16 },
            { id: '2129_0', value: '10' },
            { id: '205E_0', value: 1 },
          ];
          reply(200, { properties: all.slice(offset, offset + 2), total: all.length });
        } else if (method === 'POST' && path === '/api/prop') {
          reply(200, '', 'Connection: close\r\n');
          socket.end();
        } else reply(404);
      }
    });
    socket.on('error', () => {});
  });
  seen.tcp = 0;
  server.on('connection', () => {
    seen.tcp += 1;
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { server, seen, cert, address: { host: '127.0.0.1', port: server.address().port } };
}

const sessionOf = (address, { pin, auth = { username: 'admin', password: PASSWORD } } = {}) => ({
  address,
  auth,
  deadline: Date.now() + 5000,
  requestTimeout: 2000,
  logoutTimeout: 1000,
  trust: async (fingerprint) => {
    if (pin && fingerprint !== pin) {
      throw Object.assign(new Error('changed'), { kind: ERROR_KINDS.CERTIFICATE });
    }
  },
  identify: () => {},
});

test('a session: one TLS connection, login, pages, write, logout, closed', async (t) => {
  const { seen, cert, address } = await alfenServer(t);
  const client = new AlfenClient();
  const result = await client.session(
    sessionOf(address, { pin: cert.fingerprint }),
    async (api, info) => {
      assert.equal(info.serial, 'ace0123456');
      const values = await api.props('generic');
      return Object.fromEntries(values);
    },
  );
  assert.deepEqual(result, { '2062_0': 16, '2129_0': '10', '205E_0': 1 });
  assert.equal(seen.connections, 1);
  assert.equal(seen.sockets.size, 1, 'every request on the same connection');
  assert.deepEqual(
    seen.requests.map((r) => `${r.method} ${r.path.replace(/\?.*/, '')}`),
    ['GET /api/info', 'POST /api/login', 'GET /api/prop', 'GET /api/prop', 'POST /api/logout'],
  );
  assert.deepEqual(JSON.parse(seen.requests[1].body), {
    username: 'admin',
    password: PASSWORD,
    displayname: 'Gladys',
  });
});

test('another certificate: refused before a single byte is written (the password never leaves)', async (t) => {
  const { seen, address } = await alfenServer(t);
  const client = new AlfenClient();
  const other = selfSigned('other', 2);
  await assert.rejects(
    client.session(sessionOf(address, { pin: other.fingerprint }), async () => {}),
    (err) => err.kind === ERROR_KINDS.CERTIFICATE,
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(seen.tcp, 1, 'the charger was reached');
  assert.equal(seen.bytes, 0, 'nothing written');
  assert.equal(seen.requests.length, 0);
});

test('the fingerprint given is the SHA-256 of the certificate', async (t) => {
  const { cert, address } = await alfenServer(t);
  const connection = await openConnection({ ...address, timeoutMs: 2000 });
  assert.equal(connection.fingerprint, cert.fingerprint);
  connection.close();
});

test('a refused password: AUTH, and the connection is closed', async (t) => {
  const { seen, cert, address } = await alfenServer(t);
  const client = new AlfenClient();
  await assert.rejects(
    client.session(
      sessionOf(address, { pin: cert.fingerprint, auth: { username: 'admin', password: 'no' } }),
      async () => {},
    ),
    (err) => err.kind === ERROR_KINDS.AUTH && err.status === 401,
  );
  assert.equal(seen.requests.at(-1).path, '/api/login', 'no logout after a refused login');
});

test('a write: the charger closes the connection after it, the session ends without a logout', async (t) => {
  const { seen, cert, address } = await alfenServer(t);
  const client = new AlfenClient();
  let left = false;
  await client.session(sessionOf(address, { pin: cert.fingerprint }), (api) =>
    api.write('2062_0', 0, {
      timeoutMs: 2000,
      beforeSend: () => {
        left = true;
      },
    }),
  );
  assert.ok(left);
  assert.deepEqual(JSON.parse(seen.requests.at(-1).body), {
    '2062_0': { id: '2062_0', value: '0' },
  });
});

test('beforeSend refuses: nothing written, marked notSent', async (t) => {
  const { seen, cert, address } = await alfenServer(t);
  const client = new AlfenClient();
  await assert.rejects(
    client.session(sessionOf(address, { pin: cert.fingerprint }), (api) =>
      api.write('2062_0', 0, {
        timeoutMs: 2000,
        beforeSend: () => {
          throw new Error('too late');
        },
      }),
    ),
    (err) => err.notSent === true && err.beforeSend === true,
  );
  assert.ok(seen.requests.every((r) => r.path !== '/api/prop' || r.method !== 'POST'));
});

test('only the two command properties, in whole amperes, are ever written', async (t) => {
  const { cert, address } = await alfenServer(t);
  const client = new AlfenClient();
  for (const [id, value] of [
    ['2126_0', 1],
    ['2129_0', 5],
    ['2062_0', 1.5],
    ['2062_0', 40],
  ]) {
    await assert.rejects(
      client.session(sessionOf(address, { pin: cert.fingerprint }), (api) =>
        api.write(id, value, { timeoutMs: 1000 }),
      ),
      (err) => err.notSent === true,
      `${id}=${value}`,
    );
  }
});

test('a silent charger: TIMEOUT after the bytes left (it may have been received)', async (t) => {
  const { cert, address } = await alfenServer(t, {
    route: ({ path }) => (path.startsWith('/api/prop?cat') ? true : undefined),
  });
  const client = new AlfenClient();
  await assert.rejects(
    client.session(
      { ...sessionOf(address, { pin: cert.fingerprint }), requestTimeout: 300 },
      (api) => api.props('generic'),
    ),
    (err) => err.kind === ERROR_KINDS.TIMEOUT,
  );
});

test('the answer parser: chunked, split anywhere, bounded', () => {
  const text =
    'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4\r\n{"a"\r\n6\r\n:"bc"}\r\n0\r\n\r\n';
  const bytes = Buffer.from(text, 'latin1');
  for (let size = 1; size <= bytes.length; size += 1) {
    const parser = new AnswerParser();
    let done = false;
    for (let i = 0; i < bytes.length; i += size) {
      done = parser.push(bytes.subarray(i, i + size));
    }
    assert.ok(done, `chunks of ${size}`);
    assert.equal(parser.result().body, '{"a":"bc"}');
  }
  const big = new AnswerParser({ maxBytes: 10 });
  assert.throws(
    () => big.push(Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 11\r\n\r\n')),
    (err) => err.kind === ERROR_KINDS.PROTOCOL,
  );
  const chunkedBig = new AnswerParser({ maxBytes: 10 });
  assert.throws(
    () =>
      chunkedBig.push(Buffer.from('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nff\r\n')),
    (err) => err.kind === ERROR_KINDS.PROTOCOL,
  );
  const head = new AnswerParser({ headerBytes: 64 });
  assert.throws(
    () => head.push(Buffer.from(`HTTP/1.1 200 OK\r\nX: ${'a'.repeat(100)}`)),
    (err) => err.kind === ERROR_KINDS.PROTOCOL,
  );
  assert.throws(
    () => new AnswerParser().push(Buffer.from('SSH-2.0-OpenSSH\r\n\r\n')),
    (err) => err.kind === ERROR_KINDS.PROTOCOL,
  );
  const untilClose = new AnswerParser();
  assert.equal(untilClose.push(Buffer.from('HTTP/1.1 200 OK\r\n\r\nabc')), false);
  assert.equal(untilClose.end(), true);
  assert.equal(untilClose.result().body, 'abc');
});

test('nothing answers: UNREACHABLE (nothing sent)', async () => {
  await assert.rejects(
    openConnection({ host: '127.0.0.1', port: 1, timeoutMs: 1000 }),
    (err) => err.kind === ERROR_KINDS.UNREACHABLE && !/127\.0\.0\.1/.test(err.message),
  );
});
