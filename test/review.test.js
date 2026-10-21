// -----------------------------------------------------------------------------
// The scenarios of review 1 (S1-S10), now holding, plus the minors (M1-M8).
// Real SDK wiring, the fake charger, a mocked clock.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { AlfenApp } from '../src/app.js';
import { AnswerParser } from '../src/alfen/http.js';
import { normalizeConfig } from '../src/config.js';
import { MINUTE, SECOND } from '../src/constants.js';
import { registerHandlers } from '../src/handlers.js';
import { memoryStore } from '../src/store.js';
import {
  FP,
  HOST,
  NOW,
  OTHER_FP,
  PASSWORD,
  SERIAL,
  fakeCharger,
  settle,
} from './fixtures/fakeAlfen.js';

const CONFIG = { host: HOST, password: PASSWORD };
const ALLOWED = { ...CONFIG, allow_commands: true };
const DEVICE = `ext:test-integration:alfen:${SERIAL}`;
const feature = (role) => `${DEVICE}:${role}`;
const THIRD_FP = Array.from({ length: 32 }, () => 'CD').join(':');

async function setup(
  t,
  { config = CONFIG, server = fakeCharger(), store = memoryStore(), connect, logs = [] } = {},
) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: NOW });
  const fake = createFakeGladys({ config });
  const logger = Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((l) => [l, (...a) => logs.push(`${l} ${a.join(' ')}`)]),
  );
  const app = new AlfenApp({
    gladys: fake,
    logger,
    connect: connect ?? ((o) => server.connect(o)),
    now: () => Date.now(),
    store,
  });
  registerHandlers(fake, app);
  await fake.connect();
  await settle();
  t.after(() => app.stop());
  const advance = async (ms, step = SECOND) => {
    for (let e = 0; e < ms; e += step) {
      t.mock.timers.tick(Math.min(step, ms - e));
      await settle();
    }
  };
  if (fake.fake.discoveredDevices.length > 0) {
    await fake.fake.deviceCreated(fake.fake.discoveredDevices[0]);
    await settle();
  }
  const target = (role) => {
    const device = fake.fake.devices.find((d) => d.external_id === DEVICE);
    return [device, device.features.find((f) => f.external_id === feature(role))];
  };
  const send = (role, value = 1) => fake.fake.setValue(...target(role), value);
  const press = async (role, value = 1, wait = 5 * SECOND) => {
    const ack = send(role, value);
    await settle();
    await advance(wait, 100);
    return ack;
  };
  return { gladys: fake, app, server, store, advance, logs, press, send, charger: server.charger };
}
const last = (gladys, role) => gladys.fake.lastState(feature(role));

test('S1 the resume writes back exactly the 32 A of the installation, never capped, never forgotten', async (t) => {
  const server = fakeCharger();
  server.charger.props.generic['2062_0'] = 32;
  const ctx = await setup(t, { config: ALLOWED, server });
  assert.equal(ctx.store.data.resumeCurrent, 32, 'followed by the reads');
  let ack = await ctx.press('pause-charge');
  assert.equal(ack.success, true, ack.error);
  assert.equal(ctx.store.data.resumeCurrent, 32, 'kept before 0 is written');
  await ctx.advance(MINUTE);
  assert.equal(ctx.store.data.resumeCurrent, 32, 'never replaced by a read during the pause');
  ack = await ctx.press('resume-charge');
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(ctx.server.writes().at(-1), { '2062_0': '32' });
  // The ceiling of the configuration is for the socket current only.
  ack = await ctx.press('set-current', '20', MINUTE);
  assert.equal(ack.success, false);
  assert.match(ack.error, /entre 6 et 16 A/);
});

test('S2 a station current never read before a pause: the resume is refused, nothing guessed', async (t) => {
  const server = fakeCharger();
  server.charger.props.generic['2062_0'] = 0;
  server.charger.props.states['2501_4'] = 178;
  const ctx = await setup(t, { config: ALLOWED, server });
  assert.match(ctx.gladys.fake.connectionStatus.message.fr, /valeur avant la pause est inconnue/);
  const ack = await ctx.press('resume-charge');
  assert.equal(ack.success, false);
  assert.match(ack.error, /avant la pause est inconnu/);
  assert.deepEqual(ctx.server.writes(), []);
});

test('S3 ten pauses: one write; nothing written when already paused, no follow-up read', async (t) => {
  const ctx = await setup(t);
  for (let i = 0; i < 10; i += 1) {
    const ack = await ctx.press('pause-charge', 1, 6 * SECOND);
    assert.equal(ack.success, true, ack.error);
  }
  assert.equal(ctx.server.writes().filter((x) => x['2062_0'] === '0').length, 1);
  const reads = ctx.server.connections.length;
  // The sessions are the pauses (a login each) and the reads at the interval only.
  assert.ok(reads <= 1 + 10 + 2 + 2, `sessions: ${reads}`);
});

test('S3b the read of a pause fails: the pause is written anyway', async (t) => {
  const ctx = await setup(t);
  ctx.charger.statuses.generic = 500;
  const ack = await ctx.press('pause-charge');
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(ctx.server.writes(), [{ '2062_0': '0' }]);
  assert.equal(ctx.store.data.resumeCurrent, 16, 'the last station current read');
});

test('S3c the read of a pause times out (connection gone): the pause goes in a new session', async (t) => {
  const ctx = await setup(t);
  ctx.charger.delays.generic = 1_200;
  const ack = await ctx.press('pause-charge');
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(ctx.server.writes(), [{ '2062_0': '0' }]);
  assert.equal(ctx.server.maxOpen, 1);
});

test('S4 a pause that goes through during a block lifts it: reads again, the pause confirmed', async (t) => {
  const ctx = await setup(t);
  const { gladys, charger, store, advance, press, server } = ctx;
  charger.busy = true;
  await advance(MINUTE);
  assert.equal(store.data.block.failures, 1);
  charger.busy = false;
  await advance(5 * MINUTE, 30 * SECOND);
  const before = server.routes().filter((r) => r === 'states').length;
  const ack = await press('pause-charge');
  assert.equal(ack.success, true, ack.error);
  assert.equal(store.data.block, null);
  await advance(SECOND);
  assert.ok(server.routes().filter((r) => r === 'states').length > before, 'read again');
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.equal(last(gladys, 'charge-paused'), 1);
});

test('S5 a poll in its /data write gap and a pause: never two sessions', async (t) => {
  const inner = memoryStore();
  let slow = false;
  const store = {
    get data() {
      return inner.data;
    },
    load: () => inner.load(),
    save: (d) =>
      slow ? new Promise((r) => setTimeout(() => r(inner.save(d)), 200)) : inner.save(d),
  };
  const ctx = await setup(t, { store });
  const { server, advance, send, charger } = ctx;
  slow = true;
  charger.delays.login = 400;
  await advance(MINUTE - SECOND);
  t.mock.timers.tick(SECOND);
  await settle();
  const pause = send('pause-charge');
  await settle();
  await advance(3 * SECOND, 50);
  const ack = await pause;
  assert.equal(ack.success, true, ack.error);
  assert.equal(server.maxOpen, 1);
});

test('S6 a late refusal of the old password never blocks the new one', async (t) => {
  const ctx = await setup(t);
  const { app, charger, store, advance, send, server } = ctx;
  charger.password = 'new pass';
  charger.delays.login = 1_500;
  const pause = send('pause-charge');
  await settle();
  await advance(500, 100);
  // Saved meanwhile (its first read waits for the slow login too: not awaited here).
  const saved = app.configUpdated({ ...CONFIG, password: 'new pass' });
  await settle();
  await advance(2 * SECOND, 100);
  await saved;
  const ack = await pause;
  assert.equal(ack.success, false);
  assert.equal(store.data.block, null);
  await advance(2 * MINUTE, 30 * SECOND);
  assert.ok(
    server.requests.some((r) => r.body?.includes('new pass')),
    'read with the new password',
  );
  assert.equal(store.data.block, null);
});

test('S7 / M1 trust: two clicks, exactly the fingerprint shown', async (t) => {
  const ctx = await setup(t);
  const { gladys, charger, advance, store } = ctx;
  charger.fingerprint = OTHER_FP;
  await advance(MINUTE);
  let ack = await gladys.fake.action('trust_certificate');
  assert.match(ack.data.message.en, new RegExp(OTHER_FP));
  charger.fingerprint = THIRD_FP;
  await advance(MINUTE);
  ack = await gladys.fake.action('trust_certificate');
  await settle();
  assert.match(ack.data.message.en, new RegExp(`Certificate refused: ${THIRD_FP}`), 'listed again');
  assert.equal(store.data.pin, FP, 'nothing pinned that was not shown');
});

test('S8 the address changes while a pause connects: nothing pinned, no password to the old address', async (t) => {
  const NEW = '192.168.1.81';
  const a = fakeCharger();
  const b = fakeCharger({ fingerprint: OTHER_FP });
  const connect = (o) => (o.host === HOST ? a.connect(o) : b.connect(o));
  const ctx = await setup(t, { connect, server: a });
  const { app, advance, send, store } = ctx;
  a.charger.delays.connect = 1_000;
  const pause = send('pause-charge');
  await settle();
  await advance(300, 100);
  const loginsA = a.routes().filter((r) => r === 'login').length;
  await app.configUpdated({ host: NEW, password: PASSWORD });
  await settle();
  await advance(2 * SECOND, 100);
  const ack = await pause;
  assert.equal(ack.success, false);
  assert.equal(
    a.routes().filter((r) => r === 'login').length,
    loginsA,
    'no login to the old address',
  );
  assert.equal(store.data.target, NEW);
  assert.equal(store.data.pin, OTHER_FP, 'the pin of the new address is its own');
});

test('S9 / M2 the first pin cannot be kept in /data: the password is not sent', async (t) => {
  const store = {
    data: null,
    load: async () => null,
    save: async () => {
      throw Object.assign(new Error('ro'), { code: 'EROFS' });
    },
  };
  const server = fakeCharger();
  const ctx = await setup(t, { server, store });
  assert.equal(server.routes().filter((r) => r === 'login').length, 0);
  assert.match(ctx.gladys.fake.connectionStatus.message.en, /could not be kept in \/data/);
});

test('S10 / M3 texts: a 429 on the login of a pause says not sent', async (t) => {
  const ctx = await setup(t);
  ctx.charger.statuses.login = 429;
  const ack = await ctx.press('pause-charge');
  assert.deepEqual(ctx.server.writes(), []);
  assert.match(ack.error, /ralentir \(HTTP 429\) : non envoyée/);
});

test('M4 a write refused (401) does not spend the minute between two changes', async (t) => {
  const ctx = await setup(t, { config: ALLOWED });
  ctx.charger.statuses.write = 401;
  let ack = await ctx.press('set-current', '10');
  assert.match(ack.error, /refusé la commande \(HTTP 401\)/);
  delete ctx.charger.statuses.write;
  ack = await ctx.press('set-current', '10');
  assert.equal(ack.success, true, ack.error);
});

test('M6 the password is sent as typed; M8 a ceiling lowered during the read refuses', async (t) => {
  assert.equal(normalizeConfig({ host: HOST, password: ' pass ' }).auth.password, ' pass ');
  const ctx = await setup(t, { config: ALLOWED });
  ctx.charger.delays.states = 1_000;
  const ack = ctx.send('set-current', '14');
  await settle();
  await ctx.advance(400, 100);
  await ctx.app.configUpdated({ ...ALLOWED, max_current: 10 });
  await ctx.advance(5 * SECOND, 100);
  const r = await ack;
  assert.equal(r.success, false);
  assert.match(r.error, /entre 6 et 10 A/);
  assert.deepEqual(ctx.server.writes(), []);
});

test('M7 a 100 Continue is skipped', () => {
  const parser = new AnswerParser();
  const done = parser.push(
    Buffer.from('HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok'),
  );
  assert.equal(done, true);
  assert.equal(parser.result().status, 200);
  assert.equal(parser.result().body, 'ok');
});

// --- Review 2 ------------------------------------------------------------------

test('S14 the installer lowers the limit to 20 A, the Alfen app pauses: the resume writes 20', async (t) => {
  const server = fakeCharger();
  server.charger.props.generic['2062_0'] = 32;
  const ctx = await setup(t, { config: ALLOWED, server });
  await ctx.press('pause-charge');
  await ctx.advance(MINUTE);
  await ctx.press('resume-charge');
  await ctx.advance(2 * MINUTE);
  ctx.charger.props.generic['2062_0'] = 20;
  await ctx.advance(2 * MINUTE);
  assert.equal(ctx.store.data.resumeCurrent, 20, 'kept in /data at each read');
  ctx.charger.props.generic['2062_0'] = 0;
  ctx.charger.props.states['2501_4'] = 178;
  await ctx.advance(MINUTE);
  assert.equal(ctx.store.data.resumeCurrent, 20, 'a read at 0 replaces nothing');
  assert.match(ctx.gladys.fake.connectionStatus.message.en, /20 A before the pause/);
  const ack = await ctx.press('resume-charge');
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(ctx.server.writes().at(-1), { '2062_0': '20' });
});

test('S15 slow login and slow page: no read before the pause, the pause is written', async (t) => {
  const ctx = await setup(t);
  ctx.charger.delays.login = 1_400;
  ctx.charger.delays.generic = 1_100;
  const n0 = ctx.server.requests.length;
  const ack = await ctx.press('pause-charge');
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(ctx.server.writes(), [{ '2062_0': '0' }]);
  assert.deepEqual(ctx.server.routes().slice(n0, n0 + 3), ['info', 'login', 'write']);
});

test('S15b slow login, fast page: the pause goes', async (t) => {
  const ctx = await setup(t);
  ctx.charger.delays.login = 1_400;
  const ack = await ctx.press('pause-charge');
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(ctx.server.writes(), [{ '2062_0': '0' }]);
});

test('S17 a pause during a 429 pause: info, login, write, nothing more', async (t) => {
  const ctx = await setup(t);
  ctx.charger.statuses.generic = 429;
  ctx.charger.headers = { 'retry-after': '600' };
  await ctx.advance(MINUTE);
  assert.equal(ctx.store.data.pause.reason, '429');
  delete ctx.charger.statuses.generic;
  const n0 = ctx.server.requests.length;
  const c0 = ctx.server.connections.length;
  const ack = await ctx.press('pause-charge');
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(ctx.server.routes().slice(n0), ['info', 'login', 'write']);
  assert.equal(ctx.server.connections.length, c0 + 1, 'one session');
});

test('S17b a 429 answered to the read of a pause is kept; the pause still goes', async (t) => {
  const ctx = await setup(t);
  ctx.charger.statuses.generic = 429;
  ctx.charger.headers = { 'retry-after': '600' };
  const ack = await ctx.press('pause-charge');
  assert.equal(ack.success, true, ack.error);
  assert.equal(ctx.store.data.pause.reason, '429');
  assert.deepEqual(ctx.server.writes(), [{ '2062_0': '0' }]);
});

test('S18 a pause during a block: no read before the write', async (t) => {
  const ctx = await setup(t);
  ctx.charger.busy = true;
  await ctx.advance(MINUTE);
  ctx.charger.busy = false;
  await ctx.advance(5 * MINUTE, 30 * SECOND);
  const n0 = ctx.server.requests.length;
  const ack = await ctx.press('pause-charge');
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(ctx.server.routes().slice(n0, n0 + 3), ['info', 'login', 'write']);
});

test('m1 a command given up by a new configuration: the text says so', async (t) => {
  const ctx = await setup(t);
  ctx.charger.delays.login = 1_000;
  const pause = ctx.send('pause-charge');
  await settle();
  await ctx.advance(300, 50);
  const saved = ctx.app.configUpdated({ ...CONFIG, password: 'new pass' });
  await settle();
  await ctx.advance(3 * SECOND, 100);
  await saved;
  const ack = await pause;
  assert.match(ack.error, /La configuration a changé pendant la commande : non envoyée, réessayez/);
  assert.deepEqual(ctx.server.writes(), []);
});
