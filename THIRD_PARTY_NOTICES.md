# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`).

## alfen_wallbox

Its Alfen client (`src/alfen/client.js`, the routes, property ids, status
codes, mode 3 states and model names of `src/constants.js`) is a JavaScript
port of parts of **alfen_wallbox** (<https://github.com/leeyuentuen/alfen_wallbox>,
commit aa88b47 of 2026-10-06), the Home Assistant integration for Alfen
chargers maintained by leeyuentuen: the local HTTPS API (`/api/info`, the
login with its display name and the bearer token of newer firmware, the
logout, `/api/prop` read by category and by pages, a property written), the
one-session-at-a-time constraint, the pause written as a maximum station
current of 0 (`2062_0`), the socket current (`2129_0`), the meter of socket 1
(`2221_*`), the status (`2501_2`) and mode 3 state (`2501_4`) tables, and the
product codes. No Python code runs here and alfen_wallbox is not a
dependency. Its license:

```
MIT License

Copyright (c) 2020 Jimmy Everling

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

The test fixtures (`test/fixtures/fakeAlfen.js`) are shaped like the examples
of `doc/alfen_props.md` and the tests of alfen_wallbox; their values are made
up.

## Sibling integrations (same project, Apache-2.0)

- The energy index guard (`src/guard.js`, `test/guard.test.js`) is taken as
  it is from gladys-p1-monitor (<https://github.com/LM1LC3N7/gladys-p1-monitor>),
  with the limits as a parameter as in gladys-nrgkick.
- The publisher and the command rules follow gladys-peblar
  (<https://github.com/LM1LC3N7/gladys-peblar>) and gladys-nrgkick
  (<https://github.com/LM1LC3N7/gladys-nrgkick>); the self-signed certificate
  of the TLS tests (`test/fixtures/selfSigned.js`) comes from gladys-my-pv.

Alfen and Eve are trademarks of Alfen N.V. This project is not affiliated
with, endorsed by or supported by Alfen.
