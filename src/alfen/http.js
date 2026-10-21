// -----------------------------------------------------------------------------
// The only network access of the integration: ONE TLS connection to the
// charger at a time, on which the requests of a session go one after the
// other (HTTP/1.1, keep-alive). The Alfen charger authenticates the TCP
// connection itself (alfen_wallbox: "the wallbox authenticates the TCP
// connection, not requests"), so a session must stay on one connection:
// node:https with an agent cannot promise it, hence this small client.
//
// TLS: the charger serves a self-signed certificate, so no authority can
// vouch for it. `openConnection` resolves once the handshake is done, with
// the SHA-256 fingerprint of the certificate; NOTHING is written before the
// caller checked it against the pin (src/alfen/client.js): the password never
// reaches another device. `rejectUnauthorized: false` is safe only with that
// check. The cipher list is the default one at security level 1, as
// alfen_wallbox opens it ("DEFAULT" ciphers) for older embedded TLS: the pin,
// not an authority, vouches for the charger.
//
// Bounded: the time of every request, the size of the status line and the
// headers (8 KB), of the body (64 KB). The answer is parsed in one pass over
// the bytes as they come (no concatenation per chunk, no buffer per byte);
// chunked bodies are supported. No redirect is ever followed. Every failure
// is a ChargerError whose kind says whether the request may have reached the
// charger; its message never holds the address nor any byte of the answer.
// -----------------------------------------------------------------------------

import { isIP } from 'node:net';
import tls from 'node:tls';
import { LIMITS } from '../constants.js';

/** The kinds of failure the rest of the code tells apart. */
export const ERROR_KINDS = Object.freeze({
  /** Nothing accepted the connection (TLS included). Nothing was sent. */
  UNREACHABLE: 'unreachable',
  /** Connected, then silent or cut: the request may have been received. */
  TIMEOUT: 'timeout',
  /** An HTTP status that is not handled more precisely (`status` holds it). */
  HTTP: 'http',
  /** 401 or 403 on the login: the password was refused (`status` holds it). */
  AUTH: 'auth',
  /** 401 on a request after the login: the session was lost (not a refused password). */
  SESSION: 'session',
  /** 429 (`retryAfter` in ms when the charger gave one). */
  RATE_LIMITED: 'rate_limited',
  /** Too large, not HTTP, not JSON, not the expected shape. */
  PROTOCOL: 'protocol',
  /** The certificate is not the one pinned (`fingerprint` holds the new one). Nothing was sent. */
  CERTIFICATE: 'certificate_changed',
  /** Another charger answers at the address (`serial` holds its identity). Nothing was sent. */
  OTHER_CHARGER: 'other_charger',
  /** The time a command was given ran out before its request: nothing was sent. */
  LATE: 'late',
  /** The connection was closed by us (a pause took the charger). */
  ABORTED: 'aborted',
  /** A write refused by the charger (4xx). */
  REJECTED: 'rejected',
  /** The session belongs to a configuration replaced meanwhile: given up, nothing written. */
  STALE: 'stale',
  /** The first pin could not be kept in /data: the password is not sent. */
  STORAGE: 'storage',
});

export class ChargerError extends Error {
  constructor(kind, message, details = {}) {
    super(message);
    this.name = 'ChargerError';
    this.kind = kind;
    for (const [key, value] of Object.entries(details)) {
      this[key] = value;
    }
  }
}

/** Whether a failure says for sure that nothing reached the charger. */
export const notSent = (err) =>
  err?.notSent === true ||
  [
    ERROR_KINDS.UNREACHABLE,
    ERROR_KINDS.LATE,
    ERROR_KINDS.CERTIFICATE,
    ERROR_KINDS.OTHER_CHARGER,
    ERROR_KINDS.STALE,
    ERROR_KINDS.STORAGE,
  ].includes(err?.kind);

const CRLF = Buffer.from('\r\n\r\n');
const code = (err) => (/^[A-Z0-9_]{1,40}$/.test(String(err?.code ?? '')) ? err.code : 'error');

/** The fingerprint as Node prints it: "AB:CD:…", upper case. */
export const normalizeFingerprint = (value) =>
  typeof value === 'string' && /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/i.test(value.trim())
    ? value.trim().toUpperCase()
    : undefined;

/**
 * A parser of ONE HTTP/1.1 answer, fed with the chunks as they come. Linear:
 * the head is searched in at most 8 KB (kept in a buffer capped to that
 * size), the body bytes are copied once into a list of slices.
 */
export class AnswerParser {
  constructor({ maxBytes = LIMITS.responseBytes, headerBytes = LIMITS.headerBytes } = {}) {
    this.maxBytes = maxBytes;
    this.headerBytes = headerBytes;
    this.head = Buffer.alloc(0);
    this.phase = 'head';
    this.status = 0;
    this.headers = {};
    this.parts = [];
    this.size = 0;
    this.remaining = 0;
    this.chunkLine = '';
    this.untilClose = false;
    this.done = false;
    this.keepAlive = true;
  }

  fail(message) {
    throw new ChargerError(ERROR_KINDS.PROTOCOL, message);
  }

  /** Feeds bytes; returns true once the answer is complete. */
  push(chunk) {
    let offset = 0;
    if (this.phase === 'head') {
      // Only the bytes that may hold the head are joined (8 KB at most).
      const room = this.headerBytes - this.head.length;
      const take = chunk.subarray(0, Math.max(0, room));
      const joined = Buffer.concat([this.head, take]);
      const end = joined.indexOf(CRLF);
      if (end === -1) {
        if (joined.length >= this.headerBytes) this.fail('Head too large');
        this.head = joined;
        return false;
      }
      offset = end + 4 - this.head.length;
      this.head = Buffer.alloc(0);
      if (this.parseHead(joined.subarray(0, end).toString('latin1')) === 'interim') {
        // A 1xx answer (100 Continue…) is not the answer: skipped, 4 at most.
        this.interims = (this.interims ?? 0) + 1;
        if (this.interims > 4) this.fail('Too many interim answers');
        return this.push(chunk.subarray(offset));
      }
    }
    this.feed(chunk, offset);
    return this.done;
  }

  parseHead(text) {
    const lines = text.split('\r\n');
    const status = /^HTTP\/1\.[01] (\d{3})(?: .*)?$/.exec(lines[0]);
    if (!status) this.fail('Not HTTP');
    this.status = Number(status[1]);
    const headers = Object.create(null);
    for (const line of lines.slice(1)) {
      const at = line.indexOf(':');
      if (at <= 0) this.fail('Bad header');
      const name = line.slice(0, at).trim().toLowerCase();
      if (!/^[a-z0-9-]{1,64}$/.test(name)) this.fail('Bad header');
      headers[name] = line.slice(at + 1).trim();
    }
    if (this.status >= 100 && this.status < 200 && this.status !== 101) {
      this.status = 0;
      return 'interim';
    }
    this.headers = headers;
    const connection = String(headers.connection ?? '').toLowerCase();
    this.keepAlive = connection !== 'close';
    const encoding = String(headers['transfer-encoding'] ?? '').toLowerCase();
    if (this.status === 204 || this.status === 304 || (this.status >= 100 && this.status < 200)) {
      this.phase = 'body';
      this.remaining = 0;
      this.done = true;
      return;
    }
    if (encoding.includes('chunked')) {
      this.phase = 'size';
      return;
    }
    if (headers['content-length'] !== undefined) {
      if (!/^\d{1,9}$/.test(headers['content-length'])) this.fail('Bad length');
      this.remaining = Number(headers['content-length']);
      if (this.remaining > this.maxBytes) this.fail('Answer too large');
      this.phase = 'body';
      this.done = this.remaining === 0;
      return;
    }
    // Neither: the body ends with the connection.
    this.phase = 'body';
    this.untilClose = true;
    this.keepAlive = false;
  }

  take(slice) {
    this.size += slice.length;
    if (this.size > this.maxBytes) this.fail('Answer too large');
    this.parts.push(slice);
  }

  feed(chunk, offset) {
    let i = offset;
    while (i < chunk.length && !this.done) {
      if (this.phase === 'body') {
        if (this.untilClose) {
          this.take(chunk.subarray(i));
          return;
        }
        const n = Math.min(this.remaining, chunk.length - i);
        this.take(chunk.subarray(i, i + n));
        this.remaining -= n;
        i += n;
        if (this.remaining === 0) this.done = true;
      } else if (this.phase === 'size' || this.phase === 'trailer' || this.phase === 'dataEnd') {
        // One line, byte by byte (bounded to 64 characters).
        const byte = chunk[i];
        i += 1;
        if (byte !== 0x0a) {
          this.chunkLine += String.fromCharCode(byte);
          if (this.chunkLine.length > 64) this.fail('Bad chunk');
          continue;
        }
        const line = this.chunkLine.replace(/\r$/, '');
        this.chunkLine = '';
        if (this.phase === 'dataEnd') {
          if (line !== '') this.fail('Bad chunk');
          this.phase = 'size';
        } else if (this.phase === 'trailer') {
          if (line === '') this.done = true;
        } else {
          const size = /^([0-9a-f]{1,8})(?:;.*)?$/i.exec(line);
          if (!size) this.fail('Bad chunk');
          const n = parseInt(size[1], 16);
          if (n === 0) {
            this.phase = 'trailer';
          } else {
            if (this.size + n > this.maxBytes) this.fail('Answer too large');
            this.remaining = n;
            this.phase = 'data';
          }
        }
      } else if (this.phase === 'data') {
        const n = Math.min(this.remaining, chunk.length - i);
        this.take(chunk.subarray(i, i + n));
        this.remaining -= n;
        i += n;
        if (this.remaining === 0) this.phase = 'dataEnd';
      }
    }
  }

  /** The connection ended: an answer read until the close is complete then. */
  end() {
    if (this.phase === 'body' && this.untilClose) {
      this.done = true;
    }
    return this.done;
  }

  result() {
    return {
      status: this.status,
      headers: this.headers,
      body: Buffer.concat(this.parts, this.size).toString('utf8'),
    };
  }
}

/**
 * Opens the TLS connection. Resolves `{ fingerprint, request, close, closed }`
 * once the handshake is done; nothing is written by this function.
 * @param {{ host: string, port: number, timeoutMs: number }} options
 */
export function openConnection({ host, port, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let socket;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket?.destroy();
      reject(new ChargerError(ERROR_KINDS.UNREACHABLE, 'Unreachable: timeout'));
    }, timeoutMs);
    try {
      socket = tls.connect({
        host,
        port,
        servername: isIP(host) ? undefined : host,
        rejectUnauthorized: false,
        // TLS 1.2 at least, whatever NODE_OPTIONS says; the cipher list at
        // security level 1 for older embedded TLS (the pin vouches for the charger).
        minVersion: 'TLSv1.2',
        ciphers: 'DEFAULT@SECLEVEL=1',
      });
    } catch (err) {
      clearTimeout(timer);
      reject(new ChargerError(ERROR_KINDS.UNREACHABLE, `Unreachable: ${code(err)}`));
      return;
    }
    socket.once('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(new ChargerError(ERROR_KINDS.UNREACHABLE, `Unreachable: ${code(err)}`));
    });
    socket.once('secureConnect', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const fingerprint = normalizeFingerprint(socket.getPeerCertificate()?.fingerprint256);
      if (!fingerprint) {
        socket.destroy();
        reject(new ChargerError(ERROR_KINDS.CERTIFICATE, 'No certificate', { notSent: true }));
        return;
      }
      resolve(connectionOn(socket, host, fingerprint));
    });
  });
}

/** The requests of one session, one at a time, on the socket given. */
export function connectionOn(socket, host, fingerprint) {
  let closed = false;
  let current;
  const onClose = () => {
    closed = true;
    current?.ended();
  };
  socket.on('close', onClose);
  socket.on('end', onClose);
  socket.on('error', () => {
    closed = true;
    current?.ended();
  });
  socket.on('data', (chunk) => current?.data(chunk));

  const connection = {
    fingerprint,
    get closed() {
      return closed;
    },
    /** Destroys the connection: a request under way fails (ABORTED). */
    close() {
      closed = true;
      current?.aborted();
      socket.destroy();
    },
    /**
     * One request. `beforeSend()` runs right before the bytes are written:
     * what it throws is rethrown marked `notSent`.
     * @returns {Promise<{ status: number, headers: object, body: string }>}
     */
    request({ method = 'GET', path, headers = {}, body, timeoutMs, beforeSend }) {
      return new Promise((resolve, reject) => {
        if (current) {
          reject(new ChargerError(ERROR_KINDS.PROTOCOL, 'One request at a time'));
          return;
        }
        if (closed) {
          reject(new ChargerError(ERROR_KINDS.SESSION, 'Connection closed', { notSent: true }));
          return;
        }
        let sent = false;
        const parser = new AnswerParser();
        const finish = (error, value) => {
          if (current !== state) return;
          current = undefined;
          clearTimeout(timer);
          if (error) {
            if (sent) {
              // The connection may hold half an answer: never used again.
              closed = true;
              socket.destroy();
            }
            reject(error);
          } else {
            if (!parser.keepAlive) {
              closed = true;
              socket.end();
            }
            resolve(value);
          }
        };
        const lost = () =>
          sent
            ? new ChargerError(ERROR_KINDS.TIMEOUT, 'Connection lost')
            : new ChargerError(ERROR_KINDS.SESSION, 'Connection closed', { notSent: true });
        const state = {
          data(chunk) {
            try {
              if (parser.push(chunk)) finish(null, parser.result());
            } catch (err) {
              finish(err);
            }
          },
          ended() {
            if (parser.end()) finish(null, parser.result());
            else finish(lost());
          },
          aborted() {
            finish(new ChargerError(ERROR_KINDS.ABORTED, 'Session given up', { notSent: !sent }));
          },
        };
        current = state;
        const timer = setTimeout(
          () =>
            finish(
              sent
                ? new ChargerError(ERROR_KINDS.TIMEOUT, 'Connected but silent: timeout')
                : new ChargerError(ERROR_KINDS.LATE, 'No time left', { notSent: true }),
            ),
          Math.max(1, timeoutMs),
        );
        try {
          beforeSend?.();
        } catch (err) {
          finish(Object.assign(err, { notSent: true, beforeSend: true }));
          return;
        }
        const payload = body === undefined ? undefined : Buffer.from(body, 'utf8');
        const lines = [
          `${method} ${path} HTTP/1.1`,
          `Host: ${host.includes(':') ? `[${host}]` : host}`,
          'Connection: keep-alive',
          'Accept: application/json, */*',
          ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
          ...(payload
            ? ['Content-Type: application/json', `Content-Length: ${payload.length}`]
            : method === 'POST'
              ? ['Content-Length: 0']
              : []),
        ];
        if (lines.some((line) => /[\r\n]/.test(line))) {
          finish(new ChargerError(ERROR_KINDS.PROTOCOL, 'Bad header', { notSent: true }));
          return;
        }
        sent = true;
        const head = Buffer.from(`${lines.join('\r\n')}\r\n\r\n`, 'latin1');
        socket.write(payload ? Buffer.concat([head, payload]) : head);
      });
    },
  };
  return connection;
}
