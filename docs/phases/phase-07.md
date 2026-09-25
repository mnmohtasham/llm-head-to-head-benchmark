# Phase 07 record

- Date: 2026-09-25
- Commit and tag: branch `phase-07`, merged into `main`, tagged `v0.7`.
- Unsloth version: Studio v0.1.815-beta on the RTX machine.
- Machine and model: `test`, NVIDIA RTX 3060 12 GB, unsloth/Qwen3.8-27B-GGUF UD-IQ2_XXS,
  speculative decoding auto (MTP).
- The Lenovo stayed offline and the Mac unreachable. The RTX machine is also the controller, so
  its chips could be checked against `nvidia-smi` directly.

## Gate

- [x] Clean start, dev and production builds. A copy of the repository without ignored files
      installs with `npm ci` and passes every check below.
- [x] Demo on mocks. `npm run demo`: the chips move during a race, and energy appears in the
      comparison.
- [x] Typecheck, lint, unit, integration and end-to-end tests pass: 226 unit and integration
      tests, 36 browser tests.
- [ ] Real-machine script done. Partly: the RTX machine only.
- [x] No dead UI. The chips, the Telemetry switch on the Machines screen and in the race form,
      and the energy rows all work.
- [x] Earlier data still opens. Sessions moved to schema version 4; earlier files migrate with
      telemetry off. A new `data/settings.json` holds the switch.
- [x] README, PLAN.md and ROADMAP.md updated.

## Real-machine results

1. **Chips against nvidia-smi.** Eight seconds of samples, with `nvidia-smi` read every half
   second at the same time. Samples came every 498 ms on median, 489 to 516 ms.

   | Reading | Model Duel | nvidia-smi |
   | --- | --- | --- |
   | GPU | 1.0% | 1.0% |
   | Power | 10.03 W | 10.02 W |
   | Temperature | 48 °C | 48 °C |
   | VRAM used | 10.71 GB | 10.71 GB |

2. **Energy against mean power times duration.** Three rounds of the fixed-length preset,
   256 tokens, cold, with telemetry on.

   | Round | Energy, integral | Mean power × duration | Decode power | Tokens per joule | Peak GPU |
   | --- | --- | --- | --- | --- | --- |
   | 1 | 1,876 J | 164.0 W × 11.92 s = 1,955 J | 162.2 W | 0.136 | 98% |
   | 2 | 1,685 J | 164.6 W × 10.66 s = 1,755 J | 163.4 W | 0.152 | 100% |
   | 3 | 1,884 J | 165.0 W × 11.64 s = 1,921 J | 167.6 W | 0.136 | 98% |

   The integral is 2 to 4 percent below the simple product, because it follows the power ramp at
   the start of each run instead of averaging over it.

3. **Cost of polling.** Same three rounds with telemetry on and off, and Unsloth's CPU time over
   ten idle seconds with and without polling.

   | Measure | Telemetry on | Telemetry off |
   | --- | --- | --- |
   | Unsloth CPU per 10 s, with its child processes | 1.22 s | 0.26 s |
   | Decode speed, rounds | 22.36, 25.13, 24.16 tok/s | 22.61, 22.71, 22.47 tok/s |
   | First token, median | 515 ms | 498 ms |

   Polling costs Unsloth about a tenth of a CPU core, because every hardware reading runs
   `nvidia-smi`. The speed differences are within the round-to-round noise of this machine, which
   decodes with speculative decoding on, so the polling cost did not show in the timings.

## Findings

- **Unsloth's readings are exactly `nvidia-smi`'s.** The chips can be trusted on NVIDIA.
- **Polling has a real cost on the machine, not in the timings.** About 0.1 CPU core on this
  machine. The switch exists for runs where that matters.
- **The baseline adds 10 seconds to a race.** Five seconds before and after, as the plan asks.
  The browser tests shorten it with `MODEL_DUEL_TELEMETRY_BASELINE_MS`.

## Still to do

1. Compare the chips with Unsloth's own GPU monitor on the Lenovo, whose power comes from
   `amd-smi` or `rocm-smi`, and on the Mac, whose first power reading is null.
