# Phase 18 record

- Date: 2026-09-26
- Commit and tag: branch `lmstudio`, tested by Mani, merged into `main` by pull request, tagged `v1.8`.
- Added at Mani's request: "implement the LM Studio support in a new branch so I can test. One of
  the machines already has LM Studio running at 192.168.99.240:1234."

## Gate

- [x] Clean start, dev and production builds. A copy of the repository without ignored files
      installs with `npm ci` and passes every check below.
- [x] Demo on mocks: `npm run demo` adds "Mock LM Studio" next to the fake Unsloth machines.
- [x] Typecheck, lint, unit, integration and end-to-end tests pass: 392 unit and integration
      tests, 60 browser tests.
- [x] Real machines: the probe ran against the Lenovo's LM Studio, and Mani raced it against the RTX
      machine (below).
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

No chat request was sent before a model was loaded: LM Studio would have loaded one just in time,
which changes the machine's GPU memory.

Mani then loaded Bonsai 27B Q1_0 in LM Studio (context 8,192, 4 at once, flash attention on) and
raced it against medgemma 1.5 4B on the RTX machine, three rounds with thinking off. Every LM Studio
run finished, with LM Studio's own stats read from the end of its real stream:

| Round | First token, Model Duel | First token, LM Studio | Decode, Model Duel | Decode, LM Studio |
| --- | --- | --- | --- | --- |
| 1 | 1,403 ms | 1,150 ms | 7.99 tok/s | 7.93 tok/s |
| 2 | 1,374 ms | 1,102 ms | 8.00 tok/s | 7.92 tok/s |
| 3 | 1,391 ms | 1,104 ms | 8.00 tok/s | 7.92 tok/s |

The decode speeds agree within 1 percent, as Unsloth's do. Model Duel's first token comes about
270 ms after LM Studio's own count, which is the network and LM Studio's handling of the request
before its clock starts.

## Findings

- **The Models pane** first listed every downloaded model expanded, with its own buttons. Mani asked
  for it to look like the Unsloth panes, and it now does: the loaded model and its settings, Load
  model, Unload and Refresh in the same place, a load timer, and the models in a collapsed,
  filterable list whose rows open a load dialog.
- `/lmstudio-greeting` answers `{"lmstudio": true}`, which tells LM Studio apart from Unsloth or
  anything else on a port. LM Studio reports no version over HTTP.
- LM Studio's reasoning options go beyond its docs: Qwen3.8 27B offers `off, low, medium, xhigh,
  on`. Model Duel takes the options each model lists.
- The OpenAI-compatible endpoint returns no timings (an open LM Studio bug), so races use LM
  Studio's native chat, whose last event carries its time to first token and tokens per second.

## Still to do

1. Hardware telemetry for LM Studio machines, from the agent or from Unsloth on the same computer.
