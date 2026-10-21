// -----------------------------------------------------------------------------
// The integration: the Alfen charger typed in the configuration (one address,
// its password), one short session on it every poll interval, its Gladys
// device and states, the guard of its energy index, the transport badge, the
// "Test the connection", "Accept the held index" and "Trust the new
// certificate" buttons, and the three commands (pause, resume, charging
// current). index.js only wires the SDK handlers to it.
//
// The charger takes ONE session at a time: the integration never opens two.
// A poll, a command or a pause each open their own short session (connect,
// certificate checked against the pin, identity, login, work, logout, close);
// a command takes the charger from a poll under way, a pause takes it from
// anything (the session given up is closed at once, its read never applied).
//
// Commands follow the rules learnt on the previous modules (the approved
// gladys-peblar 0.1.2, gladys-nrgkick and gladys-openevse):
//   - "Pause charging" is protective: it needs no option and is never held
//     back: not by a command in flight (it takes the charger at once), not by
//     the minute between two changes, not by a 429/5xx pause (one session),
//     not by refused credentials (one login at most every 5 minutes: a
//     refused password never loops), not by a failed read (it needs none),
//     not before the first read after a restart (the identity is kept in
//     /data). A pause sent while a resume may still land is sent again if a
//     read shows the charge resumed, twice at most, also when a resend fails;
//   - "Resume charging" and the charging current stay behind an option (off
//     by default), checked on arrival and again right before sending; they
//     are decided on a fresh read in the same session, never on the state
//     kept in memory, and refused when a value they need is missing; one of
//     them a minute; capped by the configured ceiling and the maximum station
//     current read on the charger;
//   - the identity of the charger is read again in every session (another
//     charger at the address refuses a command; an unreadable identity is not
//     another charger: the pinned certificate still vouches for it);
//   - sent within 3.5 s of the click (connection, login and read included) or
//     refused unsent; answered by 4.3 s; checked again right before the bytes
//     go (the deadline included, after a slow shared connection);
//   - a command that may have reached the charger (silence, a 5xx) is never
//     answered "not sent": "sent, without confirmation", then spaced reads;
//     a command is confirmed only by a read showing the value asked;
//   - the ack never waits for a publication to Gladys;
//   - a read that began before the last command was sent may show the state
//     before it: quarantined, never applied nor published.
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import {
  AlfenClient,
  errorReason,
  parseControl,
  parseMeter,
  parseStatus,
  parseTemperature,
} from './alfen/client.js';
import { ChargerError, ERROR_KINDS, notSent } from './alfen/http.js';
import { addressKey, credentialsKey, normalizeConfig, targetKey } from './config.js';
import {
  CATEGORIES,
  CURRENT,
  FEATURES,
  GUARD_LIMITS,
  LIMITS,
  PLUGGED_STATES,
  PRESSED,
  PROPS,
  SECOND,
  STATE,
  TIMINGS,
} from './constants.js';
import {
  COMMAND_ROLES,
  buildDevice,
  chargerIds,
  deviceName,
  deviceStates,
  parseDeviceId,
  parseFeatureId,
  statusText,
} from './devices.js';
import { IndexGuard } from './guard.js';
import { ERRORS, STATE_NAMES, T, age, summaryOf, word } from './i18n.js';
import { StatePublisher } from './publisher.js';
import { fileStore, normalizeMemory } from './store.js';

const both = (en, fr) => ({ en, fr });
const join = (a, b) => both(`${a.en} ${b.en}`, `${a.fr} ${b.fr}`);
const round3 = (value) => Math.round(value * 1000) / 1000;

/** The key of a value held back: what it is, not where it is now (`to` moves). */
export const holdKey = (held) =>
  held.direction === 'down' ? `down:${held.from}` : `up:${held.from}:${held.threshold}`;

/** The last value Gladys holds for a feature (`{ value, at }`), from its devices. */
function lastValueOf(devices, featureId) {
  for (const device of devices ?? []) {
    const feature = (device?.features ?? []).find((f) => f.external_id === featureId);
    if (feature) {
      const value = Number(feature.last_value);
      const at = Date.parse(feature.last_value_changed ?? '');
      return feature.last_value !== null &&
        feature.last_value !== undefined &&
        Number.isFinite(value) &&
        Number.isFinite(at)
        ? { value, at }
        : undefined;
    }
  }
  return undefined;
}

const freshCharger = () => ({
  serial: undefined,
  modelId: undefined,
  model: undefined,
  firmware: undefined,
  control: undefined,
  status: undefined,
  meter: undefined,
  temperature: undefined,
  /** The energy index the guard lets through (undefined: none to publish). */
  index: undefined,
  online: undefined,
  failures: 0,
  wait: undefined,
  error: undefined,
  timer: undefined,
  running: undefined,
  followUps: new Set(),
  /** When the last request that writes left, resends included (a read begun before it is quarantined). */
  lastSentAt: -Infinity,
  /** When the last resume left: only a resume undoes a pause. */
  lastResumeAt: -Infinity,
});

const SESSION = { POLL: 'poll', COMMAND: 'command', PAUSE: 'pause' };

export class AlfenApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'alfen' }),
    connect,
    now = Date.now,
    timers = globalThis,
    store = fileStore(),
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    this.timers = timers;
    this.store = store;
    this.client = new AlfenClient({ ...(connect ? { connect } : {}), now });
    this.publisher = new StatePublisher({ gladys, logger, now, timers });
    this.config = normalizeConfig();
    this.memory = normalizeMemory(null, now());
    this.loaded = false;
    this.charger = freshCharger();
    this.generation = 0;
    this.started = false;
    this.lastStatus = undefined;
    this.published = undefined;
    this.badge = undefined;
    /** The exact start of the last read (/data keeps it at most once a minute). */
    this.lastReadAt = -Infinity;
    /** The session open on the charger: { kind, connection, aborted, done }. */
    this.session = undefined;
    /** The command in flight: { role, sentAt, overtaken, promise, settled }. */
    this.inFlight = undefined;
    /** `${serial}:pause` / `${serial}:current` -> a command sent, not seen yet. */
    this.guards = new Map();
    /** featureId -> IndexGuard (the energy index of a created device). */
    this.indexGuards = new Map();
    /** The first click of "Accept the held index": { fingerprint, at, listed }. */
    this.pendingAccept = undefined;
    /** The hold last logged (a hold is logged once). */
    this.loggedHold = undefined;
    this.savedMemory = undefined;
  }

  // --- Lifecycle -------------------------------------------------------------

  async start(raw = {}) {
    this.stop();
    await this.charger.running?.catch(() => {});
    this.config = normalizeConfig(raw);
    if (!this.loaded) {
      // Once per process: a new read of the file could be older than the memory.
      this.memory = normalizeMemory(await this.store.load().catch(() => null), this.now());
      this.loaded = true;
      // Written at most once a minute: the last read may be up to a minute
      // later than the file says (never later than now).
      if (this.memory.last) {
        this.lastReadAt = Math.min(this.now(), this.memory.last.at + TIMINGS.lastReadSave);
      }
    } else {
      this.memory = normalizeMemory(this.memory, this.now());
    }
    this.savedMemory = undefined;
    const target = targetKey(this.config) ?? null;
    if (target && this.memory.target !== target) {
      // Another address: its identity, its certificate and its reads are new.
      Object.assign(this.memory, {
        target,
        serial: null,
        pin: null,
        refusedPin: null,
        last: null,
        resumeCurrent: null,
      });
      this.lastReadAt = -Infinity;
    }
    await this.saveMemory();
    // The last resume survives a restart (new credentials or address).
    const previous = this.charger;
    this.charger = { ...freshCharger(), lastResumeAt: previous.lastResumeAt };
    this.indexGuards.clear();
    this.pendingAccept = undefined;
    this.published = undefined;
    this.badge = undefined;
    this.lastStatus = undefined;
    this.publisher.start();
    if (!this.readable) {
      // The devices already created are shown unreachable.
      await this.publishAll();
      return;
    }
    await this.setStatus(false, this.status()[1]);
    await this.tick();
  }

  /** An address and a password: the charger can be read. */
  get readable() {
    const c = this.config;
    return Boolean(c.address && c.auth && !c.badSecret && !c.credentialsInHost);
  }

  stop() {
    this.generation += 1;
    this.clearTimer();
    this.clearFollowUps();
    // A session of the old configuration is given up: it would be refused by
    // its checks anyway (generation), and it must not hold the charger.
    if (this.session) {
      this.abortSession(this.session);
    }
    this.publisher.stop();
  }

  clearTimer() {
    if (this.charger.timer) {
      this.timers.clearTimeout(this.charger.timer);
      this.charger.timer = undefined;
    }
  }

  clearFollowUps() {
    for (const handle of this.charger.followUps) {
      this.timers.clearTimeout(handle);
    }
    this.charger.followUps.clear();
  }

  /**
   * Connected to Gladys. The first time, start; after a reconnection (Gladys
   * restarted), resend what Gladys keeps in memory only (status, Discovery
   * list, badge) and the last states. Pauses, blocks, pins and guards stay;
   * a read under way is not started again, and none is started sooner than
   * the interval.
   */
  async connected(raw = {}) {
    if (!this.started) {
      this.started = true;
      await this.start(raw);
      return;
    }
    await this.onNewCredentials(raw);
    if (this.needsRestart(raw)) {
      await this.start(raw);
      return;
    }
    const previous = this.config;
    this.config = normalizeConfig(raw);
    this.published = undefined;
    this.badge = undefined;
    this.lastStatus = undefined;
    this.gladys.forgetPublishedStates?.();
    this.rescheduleOnNewInterval(previous);
    await this.publishAll();
  }

  /** Only a new address or new credentials restart (an interval only reschedules). */
  needsRestart(raw) {
    const next = normalizeConfig(raw);
    const c = this.config;
    return (
      JSON.stringify(next.address ?? null) !== JSON.stringify(c.address ?? null) ||
      next.invalidHost !== c.invalidHost ||
      next.credentialsInHost !== c.credentialsInHost ||
      next.badSecret !== c.badSecret ||
      credentialsKey(next) !== credentialsKey(c)
    );
  }

  /** New credentials saved lift a block and are tried at once (a choice of the user). */
  async onNewCredentials(raw) {
    if (credentialsKey(normalizeConfig(raw)) === credentialsKey(this.config)) {
      return;
    }
    // First, before any wait: a late answer to the old credentials (a read, a
    // command) belongs to the old generation and never blocks the new ones.
    this.stop();
    this.memory.block = null;
    this.memory.last = null;
    this.lastReadAt = -Infinity;
    await this.saveMemory();
  }

  /** A new interval: the next read follows it, without a restart. */
  rescheduleOnNewInterval(previous) {
    const c = this.charger;
    if (
      this.config.pollInterval !== previous.pollInterval &&
      this.readable &&
      !c.running &&
      c.online !== false
    ) {
      this.schedule();
    }
  }

  /**
   * New address or credentials restart (new credentials lift a block at
   * once); the interval, the option, the ceiling and the language apply at
   * once. A configuration saved unchanged reads nothing.
   */
  async configUpdated(raw = {}) {
    await this.onNewCredentials(raw);
    if (this.needsRestart(raw)) {
      await this.start(raw);
      return;
    }
    const previous = this.config;
    this.config = normalizeConfig(raw);
    this.rescheduleOnNewInterval(previous);
    if (this.config.allowCommands !== previous.allowCommands) {
      this.logger.info(
        `Alfen resume and current ${this.config.allowCommands ? 'allowed' : 'disabled'}`,
      );
    }
    if (
      this.config.language !== previous.language ||
      this.config.maxCurrent !== previous.maxCurrent ||
      this.config.allowCommands !== previous.allowCommands
    ) {
      await this.publishAll();
    }
  }

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) {
      return;
    }
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  /** Writes /data when something changed (never the secret). */
  async saveMemory() {
    const json = JSON.stringify(this.memory);
    if (json === this.savedMemory) {
      return true;
    }
    try {
      await this.store.save(this.memory);
      this.savedMemory = json;
      return true;
    } catch (err) {
      this.logger.warn(`Saving the state to /data failed: ${err?.code ?? 'error'}`);
      return false;
    }
  }

  // --- Credentials and certificate --------------------------------------------

  get blocked() {
    return Boolean(this.memory.block) && this.now() < this.memory.block.until;
  }

  /** Credentials refused: the tries are spaced (15 min, 1 h, 6 h), kept in /data. */
  async authFailed() {
    const failures = (this.memory.block?.failures ?? 0) + 1;
    const wait = TIMINGS.authBackoff[Math.min(failures - 1, TIMINGS.authBackoff.length - 1)];
    this.memory.block = { until: this.now() + wait, failures, refusedAt: this.now() };
    await this.saveMemory();
    this.logger.warn(`Alfen: credentials refused; next try in ${Math.round(wait / 60000)} min`);
  }

  /**
   * The certificate of a new connection, checked BEFORE anything is written:
   * the pin of the address, or, at the first connection, pinned now (kept in
   * /data before the password leaves). Another one is refused, and kept for
   * "Trust the new certificate".
   */
  async trust(fingerprint, { target, generation }) {
    const stale = () =>
      new ChargerError(ERROR_KINDS.STALE, 'The configuration changed', { notSent: true });
    // A session of another address or configuration pins nothing and sends nothing.
    if (generation !== this.generation || this.memory.target !== target) {
      throw stale();
    }
    const pin = this.memory.pin;
    if (pin && pin !== fingerprint) {
      if (this.memory.refusedPin !== fingerprint) {
        this.memory.refusedPin = fingerprint;
        this.logger.warn('Alfen: the certificate of the charger changed, nothing sent to it');
        await this.saveMemory();
      }
      throw new ChargerError(ERROR_KINDS.CERTIFICATE, 'The certificate changed', {
        notSent: true,
        fingerprint,
      });
    }
    if (this.memory.refusedPin) {
      // The pinned certificate is back: nothing to trust any more.
      this.memory.refusedPin = null;
      this.pendingTrust = undefined;
    }
    if (!pin) {
      this.memory.pin = fingerprint;
      // The first pin must be in /data before the password leaves: otherwise
      // a restart would trust whatever answers next.
      if (!(await this.saveMemory())) {
        if (this.memory.pin === fingerprint) this.memory.pin = null;
        throw new ChargerError(ERROR_KINDS.STORAGE, '/data not writable', { notSent: true });
      }
      this.logger.info('Alfen: certificate of the charger pinned (first connection)');
    } else {
      await this.saveMemory();
    }
    if (generation !== this.generation || this.memory.target !== target) {
      throw stale();
    }
  }

  /**
   * A login accepted by the charger, whatever the session: the credentials
   * work, so a block is lifted (a pause during a block that went through)
   * and the reads go on at the interval. Only for the credentials of now.
   */
  async loggedIn(generation, credentials, entry) {
    entry.loggedIn = true;
    if (generation !== this.generation || credentials !== credentialsKey(this.config)) {
      return;
    }
    if (this.memory.block) {
      this.memory.block = null;
      await this.saveMemory();
      this.logger.info('Alfen: credentials accepted, block lifted');
      if (!this.charger.running && this.readable) {
        this.schedule();
      }
    }
  }

  /**
   * The identity read in a session. A command refuses another charger
   * (nothing written). An identity that could not be read is not another
   * charger: the session goes on when one is known (the pin matched).
   */
  identify(kind, info, error, serial) {
    const known = serial ?? this.charger.serial ?? this.memory.serial ?? undefined;
    if (info?.serial) {
      if (kind !== SESSION.POLL && known && info.serial !== known) {
        throw new ChargerError(ERROR_KINDS.OTHER_CHARGER, 'Another charger', { notSent: true });
      }
      return;
    }
    if (!known) {
      throw error ?? new ChargerError(ERROR_KINDS.PROTOCOL, 'No identity', { notSent: true });
    }
  }

  // --- Sessions ----------------------------------------------------------------

  /** Gives a session up: its connection closed at once (a request under way fails, ABORTED). */
  abortSession(session) {
    session.aborted = true;
    session.connection?.close();
  }

  /**
   * Takes the charger for a new session. A pause takes it from anything, a
   * command from a poll; otherwise the session under way is waited for,
   * until `by` (then refused: one session at a time on the charger).
   */
  async takeCharger(kind, by) {
    const current = this.session;
    if (!current) {
      return;
    }
    const preempt =
      kind === SESSION.PAUSE || (kind === SESSION.COMMAND && current.kind === SESSION.POLL);
    if (preempt) {
      this.abortSession(current);
    }
    const limit = preempt ? TIMINGS.preemptWait : Math.max(0, by - this.now());
    let timer;
    await Promise.race([
      current.done,
      new Promise((resolve) => {
        timer = this.timers.setTimeout(resolve, limit);
      }),
    ]);
    this.timers.clearTimeout(timer);
    if (this.busy && !preempt) {
      throw this.refusal(ERRORS.stillRunning);
    }
  }

  /**
   * A session holds the charger. One given up does not: its connection is
   * closed (the charger authenticates the connection), or it never logged in.
   */
  get busy() {
    return Boolean(this.session) && !this.session.aborted;
  }

  /** Takes the charger, again after every wait (another session may have started meanwhile). */
  async acquire(kind, by) {
    for (let i = 0; i < 3; i += 1) {
      await this.takeCharger(kind, by);
      if (!this.busy) {
        return;
      }
    }
    throw this.refusal(ERRORS.stillRunning);
  }

  /**
   * One session on the charger (see AlfenClient.session), held in
   * `this.session`. The address, the credentials, the target of the pin and
   * the generation are those of now, fixed for the whole session. Never
   * while another one holds the charger.
   */
  async openSession(
    kind,
    work,
    { deadline, serial, generation = this.generation, logoutTimeout = TIMINGS.logoutTimeout },
  ) {
    if (this.busy) {
      throw this.refusal(ERRORS.stillRunning);
    }
    if (generation !== this.generation) {
      throw new ChargerError(ERROR_KINDS.STALE, 'The configuration changed', { notSent: true });
    }
    let release;
    const entry = {
      kind,
      connection: undefined,
      aborted: false,
      loggedIn: false,
      done: new Promise((resolve) => {
        release = resolve;
      }),
    };
    this.session = entry;
    const target = targetKey(this.config) ?? null;
    const credentials = credentialsKey(this.config);
    try {
      return await this.client.session(
        {
          address: this.config.address,
          auth: this.config.auth,
          deadline,
          requestTimeout: TIMINGS.readTimeout,
          logoutTimeout,
          trust: (fingerprint) => this.trust(fingerprint, { target, generation }),
          identify: (info, error) => this.identify(kind, info, error, serial),
          onLogin: () => this.loggedIn(generation, credentials, entry),
          onOpen: (connection) => {
            entry.connection = connection;
            if (entry.aborted) {
              connection.close();
            }
          },
        },
        (api, info) => {
          if (entry.aborted) {
            throw new ChargerError(ERROR_KINDS.ABORTED, 'Session given up', { notSent: true });
          }
          return work(api, info, entry);
        },
      );
    } finally {
      if (this.session === entry) {
        this.session = undefined;
      }
      release();
    }
  }

  // --- Polling ---------------------------------------------------------------

  get interval() {
    return this.config.pollInterval * SECOND;
  }

  get paused() {
    return Boolean(this.memory.pause) && this.now() < this.memory.pause.until;
  }

  /** No read before the last one + the interval (restarts, clicks, reconnections included). */
  get due() {
    return this.lastReadAt + this.interval;
  }

  /** The start of a read: kept in /data at most once a minute (an SD card is not written at every poll). */
  async markRead() {
    this.lastReadAt = this.now();
    const saved = this.memory.last?.at ?? -Infinity;
    if (this.now() - saved >= TIMINGS.lastReadSave) {
      this.memory.last = { at: this.now() };
      await this.saveMemory();
    }
  }

  /**
   * The next read: after a pause or a block (never sooner than the interval),
   * after its backoff, else the interval, never before it is due.
   */
  schedule(delay) {
    const c = this.charger;
    this.clearTimer();
    let wait;
    if (this.paused) {
      wait = Math.max(this.memory.pause.until - this.now(), this.interval);
    } else if (this.blocked) {
      wait = Math.max(this.memory.block.until - this.now(), this.interval);
    } else {
      wait = delay ?? (c.online === false ? c.wait : this.interval);
    }
    wait = Math.max(wait ?? this.interval, this.due - this.now());
    const generation = this.generation;
    c.timer = this.timers.setTimeout(
      () => {
        c.timer = undefined;
        if (generation === this.generation) {
          this.tick().catch(() => this.logger.error('Alfen refresh failed'));
        }
      },
      Math.max(0, wait),
    );
  }

  /** One read at a time: a tick during a read joins it. */
  tick({ followUp = false } = {}) {
    const c = this.charger;
    if (!c.running) {
      c.running = this.run({ followUp }).finally(() => {
        c.running = undefined;
      });
    }
    return c.running;
  }

  async run({ followUp = false } = {}) {
    const generation = this.generation;
    const c = this.charger;
    if (!this.readable || this.paused || this.blocked) {
      // Not read: the devices created are shown offline (never left "charging").
      await this.publishAll();
      if (this.readable) this.schedule();
      return;
    }
    // Never sooner than the interval after the last read, whatever restarted
    // or clicked; only the two reads after a command go sooner.
    if ((!followUp && this.now() < this.due) || this.busy) {
      // A session under way (a command) holds the charger: this read waits.
      await this.publishAll();
      this.schedule(this.busy ? this.interval : this.due - this.now());
      return;
    }
    let delay;
    await this.markRead();
    if (generation !== this.generation) {
      return;
    }
    if (this.busy) {
      // A command or a pause took the charger while /data was written: this read waits.
      await this.publishAll();
      this.schedule(this.interval);
      return;
    }
    try {
      const startedAt = this.now();
      const read = await this.openSession(
        SESSION.POLL,
        (api, info, entry) => this.readAll(api, info, entry, generation),
        { deadline: this.now() + 6 * TIMINGS.readTimeout, generation },
      );
      if (generation !== this.generation) {
        return;
      }
      if (startedAt <= c.lastSentAt) {
        // Begun before a command left: it may show the state before it.
        this.logger.debug('Alfen: read begun before a command, not applied');
      } else {
        this.applyRead(read);
        if (this.memory.block) {
          this.memory.block = null;
        }
        await this.saveMemory();
        await this.evaluateIndex();
      }
    } catch (err) {
      if (generation !== this.generation) {
        return;
      }
      if (err.kind === ERROR_KINDS.ABORTED) {
        // A command took the charger: this read is dropped, never applied.
        this.logger.debug('Alfen: read given up for a command');
      } else {
        delay = await this.failed(err);
      }
    }
    await this.publishAll();
    if (generation === this.generation) {
      this.schedule(delay);
    }
  }

  /** Control, states and meter of socket 1, then the temperature (secondary). */
  async readAll(api, info, entry, generation) {
    const step = async (category) => {
      const values = await api.props(category);
      if (generation !== this.generation || entry.aborted) {
        throw new ChargerError(ERROR_KINDS.ABORTED, 'Session given up');
      }
      return values;
    };
    const control = parseControl(await step(CATEGORIES.GENERIC));
    const status = parseStatus(await step(CATEGORIES.STATES));
    const meter = parseMeter(await step(CATEGORIES.METER));
    let temperature;
    try {
      temperature = parseTemperature(await step(CATEGORIES.TEMP));
    } catch (err) {
      // A secondary value: an error answer never stops the main data.
      if (err.kind !== ERROR_KINDS.HTTP && err.kind !== ERROR_KINDS.PROTOCOL) {
        throw err;
      }
    }
    return { info, control, status, meter, temperature };
  }

  /** A read answered: the charger as read, and the guards it may lift. */
  applyRead({ info, control, status, meter, temperature }) {
    const c = this.charger;
    c.online = true;
    c.failures = 0;
    c.wait = undefined;
    const serial = info?.serial ?? c.serial ?? this.memory.serial ?? undefined;
    if (!serial) {
      c.error = 'no_id';
      return;
    }
    c.error = undefined;
    if (c.serial && c.serial !== serial) {
      // Another charger answers at this address: the old device is no longer read.
      this.logger.warn('Alfen: another charger answers at this address');
      Object.assign(c, {
        index: undefined,
        modelId: undefined,
        model: undefined,
        firmware: undefined,
      });
      this.memory.resumeCurrent = null;
    }
    c.serial = serial;
    // The identity read last at this address, kept in /data: a pause sent
    // before the first read after a restart goes only to this device.
    this.memory.serial = serial;
    c.modelId = info?.modelId ?? c.modelId;
    c.model = info?.model ?? c.model;
    c.firmware = info?.firmware ?? c.firmware;
    c.status = status;
    c.meter = meter;
    c.temperature = temperature;
    this.applyControl(control);
  }

  /** fromCommand: the fresh read of a command (never reaffirms a pause: it would race it). */
  applyControl(control, { fromCommand = false } = {}) {
    const c = this.charger;
    // The station current a resume writes back is kept at the pause only
    // (keepResumeCurrent), never by a read: a read during a pause shows 0.
    c.control = control;
    if (c.serial) {
      this.observe(c.serial, control, { fromCommand });
    }
  }

  /** A failed read: the delay before the next one. */
  async failed(err) {
    const c = this.charger;
    const reason = errorReason(err);
    c.online = false;
    if (err.kind === ERROR_KINDS.CERTIFICATE) {
      // Nothing sent; the handshake is tried again at the interval (the pinned one may come back).
      c.error = ERROR_KINDS.CERTIFICATE;
      c.wait = this.interval;
      return c.wait;
    }
    if (err.kind === ERROR_KINDS.AUTH) {
      c.error = ERROR_KINDS.AUTH;
      await this.authFailed();
      return undefined;
    }
    if (err.kind === ERROR_KINDS.RATE_LIMITED) {
      // The charger answers: it stays online, the status shows the 429 pause.
      c.online = true;
      await this.pause(err);
      this.logger.warn(`Alfen: ${reason}, pause`);
      return undefined;
    }
    // Never read again sooner than the interval.
    const wait = Math.max(
      this.interval,
      TIMINGS.backoff[Math.min(c.failures, TIMINGS.backoff.length - 1)],
    );
    c.failures += 1;
    c.wait = wait;
    c.error = err.kind === ERROR_KINDS.SESSION ? ERROR_KINDS.SESSION : reason;
    if (err.kind === ERROR_KINDS.HTTP && err.status >= 500) {
      // A 5xx: a pause of the same length, kept in /data.
      this.memory.pause = {
        until: Math.max(this.memory.pause?.until ?? 0, this.now() + wait),
        reason: '5xx',
      };
      await this.saveMemory();
    }
    this.logger.warn(`Alfen: ${reason}; next try in ${Math.round(wait / 1000)} s`);
    return wait;
  }

  /** A 429: every path waits but a pause (polling, button, commands), kept in /data. */
  async pause(err) {
    const wait = Math.min(
      TIMINGS.rateLimitMax,
      Math.max(TIMINGS.rateLimitMin, err.retryAfter ?? TIMINGS.rateLimitDefault),
    );
    this.memory.pause = {
      until: Math.max(this.memory.pause?.until ?? 0, this.now() + wait),
      reason: '429',
    };
    await this.saveMemory();
  }

  pauseMessage() {
    if (!this.paused) {
      return undefined;
    }
    const wait = age(this.memory.pause.until - this.now());
    return this.memory.pause.reason === '5xx' ? T.serverError(wait) : T.rateLimited(wait);
  }

  /** The station current of the charger (its installation limit), as last read. */
  stationOf(control = this.charger.control) {
    if (control?.stationMax !== undefined && control.stationMax >= CURRENT.min) {
      return control.stationMax;
    }
    return this.memory.resumeCurrent ?? undefined;
  }

  /** The highest current the commands accept now. */
  ceilingOf(control) {
    return Math.max(
      CURRENT.min,
      Math.floor(Math.min(this.config.maxCurrent, this.stationOf(control) ?? Infinity)),
    );
  }

  get ceiling() {
    return this.ceilingOf(this.charger.control);
  }

  summary() {
    const c = this.charger;
    return summaryOf(
      {
        name: deviceName(c),
        power: c.meter?.power === undefined ? undefined : Math.round(c.meter.power),
        current:
          c.control?.currentSet === undefined
            ? undefined
            : Math.round(c.control.currentSet * 10) / 10,
      },
      statusText(c.status?.state, c.control?.paused),
    );
  }

  /** `[connected, message, plain]`; `plain`: the summary without "Connected". */
  status() {
    const c = this.charger;
    const config = this.config;
    if (config.credentialsInHost) {
      return [false, T.credentialsInHost];
    }
    if (!config.address) {
      return [false, config.invalidHost ? T.invalidHost(config.invalidHost) : T.noHost];
    }
    if (config.badSecret) {
      return [false, T.badSecret];
    }
    if (!config.auth) {
      return [false, T.noPassword];
    }
    const pause = this.pauseMessage();
    if (pause) {
      return [false, pause];
    }
    if (this.blocked) {
      return [false, T.authRefused(age(this.memory.block.until - this.now()))];
    }
    if (c.online === false) {
      const wait = age(c.wait ?? this.interval);
      if (c.error === ERROR_KINDS.CERTIFICATE) {
        return [false, T.certificateChanged(this.memory.refusedPin)];
      }
      if (c.error === ERROR_KINDS.SESSION) {
        return [false, T.sessionLost(wait)];
      }
      if (c.error === ERROR_KINDS.STORAGE) {
        return [false, T.storage];
      }
      return [
        false,
        c.error === ERROR_KINDS.UNREACHABLE || c.error === ERROR_KINDS.TIMEOUT
          ? T.unreachable(addressKey(config.address), wait)
          : T.failing(c.error ?? 'error', wait),
      ];
    }
    if (c.online === undefined) {
      return [false, T.connecting];
    }
    if (c.error === 'no_id' || !c.serial) {
      return [false, T.noId];
    }
    let summary = this.summary();
    if (c.control?.paused === true) {
      // The value to set back (from Gladys, or in the Alfen app with resuming off).
      summary = join(
        summary,
        this.memory.resumeCurrent ? T.pausedKept(this.memory.resumeCurrent) : T.pausedUnknown,
      );
    }
    const held = this.currentHold();
    if (held) {
      summary = join(summary, T.held(held));
    }
    return [true, T.connected(summary), summary];
  }

  /** The connection status of the configuration screen. */
  async updateStatus() {
    const [connected, message, plain] = this.status();
    // "Not read any more" only once a charger was read: before, the status
    // already says why nothing is read (no address, block, pause, no answer).
    const orphans = this.charger.serial !== undefined ? this.orphans() : [];
    if (orphans.length === 0) {
      await this.setStatus(connected, message);
      return;
    }
    const names = orphans
      .map((serial) => {
        const device = (this.gladys.devices ?? []).find(
          (d) => d.external_id === chargerIds(this.gladys, serial).device,
        );
        return typeof device?.name === 'string' && device.name !== ''
          ? `${device.name.slice(0, 60)} (${serial})`
          : serial;
      })
      .join(', ');
    // Not connected: the message never starts with "Connected".
    await this.setStatus(false, join(plain ?? message, T.otherCharger(names)));
  }

  // --- Energy index ----------------------------------------------------------

  indexFeatureId(serial = this.charger.serial) {
    return chargerIds(this.gladys, serial).feature(FEATURES.ENERGY_INDEX);
  }

  /** The guard of an index feature of a created device, from Gladys and /data. */
  guardOf(featureId) {
    if (!this.indexGuards.has(featureId)) {
      this.indexGuards.set(
        featureId,
        new IndexGuard(
          lastValueOf(this.gladys.devices, featureId),
          this.memory.indexes[featureId],
          this.now(),
          GUARD_LIMITS,
        ),
      );
    }
    return this.indexGuards.get(featureId);
  }

  /** The value held back on the index of the charger read, else undefined. */
  currentHold() {
    const c = this.known();
    return c ? this.indexGuards.get(this.indexFeatureId(c.serial))?.held : undefined;
  }

  /**
   * The meter reading through the guard, once per read: what may be
   * published (`c.index`), the guard written to /data BEFORE Gladys gets the
   * value (a crash in between never sends an index /data does not know).
   * Only once the device is created (its feature exists).
   */
  async evaluateIndex() {
    const c = this.known();
    if (!c) {
      return;
    }
    const featureId = this.indexFeatureId(c.serial);
    if (!this.createdFeatures().has(featureId)) {
      c.index = undefined;
      return;
    }
    const guard = this.guardOf(featureId);
    const total = c.meter?.totalEnergy === undefined ? undefined : round3(c.meter.totalEnergy);
    if (total === undefined) {
      // Not in this answer: the last accepted value keeps its date in Gladys.
      c.index = guard.held ? guard.last?.value : undefined;
    } else {
      const plausible = guard.accept(total, this.now());
      c.index = plausible ? total : guard.held ? guard.last?.value : undefined;
    }
    const held = guard.held;
    const key = held ? `${featureId}:${holdKey(held)}` : undefined;
    if (key && key !== this.loggedHold) {
      this.logger.warn(
        `Alfen energy index ${held.direction === 'down' ? 'drop' : 'jump'} held back: the "Accept the held index" button takes it`,
      );
    }
    this.loggedHold = key;
    const kept = Object.entries(this.memory.indexes).filter(([id]) => id !== featureId);
    this.memory.indexes = Object.fromEntries(
      [[featureId, guard.state()], ...kept].slice(0, LIMITS.indexStates),
    );
    await this.saveMemory();
  }

  // --- Gladys ----------------------------------------------------------------

  /** The charger read with a valid identity, else undefined. */
  known() {
    const c = this.charger;
    return c.serial && c.status ? c : undefined;
  }

  /**
   * The identities of the devices created in Gladys that the charger read is
   * not (another charger at this address, an address changed, or no answer
   * since the start): shown offline. Empty while a first read is still under
   * way; a pause or a block kept across a restart (no read) shows them
   * offline too.
   */
  orphans() {
    const c = this.charger;
    if (c.online === undefined && !this.blocked && !this.paused && this.readable) {
      return [];
    }
    const serials = [];
    for (const device of this.gladys.devices ?? []) {
      const serial = parseDeviceId(device?.external_id);
      if (
        serial &&
        serial !== c.serial &&
        chargerIds(this.gladys, serial).device === device.external_id
      ) {
        serials.push(serial);
      }
    }
    return serials;
  }

  async publishAll() {
    await this.publishDevices();
    this.queueStates();
    await this.flush();
    await this.publishBadge();
    await this.updateStatus();
  }

  async flush() {
    await this.publisher
      .flush()
      .catch((err) => this.logger.warn(`Sending to Gladys failed: ${err.message}`));
  }

  async publishDevices() {
    const c = this.known();
    if (!c) {
      return;
    }
    const devices = [
      buildDevice(this.gladys, c, { ceiling: this.ceiling, language: this.config.language }),
    ];
    const json = JSON.stringify(devices);
    if (json === this.published) {
      return;
    }
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      this.published = json;
    } catch (err) {
      this.logger.warn(`Publishing the discovered devices failed: ${err.message}`);
    }
  }

  createdFeatures() {
    return new Set(
      (this.gladys.devices ?? []).flatMap((d) => (d.features ?? []).map((f) => f.external_id)),
    );
  }

  queueStates(created = this.createdFeatures()) {
    const push = (serial, charger, online) => {
      const states = deviceStates(chargerIds(this.gladys, serial), charger, {
        online,
        language: this.config.language,
        ceiling: this.ceiling,
        index: charger.index,
      });
      for (const { device_feature_external_id: id, ...value } of states) {
        if (created.has(id)) {
          this.publisher.push(id, value);
        }
      }
    };
    const c = this.known();
    if (c) {
      push(c.serial, c, c.online !== false);
    }
    // A created device the charger read is not: unreachable, never left "charging".
    for (const serial of this.orphans()) {
      push(serial, {}, false);
    }
  }

  async publishBadge() {
    const created = new Set((this.gladys.devices ?? []).map((d) => d.external_id));
    const entries = [];
    const c = this.known();
    if (c && created.has(chargerIds(this.gladys, c.serial).device)) {
      const held = this.currentHold();
      entries.push({
        external_id: chargerIds(this.gladys, c.serial).device,
        transport: c.online === false ? DEVICE_TRANSPORTS.UNREACHABLE : DEVICE_TRANSPORTS.LOCAL,
        ...(held ? { degraded: true, message: T.badge.held(held) } : {}),
      });
    }
    for (const serial of this.orphans()) {
      entries.push({
        external_id: chargerIds(this.gladys, serial).device,
        transport: DEVICE_TRANSPORTS.UNREACHABLE,
      });
    }
    const json = JSON.stringify(entries);
    if (entries.length === 0 || json === this.badge) {
      return;
    }
    try {
      await this.gladys.publishTransports(entries);
      this.badge = json;
    } catch (err) {
      this.logger.warn(`Transport badge failed: ${err.message}`);
    }
  }

  /** A device was created (or updated): its index guard, then its last values at once. */
  async deviceCreated(device) {
    this.badge = undefined;
    const created = this.createdFeatures();
    for (const f of device?.features ?? []) {
      created.add(f.external_id);
    }
    await this.evaluateIndex();
    this.queueStates(created);
    await this.flush();
    await this.publishBadge();
  }

  /** A device deleted: its pending states and its index guard go (added again, a fresh guard). */
  async deviceDeleted(device) {
    this.badge = undefined;
    if (typeof device?.external_id !== 'string') {
      return;
    }
    this.publisher.forget(device.external_id);
    const prefix = `${device.external_id}:`;
    for (const id of [...this.indexGuards.keys()]) {
      if (id.startsWith(prefix)) {
        this.indexGuards.delete(id);
      }
    }
    this.memory.indexes = Object.fromEntries(
      Object.entries(this.memory.indexes).filter(([id]) => !id.startsWith(prefix)),
    );
    if (parseDeviceId(device.external_id) === this.charger.serial) {
      this.charger.index = undefined;
      this.pendingAccept = undefined;
    }
    await this.saveMemory();
  }

  /** The Discovery tab asks for a scan: the device of the last read, sent again (no read). */
  async scan() {
    this.published = undefined;
    await this.publishDevices();
  }

  // --- Configuration buttons -------------------------------------------------------

  /** Reads the charger now, if a read is due (never sooner than the interval). */
  async testConnection() {
    if (!this.readable || this.paused || this.blocked) {
      return this.status()[1];
    }
    if (this.now() < this.due || this.session) {
      const last = JSON.parse(this.lastStatus ?? '[false,null]')[1];
      const notDue = T.test.notDue(age(Math.max(SECOND, this.due - this.now())));
      return last ? join(notDue, last) : notDue;
    }
    // A read now (a read in progress is joined).
    await this.tick();
    return JSON.parse(this.lastStatus ?? '[false,null]')[1] ?? T.connecting;
  }

  /**
   * "Trust the new certificate", in two clicks: the first one shows the whole
   * fingerprint refused and pins nothing; a second one within 60 s pins
   * exactly that fingerprint, if it is still the one refused (another one
   * seen meanwhile: shown again), then reads at once (a choice of the user,
   * like new credentials). Never a certificate that was not shown.
   */
  async trustCertificate() {
    const refused = this.memory.refusedPin;
    if (!refused || !this.readable) {
      this.pendingTrust = undefined;
      return T.trust.nothing;
    }
    const pending = this.pendingTrust;
    const now = this.now();
    if (
      !pending ||
      pending.fingerprint !== refused ||
      now - pending.at > TIMINGS.acceptConfirm ||
      now < pending.at
    ) {
      this.pendingTrust = { fingerprint: refused, at: now };
      return T.trust.confirm(refused);
    }
    this.pendingTrust = undefined;
    this.memory.pin = refused;
    this.memory.refusedPin = null;
    this.memory.last = null;
    this.lastReadAt = -Infinity;
    this.charger.error = undefined;
    await this.saveMemory();
    this.logger.info('Alfen: the new certificate of the charger was trusted by the user');
    await this.charger.running?.catch(() => {});
    await this.tick();
    const last = JSON.parse(this.lastStatus ?? '[false,null]')[1];
    return last ? join(T.trust.done(refused), last) : T.trust.done(refused);
  }

  /**
   * "Accept the held index", in two clicks (like gladys-homee and
   * gladys-hubitat). The first one takes nothing: it lists the value held
   * (drop or jump, from → to, kWh). A second click within
   * TIMINGS.acceptConfirm takes exactly that, if the hold is still the same
   * (direction, from, threshold) and its value is still the one listed plus
   * what the charger may have delivered since (a jump not below it, a drop
   * not above it plus that margin); otherwise it is a first click again. A
   * save of the configuration or a reconnection never accepts anything.
   */
  async acceptHeldIndex() {
    const c = this.known();
    const featureId = c ? this.indexFeatureId(c.serial) : undefined;
    const guard = featureId ? this.indexGuards.get(featureId) : undefined;
    const held = guard?.held;
    if (!held) {
      this.pendingAccept = undefined;
      return T.accept.nothing;
    }
    const now = this.now();
    const fingerprint = `${featureId}:${holdKey(held)}`;
    const pending = this.pendingAccept;
    const asListed = () => {
      const top = pending.listed.to + guard.margin(pending.listed.at, now);
      return held.direction === 'up'
        ? held.to >= pending.listed.to && held.to <= top
        : held.to <= top;
    };
    if (
      !pending ||
      pending.fingerprint !== fingerprint ||
      now - pending.at > TIMINGS.acceptConfirm ||
      now < pending.at ||
      !asListed()
    ) {
      this.pendingAccept = { fingerprint, at: now, listed: { to: held.to, at: now } };
      return T.accept.confirm(held);
    }
    this.pendingAccept = undefined;
    const taken = guard.acceptHeld();
    this.logger.info(
      `Alfen energy index ${taken.direction === 'down' ? 'drop' : 'jump'} from ${taken.from} to ${taken.to} kWh accepted by the user`,
    );
    // The value held is the one of the last read: taken now.
    await this.evaluateIndex();
    this.badge = undefined;
    await this.publishAll();
    return T.accept.done(taken);
  }

  // --- Commands --------------------------------------------------------------------

  refusal(text) {
    return Object.assign(new Error(word(text, this.config.language)), { refusal: true });
  }

  /**
   * The value of a command, strictly: null, '', ' ', true or 1.5 are never
   * read as a number. Throws a refusal when it is not valid.
   */
  commandValue(role, value) {
    if (role === FEATURES.PAUSE || role === FEATURES.RESUME) {
      if (value === PRESSED || value === String(PRESSED)) {
        return PRESSED;
      }
      throw this.refusal(ERRORS.badButton);
    }
    const amps =
      typeof value === 'number'
        ? value
        : typeof value === 'string' && /^\s*\d{1,3}\s*$/.test(value)
          ? Number(value.trim())
          : NaN;
    if (!Number.isInteger(amps)) {
      throw this.refusal(ERRORS.badCurrent);
    }
    if (amps < CURRENT.min || amps > CURRENT.max) {
      throw this.refusal(ERRORS.outOfBounds(CURRENT.min, CURRENT.max));
    }
    return amps;
  }

  async setValue(_device, feature, value) {
    // The deadlines count from the arrival of the command, before any wait.
    const received = this.now();
    const target = parseFeatureId(feature?.external_id);
    if (!target || !COMMAND_ROLES.includes(target.role)) {
      throw this.refusal(ERRORS.readOnly);
    }
    const wanted = this.commandValue(target.role, value);
    const { role } = target;
    const isPause = role === FEATURES.PAUSE;
    if (!isPause && !this.config.allowCommands) {
      throw this.refusal(ERRORS.disabled);
    }
    if (role === FEATURES.SET_CURRENT && wanted > this.ceiling) {
      // Above the ceiling known now: refused without a session (checked again on the fresh read).
      throw this.refusal(ERRORS.outOfBounds(CURRENT.min, this.ceiling));
    }
    if (!this.readable) {
      throw this.refusal(ERRORS.noAddress);
    }
    if (!this.isTarget(target.serial, role)) {
      throw this.refusal(
        !isPause && this.charger.serial === undefined ? ERRORS.notReadYet : ERRORS.unknownCharger,
      );
    }
    const previous = this.inFlight;
    if (previous && isPause && previous.role === FEATURES.PAUSE && !previous.settled) {
      // A pause still under way: this one shares its outcome.
      return previous.promise;
    }
    // One command at a time: a busy charger refuses at once, but a pause is
    // never held back: it takes the charger from the command under way.
    if (previous && !isPause) {
      throw this.refusal(ERRORS.stillRunning);
    }
    const entry = {
      role,
      sentAt: undefined,
      overtaken: previous,
      promise: undefined,
      settled: false,
    };
    this.inFlight = entry;
    entry.promise = this.command(target, wanted, received, entry);
    try {
      return await entry.promise;
    } finally {
      entry.settled = true;
      if (this.inFlight === entry) {
        this.inFlight = undefined;
      }
    }
  }

  /**
   * Whether a command of the device `serial` goes to the charger at the
   * address. A pause also goes when no read gave an identity yet (a pause or
   * a block kept in /data across a restart, a first read under way) for the
   * device of the last identity read at this address (kept in /data):
   * pausing is never held back. Never when another charger was read at the
   * address. Without an identity in /data, any device created in Gladys.
   */
  isTarget(serial, role) {
    if (this.charger.serial !== undefined) {
      return this.charger.serial === serial;
    }
    if (role !== FEATURES.PAUSE) {
      return false;
    }
    if (this.memory.serial) {
      return this.memory.serial === serial;
    }
    return (this.gladys.devices ?? []).some(
      (d) => d.external_id === chargerIds(this.gladys, serial).device,
    );
  }

  /** The checks before sending, on the latest configuration. */
  checkBeforeSend(generation, serial, role) {
    if (generation !== this.generation || !this.isTarget(serial, role)) {
      throw this.refusal(ERRORS.unknownCharger);
    }
    if (!this.readable) {
      throw this.refusal(ERRORS.noAddress);
    }
    if (role === FEATURES.PAUSE) {
      // Refused credentials: a pause still tries, but a refused password is
      // never sent again in a loop (a scene pressing the button every minute).
      if (this.blocked) {
        const since = this.now() - this.memory.block.refusedAt;
        if (since < TIMINGS.blockedPauseSpacing) {
          throw this.refusal(ERRORS.blockedPause(age(TIMINGS.blockedPauseSpacing - since)));
        }
      }
      return;
    }
    if (!this.config.allowCommands) {
      throw this.refusal(ERRORS.disabled);
    }
    if (this.paused) {
      const wait = age(this.memory.pause.until - this.now());
      throw this.refusal(
        this.memory.pause.reason === '5xx' ? ERRORS.serverPaused(wait) : ERRORS.paused(wait),
      );
    }
    if (this.blocked) {
      throw this.refusal(ERRORS.blocked);
    }
    const since = this.now() - this.memory.lastChangeAt;
    if (since < TIMINGS.changeMinInterval) {
      throw this.refusal(ERRORS.tooOften(age(TIMINGS.changeMinInterval - since)));
    }
  }

  /** A pause arrived after `entry` started: anything but a pause gives way. */
  pauseArrived(entry) {
    return entry.role !== FEATURES.PAUSE && this.inFlight !== entry;
  }

  /**
   * What to write (`{ id, value, guardKey, expected, from }`), from the state
   * just read; undefined when already so.
   */
  plan(role, wanted, fresh, serial) {
    if (role === FEATURES.PAUSE) {
      return {
        id: PROPS.STATION_MAX,
        value: 0,
        guardKey: 'pause',
        expected: true,
        from: fresh?.control?.paused ?? this.charger.control?.paused,
      };
    }
    const control = fresh.control;
    if (role === FEATURES.RESUME) {
      const state = fresh.status.state;
      if (state === STATE.STANDBY) {
        throw this.refusal(ERRORS.noVehicle);
      }
      if (!PLUGGED_STATES.has(state)) {
        throw this.refusal(ERRORS.fault(STATE_NAMES[state] ?? STATE_NAMES[STATE.UNKNOWN]));
      }
      if (control.paused === undefined) {
        throw this.refusal(ERRORS.missing);
      }
      if (control.paused === false && !this.guardActive(serial, 'pause')) {
        return undefined;
      }
      // Exactly the station current read just before the pause (the setting
      // of the installation): never capped (the ceiling of the configuration
      // is for the current of the socket), never guessed.
      const value = this.memory.resumeCurrent;
      if (!value) {
        throw this.refusal(ERRORS.noResumeValue);
      }
      return {
        id: PROPS.STATION_MAX,
        value,
        guardKey: 'pause',
        expected: false,
        from: control.paused,
      };
    }
    if (control.currentSet === undefined) {
      throw this.refusal(ERRORS.missing);
    }
    const ceiling = this.ceilingOf(control);
    if (wanted > ceiling) {
      throw this.refusal(ERRORS.outOfBounds(CURRENT.min, ceiling));
    }
    if (
      Math.abs(control.currentSet - wanted) <= CURRENT.tolerance &&
      !this.guardActive(serial, 'current')
    ) {
      return undefined;
    }
    return {
      id: PROPS.SOCKET_MAX,
      value: wanted,
      guardKey: 'current',
      expected: wanted,
      from: control.currentSet,
    };
  }

  /** A resume not confirmed may still land on the charger. */
  get unconfirmedResume() {
    return this.now() < this.memory.unconfirmedResumeUntil;
  }

  /** A resume of Gladys may still land: in flight, overtaken, unconfirmed, or under its guard. */
  resumeMayLand(entry, serial) {
    const guard = this.guards.get(`${serial}:pause`);
    return (
      entry.overtaken?.role === FEATURES.RESUME ||
      this.inFlight?.role === FEATURES.RESUME ||
      this.unconfirmedResume ||
      (this.guardActive(serial, 'pause') && guard?.expected === false)
    );
  }

  /**
   * The station current a resume writes back, kept in /data at the pause,
   * before 0 is written: the value read just before (in the session of the
   * pause, else the last read). A value under 6 A (already paused) never
   * replaces the one kept.
   */
  async keepResumeCurrent(control) {
    const station = control?.stationMax;
    if (station !== undefined && station >= CURRENT.min) {
      this.memory.resumeCurrent = Math.min(CURRENT.station, Math.floor(station));
      await this.saveMemory();
    }
  }

  async command({ serial, role }, wanted, received, entry) {
    const generation = this.generation;
    const isPause = role === FEATURES.PAUSE;
    const sendBy = received + TIMINGS.commandSendBy;
    const answerBy = received + TIMINGS.commandAnswerBy;
    const c = this.charger;
    this.checkBeforeSend(generation, serial, role);
    await this.acquire(isPause ? SESSION.PAUSE : SESSION.COMMAND, sendBy - TIMINGS.commandMinSend);
    if (this.pauseArrived(entry)) {
      throw this.refusal(ERRORS.pauseMeanwhile);
    }
    this.checkBeforeSend(generation, serial, role);
    let plan;
    let freshControl;
    const work = (skipRead) => async (api, _info, session) => {
      const readStart = this.now();
      const given = () => generation !== this.generation || session.aborted;
      if (!isPause) {
        // The state just before acting, read in this session, never the one in memory.
        const generic = await api.props(CATEGORIES.GENERIC);
        const states = await api.props(CATEGORIES.STATES);
        if (given()) {
          throw new ChargerError(ERROR_KINDS.ABORTED, 'Session given up', { notSent: true });
        }
        const fresh = { control: parseControl(generic), status: parseStatus(states) };
        freshControl = fresh.control;
        this.applyFresh(fresh, readStart);
        plan = this.plan(role, wanted, fresh, serial);
      } else {
        // A pause reads the control first when time allows (never needed:
        // a read that fails or lags never stops it): the station current to
        // write back on a resume, and nothing written when already paused.
        let control;
        if (!skipRead && sendBy - this.now() >= TIMINGS.pauseReadMin) {
          try {
            control = parseControl(
              await api.props(CATEGORIES.GENERIC, {
                by: sendBy - TIMINGS.commandMinSend,
                timeout: TIMINGS.pauseReadMax,
              }),
            );
          } catch (err) {
            if (err.kind === ERROR_KINDS.ABORTED || err.refusal) throw err;
            if (api.closed) {
              // The connection is gone with the read: the pause goes in a new session.
              throw new ChargerError(ERROR_KINDS.SESSION, 'Read failed', {
                notSent: true,
                retryWithoutRead: true,
              });
            }
          }
        }
        if (given()) {
          throw new ChargerError(ERROR_KINDS.ABORTED, 'Session given up', { notSent: true });
        }
        if (control) {
          this.applyFresh({ control }, readStart);
          await this.keepResumeCurrent(control);
          if (control.paused === true && !this.resumeMayLand(entry, serial)) {
            // Already paused, decided on this read: nothing written.
            plan = undefined;
            return;
          }
        } else {
          await this.keepResumeCurrent(c.control);
        }
        plan = this.plan(role, undefined, control ? { control } : undefined);
      }
      if (!plan) {
        return;
      }
      await api.write(plan.id, plan.value, {
        timeoutMs: Math.max(200, answerBy - this.now()),
        // The last checks, right before the bytes go.
        beforeSend: () => {
          this.checkBeforeSend(generation, serial, role);
          if (this.pauseArrived(entry) || session.aborted) {
            throw this.refusal(ERRORS.pauseMeanwhile);
          }
          if (this.now() > sendBy) {
            throw this.refusal(ERRORS.tooSlow);
          }
          if (role === FEATURES.SET_CURRENT && plan.value > this.ceilingOf(freshControl)) {
            // The ceiling lowered meanwhile.
            throw this.refusal(ERRORS.outOfBounds(CURRENT.min, this.ceilingOf(freshControl)));
          }
          this.markSent(entry, role);
          this.logger.info(`Alfen: ${role} (${plan.id}=${plan.value})`);
        },
      });
    };
    const attempt = (skipRead) =>
      this.openSession(isPause ? SESSION.PAUSE : SESSION.COMMAND, work(skipRead), {
        deadline: sendBy - (isPause ? 0 : TIMINGS.commandMinSend),
        serial,
        generation,
        // The ack must reach Gladys within 5 s: the logout never delays it.
        logoutTimeout: () => Math.min(TIMINGS.logoutTimeout, answerBy + 400 - this.now()),
      });
    try {
      try {
        await attempt(false);
      } catch (err) {
        if (!err?.retryWithoutRead || this.now() > sendBy - TIMINGS.commandMinSend) {
          throw err;
        }
        await attempt(true);
      }
    } catch (err) {
      throw await this.commandFailed(err, { serial, role, entry, plan, generation });
    }
    if (!plan || generation !== this.generation) {
      // Nothing written (already so), or an answer of a configuration replaced since.
      return;
    }
    // Accepted by the charger: confirmed only by a read showing the value
    // asked (the guard holds until then, the reads 5 s and 20 s after).
    this.guard(serial, plan, this.reassertFrom(entry));
    this.followUp();
  }

  /** The fresh read of a command, applied only when no command left during it. */
  applyFresh(fresh, readStart) {
    const c = this.charger;
    if (readStart <= c.lastSentAt) {
      return;
    }
    if (fresh.status) {
      c.status = fresh.status;
    }
    this.applyControl(fresh.control, { fromCommand: true });
    // Shown in the background: the ack never waits for Gladys.
    this.publishAll().catch((err) => this.logger.warn(`Publishing failed: ${err.message}`));
  }

  /** The bookkeeping of a write at the moment it leaves. */
  markSent(entry, role) {
    const c = this.charger;
    entry.sentAt = this.now();
    entry.previousChangeAt = this.memory.lastChangeAt;
    c.lastSentAt = this.now();
    if (role !== FEATURES.PAUSE) {
      this.memory.lastChangeAt = this.now();
    }
    if (role === FEATURES.RESUME) {
      c.lastResumeAt = this.now();
    }
    this.saveMemory().catch(() => {});
  }

  /** A write the charger refused: the minute between two changes is not spent. */
  unspend(entry) {
    if (entry.previousChangeAt !== undefined && this.memory.lastChangeAt === entry.sentAt) {
      this.memory.lastChangeAt = entry.previousChangeAt;
      this.saveMemory().catch(() => {});
    }
  }

  /** A pause that overtook a resume that left, or sent while a resume is unconfirmed: reaffirmed. */
  reassertFrom(entry) {
    return entry.role === FEATURES.PAUSE &&
      (this.unconfirmedResume ||
        (entry.overtaken?.role === FEATURES.RESUME && entry.overtaken.sentAt !== undefined))
      ? entry.sentAt
      : undefined;
  }

  /**
   * The error a failed command answers, and what it leaves behind (guards,
   * pauses, block). A command of a configuration replaced meanwhile leaves
   * nothing behind: its answer only goes back to Gladys.
   */
  async commandFailed(err, { serial, role, entry, plan, generation }) {
    if (err?.refusal) {
      return err;
    }
    const stale = generation !== this.generation;
    const reason = errorReason(err);
    const isPause = role === FEATURES.PAUSE;
    const sent = entry.sentAt !== undefined;
    if (
      sent &&
      (err.kind === ERROR_KINDS.REJECTED || (err.kind === ERROR_KINDS.SESSION && err.status))
    ) {
      // The charger answered the write itself with a refusal.
      this.unspend(entry);
      if (!stale) this.followUp();
      return this.refusal(ERRORS.refused(reason));
    }
    if (!sent || notSent(err)) {
      // Nothing written (the minute between two changes is not spent).
      if (sent) this.unspend(entry);
      switch (err.kind) {
        case ERROR_KINDS.CERTIFICATE:
          return this.refusal(ERRORS.certificate);
        case ERROR_KINDS.OTHER_CHARGER:
          return this.refusal(ERRORS.otherCharger);
        case ERROR_KINDS.STALE:
          return this.refusal(ERRORS.unknownCharger);
        case ERROR_KINDS.STORAGE:
          return this.refusal(ERRORS.storage);
        case ERROR_KINDS.LATE:
        case ERROR_KINDS.TIMEOUT:
          // Before the write, every request is bounded by the deadline of the command.
          return this.refusal(ERRORS.tooSlow);
        case ERROR_KINDS.ABORTED:
          return this.refusal(stale ? ERRORS.unknownCharger : ERRORS.pauseMeanwhile);
        case ERROR_KINDS.SESSION:
          // The session was lost before the write (another app logged in?).
          return this.refusal(ERRORS.sessionLost);
        case ERROR_KINDS.AUTH:
          if (!stale && this.config.auth) {
            if (isPause && this.memory.block) {
              // A pause during a block: its own spacing only, the reads keep theirs.
              this.memory.block.refusedAt = this.now();
              await this.saveMemory();
            } else {
              await this.authFailed();
            }
            this.updateStatus().catch(() => {});
          }
          return this.refusal(ERRORS.credentialsRefused);
        case ERROR_KINDS.RATE_LIMITED:
          if (!stale) {
            await this.pause(err);
            this.updateStatus().catch(() => {});
          }
          return this.refusal(
            ERRORS.rateLimitedNotSent(
              age(Math.max(0, (this.memory.pause?.until ?? 0) - this.now())),
            ),
          );
        default:
          if (!isPause && plan === undefined) {
            return this.refusal(ERRORS.unknownState(reason));
          }
          return this.refusal(ERRORS.notSent(reason));
      }
    }
    this.logger.warn(`Alfen: ${role} failed (${reason})`);
    if (err.kind === ERROR_KINDS.RATE_LIMITED) {
      if (!stale) {
        await this.pause(err);
        this.updateStatus().catch(() => {});
      }
      return this.refusal(ERRORS.refused(reason));
    }
    // A silence, a 5xx, a cut connection after the write: it may have reached the charger.
    if (!stale) {
      if (role === FEATURES.RESUME) {
        // It may still land later, even after a pause: a pause sent within
        // the next 90 s is reaffirmed if a read shows the charge resumed.
        this.memory.unconfirmedResumeUntil = this.now() + TIMINGS.guard;
        await this.saveMemory();
      }
      this.guard(serial, plan, this.reassertFrom(entry));
      this.followUp();
    }
    return this.refusal(ERRORS.sentUnconfirmed(reason));
  }

  /** Spaced reads after a command: its effect, then a check (each a new read; one series at a time). */
  followUp() {
    const generation = this.generation;
    const c = this.charger;
    this.clearFollowUps();
    for (const delay of TIMINGS.followUps) {
      const handle = this.timers.setTimeout(() => {
        c.followUps.delete(handle);
        if (generation !== this.generation) {
          return;
        }
        // A read or a session under way began before: wait for it, then read again.
        Promise.resolve(c.running)
          .catch(() => {})
          .then(() => this.session?.done)
          .then(() => this.tick({ followUp: true }))
          .catch(() => this.logger.error('Alfen refresh failed'));
      }, delay);
      c.followUps.add(handle);
    }
  }

  // --- Guards ----------------------------------------------------------------------

  /**
   * After a command, until the charger shows it: a new command is always
   * sent, never answered "already so" on a state that may not show the
   * previous one yet. The start state is kept: a read equal to it lifts
   * nothing until a move was seen. `reassertFrom`: a pause sent while a
   * resume may still land (the time it left): its guard holds the whole 90 s
   * and reaffirms the pause (see observe).
   */
  guard(serial, plan, reassertFrom) {
    const key = `${serial}:${plan.guardKey}`;
    const held = this.guards.get(key);
    // A pause sent again keeps the reaffirmation of the pause it repeats.
    const keep =
      held?.reassertFrom !== undefined &&
      plan.expected === true &&
      this.guardActive(serial, plan.guardKey);
    this.guards.set(key, {
      from: plan.from,
      expected: plan.expected,
      moved: false,
      until: keep ? held.until : this.now() + TIMINGS.guard,
      // A second pause click renews the reaffirmation from its own time.
      reassertFrom: keep ? (reassertFrom ?? held.reassertFrom) : reassertFrom,
      reasserts: keep ? held.reasserts : 0,
    });
  }

  guardActive(serial, guardKey) {
    const key = `${serial}:${guardKey}`;
    const guard = this.guards.get(key);
    if (guard && this.now() >= guard.until) {
      this.guards.delete(key);
      return false;
    }
    return Boolean(guard);
  }

  /** A read of the control, through the guards: never lifted on an unknown value. */
  observe(serial, control, { fromCommand = false } = {}) {
    const same = (a, b) =>
      typeof a === 'number' && typeof b === 'number'
        ? Math.abs(a - b) <= CURRENT.tolerance
        : a === b;
    for (const [guardKey, value] of [
      ['pause', control.paused],
      ['current', control.currentSet],
    ]) {
      if (!this.guardActive(serial, guardKey) || value === undefined) {
        continue;
      }
      const key = `${serial}:${guardKey}`;
      const guard = this.guards.get(key);
      if (!same(value, guard.from)) {
        guard.moved = true;
      }
      if (guard.reassertFrom !== undefined) {
        // A pause to reaffirm: the guard holds its 90 s. The charge read
        // resumed while no resume left since the pause is a late resume
        // landing after it: the pause is sent again, twice at most (a resend
        // that fails keeps the reaffirmation for the next read).
        if (
          value === false &&
          !fromCommand &&
          !(this.inFlight && this.inFlight.role === FEATURES.RESUME) &&
          this.charger.lastResumeAt <= guard.reassertFrom &&
          guard.reasserts < TIMINGS.pauseReasserts
        ) {
          guard.reasserts += 1;
          this.reassertPause(serial);
        }
        continue;
      }
      if (guard.moved && same(value, guard.expected)) {
        this.guards.delete(key);
      }
    }
  }

  /** Sends the pause again (a late resume landed after it), in its own session. No read, no option. */
  reassertPause(serial) {
    if (this.charger.serial !== serial || !this.readable || this.session?.kind === SESSION.PAUSE) {
      // A pause is already going to the charger.
      return;
    }
    this.logger.warn('Alfen: the charge resumed after a pause, pause sent again');
    const generation = this.generation;
    const send = async () => {
      // Never two sessions: the read that saw it has ended; a command under way gives way.
      await this.acquire(SESSION.PAUSE, this.now());
      await this.openSession(
        SESSION.PAUSE,
        (api) =>
          api.write(PROPS.STATION_MAX, 0, {
            timeoutMs: TIMINGS.readTimeout,
            beforeSend: () => {
              if (this.charger.serial !== serial || !this.readable) {
                throw new ChargerError(ERROR_KINDS.OTHER_CHARGER, 'Not the charger');
              }
              this.charger.lastSentAt = this.now();
            },
          }),
        { deadline: this.now() + 4 * TIMINGS.readTimeout, serial, generation },
      );
    };
    send()
      .then(() => this.followUp())
      .catch(async (err) => {
        if (generation !== this.generation) {
          return;
        }
        this.logger.warn(`Alfen: pause reaffirmed failed (${errorReason(err)})`);
        // The guard keeps its reaffirmation: the next read tries again (twice at most in all).
        this.followUp();
        if (err.kind === ERROR_KINDS.RATE_LIMITED) {
          await this.pause(err);
        }
      })
      .catch(() => {});
  }
}
