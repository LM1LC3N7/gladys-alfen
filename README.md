# gladys-alfen

[Gladys Assistant](https://gladysassistant.com) external integration for
**Alfen Eve** EV chargers (Single S-line, Single Pro-line, Double Pro-line,
socket 1) through their local HTTPS API: state, connector and charging state,
vehicle plugged in, charge paused, power, current and voltage per phase,
maximum station current, current set, energy index (guarded), temperature;
"Pause charging" always available, resume and the charging current behind an
off-by-default option. **Never tested with a real charger. Not affiliated
with Alfen.**

User documentation: [docs/en.md](docs/en.md) · [docs/fr.md](docs/fr.md).

## How it works

```
Gladys ⇄ SDK ⇄ src/handlers.js ⇄ src/app.js (AlfenApp)
                                  ├─ src/alfen/client.js  sessions, /api/info, login, /api/prop, parsing
                                  ├─ src/alfen/http.js    the only network access (one pinned TLS connection)
                                  ├─ src/devices.js       the device and its states (pure)
                                  ├─ src/guard.js         energy index guard (from gladys-p1-monitor)
                                  ├─ src/publisher.js     states within 300/min
                                  └─ src/store.js         /data/alfen-state.json (pin, pauses, block, guard; no secret)
```

- **One session at a time** (the charger takes one, and authenticates the
  TCP connection): every read, command or pause is one short TLS connection
  — certificate checked, identity read, login, work, logout (1 s at most),
  close. Never two at once: a command takes the charger from a read, a pause
  from anything (the session given up is closed, its read never applied).
- **Pinned certificate**: the self-signed certificate is pinned at the first
  connection (SHA-256 in `/data`) and checked BEFORE any byte is written (the
  password included); another one is refused until "Trust the new
  certificate" pins exactly the one shown.
- **Credentials**: user name (`admin` by default) and password (secret
  field), memory only. Refused: tries after 15 min, 1 h, then 6 h (kept in
  `/data`, no secret, no hash).
- **Reads**: `generic`, `states`, `meter1`, `temp` (`GET /api/prop?cat=&offset=`,
  by pages) every 60 s (configurable, 30 s – 1 h), never sooner (the time of
  the last read kept in `/data`, written at most once a minute); failures
  retried after 30 s, 1, 2, 5 min; 429 and 5xx pause, kept in `/data`; the
  temperature is secondary.
- **Device**: `ext:<selector>:alfen:<identity>` (`Identity` of `/api/info`,
  lower case), never the IP address. Readings on `energy-sensor` (W, A, V),
  the meter of socket 1 as `energy-sensor/index` (kWh) through the guard of
  gladys-p1-monitor (never 0, drops and jumps held, never confirmed by time,
  accepted in two clicks bounded to what was listed, 25 kW as its `maxKw`),
  the two currents as `electrical-vehicle-charge/target-current` (read
  only), temperature, connector and charging state.
- **Commands**: `button/push` "Pause charging" (no option, never held back:
  writes the maximum station current `2062_0` = 0; sent again when a resume
  left unconfirmed lands after it, twice at most), `button/push` "Resume
  charging" (writes back exactly the last station current read at 6 A or more; refused when none is known)
  and a `text/select` for `2129_0` (6 A to the ceiling) behind
  `allow_commands` (off by default); never a switch nor a writable binary.
  Resume and current decide on a read in the same session, check the option
  and the deadline again right before the bytes go, leave within 3.5 s of
  the click or are refused unsent, and are answered by 4.3 s (the logout
  never delays the ack); confirmed only by a read showing the value (5 s and
  20 s later); a silence or a 5xx is "sent, without confirmation". One
  change a minute.
- **Hostile answers**: 64 KB per answer, 8 KB of headers, 10 pages, parsed in
  one pass; only own fields of plain objects with their exact type; no
  answer text in the logs.

## Credits

The API, its properties, codes and the pause as a station current of 0 are
ported from [alfen_wallbox](https://github.com/leeyuentuen/alfen_wallbox)
(leeyuentuen, MIT). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
Modelled on the sibling integrations
[gladys-peblar](https://github.com/LM1LC3N7/gladys-peblar) and
[gladys-nrgkick](https://github.com/LM1LC3N7/gladys-nrgkick) (local
chargers, command rules) and
[gladys-p1-monitor](https://github.com/LM1LC3N7/gladys-p1-monitor) (energy
index guard).

## Development

```bash
npm install
npm test                                        # node --test, no network
npm run lint && npm run format:check
npm run audit                                   # npm audit --omit=dev
npm run cover                                   # cover.png, plain Node
npx github:GladysAssistant/integration-store .  # store admission checks
```

Tests never touch the network: the charger is a fake behind the injected
`connect`, Gladys is the SDK's fake; `test/http.test.js` runs the real
transport against a TLS server on the loopback with a self-signed
certificate made in the test.

## Releasing

**Actions → Release → Run workflow** (patch / minor / major): bumps the
version in `package.json` and the manifest, rolls `CHANGELOG.md`, tags, builds
the multi-arch image to GHCR and publishes the GitHub Release.

## License

Apache-2.0 (`LICENSE`). The ported logic comes from an MIT project, credited
in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) (also shipped in the
Docker image).
