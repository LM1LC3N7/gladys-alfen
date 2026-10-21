// -----------------------------------------------------------------------------
// The local HTTPS API of an Alfen Eve charger, ported from alfen_wallbox (MIT,
// leeyuentuen/alfen_wallbox, the Home Assistant integration, commit aa88b47):
// the identity (`GET /api/info`), the login and the logout, the properties of
// a category read by pages (`GET /api/prop?cat=&offset=`), a property written
// (`POST /api/prop`), the bearer token newer firmware gives at the login, the
// status codes and the mode 3 states.
//
// One session = one short connection (the charger takes ONE session at a time
// and authenticates the TCP connection): connect, check the certificate
// against the pin (BEFORE anything is written), read the identity, check it,
// log in, do the work, log out (1 s at most) and close. Never two sessions at
// once (the app holds one at a time). Nothing is retried here: the app spaces
// its new tries, and a write is never retried (it may have reached the
// charger). alfen_wallbox's queue of writes retried at every cycle is not
// kept.
//
// The answers come from the network: only own fields of plain objects are
// read, each with its exact type (a missing or mistyped value is undefined,
// never a default, so that a command is refused rather than decided on a
// guess); properties are kept in a Map. JSON.parse keeps `__proto__` as a
// plain own key: it never reaches a prototype, and it is never read.
// -----------------------------------------------------------------------------

import {
  CATEGORIES,
  CURRENT,
  DISPLAY_NAME,
  ERROR_STATUS,
  LIMITS,
  MODE3_STATES,
  MODELS,
  PATHS,
  PROPS,
  STATE,
} from '../constants.js';
import { ChargerError, ERROR_KINDS, openConnection } from './http.js';

const plain = (data) => data !== null && typeof data === 'object' && !Array.isArray(data);
const own = (object, key) =>
  plain(object) && Object.hasOwn(object, key) ? object[key] : undefined;

/** A number, or a text that is exactly one (the charger writes some as text), else undefined. */
export function numberOf(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'string' && /^\s*-?\d{1,12}(?:\.\d{1,12})?\s*$/.test(value)) {
    return Number(value);
  }
  return undefined;
}

/** A short text from the charger, without control characters. */
export function text(value, max = LIMITS.textLength) {
  if (typeof value !== 'string') {
    return undefined;
  }
  // eslint-disable-next-line no-control-regex
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return clean === '' ? undefined : clean.slice(0, max);
}

/** The identity of the charger ("ACE0123456") in lower case, else undefined. */
export function serialOf(value) {
  if (typeof value !== 'string') {
    return undefined;
  }
  const serial = value.trim().toLowerCase();
  return /^[0-9a-z](?:[0-9a-z_-]{2,38}[0-9a-z])$/.test(serial) ? serial : undefined;
}

const notObject = () => new ChargerError(ERROR_KINDS.PROTOCOL, 'Not a JSON object');

/** GET /api/info -> identity, model, firmware. */
export function parseInfo(data) {
  if (!plain(data)) {
    throw notObject();
  }
  const modelId = text(own(data, 'Model'), 20);
  return {
    serial: serialOf(own(data, 'Identity')),
    modelId,
    model: modelId && Object.hasOwn(MODELS, modelId) ? MODELS[modelId] : undefined,
    firmware: text(own(data, 'FWVersion'), 30),
  };
}

const PROP_ID = /^[0-9A-F]{4}_[0-9A-F]{1,2}$/;

/**
 * One page of `GET /api/prop`: `{ properties: [{ id, value, … }], total }`.
 * Returns `{ values: Map(id -> value), count, total }`; a property whose id
 * is not of the expected shape is skipped.
 */
export function parsePropsPage(data) {
  if (!plain(data)) {
    throw notObject();
  }
  const properties = own(data, 'properties');
  const total = own(data, 'total');
  if (!Array.isArray(properties) || !Number.isInteger(total) || total < 0) {
    throw new ChargerError(ERROR_KINDS.PROTOCOL, 'Not a page of properties');
  }
  if (properties.length > LIMITS.propsPerPage) {
    throw new ChargerError(ERROR_KINDS.PROTOCOL, 'Too many properties');
  }
  const values = new Map();
  for (const prop of properties) {
    const id = own(prop, 'id');
    if (typeof id === 'string' && PROP_ID.test(id)) {
      values.set(id, own(prop, 'value'));
    }
  }
  return { values, count: properties.length, total };
}

/** The mode 3 state -> our state (unknown when not one of the known codes). */
export function stateOf(mode3) {
  const letter =
    Number.isInteger(mode3) && Object.hasOwn(MODE3_STATES, mode3) ? MODE3_STATES[mode3] : undefined;
  switch (letter) {
    case 'A':
      return STATE.STANDBY;
    case 'B':
      return STATE.CONNECTED;
    case 'C':
    case 'D':
      return STATE.CHARGING;
    case 'E':
    case 'F':
      return STATE.ERROR;
    default:
      return STATE.UNKNOWN;
  }
}

/** A current as the charger gives it (A), usable as a setting: 0 to 80 A, else undefined. */
const amps = (value) => {
  const a = numberOf(value);
  return a !== undefined && a >= 0 && a <= 80 ? a : undefined;
};
const measure = (value, min, max) => {
  const v = numberOf(value);
  return v !== undefined && v >= min && v <= max ? v : undefined;
};
const integerIn = (value, min, max) => {
  const v = numberOf(value);
  return Number.isInteger(v) && v >= min && v <= max ? v : undefined;
};

/**
 * The control properties (category generic): the maximum station current
 * (0 = paused), the max current of socket 1, the number of sockets.
 */
export function parseControl(values) {
  const station = amps(values.get(PROPS.STATION_MAX));
  return {
    stationMax: station,
    paused: station === undefined ? undefined : station < CURRENT.min,
    currentSet: amps(values.get(PROPS.SOCKET_MAX)),
    sockets: integerIn(values.get(PROPS.SOCKETS), 1, 4),
  };
}

/** The status properties (category states): status code and mode 3 state of socket 1. */
export function parseStatus(values) {
  const status = integerIn(values.get(PROPS.STATUS), 0, 255);
  const mode3 = integerIn(values.get(PROPS.MODE3), 0, 255);
  const state = stateOf(mode3);
  const statusError =
    status !== undefined && status >= ERROR_STATUS.min && status <= ERROR_STATUS.max;
  return {
    status,
    mode3,
    state,
    error:
      status === undefined && state === STATE.UNKNOWN
        ? undefined
        : statusError || state === STATE.ERROR,
  };
}

/** The meter of socket 1 (category meter1): V, A, W, and the meter reading (Wh -> kWh). */
export function parseMeter(values) {
  const wh = measure(values.get(PROPS.METER), 0, 1e12);
  return {
    voltages: [PROPS.VOLTAGE_L1, PROPS.VOLTAGE_L2, PROPS.VOLTAGE_L3].map((id) =>
      measure(values.get(id), 0, 500),
    ),
    currents: [PROPS.CURRENT_L1, PROPS.CURRENT_L2, PROPS.CURRENT_L3].map((id) =>
      measure(values.get(id), 0, 100),
    ),
    power: measure(values.get(PROPS.POWER), 0, 100_000),
    totalEnergy: wh === undefined ? undefined : wh / 1000,
  };
}

/** The temperature of the charger (category temp), °C. */
export function parseTemperature(values) {
  return measure(values.get(PROPS.TEMPERATURE), -50, 150);
}

/** Retry-After (seconds or an HTTP date) in ms, else undefined. */
export function retryAfterOf(header, now = Date.now()) {
  if (typeof header !== 'string' || header.trim() === '') {
    return undefined;
  }
  if (/^\s*\d{1,6}\s*$/.test(header)) {
    return Number(header) * 1000;
  }
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/** The error of a non-2xx answer (the body is never kept). */
function statusError(response, now, { login = false, write = false } = {}) {
  const status = response.status;
  if (status === 429) {
    return new ChargerError(ERROR_KINDS.RATE_LIMITED, 'HTTP 429', {
      status,
      retryAfter: retryAfterOf(response.headers?.['retry-after'], now),
    });
  }
  if (login && (status === 401 || status === 403)) {
    return new ChargerError(ERROR_KINDS.AUTH, `HTTP ${status}`, { status });
  }
  if (!login && status === 401) {
    // After a login that succeeded: the session was lost, not the password refused.
    return new ChargerError(ERROR_KINDS.SESSION, 'HTTP 401', { status, notSent: write });
  }
  if (write && status >= 400 && status < 500) {
    return new ChargerError(ERROR_KINDS.REJECTED, `HTTP ${status}`, { status });
  }
  return new ChargerError(ERROR_KINDS.HTTP, `HTTP ${status}`, { status });
}

/** The reason of an error for a log or a message: its kind and status, never the answer. */
export function errorReason(err) {
  if (
    err?.kind === ERROR_KINDS.HTTP ||
    err?.kind === ERROR_KINDS.RATE_LIMITED ||
    err?.kind === ERROR_KINDS.AUTH ||
    err?.kind === ERROR_KINDS.REJECTED ||
    (err?.kind === ERROR_KINDS.SESSION && err.status)
  ) {
    return `HTTP ${err.status}`;
  }
  return err?.kind ?? 'error';
}

const ok = (response) => response.status >= 200 && response.status <= 299;

/** The JSON of an answer, else a protocol error. */
function jsonOf(response) {
  try {
    return JSON.parse(response.body);
  } catch {
    throw new ChargerError(ERROR_KINDS.PROTOCOL, 'Not JSON');
  }
}

export class AlfenClient {
  constructor({ connect = openConnection, now = Date.now } = {}) {
    this.connect = connect;
    this.now = now;
  }

  /** The timeout of the next request: the time left before `deadline`, at most `max`. */
  budget(deadline, max) {
    const left = Math.min(max, deadline - this.now());
    if (left <= 0) {
      throw new ChargerError(ERROR_KINDS.LATE, 'No time left', { notSent: true });
    }
    return left;
  }

  /**
   * One session. `trust(fingerprint)` checks the certificate (it throws to
   * refuse it; it may await the first pin being kept); `identify(info, err)`
   * checks the identity read (it throws to refuse the charger; `err` when
   * /api/info could not be read); `work(api, info)` does the reads and the
   * write. `onOpen(connection)` lets the app give the session up (a pause).
   * Every request ends by `deadline` (ms since epoch), each one within
   * `requestTimeout`; the logout is never waited for longer than
   * `logoutTimeout`.
   */
  async session(
    { address, auth, deadline, requestTimeout, logoutTimeout, trust, identify, onOpen, onLogin },
    work,
  ) {
    const connection = await this.connect({
      host: address.host,
      port: address.port,
      timeoutMs: this.budget(deadline, requestTimeout),
    });
    let token;
    let loggedIn = false;
    try {
      onOpen?.(connection);
      if (connection.closed) {
        // Given up while it connected: nothing is checked nor written.
        throw new ChargerError(ERROR_KINDS.ABORTED, 'Session given up', { notSent: true });
      }
      await trust(connection.fingerprint);
      if (connection.closed) {
        throw new ChargerError(ERROR_KINDS.ABORTED, 'Session given up', { notSent: true });
      }
      let info;
      let infoError;
      try {
        info = parseInfo(
          jsonOf(
            await this.expectOk(
              connection.request({
                method: 'GET',
                path: PATHS.info,
                timeoutMs: this.budget(deadline, requestTimeout),
              }),
            ),
          ),
        );
      } catch (err) {
        if (
          err.kind === ERROR_KINDS.ABORTED ||
          err.kind === ERROR_KINDS.LATE ||
          err.kind === ERROR_KINDS.RATE_LIMITED ||
          connection.closed
        ) {
          throw err;
        }
        infoError = err;
      }
      await identify(info, infoError);
      if (connection.closed) {
        throw new ChargerError(ERROR_KINDS.ABORTED, 'Session given up', { notSent: true });
      }
      if (!auth) {
        throw new ChargerError(ERROR_KINDS.AUTH, 'No password', { notSent: true });
      }
      const answer = await connection.request({
        method: 'POST',
        path: PATHS.login,
        body: JSON.stringify({
          username: auth.username,
          password: auth.password,
          displayname: DISPLAY_NAME,
        }),
        timeoutMs: this.budget(deadline, requestTimeout),
      });
      if (!ok(answer)) {
        throw statusError(answer, this.now(), { login: true });
      }
      loggedIn = true;
      await onLogin?.();
      // Newer firmware: a bearer token for the requests of this connection (memory only).
      let data;
      try {
        data = JSON.parse(answer.body);
      } catch {
        data = undefined;
      }
      const access = own(data, 'access');
      token =
        typeof access === 'string' && /^[\x21-\x7e]{1,4096}$/.test(access) ? access : undefined;
      const api = {
        props: (category, { by = deadline, timeout = requestTimeout } = {}) =>
          this.category(connection, token, category, by, timeout),
        get closed() {
          return connection.closed;
        },
        write: (id, value, options) => this.write(connection, token, id, value, options),
      };
      return await work(api, info);
    } finally {
      // The session is released at once: logged out (bounded), then closed.
      // No time left (a command must answer Gladys): closed only, which ends
      // the session of the charger too (it authenticates the connection).
      const wait = typeof logoutTimeout === 'function' ? logoutTimeout() : logoutTimeout;
      if (loggedIn && !connection.closed && wait > 0) {
        await connection
          .request({
            method: 'POST',
            path: PATHS.logout,
            headers: token ? { Authorization: `Bearer ${token}` } : {},
            timeoutMs: wait,
          })
          .catch(() => {});
      }
      connection.close();
    }
  }

  async expectOk(promise, options) {
    const response = await promise;
    if (!ok(response)) {
      throw statusError(response, this.now(), options);
    }
    return response;
  }

  /** Every page of a category (LIMITS.pages at most) -> Map(id -> value). */
  async category(connection, token, category, deadline, requestTimeout) {
    if (!Object.values(CATEGORIES).includes(category)) {
      throw new ChargerError(ERROR_KINDS.PROTOCOL, 'Unknown category', { notSent: true });
    }
    const values = new Map();
    let offset = 0;
    for (let page = 0; page < LIMITS.pages; page += 1) {
      const response = await this.expectOk(
        connection.request({
          method: 'GET',
          path: `${PATHS.prop}?${new URLSearchParams({ cat: category, offset: String(offset) })}`,
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          timeoutMs: this.budget(deadline, requestTimeout),
        }),
      );
      const parsed = parsePropsPage(jsonOf(response));
      for (const [id, value] of parsed.values) {
        values.set(id, value);
      }
      offset += parsed.count;
      if (parsed.count === 0 || offset >= parsed.total) {
        return values;
      }
    }
    return values;
  }

  /**
   * One property written, never retried. `beforeSend()` runs right before the
   * bytes go (the last checks of a command, the deadline): what it throws is
   * rethrown marked `notSent`. Only the two properties of the commands, with
   * whole amperes, are ever written.
   */
  async write(connection, token, id, value, { timeoutMs, beforeSend }) {
    const valid =
      // The station current: 0 (pause), or the value read before the pause (6 to 80 A).
      (id === PROPS.STATION_MAX &&
        Number.isInteger(value) &&
        (value === 0 || (value >= CURRENT.min && value <= CURRENT.station))) ||
      (id === PROPS.SOCKET_MAX &&
        Number.isInteger(value) &&
        value >= CURRENT.min &&
        value <= CURRENT.max);
    if (!valid) {
      throw new ChargerError(ERROR_KINDS.PROTOCOL, 'Bad command', { notSent: true });
    }
    const response = await connection.request({
      method: 'POST',
      path: PATHS.prop,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: JSON.stringify({ [id]: { id, value: String(value) } }),
      timeoutMs,
      beforeSend,
    });
    if (!ok(response)) {
      throw statusError(response, this.now(), { write: true });
    }
  }
}
