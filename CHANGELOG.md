# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- Alfen Eve chargers (Single S-line, Single Pro-line, Double Pro-line,
  socket 1) read over their local HTTPS API (no cloud): one device, keyed by
  the identity of the charger.
- One short session at a time on the charger (connect, login, read, logout,
  close), so that the Alfen app can still log in; never two at once.
- The self-signed certificate pinned at the first connection and checked
  before anything is written, the password included; a changed certificate
  stops everything until "Trust the new certificate" pins exactly the one
  shown.
- State, status of the charger, connector and charging state
  (charging-station category), vehicle plugged in, charge paused, error,
  power, current and voltage per phase, maximum station current, charging
  current set, temperature (read only).
- The meter of the socket as an energy index, through the guard of the P1
  Monitor integration: never 0, drops and jumps held (kept in `/data`), never
  confirmed by time, accepted only by the "Accept the held index" action, in
  two clicks bounded to what the first one listed.
- "Pause charging" button (maximum station current at 0 A), always available
  and never held back (not by a command in flight, the minute between
  changes, a 429/5xx pause, a failed read, nor a restart), sent again when a
  resume left unconfirmed lands after it; during refused credentials, one
  login at most every 5 minutes (a pause that goes through lifts the block).
  It reads the station current first only when that costs it nothing (never
  during a 429/5xx pause or a block, and only when time covers a new
  session): nothing written when already paused.
- "Resume charging" button (exactly the last station current read at 6 A or
  more, kept in `/data`, refused when none is known, shown in the status during a pause) and a
  charging current list (6 A to a ceiling of 16 A by default, lowered by the
  maximum station current), refused unless "Allow resuming and the charging
  current" is on (off by default); resume refused without a vehicle plugged
  in; one change a minute (not spent by a refused write).
- Never two sessions on the charger; a session pins nothing and sends no
  password once the address or the credentials changed; the first pin must
  be written to `/data` before the password leaves; "Trust the new
  certificate" in two clicks; TLS 1.2 at least; the password sent as typed;
  interim HTTP answers (100 Continue) skipped.
- Reads every 60 s (configurable), never sooner, restarts and reconnections
  included; failures retried after 30 s to 5 minutes; 429 and 5xx pause,
  kept in `/data`; refused credentials are tried again after 15 min, 1 h,
  then every 6 h, kept in `/data` (no secret in it).
- "Test the connection" button; documentation in English and French;
  `LICENSE` and `THIRD_PARTY_NOTICES.md` shipped in the image.
