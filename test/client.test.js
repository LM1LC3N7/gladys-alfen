// -----------------------------------------------------------------------------
// The parsers of src/alfen/client.js against hostile or odd answers: only own
// fields, exact types, bounded; and the state of /data repaired and bounded.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  numberOf,
  parseControl,
  parseInfo,
  parseMeter,
  parsePropsPage,
  parseStatus,
  retryAfterOf,
  serialOf,
  stateOf,
} from '../src/alfen/client.js';
import { normalizeConfig, parseAddress } from '../src/config.js';
import { CURRENT, HOUR, STATE } from '../src/constants.js';
import { normalizeMemory } from '../src/store.js';

const page = (properties, total = properties.length) => ({ version: 2, properties, total });
const map = (entries) => new Map(Object.entries(entries));

test('the identity, model and firmware: bounded, never a prototype', () => {
  const info = parseInfo(
    JSON.parse(
      '{"Identity":"ACE0123456","Model":"NG910-60023","FWVersion":"7.2.0\\u0007-4189","__proto__":{"Identity":"x"}}',
    ),
  );
  assert.deepEqual(info, {
    serial: 'ace0123456',
    modelId: 'NG910-60023',
    model: 'Eve Single Pro-line, 3 phase',
    firmware: '7.2.0-4189',
  });
  assert.equal({}.Identity, undefined);
  assert.equal(parseInfo({ Identity: 'a/b' }).serial, undefined);
  assert.equal(serialOf(' ACE_01-2 '), 'ace_01-2');
  assert.equal(serialOf(42), undefined);
  assert.throws(() => parseInfo([]));
});

test('a page of properties: only ids of the expected shape, bounded', () => {
  const parsed = parsePropsPage(
    page([
      { id: '2062_0', value: 16 },
      { id: '__proto__', value: 1 },
      { id: '2221_A', value: '15.98' },
      { value: 3 },
      'x',
    ]),
  );
  assert.deepEqual([...parsed.values.keys()], ['2062_0', '2221_A']);
  assert.equal(parsed.count, 5);
  assert.throws(() => parsePropsPage({ properties: {}, total: 1 }));
  assert.throws(() => parsePropsPage({ properties: [], total: -1 }));
  assert.throws(() => parsePropsPage(page(Array.from({ length: 501 }, () => ({})))));
});

test('numbers: exact, or a text that is exactly one', () => {
  assert.equal(numberOf(16), 16);
  assert.equal(numberOf('16'), 16);
  assert.equal(numberOf(' 15.5 '), 15.5);
  for (const bad of ['', ' ', '16A', null, true, NaN, Infinity, '1e3', [16]]) {
    assert.equal(numberOf(bad), undefined, String(bad));
  }
});

test('the control: paused when the station current is under 6 A, missing stays missing', () => {
  assert.deepEqual(parseControl(map({ '2062_0': 16, '2129_0': '10', '205E_0': 1 })), {
    stationMax: 16,
    paused: false,
    currentSet: 10,
    sockets: 1,
  });
  assert.equal(parseControl(map({ '2062_0': 0 })).paused, true);
  assert.equal(parseControl(map({})).paused, undefined, 'never a guess');
  assert.equal(parseControl(map({ '2062_0': 500 })).stationMax, undefined);
});

test('the status: the mode 3 state decides, the error codes flag', () => {
  assert.equal(stateOf(160), STATE.STANDBY);
  assert.equal(stateOf(178), STATE.CONNECTED);
  assert.equal(stateOf(194), STATE.CHARGING);
  assert.equal(stateOf(209), STATE.CHARGING);
  assert.equal(stateOf(240), STATE.ERROR);
  assert.equal(stateOf(7), STATE.UNKNOWN);
  assert.equal(stateOf('194'), STATE.UNKNOWN);
  assert.deepEqual(parseStatus(map({ '2501_2': 21, '2501_4': 194 })), {
    status: 21,
    mode3: 194,
    state: STATE.CHARGING,
    error: true,
  });
  assert.equal(parseStatus(map({})).error, undefined);
});

test('the meter: Wh to kWh, out of bounds dropped', () => {
  const meter = parseMeter(
    map({ '2221_22': 14_187_000, '2221_3': 230, '2221_A': -1, '2221_16': 'x' }),
  );
  assert.equal(meter.totalEnergy, 14_187);
  assert.deepEqual(meter.voltages, [230, undefined, undefined]);
  assert.equal(meter.currents[0], undefined);
  assert.equal(meter.power, undefined);
});

test('Retry-After: seconds or a date', () => {
  assert.equal(retryAfterOf('120'), 120_000);
  assert.equal(retryAfterOf('soon'), undefined);
  assert.equal(retryAfterOf(undefined), undefined);
});

test('the configuration: address, port 443, credentials pasted never kept, ceiling bounded', () => {
  assert.deepEqual(parseAddress('https://192.168.1.80/'), { host: '192.168.1.80', port: 443 });
  assert.deepEqual(parseAddress('alfen.local:8443'), { host: 'alfen.local', port: 8443 });
  assert.equal(parseAddress('999.1.1.1'), undefined);
  const pasted = normalizeConfig({ host: 'admin:secret@192.168.1.80', password: 'p' });
  assert.equal(pasted.address, undefined);
  assert.equal(pasted.credentialsInHost, true);
  assert.ok(!JSON.stringify(pasted).includes('secret'));
  const c = normalizeConfig({
    host: '192.168.1.80',
    password: 'p',
    max_current: 99,
    poll_interval: 1,
  });
  assert.equal(c.auth.username, 'admin');
  assert.equal(c.maxCurrent, CURRENT.max);
  assert.equal(c.pollInterval, 30);
  assert.equal(c.allowCommands, false);
  assert.equal(normalizeConfig({ allow_commands: 'yes' }).allowCommands, false);
  assert.equal(normalizeConfig({ host: 'x', password: 'é' }).badSecret, true);
  assert.equal(normalizeConfig({ __proto__: { allow_commands: true } }).allowCommands, false);
});

test('/data: repaired and bounded, never a secret', () => {
  const now = Date.UTC(2026, 9, 21);
  const memory = normalizeMemory(
    {
      pause: { until: now + 100 * HOUR, reason: 'x' },
      block: { until: now + 100 * HOUR, failures: 1e9, refusedAt: now + HOUR },
      target: '192.168.1.80',
      serial: 'ACE!',
      pin: 'not a fingerprint',
      last: { at: now + HOUR },
      resumeCurrent: 3,
      lastChangeAt: now + HOUR,
      unconfirmedResumeUntil: now + HOUR,
      password: 'leaked?',
    },
    now,
  );
  assert.equal(memory.pause.until, now + 6 * HOUR);
  assert.equal(memory.pause.reason, '429');
  assert.equal(memory.block.until, now + 6 * HOUR);
  assert.equal(memory.block.failures, 100);
  assert.equal(memory.block.refusedAt, now);
  assert.equal(memory.serial, null);
  assert.equal(memory.pin, null);
  assert.equal(memory.last.at, now);
  assert.equal(memory.resumeCurrent, null);
  assert.equal(memory.lastChangeAt, now);
  assert.equal(memory.unconfirmedResumeUntil, now + 90_000);
  assert.equal(memory.password, undefined);
  assert.deepEqual(normalizeMemory('garbage', now).indexes, {});
});
