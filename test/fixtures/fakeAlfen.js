// -----------------------------------------------------------------------------
// A fake Alfen Eve behind the `connect` the integration is given: the routes
// of the local HTTPS API as alfen_wallbox reads them (values made up, never
// captured from a real charger), ONE session at a time authenticated on the
// connection (a request before the login answers 401), the properties by
// category and by pages, a write applied to the charger (and the connection
// closed after it, as alfen_wallbox says the wallbox does), the logout.
// Records every connection and request. No network. Delays use setTimeout,
// so the mocked clock drives them.
// -----------------------------------------------------------------------------

import { ChargerError, ERROR_KINDS } from '../../src/alfen/http.js';

export const HOST = '192.168.1.80';
export const USER = 'admin';
export const PASSWORD = 'correct horse';
export const IDENTITY = 'ACE0123456';
export const SERIAL = 'ace0123456';
export const FP = Array.from({ length: 32 }, (_, i) =>
  (i * 7 + 16).toString(16).slice(-2).toUpperCase().padStart(2, '0'),
).join(':');
export const OTHER_FP = Array.from({ length: 32 }, () => 'AB').join(':');
export const NOW = Date.UTC(2026, 9, 21, 18, 0, 0);

/** Charging on three phases at 16 A, 11 kW, 14 187 kWh on the meter. */
export const props = () => ({
  generic: { '2062_0': 16, '2129_0': 16, '205E_0': 1, '2068_0': 6, '2056_0': 27 },
  states: { '2501_1': 14, '2501_2': 11, '2501_3': 5, '2501_4': 194 },
  meter1: {
    '2221_3': 229.6,
    '2221_4': 230.4,
    '2221_5': 231.2,
    '2221_A': 16.01,
    '2221_B': 15.98,
    '2221_C': 16.03,
    '2221_16': 11040.5,
    '2221_22': 14_187_000,
  },
  temp: { '2201_0': 42.875 },
});

const answer = (status, body = '', headers = {}) => ({
  status,
  headers,
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The charger. The test may set: `down` (nothing answers), `fingerprint`,
 * `password`, `info` (or `infoStatus`), `delays` and `statuses` by route
 * (`info`, `login`, `generic`, `states`, `meter1`, `temp`, `write`,
 * `logout`), `silent` routes (connected, no answer), `pageSize`,
 * `closeAfterWrite` (true by default), `writePlan(index)` ->
 * { applyAfter, answerAfter } (ms), `busy` (the login answers 401: another
 * session is open).
 */
export function fakeCharger(over = {}) {
  const charger = {
    info: {
      Identity: IDENTITY,
      FWVersion: '7.2.0-4189',
      Model: 'NG910-60023',
      ObjectId: '12345',
      Type: '1',
    },
    props: props(),
    fingerprint: FP,
    username: USER,
    password: PASSWORD,
    delays: {},
    statuses: {},
    headers: {},
    silent: new Set(),
    pageSize: 3,
    closeAfterWrite: true,
    ...over,
  };
  let nextId = 0;
  const server = {
    charger,
    /** Every connection: { id, open, loggedIn, loggedOut, closedBy } */
    connections: [],
    /** { id, method, path, body } */
    requests: [],
    /** The most connections open at once. */
    maxOpen: 0,
    open: () => server.connections.filter((c) => c.open).length,
    routes: () => server.requests.map((r) => routeOf(r)),
    writes: () =>
      server.requests
        .filter((r) => routeOf(r) === 'write')
        .map((r) => {
          const [[id, { value }]] = Object.entries(JSON.parse(r.body));
          return { [id]: value };
        }),
    async connect({ host, port, timeoutMs }) {
      if (charger.down) {
        throw new ChargerError(ERROR_KINDS.UNREACHABLE, 'Unreachable: ECONNREFUSED');
      }
      if (charger.delays.connect) {
        if (charger.delays.connect >= timeoutMs) {
          await wait(timeoutMs);
          throw new ChargerError(ERROR_KINDS.UNREACHABLE, 'Unreachable: timeout');
        }
        await wait(charger.delays.connect);
      }
      const state = {
        id: (nextId += 1),
        host,
        port,
        open: true,
        loggedIn: false,
        loggedOut: false,
      };
      server.connections.push(state);
      server.maxOpen = Math.max(server.maxOpen, server.open());
      return connectionOf(server, state);
    },
  };
  return server;
}

export function routeOf({ method, path }) {
  const url = new URL(path, 'https://x');
  if (url.pathname === '/api/info') return 'info';
  if (url.pathname === '/api/login') return 'login';
  if (url.pathname === '/api/logout') return 'logout';
  if (url.pathname === '/api/prop')
    return method === 'POST' ? 'write' : url.searchParams.get('cat');
  return 'other';
}

function connectionOf(server, state) {
  const { charger } = server;
  let pending;
  const close = () => {
    state.open = false;
  };
  const connection = {
    fingerprint: charger.fingerprint,
    get closed() {
      return !state.open;
    },
    close() {
      if (!state.open) return;
      close();
      pending?.(new ChargerError(ERROR_KINDS.ABORTED, 'Session given up'));
    },
    request({ method = 'GET', path, headers = {}, body, timeoutMs, beforeSend }) {
      return new Promise((resolve, reject) => {
        if (!state.open) {
          reject(new ChargerError(ERROR_KINDS.SESSION, 'Connection closed', { notSent: true }));
          return;
        }
        let sent = false;
        pending = (err) => {
          pending = undefined;
          reject(Object.assign(err, { notSent: !sent }));
        };
        try {
          beforeSend?.();
        } catch (err) {
          pending = undefined;
          reject(Object.assign(err, { notSent: true, beforeSend: true }));
          return;
        }
        sent = true;
        const request = { id: state.id, method, path, body, headers };
        server.requests.push(request);
        handle(server, state, request, timeoutMs).then(
          (value) => {
            if (!pending) return;
            pending = undefined;
            resolve(value);
          },
          (err) => pending?.(err),
        );
      });
    },
  };
  return connection;
}

async function handle(server, state, request, timeoutMs) {
  const { charger } = server;
  const route = routeOf(request);
  charger.onRequest?.(route, request);
  if (charger.silent.has(route)) {
    await wait(timeoutMs);
    state.open = false;
    throw new ChargerError(ERROR_KINDS.TIMEOUT, 'Connected but silent: timeout');
  }
  if (route === 'write' && charger.writePlan) {
    const index = server.writes().length - 1;
    const { applyAfter = 0, answerAfter = 0 } = charger.writePlan(index) ?? {};
    const apply = () => applyWrite(charger, request.body);
    if (applyAfter > 0) setTimeout(apply, applyAfter);
    else apply();
    if (answerAfter >= timeoutMs) {
      await wait(timeoutMs);
      state.open = false;
      throw new ChargerError(ERROR_KINDS.TIMEOUT, 'Connected but silent: timeout');
    }
    if (answerAfter) await wait(answerAfter);
    if (charger.closeAfterWrite) state.open = false;
    return answer(200, '');
  }
  const delay = charger.delays[route] ?? 0;
  if (delay >= timeoutMs) {
    await wait(timeoutMs);
    state.open = false;
    throw new ChargerError(ERROR_KINDS.TIMEOUT, 'Connected but silent: timeout');
  }
  if (delay) await wait(delay);
  if (!state.open) {
    throw new ChargerError(ERROR_KINDS.ABORTED, 'Session given up');
  }
  const status = charger.statuses[route];
  if (status) {
    return answer(status, 'error', charger.headers);
  }
  switch (route) {
    case 'info':
      return answer(200, charger.info);
    case 'login': {
      const { username, password } = JSON.parse(request.body);
      if (charger.busy || username !== charger.username || password !== charger.password) {
        return answer(401, 'Unauthorized');
      }
      state.loggedIn = true;
      return answer(200, charger.token ? { access: charger.token } : '');
    }
    case 'logout':
      state.loggedIn = false;
      state.loggedOut = true;
      return answer(200, '');
    case 'write':
      if (!state.loggedIn) return answer(401, 'Unauthorized');
      applyWrite(charger, request.body);
      if (charger.closeAfterWrite) state.open = false;
      return answer(200, '');
    case 'generic':
    case 'states':
    case 'meter1':
    case 'temp': {
      if (!state.loggedIn) return answer(401, 'Unauthorized');
      const offset = Number(new URL(request.path, 'https://x').searchParams.get('offset'));
      const all = Object.entries(charger.props[route]).map(([id, value]) => ({
        id,
        access: 1,
        type: 8,
        len: 0,
        cat: route,
        value,
      }));
      return answer(200, {
        version: 2,
        properties: all.slice(offset, offset + charger.pageSize),
        offset,
        total: all.length,
      });
    }
    default:
      return answer(404, 'Not found');
  }
}

/** A write changes the charger: a station current of 0 stops the charge (C -> B), above 6 A resumes it. */
function applyWrite(charger, body) {
  for (const [id, { value }] of Object.entries(JSON.parse(body))) {
    charger.props.generic[id] = Number(value);
    const states = charger.props.states;
    if (id === '2062_0' && Number(value) === 0 && [193, 194, 209, 210].includes(states['2501_4'])) {
      states['2501_4'] = 178;
      states['2501_2'] = 10;
    } else if (id === '2062_0' && Number(value) >= 6 && states['2501_4'] === 178) {
      states['2501_4'] = 194;
      states['2501_2'] = 11;
    }
  }
}

export const settle = async (rounds = 20) => {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};
