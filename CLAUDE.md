# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration**: a Node.js service (Node 22+, ESM,
no build step) that runs in its own sandboxed Docker container and talks to
Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency. It started from the official JavaScript template.

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/app.test.js              # one file
node --test --test-name-pattern "pause"   # tests whose name matches
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npx github:GladysAssistant/integration-store .   # store admission checks
```

The CI (`.github/workflows/ci.yml`) runs `format:check`, `lint` and `test` on
Node 22 and 24, and builds the Docker image: run the three commands before
pushing.

## Architecture

```
index.js                          SDK wiring only: handlers registered before connect()
src/handlers.js                   SDK handlers -> AlfenApp (shared with the tests)
src/app.js                        sessions, polling, device, states, status, commands, pin
src/devices.js                    device and states of the charger (pure); feature roles are frozen
src/alfen/client.js               one session (pin, identity, login, pages, write, logout), pure parsers
src/alfen/http.js                 one TLS connection, HTTP/1.1 requests on it, bounded parser, error kinds
src/guard.js                      energy index guard, taken as it is from gladys-p1-monitor
src/store.js                      /data/alfen-state.json: pin, pauses, block, guard; no secret
src/publisher.js                  states to Gladys within 300 per minute
src/config.js                     DEFAULT_CONFIG (mirrors the manifest defaults) + normalization
src/i18n.js                       English and French runtime texts
scripts/cover.mjs                 cover.png generator (plain Node, no dependency)
gladys-assistant-integration.json manifest: name, config_schema, actions, image...
docs/en.md, docs/fr.md            user documentation, re-hosted by Gladys (mandatory)
test/                             node --test, against the SDK's fake Gladys (integration-sdk/testing)
.github/scripts/release.mjs       release helpers (manifest bump, changelog), tested in test/
```

## Rules

- **External ids are forever.** Build them with
  `gladys.externalIds(type, platformId)`, `platformId` being the unique id the
  platform gives the device (here the `Identity` of the charger), never a
  label. Gladys keys devices, their history, scenes and dashboards on them:
  changing one creates a new device and orphans the old one. The same goes
  for every key users store: manifest `config_schema`, `actions`, feature
  keys.
- **The container rootfs is read-only.** Write only under `/data`, the one
  writable volume. Never log, store or show the password or the session
  token; never keep the body of an HTTP answer in an error. A `secret` field
  is "kept by Gladys in its database, never shown again", never described as
  protected otherwise.
- **Versions belong to the Release workflow** (Actions → Release). Never edit
  `version` in `package.json` or in the manifest, nor the `docker_image` tag,
  by hand — except on the README's hand-pushed tag path, which bumps all three
  together before tagging. `test/manifest.test.js` checks they agree.
- **Changelog.** Every user-visible change adds a line under `## [Unreleased]`
  in `CHANGELOG.md` (`### Added`, `Changed`, `Fixed`, `Removed`, `Security`).
  Never write a version heading: the Release workflow moves the section, and it
  becomes the notes of the GitHub Release.
- **Manifest.** Texts are multi-language objects `{ "en": ..., "fr": ... }`:
  `label`, `description` and `placeholder` alike, never a plain string. The
  catalog `description` holds 10 to 100 characters per language.
  `test/manifest.test.js` ties the manifest to the code: change both sides
  together.
- **User-facing text** is bilingual (English and French): action messages,
  manifest texts, and `docs/en.md` / `docs/fr.md`, kept in sync. Files are
  UTF-8 without BOM and without control bytes (`test/encoding.test.js`).
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never touch the network (the TLS tests use the loopback).
- **Alfen.** The charger takes ONE session at a time and authenticates the
  TCP connection: never two sessions at once (`app.session`), each one short
  and logged out. The certificate is checked against the pin BEFORE any byte
  is written. The identity is read in every session; an unreadable one is not
  another charger. Never a read sooner than the interval (button, Discovery,
  reconnection, unchanged save, restart). A late answer of an old session or
  configuration publishes nothing (generation and `aborted` checked after
  every await). Commands stay buttons and a select (never a switch); only
  `2062_0` (pause 0, resume) and `2129_0` (current) are ever written. "Pause
  charging" needs no option and is never held back (in flight, the minute, a
  429/5xx pause, before the first read; a block allows one login every
  5 minutes); resume and current are behind `allow_commands` (off), decided
  on a read of the same session, checked again in `beforeSend` (option,
  deadline, a pause arrived, the ceiling), one a minute; the resume writes
  back exactly the station current kept at the pause (refused when none). A command is confirmed
  only by a read of the value asked. The energy index goes through
  `src/guard.js` only.
