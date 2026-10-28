// -----------------------------------------------------------------------------
// End to end: the real SDK wiring (src/handlers.js) against the SDK's fake
// Gladys and a fake charger behind the injected `connect`. Timers and Date are
// mocked: the tests move the clock.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEVICE_TRANSPORTS } from '@gladysassistant/integration-sdk';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { AlfenApp } from '../src/app.js';
import { ACTIONS, HOUR, MINUTE, SECOND } from '../src/constants.js';
import { CHARGING_STATE, CONNECTOR_STATUS } from '../src/devices.js';
import { registerHandlers } from '../src/handlers.js';
import { memoryStore } from '../src/store.js';
import {
  FP,
  HOST,
  NOW,
  OTHER_FP,
  PASSWORD,
  SERIAL,
  USER,
  fakeCharger,
  routeOf,
  settle,
} from './fixtures/fakeAlfen.js';

const CONFIG = { host: HOST, password: PASSWORD };
const ALLOWED = { ...CONFIG, allow_commands: true };
const DEVICE = `ext:test-integration:alfen:${SERIAL}`;
const feature = (role) => `${DEVICE}:${role}`;
const READ = [
  'info',
  'login',
  'generic',
  'generic',
  'states',
  'states',
  'meter1',
  'meter1',
  'meter1',
  'temp',
  'logout',
];

const recorder = (logs) =>
  Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((level) => [
      level,
      (...args) => logs.push(args.map((a) => (a instanceof Error ? a.stack : String(a))).join(' ')),
    ]),
  );

async function setup(
  t,
  {
    config = CONFIG,
    server = fakeCharger(),
    store = memoryStore(),
    create = true,
    logs = [],
    gladys,
  } = {},
) {
  if (!gladys) {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: NOW });
  }
  const fake = gladys ?? createFakeGladys({ config });
  const app = new AlfenApp({
    gladys: fake,
    logger: recorder(logs),
    connect: (options) => server.connect(options),
    now: () => Date.now(),
    store,
  });
  if (!gladys) {
    registerHandlers(fake, app);
    await fake.connect();
  } else {
    await app.connected(config);
  }
  await settle();
  t.after(() => app.stop());
  const advance = async (ms, step = SECOND) => {
    for (let elapsed = 0; elapsed < ms; elapsed += step) {
      t.mock.timers.tick(Math.min(step, ms - elapsed));
      await settle();
    }
  };
  if (create && !gladys && fake.fake.discoveredDevices.length > 0) {
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
const message = (gladys) => gladys.fake.connectionStatus?.message ?? {};
const deviceOf = (gladys) => gladys.fake.discoveredDevices.at(-1);

/** No secret anywhere a user or a log reader may see. */
function assertNoSecret({ gladys, logs, store }) {
  const seen = JSON.stringify([logs, gladys.fake.connectionStatuses, store.data]);
  assert.ok(!seen.includes(PASSWORD), 'the password leaked');
  assert.ok(!seen.includes('jwt-'), 'the session token leaked');
}

test('without an address or a password, the status asks for it and nothing is requested', async (t) => {
  const server = fakeCharger();
  const { gladys, app } = await setup(t, { config: {}, server });
  assert.match(message(gladys).fr, /adresse IP/);
  const ack = await gladys.fake.action(ACTIONS.TEST_CONNECTION);
  assert.match(ack.data.message.en, /IP address/);
  await app.configUpdated({ host: HOST });
  assert.match(message(gladys).en, /Enter the password of the charger/);
  await app.configUpdated({ host: `admin:${PASSWORD}@${HOST}`, password: PASSWORD });
  assert.match(message(gladys).en, /holds a user name or a password/);
  assert.ok(!JSON.stringify(gladys.fake.connectionStatuses).includes(PASSWORD));
  assert.equal(server.connections.length, 0);
});

test('one read: one short session (identity, login, pages, logout), the device and its states', async (t) => {
  const ctx = await setup(t, { server: fakeCharger({ token: 'jwt-abc' }) });
  const { gladys, server, store } = ctx;
  assert.deepEqual(server.routes(), READ);
  assert.equal(server.connections.length, 1);
  assert.deepEqual(
    [server.connections[0].open, server.connections[0].loggedOut],
    [false, true],
    'logged out and closed',
  );
  assert.equal(server.maxOpen, 1);
  const login = JSON.parse(server.requests[1].body);
  assert.deepEqual(login, { username: USER, password: PASSWORD, displayname: 'Gladys' });
  assert.equal(server.requests[2].headers.Authorization, 'Bearer jwt-abc');
  assert.equal(store.data.pin, FP, 'the certificate pinned at the first connection');
  const device = deviceOf(gladys);
  assert.equal(device.external_id, DEVICE);
  assert.equal(device.name, 'Alfen Eve 3456');
  assert.equal(device.model, 'Eve Single Pro-line, 3 phase');
  assert.deepEqual(device.params, [
    { name: 'identity', value: SERIAL },
    { name: 'model_code', value: 'NG910-60023' },
    { name: 'firmware', value: '7.2.0-4189' },
  ]);
  assert.ok(
    device.features.every((f) => f.category !== 'switch'),
    'never a switch',
  );
  assert.ok(device.features.every((f) => f.type !== 'binary' || f.read_only));
  const roles = device.features.map((f) => f.external_id.slice(DEVICE.length + 1));
  assert.deepEqual(roles.slice(-3), ['pause-charge', 'resume-charge', 'set-current']);
  const index = device.features.find((f) => f.external_id === feature('energy-index'));
  assert.deepEqual(
    [index.category, index.type, index.unit],
    ['energy-sensor', 'index', 'kilowatt-hour'],
  );
  assert.deepEqual(
    device.features
      .at(-1)
      .supported_options.map((o) => o.value)
      .slice(-1),
    ['16'],
    'the ceiling: 16 A by default',
  );
  assert.equal(last(gladys, 'status'), 'En charge');
  assert.equal(last(gladys, 'status-code'), 'Charging Normal (11)');
  assert.equal(last(gladys, 'connector-status'), CONNECTOR_STATUS.OCCUPIED);
  assert.equal(last(gladys, 'charging-state'), CHARGING_STATE.CHARGING);
  assert.equal(last(gladys, 'plugged'), 1);
  assert.equal(last(gladys, 'charge-paused'), 0);
  assert.equal(last(gladys, 'power'), 11_041);
  assert.equal(last(gladys, 'current-l2'), 15.98);
  assert.equal(last(gladys, 'voltage-l3'), 231.2);
  assert.equal(last(gladys, 'station-max-current'), 16);
  assert.equal(last(gladys, 'current-set'), 16);
  assert.equal(last(gladys, 'energy-index'), 14_187);
  assert.equal(last(gladys, 'temperature'), 42.9);
  assert.equal(last(gladys, 'error'), 0);
  assert.equal(last(gladys, 'set-current'), '16');
  assert.match(message(gladys).fr, /Alfen Eve 3456 : En charge, 11041 W, 16 A réglés/);
  assert.equal(gladys.fake.transports.at(-1).transport, DEVICE_TRANSPORTS.LOCAL);
  assert.deepEqual(gladys.fake.publishedEnergyConsumption, [], 'the core computes it');
  assertNoSecret(ctx);
});

test('the certificate is pinned before the password leaves; another one: nothing sent, trusted on a click', async (t) => {
  const store = memoryStore();
  const server = fakeCharger();
  let pinAtLogin;
  server.charger.onRequest = (route) => {
    if (route === 'login') pinAtLogin = store.data?.pin;
  };
  const { gladys, advance, charger } = await setup(t, { server, store });
  assert.equal(pinAtLogin, FP, 'kept in /data before the login');
  charger.fingerprint = OTHER_FP;
  const before = server.requests.length;
  await advance(MINUTE);
  assert.equal(server.requests.length, before, 'not a byte written on that connection');
  assert.equal(server.connections.at(-1).open, false, 'the connection closed at once');
  assert.match(
    message(gladys).en,
    /certificate of the charger changed \(now AB:AB:AB:AB:AB:AB:AB:AB…\)/,
  );
  assert.equal(store.data.refusedPin, OTHER_FP);
  assert.equal(store.data.pin, FP, 'the pin is kept');
  assert.equal(last(gladys, 'connector-status'), CONNECTOR_STATUS.UNAVAILABLE);
  const pause = await (async () => {
    const ack = gladys.fake.setValue(
      gladys.fake.devices[0],
      gladys.fake.devices[0].features.find((f) => f.external_id === feature('pause-charge')),
      1,
    );
    await advance(5 * SECOND, 100);
    return ack;
  })();
  assert.equal(pause.success, false);
  assert.match(pause.error, /certificat de la borne a changé/);
  assert.equal(server.requests.length, before, 'the pause neither');
  const first = await gladys.fake.action(ACTIONS.TRUST_CERTIFICATE);
  assert.match(first.data.message.en, new RegExp(`Certificate refused: ${OTHER_FP}`));
  assert.equal(store.data.pin, FP, 'the first click pins nothing');
  const ack = await gladys.fake.action(ACTIONS.TRUST_CERTIFICATE);
  await settle();
  assert.match(ack.data.message.en, /AB:AB:AB:AB:AB:AB:AB:AB… is trusted/);
  assert.equal(store.data.pin, OTHER_FP);
  assert.equal(store.data.refusedPin, null);
  assert.equal(server.routes().at(-1), 'logout', 'read at once');
  assert.equal(gladys.fake.connectionStatus.connected, true);
  const again = await gladys.fake.action(ACTIONS.TRUST_CERTIFICATE);
  assert.match(again.data.message.en, /nothing to trust/);
});

test('refused credentials: spaced tries kept in /data, never the password; new ones tried at once', async (t) => {
  const store = memoryStore();
  const server = fakeCharger({ password: 'other' });
  const logs = [];
  const ctx = await setup(t, { server, store, logs });
  const { gladys, advance, app } = ctx;
  assert.equal(server.routes().filter((r) => r === 'login').length, 1);
  assert.match(message(gladys).fr, /refusé le nom d'utilisateur ou le mot de passe/);
  assert.equal(store.data.block.failures, 1);
  await advance(14 * MINUTE, 30 * SECOND);
  assert.equal(server.routes().filter((r) => r === 'login').length, 1, 'no try during the block');
  await advance(MINUTE + SECOND, 30 * SECOND);
  assert.equal(server.routes().filter((r) => r === 'login').length, 2);
  await advance(59 * MINUTE, MINUTE);
  assert.equal(server.routes().filter((r) => r === 'login').length, 2);
  assertNoSecret(ctx);
  await app.configUpdated({ ...CONFIG, password: 'other' });
  await settle();
  assert.equal(store.data.block, null);
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('never a read sooner than the interval: test button, reconnection, unchanged save, restart', async (t) => {
  const store = memoryStore();
  const ctx = await setup(t, { store });
  const { gladys, app, server, advance } = ctx;
  const sessions = () => server.connections.length;
  assert.equal(sessions(), 1);
  let ack = await gladys.fake.action(ACTIONS.TEST_CONNECTION);
  assert.match(ack.data.message.en, /next read in 60 s/);
  await app.connected({ ...CONFIG });
  await app.configUpdated({ ...CONFIG });
  await gladys.fake.scan?.();
  await settle();
  assert.equal(sessions(), 1);
  await advance(30 * SECOND);
  assert.equal(store.data.last.at, NOW, 'the start of the last read, in /data');
  // A restart (a new process, the same /data): not before the interval.
  app.stop();
  const again = await setup(t, { store, server, gladys: createFakeGladys({ config: CONFIG }) });
  assert.equal(sessions(), 1, 'the restart waits for the interval');
  await again.advance(31 * SECOND);
  // /data keeps the time at most once a minute: a restart counts a minute more, never less.
  assert.equal(sessions(), 1);
  await again.advance(MINUTE);
  assert.equal(sessions(), 2);
  ack = await gladys.fake.action(ACTIONS.TEST_CONNECTION);
  assert.ok(ack.data.message.en);
});

test('pause: no option, one session writing the station current to 0', async (t) => {
  const { gladys, server, press, advance } = await setup(t);
  const ack = await press('pause-charge');
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(server.writes(), [{ '2062_0': '0' }]);
  assert.equal(server.maxOpen, 1, 'never two sessions at once');
  const session = server.routes().slice(READ.length);
  assert.deepEqual(session.slice(0, 5), ['info', 'login', 'generic', 'generic', 'write']);
  await advance(20 * SECOND);
  assert.equal(last(gladys, 'charge-paused'), 1, 'confirmed by a read');
  assert.equal(last(gladys, 'status'), 'Véhicule branché, charge en pause');
});

test('resume and current refused unless allowed; nothing written', async (t) => {
  const { server, press } = await setup(t);
  for (const [role, value] of [
    ['resume-charge', 1],
    ['set-current', '10'],
  ]) {
    const ack = await press(role, value);
    assert.equal(ack.success, false);
    assert.match(ack.error, /désactivés/);
  }
  assert.deepEqual(server.writes(), []);
});

test('resume: exactly the station current read before the pause (never capped); refused without a vehicle', async (t) => {
  const { server, press, charger, advance, gladys } = await setup(t, {
    config: { ...ALLOWED, max_current: 10 },
  });
  let ack = await press('pause-charge');
  assert.equal(ack.success, true, ack.error);
  await advance(MINUTE);
  ack = await press('resume-charge');
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(server.writes().at(-1), { '2062_0': '16' }, 'the 16 A of the installation');
  await advance(20 * SECOND);
  assert.equal(last(gladys, 'station-max-current'), 16);
  charger.props.states['2501_4'] = 160;
  charger.props.generic['2062_0'] = 0;
  await advance(2 * MINUTE);
  ack = await press('resume-charge');
  assert.equal(ack.success, false);
  assert.match(ack.error, /Aucun véhicule/);
});

test('current: decided on a fresh read, capped, one change a minute', async (t) => {
  const { server, press, charger, advance } = await setup(t, { config: ALLOWED });
  let ack = await press('set-current', '17');
  assert.equal(ack.success, false);
  assert.match(ack.error, /entre 6 et 16 A/);
  assert.equal(server.connections.length, 1, 'refused without a session');
  ack = await press('set-current', '10');
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(server.writes(), [{ '2129_0': '10' }]);
  const session = server.requests
    .filter((r) => r.id === server.connections[1].id)
    .map((r) => routeOf(r));
  assert.deepEqual(session, ['info', 'login', 'generic', 'generic', 'states', 'states', 'write']);
  assert.equal(server.connections[1].open, false, 'closed after the write');
  ack = await press('set-current', '12');
  assert.equal(ack.success, false);
  assert.match(ack.error, /moins d'une minute/);
  // The installation limit read on the charger caps it too.
  charger.props.generic['2062_0'] = 8;
  await advance(MINUTE);
  ack = await press('set-current', '9');
  assert.equal(ack.success, false);
  assert.match(ack.error, /entre 6 et 8 A/);
  assert.deepEqual(server.writes(), [{ '2129_0': '10' }]);
});

test('a pause takes the charger from a resume under way: never two sessions, the resume gives way', async (t) => {
  const { server, send, advance, charger } = await setup(t, { config: ALLOWED });
  charger.props.generic['2062_0'] = 0;
  await advance(MINUTE);
  charger.delays.states = 2_000;
  const resume = send('resume-charge');
  await advance(500, 100);
  const pause = send('pause-charge');
  await advance(5 * SECOND, 100);
  const [r, p] = [await resume, await pause];
  assert.equal(r.success, false);
  assert.match(r.error, /pause de cette borne est arrivée/);
  assert.equal(p.success, true, p.error);
  assert.deepEqual(server.writes(), [{ '2062_0': '0' }], 'only the pause written');
  assert.equal(server.maxOpen, 1);
});

test('a late resume landing after a pause: the pause is sent again by the next reads', async (t) => {
  const logs = [];
  const { server, press, advance, charger } = await setup(t, { config: ALLOWED, logs });
  await press('pause-charge');
  await advance(MINUTE);
  // The resume is applied 12 s later and never answered.
  charger.writePlan = (i) => (i === 1 ? { applyAfter: 12 * SECOND, answerAfter: 10 * SECOND } : {});
  const resume = await press('resume-charge');
  assert.equal(resume.success, false);
  assert.match(resume.error, /envoyée, sans confirmation/);
  const pause = await press('pause-charge');
  assert.equal(pause.success, true, pause.error);
  await advance(30 * SECOND);
  assert.equal(charger.props.generic['2062_0'], 0, 'the pause reaffirmed after the late resume');
  assert.ok(logs.some((l) => /pause sent again/.test(l)));
  assert.ok(server.writes().filter((w) => w['2062_0'] === '0').length >= 3);
});

test('a pause before the first read after a restart (a block kept): the device of the identity kept', async (t) => {
  const store = memoryStore();
  const first = await setup(t, { store });
  first.app.stop();
  store.data.block = { until: Date.now() + HOUR, failures: 1, refusedAt: Date.now() - 10 * MINUTE };
  const server = fakeCharger();
  const app = new AlfenApp({
    gladys: first.gladys,
    connect: (o) => server.connect(o),
    now: () => Date.now(),
    store,
    logger: recorder([]),
  });
  t.after(() => app.stop());
  await app.connected({ ...ALLOWED });
  await settle();
  assert.equal(server.connections.length, 0, 'no read during the block');
  const device = first.gladys.fake.devices.find((d) => d.external_id === DEVICE);
  const target = (role) => device.features.find((f) => f.external_id === feature(role));
  const pause = app.setValue(device, target('pause-charge'), 1);
  await settle();
  await first.advance(SECOND, 100);
  await pause;
  assert.deepEqual(server.writes(), [{ '2062_0': '0' }]);
  await assert.rejects(app.setValue(device, target('resume-charge'), 1), /pas encore été lue/);
});

test('a pause during a block: one login at most every 5 minutes', async (t) => {
  const { press, advance, charger, server, store } = await setup(t);
  const logins = () => server.routes().filter((r) => r === 'login').length;
  charger.password = 'changed on the charger';
  await advance(MINUTE);
  assert.equal(logins(), 2);
  assert.equal(store.data.block.failures, 1);
  let ack = await press('pause-charge');
  assert.equal(ack.success, false);
  assert.match(ack.error, /jamais renvoyé en boucle/);
  assert.equal(logins(), 2);
  await advance(5 * MINUTE, 30 * SECOND);
  ack = await press('pause-charge');
  assert.equal(ack.success, false, 'still refused by the charger');
  assert.match(ack.error, /refusé le nom d'utilisateur ou le mot de passe : non envoyée/);
  assert.equal(logins(), 3, 'one login for the pause');
  assert.equal(store.data.block.failures, 1, 'the reads keep their spacing');
});

test('429 or 5xx: the pause still goes, the others wait; 5xx on the temperature never stops the rest', async (t) => {
  const store = memoryStore();
  const { gladys, server, press, advance, charger, app } = await setup(t, {
    store,
    config: ALLOWED,
  });
  charger.statuses.temp = 500;
  await advance(MINUTE);
  assert.equal(gladys.fake.connectionStatus.connected, true, 'the temperature is secondary');
  delete charger.statuses.temp;
  charger.statuses.generic = 503;
  await advance(MINUTE);
  assert.equal(store.data.pause.reason, '5xx');
  delete charger.statuses.generic;
  const before = server.connections.length;
  await app.connected({ ...ALLOWED });
  await settle();
  assert.equal(server.connections.length, before, 'no read during the pause');
  let ack = await press('set-current', '10');
  assert.equal(ack.success, false);
  assert.match(ack.error, /erreur serveur/);
  ack = await press('pause-charge');
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(server.writes(), [{ '2062_0': '0' }]);
});

test('a slow login: the command leaves by 3.5 s or not at all', async (t) => {
  const { server, press, charger } = await setup(t, { config: ALLOWED });
  charger.delays.login = 3_600;
  const ack = await press('pause-charge');
  assert.equal(ack.success, false);
  assert.match(ack.error, /trop lentement/);
  assert.deepEqual(server.writes(), []);
});

test('a write refused (401: the session was lost): refused, never a block', async (t) => {
  const store = memoryStore();
  const { press, charger } = await setup(t, { store });
  charger.statuses.write = 401;
  const ack = await press('pause-charge');
  assert.equal(ack.success, false);
  assert.match(ack.error, /refusé la commande \(HTTP 401\)/);
  assert.equal(store.data.block, null);
});

test('another charger at the address: the old device is not read any more, its commands refused', async (t) => {
  const { gladys, press, advance, charger, server } = await setup(t, { config: ALLOWED });
  charger.info = { ...charger.info, Identity: 'ACE0999999' };
  const before = server.writes().length;
  const ack = await press('pause-charge');
  assert.equal(ack.success, false);
  assert.match(ack.error, /autre borne répond/);
  assert.equal(server.writes().length, before);
  await advance(MINUTE);
  assert.match(message(gladys).fr, /Plus lue : Alfen Eve 3456 \(ace0123456\)/);
  assert.equal(last(gladys, 'connector-status'), CONNECTOR_STATUS.UNAVAILABLE);
});

test('an identity that cannot be read is not another charger', async (t) => {
  const { gladys, press, advance, charger, server } = await setup(t);
  charger.statuses.info = 500;
  charger.props.meter1['2221_16'] = 7000;
  await advance(MINUTE);
  assert.equal(last(gladys, 'power'), 7000);
  const ack = await press('pause-charge');
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(server.writes(), [{ '2062_0': '0' }]);
});

test('the energy index: never 0, a jump held, two clicks to accept it', async (t) => {
  const store = memoryStore();
  const { gladys, advance, charger } = await setup(t, { store });
  assert.equal(last(gladys, 'energy-index'), 14_187);
  charger.props.meter1['2221_22'] = 14_187_100;
  await advance(MINUTE);
  assert.equal(last(gladys, 'energy-index'), 14_187.1);
  charger.props.meter1['2221_22'] = 0;
  await advance(MINUTE);
  assert.equal(last(gladys, 'energy-index'), 14_187.1, 'never 0');
  charger.props.meter1['2221_22'] = 20_000_000;
  await advance(MINUTE);
  assert.equal(last(gladys, 'energy-index'), 14_187.1, 'a jump held');
  assert.match(message(gladys).fr, /Index d'énergie retenu : un saut de 14187\.1 à 20000 kWh/);
  await advance(10 * MINUTE, 30 * SECOND);
  assert.equal(last(gladys, 'energy-index'), 14_187.1, 'never confirmed by time');
  let ack = await gladys.fake.action(ACTIONS.ACCEPT_HELD);
  assert.match(ack.data.message.en, /Click again within 60 s/);
  ack = await gladys.fake.action(ACTIONS.ACCEPT_HELD);
  await settle();
  assert.match(ack.data.message.fr, /Accepté : le saut de 14187\.1 à 20000 kWh/);
  assert.equal(last(gladys, 'energy-index'), 20_000);
});

test('the energy index: a second click never takes a drop lower than the one listed', async (t) => {
  const { gladys, advance, charger } = await setup(t);
  charger.props.meter1['2221_22'] = 14_187_100;
  await advance(MINUTE);
  charger.props.meter1['2221_22'] = 12_000;
  await advance(MINUTE);
  assert.equal(last(gladys, 'energy-index'), 14_187.1, 'a drop held');
  let ack = await gladys.fake.action(ACTIONS.ACCEPT_HELD);
  assert.match(ack.data.message.en, /Click again within 60 s/);
  charger.props.meter1['2221_22'] = 5_000;
  await advance(MINUTE);
  assert.equal(last(gladys, 'energy-index'), 14_187.1);
  ack = await gladys.fake.action(ACTIONS.ACCEPT_HELD);
  await settle();
  assert.match(ack.data.message.en, /Click again within 60 s/, 'a first click again');
  assert.match(ack.data.message.fr, /14187\.1 à 5 kWh/);
  assert.equal(last(gladys, 'energy-index'), 14_187.1, 'never 5 kWh without a click');
  ack = await gladys.fake.action(ACTIONS.ACCEPT_HELD);
  await settle();
  assert.match(ack.data.message.en, /^Accepted/);
  assert.equal(last(gladys, 'energy-index'), 5, 'the value listed, accepted');
});

test('unreachable: offline states, spaced tries never sooner than the interval', async (t) => {
  const { gladys, server, advance, charger } = await setup(t);
  charger.down = true;
  await advance(MINUTE);
  assert.equal(last(gladys, 'status'), 'Borne injoignable');
  assert.equal(last(gladys, 'connector-status'), CONNECTOR_STATUS.UNAVAILABLE);
  assert.equal(gladys.fake.transports.at(-1).transport, DEVICE_TRANSPORTS.UNREACHABLE);
  assert.match(message(gladys).en, /No answer from 192\.168\.1\.80/);
  const before = server.requests.length;
  await advance(59 * SECOND);
  assert.equal(server.requests.length, before);
});

test('statuses: no vehicle, paused, error', async (t) => {
  const { gladys, advance, charger } = await setup(t);
  const cases = [
    [160, 4, 16, 'Aucun véhicule', CONNECTOR_STATUS.AVAILABLE, CHARGING_STATE.IDLE],
    [
      178,
      8,
      0,
      'Véhicule branché, charge en pause',
      CONNECTOR_STATUS.OCCUPIED,
      CHARGING_STATE.PAUSED_BY_CHARGER,
    ],
    [
      178,
      8,
      16,
      'Véhicule branché, sans charge',
      CONNECTOR_STATUS.OCCUPIED,
      CHARGING_STATE.EV_CONNECTED,
    ],
    [240, 21, 16, 'Erreur de la borne', CONNECTOR_STATUS.FAULTED, CHARGING_STATE.IDLE],
  ];
  for (const [mode3, status, station, text, connector, charging] of cases) {
    charger.props.states['2501_4'] = mode3;
    charger.props.states['2501_2'] = status;
    charger.props.generic['2062_0'] = station;
    await advance(MINUTE);
    assert.equal(last(gladys, 'status'), text);
    assert.equal(last(gladys, 'connector-status'), connector, text);
    assert.equal(last(gladys, 'charging-state'), charging, text);
  }
  assert.equal(last(gladys, 'error'), 1);
  assert.equal(last(gladys, 'status-code'), 'Error Charging (21)');
});

test('a read under way is given up for a pause: never applied, never two sessions', async (t) => {
  const { gladys, server, send, advance, charger } = await setup(t);
  charger.delays.meter1 = 3_000;
  await advance(MINUTE - SECOND);
  charger.props.meter1['2221_16'] = 1;
  await advance(SECOND, 100);
  assert.equal(server.open(), 1, 'a read under way');
  const pause = send('pause-charge');
  await advance(5 * SECOND, 100);
  assert.equal((await pause).success, true);
  assert.equal(server.maxOpen, 1, 'never two sessions on the charger');
  assert.notEqual(last(gladys, 'power'), 1, 'the read given up is never applied');
});

test('a reconnection during a read starts no other read; an old configuration publishes nothing', async (t) => {
  const { gladys, server, app, advance, charger } = await setup(t);
  charger.delays.meter1 = 3_000;
  await advance(MINUTE, 500);
  const sessions = server.connections.length;
  await app.connected({ ...CONFIG });
  await settle();
  assert.equal(server.connections.length, sessions, 'no new read');
  // The address changes during the read: its late answer publishes nothing.
  charger.props.meter1['2221_16'] = 2;
  charger.down = true;
  await app.configUpdated({ ...CONFIG, host: '192.168.1.81' });
  await advance(4 * SECOND, 500);
  assert.notEqual(last(gladys, 'power'), 2);
});

test('a resend of the pause that fails keeps its reaffirmation (twice at most)', async (t) => {
  const logs = [];
  const { server, press, advance, charger } = await setup(t, { config: ALLOWED, logs });
  await press('pause-charge');
  await advance(MINUTE);
  charger.writePlan = (i) =>
    i === 1 ? { applyAfter: 12 * SECOND, answerAfter: 10 * SECOND } : undefined;
  await press('resume-charge');
  const pause = await press('pause-charge');
  assert.equal(pause.success, true, pause.error);
  charger.writePlan = undefined;
  charger.statuses.write = 500;
  await advance(60 * SECOND);
  const zeros = server.writes().filter((w) => w['2062_0'] === '0').length;
  assert.equal(zeros, 4, 'two pauses, then two resends that failed');
  assert.equal(logs.filter((l) => /pause reaffirmed failed/.test(l)).length, 2);
  assert.equal(server.maxOpen, 1);
});
