# Phase 19 record

- Date: 2026-09-27
- Commit and tag: branch `phase-19`, merged into `main`, tagged `v1.9`.
- Asked by Mani: "I do not want this video benchmark. Remove it from the documentation and the app
  itself."

## Gate

- [x] Clean start, dev and production builds. A copy of the repository without ignored files
      installs with `npm ci` and passes every check below.
- [x] Demo on mocks: `npm run demo` starts no agents and shows no Command tab.
- [x] Typecheck, lint, unit, integration and end-to-end tests pass: 375 unit and integration
      tests, 57 browser tests.
- [x] Real data: Mani's data has no video encode race and no machine with an agent; all 31 of his
      result files still validate against the new JSON Schema.
- [x] No dead UI: no Command tab, no agent fields, no Command kind on the Results tab.
- [x] Earlier data still opens (below).
- [x] README, PLAN.md, ROADMAP.md, `docs/result-format.md` and `docs/share-api.md` updated; the
      phase 12 record is kept and marked removed.

## What went

- The Command tab and its pane, the command workload (sessions, pre-flight, metrics, report
  sections, Results rows and sent records), the `agent/` workspace with its fake encode, the server's
  agent client and `GET /api/machines/:id/agent`, and the agent address and token on machines.
- The demo's fake agents and the browser tests' agent ports.
- The documentation of all of it.

## What stayed, and why

- Result files keep `machines[].state.agent` and `details.command`, always null: the published JSON
  Schema requires them, and removing them would make every result file written so far invalid.
  `docs/result-format.md` says so. `command` is no longer a `workload` or `kind`.
- A machines file with an agent address or token opens as before; the two fields are dropped the
  next time the file is written. A saved video encode race is skipped at start with a log line,
  since nothing can show it any more.
