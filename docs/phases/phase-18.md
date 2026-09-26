# Phase 18 record

- Date: 2026-09-26
- Commit: branch `lmstudio`, for Mani to test before it is merged and tagged `v1.8`.
- Added at Mani's request: "implement the LM Studio support in a new branch so I can test. One of
  the machines already has LM Studio running at 192.168.99.240:1234."

## Gate

- [x] Clean start, dev and production builds. A copy of the repository without ignored files
      installs with `npm ci` and passes every check below.
- [x] Demo on mocks: `npm run demo` adds "Mock LM Studio" next to the fake Unsloth machines.
- [x] Typecheck, lint, unit, integration and end-to-end tests pass: 392 unit and integration
      tests, 60 browser tests.
- [ ] Real machines: the probe ran against the Lenovo's LM Studio (below). A real race waits for a
      loaded model, which only Mani loads or approves.
- [x] No dead UI: LM Studio machines appear on Machines, Models, Text and Results; the tabs that need
      Unsloth leave them out.
- [x] Earlier data still opens: machines saved before read as Unsloth.
- [x] README, PLAN.md (section 2.8), ROADMAP.md and `docs/result-format.md` updated.

## Real LM Studio

The Lenovo runs LM Studio 0.4.25 at 192.168.99.240:1234, with no token required and no model
loaded. Read-only, Model Duel's probe found it reachable (round trip 6.6 ms), answering without a
token, with 9 chat models and one embedding model downloaded. It borrowed the GPU (AMD Radeon 780M,
28 GB shared), memory and system from the last probe of "lenovo (780M)", Mani's Unsloth machine at
the same address. Its model list is saved as `fixtures/lmstudio/models-0.4.25.json` and the unit
tests read it.

No chat request was sent: with no model loaded, LM Studio would have loaded one just in time,
which changes the machine's GPU memory.

## Findings

- `/lmstudio-greeting` answers `{"lmstudio": true}`, which tells LM Studio apart from Unsloth or
  anything else on a port. LM Studio reports no version over HTTP.
- LM Studio's reasoning options go beyond its docs: Qwen3.8 27B offers `off, low, medium, xhigh,
  on`. Model Duel takes the options each model lists.
- The OpenAI-compatible endpoint returns no timings (an open LM Studio bug), so races use LM
  Studio's native chat, whose last event carries its time to first token and tokens per second.

## Still to do

1. With Mani's go-ahead, load one model in LM Studio on the Lenovo and race it against the same
   model under Unsloth, to confirm the stream against a real LM Studio.
2. Hardware telemetry for LM Studio machines, from the agent or from Unsloth on the same computer.
