# Phase 01 record

- Date: 2026-09-24
- Commit and tag: not committed yet. Tag `v0.1` once the real-machine script below is done.
- Unsloth version per machine: pending. The probe reports it once a key is added.
- Machines: the Linux development machine runs the Unsloth desktop app. The Mac is pending.
- Controller location: the Linux development machine, for the automated checks.

## Gate

- [x] Clean start, dev and production builds. `npm run dev` serves port 3000 with the API
      proxied to 3001. `npm run build && npm start` serves the built client, deep links and the
      API. A copy of the repository without ignored files installs with `npm ci` and passes
      every check below.
- [x] Demo on mocks. `npm run demo` starts both fake machines and the app with both added and
      probed.
- [x] Typecheck, lint, unit, integration and end-to-end tests pass: 83 unit and integration
      tests, 6 browser tests.
- [ ] Real-machine script done. Partly: see below.
- [x] No dead UI. The Machines screen is the only screen. Nothing from later phases is shown.
- [x] Earlier data still opens. First phase. `machines.json` carries `schemaVersion: 1`, and
      the app refuses a damaged or newer file instead of overwriting it.
- [x] README and PLAN.md updated.

## Real-machine results

### Done

The Unsloth desktop app on the Linux development machine was probed without a key at
`127.0.0.1:8888`. It is reachable, and the probe correctly asks for a key. The recording is
`fixtures/probe/real-linux-no-key.json`. These real answers were checked by hand and are pinned
in `mock/test/mock.test.ts`, so the fake server answers the same way:

| Request                                  | Real answer                                        |
| ---------------------------------------- | -------------------------------------------------- |
| `GET /api/health`, no key or a wrong key | 200 with base fields only, no version              |
| Protected route, no key                  | 401 `{"detail":"Not authenticated"}`               |
| Protected route, wrong key               | 401 `{"detail":"Invalid or expired API key"}`      |
| `/v1/models`, no key                     | 401 in the OpenAI error shape                      |
| Unknown route                            | 404 `{"detail":"API endpoint not found"}`          |

### Probes with API keys, 2026-09-24

The app probed three machines with their keys. Two are fully green on Unsloth 2026.9.11: the
Linux machine with an RTX 3060 on CUDA, and a Lenovo with an AMD Radeon 780M on ROCm. The
MacBook M4 at 192.168.99.91 resets the connection on port 8888, most likely its firewall; the
phase 2 record describes the fix.

### Still to do

1. On each machine, in Unsloth: **Settings → API → Remote & LAN → Start**, turn on **Start
   automatically**, and create an API key.
2. On the third machine, run `npm run build && npm start`, open http://localhost:3000, add both
   machines and probe them. Expect every chip green, except that a Mac without whisper.cpp
   shows a note about it.
3. Run the app on the Linux machine instead, with its own Unsloth at `127.0.0.1` and the Mac
   over the LAN, and probe both.
4. Press **Export probe** on both cards and save the files in `docs/phases/phase-01/`. Compare
   them with PLAN.md section 2. To also make them test fixtures, run
   `UNSLOTH_API_KEY=<key> npm run record:probe -- --url <address> --name real-<machine>`.
5. Record the Unsloth versions above, tick the real-machine gate item, then commit and tag
   `v0.1`.

## Findings

- TypeScript is pinned to 6.0. TypeScript 7 is current, but typescript-eslint 8.70 supports
  versions below 6.1 only.
- undici 8 needs Node 22.19 or newer. `package.json` and PLAN.md now say so.
- Playwright 1.63 needs a Chromium build that was not cached here. The browser tests use the
  installed Google Chrome when there is one, and Playwright's own Chromium otherwise.
- Unsloth's health route answers without a key and silently ignores a wrong one, so the probe
  checks the key on `/api/inference/status`.
- Apple Silicon reports no GPU power on its first reading, because the value is a difference
  between two readings. The probe shows "power n/a" then. Phase 7 must drop that first sample.
