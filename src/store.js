// -----------------------------------------------------------------------------
// What must survive a restart, in /data (the only writable place of the
// container):
//   - the end of a pause (429, or a 5xx) and the block after refused
//     credentials, so a restart never asks the charger again before its time
//     and never loops on a refused login;
//   - the time of the last read (written at most once a minute), so a
//     restart never reads the charger sooner than the interval;
//   - the address read last, the identity of the charger there (not a secret:
//     the id of the device), so that "Pause charging" goes before the first
//     read after a restart, and the SHA-256 fingerprint of its certificate
//     (the pin: not a secret either, the certificate is public), plus the one
//     last refused, for "Trust the new certificate";
//   - the last maximum station current above 6 A (what "Resume charging"
//     writes back), the minute between two changes and the watch of a resume
//     left without confirmation;
//   - the guard of the energy index (its reference and a value held back).
// Bounded when read back. NO SECRET: neither the user name, nor the password,
// nor anything derived from them (not even a hash), nor the session token.
// The file is readable by the container user only (0600).
// -----------------------------------------------------------------------------

import { readFile, rename, writeFile } from 'node:fs/promises';
import { CURRENT, LIMITS, TIMINGS } from './constants.js';
import { normalizeFingerprint } from './alfen/http.js';

export const STATE_FILE = '/data/alfen-state.json';

export function fileStore(path = STATE_FILE) {
  // One write at a time: two saves never share the temporary file.
  let chain = Promise.resolve();
  return {
    async load() {
      try {
        const text = await readFile(path, 'utf8');
        return text.length > 256 * 1024 ? null : JSON.parse(text);
      } catch {
        return null;
      }
    },
    save(data) {
      const text = JSON.stringify(data);
      const write = chain.then(async () => {
        const temporary = `${path}.tmp`;
        await writeFile(temporary, text, { mode: 0o600 });
        await rename(temporary, path);
      });
      chain = write.catch(() => {});
      return write;
    },
  };
}

/** For the tests: the same JSON round trip as the file. */
export function memoryStore(initial = null) {
  return {
    data: initial === null ? null : JSON.parse(JSON.stringify(initial)),
    saves: 0,
    async load() {
      return this.data === null ? null : JSON.parse(JSON.stringify(this.data));
    },
    async save(data) {
      this.data = JSON.parse(JSON.stringify(data));
      this.saves += 1;
    },
  };
}

const longestBlock = TIMINGS.authBackoff.at(-1);
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const FEATURE_ID = /^[a-z0-9:_-]{1,200}$/;
const SERIAL = /^[0-9a-z](?:[0-9a-z_-]{2,38}[0-9a-z])$/;
const TARGET = /^[a-z0-9.-]{1,253}(?::\d{1,5})?$/;

const pointOf = (p) =>
  plain(p) && Number.isFinite(p.value) && p.value > 0 && Number.isFinite(p.at)
    ? { value: p.value, at: p.at }
    : null;

const heldOf = (h) =>
  plain(h) &&
  (h.direction === 'up' || h.direction === 'down') &&
  [h.from, h.to, h.threshold, h.at].every(Number.isFinite)
    ? { direction: h.direction, from: h.from, to: h.to, threshold: h.threshold, at: h.at }
    : null;

/** The guards of the index features: `{ [featureId]: { last, held } }`, bounded. */
function indexesOf(raw) {
  const indexes = {};
  if (!plain(raw)) {
    return indexes;
  }
  for (const [id, state] of Object.entries(raw).slice(0, LIMITS.indexStates)) {
    if (FEATURE_ID.test(id) && plain(state)) {
      indexes[id] = { last: pointOf(state.last), held: heldOf(state.held) };
    }
  }
  return indexes;
}

/** A time in the past (or now), else -Infinity (JSON writes it as null). */
const past = (value, now) => (Number.isFinite(value) ? Math.min(value, now) : -Infinity);

/**
 * The persisted state, repaired and bounded:
 * `{ pause, block, indexes, target, serial, pin, refusedPin, last,
 *    resumeCurrent, lastChangeAt, unconfirmedResumeUntil }`.
 */
export function normalizeMemory(raw, now) {
  const data = plain(raw) ? raw : {};
  const pause = plain(data.pause) ? data.pause : {};
  const block = plain(data.block) ? data.block : {};
  const failures = Number.isInteger(block.failures) && block.failures > 0 ? block.failures : 1;
  const target = typeof data.target === 'string' && TARGET.test(data.target) ? data.target : null;
  const last = plain(data.last) && Number.isFinite(data.last.at) ? data.last : undefined;
  return {
    pause:
      Number.isFinite(pause.until) && pause.until > now
        ? {
            until: Math.min(pause.until, now + TIMINGS.rateLimitMax),
            reason: pause.reason === '5xx' ? '5xx' : '429',
          }
        : null,
    block: Number.isFinite(block.until)
      ? {
          // An expired block is kept (its count spaces the next tries) but no longer waits.
          until: Math.min(block.until, now + longestBlock),
          failures: Math.min(failures, 100),
          /** When a login was last refused (a pause during a block never loops). */
          refusedAt: past(block.refusedAt, now),
        }
      : null,
    indexes: indexesOf(data.indexes),
    /** The address the identity and the pin below belong to. */
    target,
    serial:
      target && typeof data.serial === 'string' && SERIAL.test(data.serial) ? data.serial : null,
    pin: target ? (normalizeFingerprint(data.pin) ?? null) : null,
    refusedPin: target ? (normalizeFingerprint(data.refusedPin) ?? null) : null,
    /** The start of the last read of `target`: never in the future. */
    last: target && last ? { at: Math.min(last.at, now) } : null,
    resumeCurrent:
      Number.isInteger(data.resumeCurrent) &&
      data.resumeCurrent >= CURRENT.min &&
      data.resumeCurrent <= 80
        ? data.resumeCurrent
        : null,
    lastChangeAt: past(data.lastChangeAt, now),
    unconfirmedResumeUntil: Number.isFinite(data.unconfirmedResumeUntil)
      ? Math.min(data.unconfirmedResumeUntil, now + TIMINGS.guard)
      : -Infinity,
  };
}
