// -----------------------------------------------------------------------------
// Alfen constants, limits and timings.
//
// An Alfen Eve charger (Single S-line, Single Pro-line, Double Pro-line) has a
// local HTTPS API, undocumented, as alfen_wallbox (MIT, leeyuentuen/
// alfen_wallbox, the Home Assistant integration) reads it:
//   - `GET /api/info`: identity, model, firmware (no login needed);
//   - `POST /api/login` {username, password, displayname}, `POST /api/logout`:
//     the charger takes ONE session at a time and authenticates the TCP
//     connection (newer firmware also gives a bearer token, `access`): every
//     exchange of the integration is one short connection, logged in, then
//     logged out and closed, so that the Alfen app of the installer can log
//     in between;
//   - `GET /api/prop?cat=<category>&offset=<n>`: the properties of a
//     category, by pages (`total`, `offset`);
//   - `POST /api/prop` {"<id>": {"id": "<id>", "value": "<value>"}}: writes a
//     property (the charger closes the connection after a write).
// The certificate of the charger is self-signed: it is pinned at the first
// connection (its SHA-256 fingerprint kept in /data) and checked at every
// connection, BEFORE the password is written.
// -----------------------------------------------------------------------------

export const DEFAULT_PORT = 443;

export const PATHS = {
  info: '/api/info',
  login: '/api/login',
  logout: '/api/logout',
  prop: '/api/prop',
};

/** The name of our session on the charger (alfen_wallbox sends the entry name, 32 chars at most). */
export const DISPLAY_NAME = 'Gladys';

/** The user name of the local API (alfen_wallbox's default). */
export const DEFAULT_USERNAME = 'admin';

/** The categories read at every poll: control, states, meter of socket 1, temperature. */
export const CATEGORIES = {
  GENERIC: 'generic',
  STATES: 'states',
  METER: 'meter1',
  TEMP: 'temp',
};

/** The properties read (socket 1), as alfen_wallbox names them. */
export const PROPS = {
  /** Maximum station current (A): 0 pauses the charge (alfen_wallbox's charging switch). */
  STATION_MAX: '2062_0',
  /** Max current of socket 1 (A): the charging current Gladys sets. */
  SOCKET_MAX: '2129_0',
  /** Number of sockets (1 or 2). */
  SOCKETS: '205E_0',
  /** Status of socket 1 (STATUS_CODES). */
  STATUS: '2501_2',
  /** Mode 3 (IEC 61851) state of socket 1 (MODE3_STATES). */
  MODE3: '2501_4',
  VOLTAGE_L1: '2221_3',
  VOLTAGE_L2: '2221_4',
  VOLTAGE_L3: '2221_5',
  CURRENT_L1: '2221_A',
  CURRENT_L2: '2221_B',
  CURRENT_L3: '2221_C',
  /** Active power of socket 1 (W). */
  POWER: '2221_16',
  /** Meter reading of socket 1 (Wh): the energy index. */
  METER: '2221_22',
  /** Temperature of the charger (°C). */
  TEMPERATURE: '2201_0',
};

/**
 * The charging current, in whole amperes: never below 6 A (IEC 61851, the
 * lowest current a vehicle accepts), never above the ceiling of the
 * configuration (16 A by default, 32 A at most) nor the maximum station
 * current read on the charger (its installation limit).
 */
export const CURRENT = {
  min: 6,
  max: 32,
  defaultCeiling: 16,
  /** A current read back within this tolerance is the one asked. */
  tolerance: 0.1,
};

/** Status of a socket (2501_2), alfen_wallbox's STATUS_DICT. */
export const STATUS_CODES = {
  0: 'Unknown',
  1: 'Off',
  2: 'Booting',
  3: 'Check Mains',
  4: 'Available',
  5: 'Authorizing',
  6: 'Authorized',
  7: 'Cable connected',
  8: 'EV Connected',
  9: 'Preparing Charging',
  10: 'Wait Vehicle Charging',
  11: 'Charging Normal',
  12: 'Charging Simplified',
  13: 'Suspended Over-Current',
  14: 'Suspended HF Switching',
  15: 'Suspended EV Disconnected',
  16: 'Finish Wait Vehicle',
  17: 'Finish Wait Disconnect',
  18: 'Error Protective Earth',
  19: 'Error Power Failure',
  20: 'Error Contactor Fault',
  21: 'Error Charging',
  22: 'Error Power Failure',
  23: 'Error Temperature',
  24: 'Error Illegal CP Value',
  25: 'Error Illegal PP Value',
  26: 'Error Too Many Restarts',
  27: 'Error',
  28: 'Error Message',
  29: 'Error Message Not Authorised',
  30: 'Error Message Cable Not Supported',
  31: 'Error Message S2 Not Opened',
  32: 'Error Message Time-Out',
  33: 'Reserved',
  34: 'In Operative',
  35: 'Load Balancing Limited',
  36: 'Load Balancing Forced Off',
  38: 'Not Charging',
  39: 'Solar Charging Wait',
  40: 'Charging Non Charging',
  41: 'Solar Charging',
  42: 'Charge Point Ready, Waiting For Power',
  43: 'Partial Solar Charging',
};

/** The status codes of an error (18 to 32). */
export const ERROR_STATUS = { min: 18, max: 32 };

/** Mode 3 state (2501_4) -> IEC 61851 state letter, alfen_wallbox's MODE_3_STAT_DICT. */
export const MODE3_STATES = {
  160: 'A',
  161: 'A',
  162: 'A',
  177: 'B',
  178: 'B',
  193: 'C',
  194: 'C',
  209: 'D',
  210: 'D',
  224: 'E',
  240: 'F',
};

/** Our states, from the mode 3 state, plus `offline` (no answer). */
export const STATE = {
  UNKNOWN: 'unknown',
  STANDBY: 'standby',
  CONNECTED: 'connected',
  CHARGING: 'charging',
  ERROR: 'error',
  OFFLINE: 'offline',
};

/** A vehicle is plugged in: the only states where a resume is sent. */
export const PLUGGED_STATES = new Set([STATE.CONNECTED, STATE.CHARGING]);

/** Model codes (`Model` of /api/info), alfen_wallbox's ALFEN_PRODUCT_MAP, shortened. */
export const MODELS = {
  'NG900-60503': 'Eve Single S-line, 1 phase',
  'NG900-60505': 'Eve Single S-line, 1 phase, shutters',
  'NG900-60507': 'Eve Single S-line, 1 phase, tethered',
  'NG910-60003': 'Eve Single Pro-line, 1 phase',
  'NG910-60005': 'Eve Single Pro-line FR, 1 phase',
  'NG910-60007': 'Eve Single Pro-line, 1 phase, tethered',
  'NG910-60023': 'Eve Single Pro-line, 3 phase',
  'NG910-60025': 'Eve Single Pro-line FR, 3 phase',
  'NG910-60027': 'Eve Single Pro-line, 3 phase, tethered',
  'NG910-60123': 'Eve Single Pro-line DE, 3 phase',
  'NG910-60127': 'Eve Single Pro-line DE, 3 phase, tethered',
  'NG910-60503': 'Eve Single S-line, 1 phase',
  'NG910-60505': 'Eve Single S-line, 1 phase, shutters',
  'NG910-60507': 'Eve Single S-line, 1 phase, tethered',
  'NG910-60523': 'Eve Single S-line, 3 phase',
  'NG910-60525': 'Eve Single S-line, 3 phase, shutters',
  'NG910-60527': 'Eve Single S-line, 3 phase, tethered',
  'NG910-60553': 'Eve Single S-line, 1 phase, RFID',
  'NG910-60555': 'Eve Single S-line, 3 phase, RFID, shutters',
  'NG910-60557': 'Eve Single S-line, 3 phase, RFID, tethered',
  'NG910-60573': 'Eve Single S-line, 3 phase, GPRS',
  'NG910-60575': 'Eve Single S-line, 3 phase, GPRS, shutters',
  'NG910-60577': 'Eve Single S-line, 3 phase, GPRS, tethered',
  'NG910-60583': 'Eve Single S-line, 3 phase, RFID',
  'NG910-60585': 'Eve Single S-line, 3 phase, RFID, shutters',
  'NG910-60587': 'Eve Single S-line, 3 phase, RFID, tethered',
  'NG910-60593': 'Eve Single S-line, 3 phase, GPRS',
  'NG910-60595': 'Eve Single S-line, 3 phase, GPRS, shutters',
  'NG910-60597': 'Eve Single S-line, 3 phase, GPRS, tethered',
  'NG920-61001': 'Eve Double Pro-line, 3 phase',
  'NG920-61002': 'Eve Double Pro-line, 3 phase, dual feeder',
  'NG920-61011': 'Eve Double Pro-line, 1 phase',
  'NG920-61012': 'Eve Double Pro-line, 1 phase, 2x32 A',
  'NG920-61021': 'Eve Double Pro-line, 3 phase, 1x32 A',
  'NG920-61022': 'Eve Double Pro-line, 3 phase, 2x32 A',
  'NG920-61031': 'Eve Double Pro-line, 1 phase, 1x32 A',
  'NG920-61032': 'Eve Double Pro-line, 2 phase, 1x32 A',
  'NG920-61101': 'Eve Double Pro-line DE, 3 phase, 1x32 A',
  'NG920-61102': 'Eve Double Pro-line DE, 3 phase, 2x32 A',
  'NG920-61205': 'Eve Double Pro-line FR, 3 phase, 1x32 A',
  'NG920-61206': 'Eve Double Pro-line FR, 3 phase, 2x32 A',
  'NG920-61215': 'Eve Double Pro-line FR, 1 phase, 1x32 A',
  'NG920-61216': 'Eve Double Pro-line FR, 1 phase, 2x32 A',
};

/** Feature roles (the last part of the feature external ids): frozen. */
export const FEATURES = {
  STATUS: 'status',
  STATUS_CODE: 'status-code',
  CONNECTOR: 'connector-status',
  CHARGING_STATE: 'charging-state',
  PLUGGED: 'plugged',
  PAUSED: 'charge-paused',
  POWER: 'power',
  CURRENT_L1: 'current-l1',
  CURRENT_L2: 'current-l2',
  CURRENT_L3: 'current-l3',
  VOLTAGE_L1: 'voltage-l1',
  VOLTAGE_L2: 'voltage-l2',
  VOLTAGE_L3: 'voltage-l3',
  STATION_MAX: 'station-max-current',
  CURRENT_SET: 'current-set',
  ENERGY_INDEX: 'energy-index',
  TEMPERATURE: 'temperature',
  ERROR: 'error',
  PAUSE: 'pause-charge',
  RESUME: 'resume-charge',
  SET_CURRENT: 'set-current',
};

export const ACTIONS = {
  TEST_CONNECTION: 'test_connection',
  ACCEPT_HELD: 'accept_held_index',
  TRUST_CERTIFICATE: 'trust_certificate',
};

/** The value a `button/push` feature sends (BUTTON_PUSH.PRESSED of the core). */
export const PRESSED = 1;

/**
 * The poll interval of the configuration, in seconds. Every poll is a login
 * on the charger, which takes one session at a time: 60 s by default.
 */
export const POLL_INTERVAL = {
  min: 30,
  max: 3600,
  default: 60,
};

/**
 * The guard of the energy index (src/guard.js): a socket of an Alfen Eve
 * delivers 22 kW at most (32 A on three phases); 25 kW on average since the
 * last value is already implausible. 0.5 kWh always allowed on top.
 */
export const GUARD_LIMITS = { maxKw: 25, slackKwh: 0.5 };

export const LIMITS = {
  /** Gladys: 300 states per minute. */
  statesPerMinute: 300,
  statesPerRequest: 100,
  /** One answer (a page of properties is a few KB). */
  responseBytes: 64 * 1024,
  /** The status line and the headers of an answer. */
  headerBytes: 8 * 1024,
  /** Pages of one category, and properties of one page, at most. */
  pages: 10,
  propsPerPage: 500,
  /** Longest text kept from an answer (model, firmware). */
  textLength: 60,
  /** User name and password: printable ASCII, bounded. */
  secretMin: 1,
  secretMax: 256,
  /** Index guards kept in /data at most (one per index feature). */
  indexStates: 8,
};

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;

export const TIMINGS = {
  /** One request of the polling (TLS handshake included for the first one). */
  readTimeout: 8 * SECOND,
  /** The logout at the end of a session: never waited for longer. */
  logoutTimeout: SECOND,
  /** Failed reads: 30 s, 1, 2, then 5 minutes, never shorter than the interval. */
  backoff: [30 * SECOND, MINUTE, 2 * MINUTE, 5 * MINUTE],
  /** 429: Retry-After bounded to 1 min .. 6 h, 5 min without. A 5xx pauses as a failed read. */
  rateLimitMin: MINUTE,
  rateLimitMax: 6 * HOUR,
  rateLimitDefault: 5 * MINUTE,
  /** Credentials refused: new tries 15 min, 1 h, then every 6 h (kept in /data). */
  authBackoff: [15 * MINUTE, HOUR, 6 * HOUR],
  /** During a block, a pause tries a login at most this often (a refused password never loops). */
  blockedPauseSpacing: 5 * MINUTE,
  /** The time of the last read is written to /data at most this often. */
  lastReadSave: MINUTE,
  /** The publisher sends what is pending every second; unchanged states again every 30 min. */
  flushInterval: SECOND,
  stateHeartbeat: 30 * MINUTE,
  /** "Accept the held index": the second click within this time takes what the first listed. */
  acceptConfirm: MINUTE,
  /**
   * Commands (Gladys waits 5 s for the ack): the command must leave by 3.5 s
   * after the click (connection, login and fresh read included), or it is
   * refused unsent; the answer is awaited until 4.3 s, after which the
   * command is "sent, without confirmation".
   */
  commandSendBy: 3_500,
  commandAnswerBy: 4_300,
  /** Time left to send after the fresh read, at least. */
  commandMinSend: 300,
  /** Reads after a command, spaced: its effect, then a check. */
  followUps: [5 * SECOND, 20 * SECOND],
  /** A sent command keeps its guard until the charger shows what it asked, or 90 s. */
  guard: 90 * SECOND,
  /** A pause reaffirmed at most this often while its guard holds (a late resume landing after it). */
  pauseReasserts: 2,
  /** One resume or current change a minute; a pause is never limited. */
  changeMinInterval: MINUTE,
  /** A session given up for a pause: waited for at most this long to close. */
  preemptWait: 500,
};
