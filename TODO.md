# TODO — Alfen v1

Handoff document: what is done, what was decided, what comes next. Keep it
up to date at the end of every milestone.

## Working method

- One milestone at a time, one commit per milestone, tests green before moving on.
- After each milestone: `npm run format:check`, `npm run lint`, `npm test`
  (Node 22 and 24), `npm run audit`, `npx github:GladysAssistant/integration-store .`,
  then update README, `docs/en.md`, `docs/fr.md`, `CHANGELOG.md` and this file.
- No forum topic of its own, no forum post from a module session: the batch
  reserved in /t/10385 (lot 12) gets one recap message there.
- The `gladys-assistant-integration` topic is added at the first real release only.

## Status

- [x] **Milestone 1 — core** (2026-10-21): one Alfen Eve by address and
      password, one short session at a time (connect, pin, identity, login,
      pages, logout, close), the certificate pinned at the first connection
      and checked before any byte, "Trust the new certificate", one device
      per identity, state, status code, connector, charging state, plugged,
      paused, error, power, current and voltage per phase, maximum station
      current, current set, temperature, energy index through the P1 Monitor
      guard with the two-click acceptance, "Pause charging" always available
      and never held back, "Resume charging" and the current select behind
      `allow_commands` (off), one change a minute, late reads quarantined,
      sessions given up for a command or a pause, 429/5xx pauses, credential
      blocks and the time of the last read persisted, test button, docs
      en/fr, cover. Tested against made-up answers and a loopback TLS server
      only.
- [ ] **Milestone 2 — real charger**: run against a real Eve (see "To
      check"), turn the answers (anonymized) into fixtures.
- [ ] **Milestone 3 — more**: socket 2 of an Eve Double (`2502_*`, `3221_*`,
      `3129_0`), the energy of the session (the transactions log, as
      alfen_wallbox reads it), several chargers, the phases and the solar
      charging (behind the option, never a switch).

## To check on a real charger

- That `GET /api/prop?cat=generic|states|meter1|temp&offset=n` answers as
  alfen_wallbox reads it (`properties`, `total`), the page size, and the
  values typed as numbers or texts.
- What the charger answers to a login while the Alfen app (MyEve, Eve
  Connect) holds the session: 401 (read as refused credentials: a block of
  15 min), another status, or does it log the app out? Same for the app while
  Gladys is logged in. Whether the logout releases the session at once and
  how long a session given up (connection closed without a logout, after a
  pause took the charger) stays open on the charger.
- That `/api/info` answers without a login (alfen_wallbox's doc says so), and
  the shape of `Identity` (the device id: lower case, `[0-9a-z_-]`).
- The certificate: whether it is the same after a reboot and a firmware
  update (a new one stops everything until "Trust the new certificate"), its
  key size and signature (the TLS client allows `DEFAULT@SECLEVEL=1`, as
  alfen_wallbox opens its ciphers), TLS 1.2 or 1.3.
- That writing `2062_0` = 0 pauses at once, how `2501_2` and `2501_4` show
  it (178 "B2" expected), that writing it back resumes; whether `2062_0` is
  a setting kept in flash (one change a minute; the docs say not to change
  it all the time), and whether the charger refuses a value above the
  installation limit.
- That `POST /api/prop` closes the connection after a write (alfen_wallbox
  says so: the logout is then skipped), and its status when the value is
  refused (400? 409? 422?).
- `2221_22` (Wh) after a firmware update or a meter swap (a drop is held by
  the guard; the user accepts it).
- How the active load balancing and OCPP overwrite `2062_0` and `2129_0`
  (two masters may contradict each other: said in the docs).
- The bearer token (`access`) of newer firmware: its lifetime within one
  session.

## Decisions

- **Version 0.1.0 set by hand** in `package.json`, `package-lock.json`, the
  manifest and the `docker_image` tag (`ghcr.io/lm1lc3n7/gladys-alfen:0.1.0`);
  the first patch release gives 0.1.1. `test/manifest.test.js` checks the
  four agree.
- **Reference**: alfen_wallbox (MIT, `Copyright (c) 2020 Jimmy Everling`,
  maintained by leeyuentuen, leeyuentuen/alfen_wallbox, commit aa88b47 of
  2026-10-06; no PyPI library) — license checked in its `LICENSE`: MIT, not
  GPL. Cloned read only in `_ref/alfen_wallbox`. Ported to JavaScript
  (`src/alfen/client.js`, `src/alfen/http.js` on `node:tls`), no Python, no
  runtime dependency but the SDK; full MIT notice in
  `THIRD_PARTY_NOTICES.md`, shipped in the image with `LICENSE` (the standard
  Apache-2.0 text, no name). alfen_wallbox's queue of writes retried at
  every cycle, its 2 s retries of a page, its log and transaction walks are
  not kept.
- **Neighbour modules** (read only, nothing modified): gladys-peblar 0.1.2
  and gladys-nrgkick (structure, command rules, publisher, store),
  gladys-openevse, gladys-keba; the index guard of gladys-p1-monitor as
  gladys-nrgkick takes it (limits as a parameter, tests unchanged); the TLS
  pinning of gladys-my-pv and gladys-teltonika (handshake checked before
  writing), and its self-signed certificate for the tests.
- **One session at a time**: the charger takes one login and authenticates
  the TCP connection (alfen_wallbox). `node:https` with an agent cannot keep
  a session on one connection, hence a small HTTP/1.1 client on one TLS
  socket (`src/alfen/http.js`): one request at a time, keep-alive, Content-
  Length or chunked bodies, parsed in one pass, 8 KB of headers, 64 KB per
  answer, 10 pages per category. Each read, command or pause is one session
  (connect, pin, `/api/info`, login with `displayname` "Gladys", work,
  logout bounded to 1 s, close). `app.session` holds the one open: a poll
  never starts while one is open; a command takes the charger from a poll; a
  pause from anything (the connection closed at once: the request under way
  fails ABORTED, "not sent" when its bytes had not left). A session given up
  is never applied.
- **Pinned certificate** (lot 11: "HTTPS local : certificat épinglé et mot de
  passe envoyé seulement sur la connexion vérifiée"): trust on first use,
  the SHA-256 fingerprint kept in `/data` (`pin`, not a secret) before the
  login of that first connection; then compared right after the handshake,
  before any byte (the password included). Another one: nothing written, the
  connection closed, kept as `refusedPin`, the status shows its first 8
  bytes; the handshake alone is tried again at the interval (the pinned one
  may come back, which clears `refusedPin`); "Trust the new certificate" pins
  exactly `refusedPin` (never "whatever comes next"), then reads at once. A
  new address forgets the pin, the identity and the last read.
  `rejectUnauthorized: false` only with that check; ciphers
  `DEFAULT@SECLEVEL=1` for older embedded TLS (the pin vouches for the
  charger). Tested against a real TLS server on the loopback
  (`test/http.test.js`).
- **Credentials**: user name (`admin` by default) and password (secret
  field, required), printable ASCII, 256 characters at most, memory only:
  never logged, never in `/data` (not even a hash of a refused one), never in
  a status or an error; the bearer token of newer firmware is kept for its
  connection only. Credentials pasted in the address ignore the address
  (fixed text, never shown back). A login answered 401/403 blocks the tries:
  15 min, 1 h, then every 6 h, persisted (`until`, `failures`, `refusedAt`),
  bounded at a restart; saving other credentials lifts it and reads at once.
  A 401 after a login (a request, a write) is a session lost, never a block;
  it says so in the status.
- **Reads**: `generic`, `states`, `meter1`, then `temp` (secondary: an HTTP
  or protocol error there never stops the rest) every interval (60 s
  default, 30 s – 1 h: each read is a login). Never sooner than the
  interval: the test button, Discovery (it only republishes), `connected`,
  a configuration saved unchanged, a restart (the start of the last read
  written to `/data` at most once a minute; read back + 1 minute, never
  later than now). Only the two reads after a command go sooner (5 s, 20 s;
  one series pending at a time). 429: pause 1 min – 6 h (Retry-After, 5 min
  without); 5xx on a main category or the login: a pause of the failure
  delay; both persisted, bounded to 6 h at a restart, applied to every path
  but the pause command. Failures: 30 s, 1, 2, 5 min, never under the
  interval.
- **Identity**: one device per `Identity` of `/api/info` (lower case,
  `[0-9a-z_-]`, 4 to 40 characters), never per IP; read again in every
  session. Another identity: a poll applies it (the old device becomes "not
  read any more"); a command is refused unsent. An identity that cannot be
  read (an error answer, a bad JSON) is not another charger: the session
  goes on for the known one (the pinned certificate vouches for it); none
  known: the read fails. The identity read last is kept in `/data` with its
  address.
- **Features and units** (core `DEVICE_FEATURE_UNITS_BY_CATEGORY`): power and
  current/voltage per phase on `energy-sensor` (W/A/V); the meter of socket 1
  (`2221_22`, Wh → kWh) **the only index** (`energy-sensor/index`, kWh),
  always through the guard (`maxKw` 25, `slackKwh` 0.5); the maximum station
  current (`2062_0`) and the current of socket 1 (`2129_0`) on
  `electrical-vehicle-charge/target-current` (A, read only); temperature
  (`2201_0`) on `temperature-sensor/decimal`; charge paused (station current
  under 6 A) and error (status 18–32, or mode 3 E/F) on `unknown/binary`;
  status and status code as text. Every role always built. No
  `publishEnergyConsumption`, no daily consumption, no session energy in v1
  (only the transactions log gives it).
- **States** (mode 3, `2501_4`, IEC 61851): A → AVAILABLE/IDLE, plugged 0;
  B → OCCUPIED, EV_CONNECTED (PAUSED_BY_CHARGER and "charge paused" when the
  station current is under 6 A); C, D → OCCUPIED/CHARGING; E, F →
  FAULTED/IDLE; other codes → "Unknown state", no connector. Offline: status
  "Charger unreachable", connector UNAVAILABLE, other values kept.
- **Commands**: `pause-charge` and `resume-charge` (`button/push`, value 1
  only) and `set-current` (`text/select` of whole amperes from 6 A to the
  ceiling); never a switch nor a writable binary. The pause writes `2062_0`
  = 0 (alfen_wallbox's charging switch: the charger has no pause command);
  the resume writes `2062_0` back to the last station current read at 6 A or
  more (kept in `/data`), capped by `max_current` (6 A when never read); the
  current writes `2129_0` (6–32 A, whole). The client refuses any other
  property or value. Never the phases, the solar charging, the RFID mode, a
  reboot.
- **"Pause charging" is protective** (no option, never held back): it takes
  the charger from a session under way (a resume or a current not written
  yet gives way, "a pause arrived"), ignores the minute, a 429/5xx pause, a
  missing read; it goes before the first read after a restart to the device
  of the identity kept in `/data` (any created device when none is kept).
  During a credential block it still logs in, but at most once every
  5 minutes after the last refusal (a scene pressing it in a loop never
  replays a refused password). Refused only without address/password, with
  another charger or another certificate at the address.
- **Late resume**: a resume left without confirmation opens a 90 s watch
  (kept in `/data`); a pause sent in it, or that overtook a resume whose
  bytes left, keeps its guard 90 s and, at each poll or follow-up read
  (never the fresh read of a command, never while a resume is in flight),
  if the charge reads resumed and no resume left since the pause, is sent
  again in its own session (twice at most; a resend that fails keeps the
  watch for the next read).
- **Resume and current** (`allow_commands`, off by default, only `true`
  allows): value validated strictly; a current above the ceiling known is
  refused without a session; the option checked on arrival and in
  `beforeSend`, with the generation, the identity and the deadline; decided
  on a read of `generic` and `states` in the same session (never memory); a
  missing value refuses; resume refused without a vehicle (A), on E, F or an
  unknown state; nothing sent when already so (unless a guard holds); sent
  within 3.5 s of the click (connection, login and read included) or
  refused unsent (a timeout before the write is "too slow"); answered by
  4.3 s, the logout bounded so that the ack reaches Gladys within 5 s. One
  change a minute (persisted).
- **Outcomes**: 2xx → success, the guard holds until a read shows the value
  asked (reads 5 s and 20 s after; no optimistic state); not written →
  "not sent"/"too slow"/"a pause arrived"; 401 (session lost) or another 4xx
  on the write → "refused by the charger", never a block; 429 → pause;
  silence, 5xx, a cut connection after the bytes left → **"sent, without
  confirmation"** + guard + reads. The ack never waits for Gladys.
- **Ceiling**: the lower of `max_current` (16 A by default, 6–32 A) and the
  maximum station current read (or the one kept from before a pause).
- **Late answers**: a poll read begun before a command left is quarantined; a
  poll given up for a command is dropped; the fresh read of a command is
  applied only when no command left during it; an answer of an old
  configuration (generation) publishes nothing.
- **Hostile answers**: see above for the transport; only own fields of plain
  objects, properties in a `Map`, ids matched by `^[0-9A-F]{4}_[0-9A-F]{1,2}$`,
  numbers exact or texts that are exactly one, every value bounded, texts
  without control characters; `/data` repaired and bounded (8 index guards
  at most). Logs carry error kinds and HTTP statuses only.
- **Gladys**: reconnection (`connected`): republishes status, devices,
  states and badge (caches cleared, `forgetPublishedStates`), never reads
  sooner, never clears a block, a pause, a pin or a guard; a changed address
  or credentials restarts; the interval reschedules; the option, the ceiling
  and the language apply at once. No `publishSceneEvent` (no scene trigger
  in v1). Budget of 300 states a minute in `src/publisher.js` (one flush at
  a time).
- **gladys_version >= 5.1.0** (as the sibling local modules); **category
  `energy`**, transport `local`.
- **Demo files of the template** (`src/devices/*`, `scenes.js`, `widgets.js`,
  `weather.js` and their tests, the demo `test/config.test.js`) deleted with
  `git rm`.
- **Not checked here (PIPELINE step 1, main session)**: duplicates in the
  store, the core and the forum were checked when the batch was reserved. No
  Docker on this PC: the image was not built locally. The store validator
  (`npx github:GladysAssistant/integration-store .`) cannot be run from this
  session: to run in the real terminal (`validate.ps1`).
