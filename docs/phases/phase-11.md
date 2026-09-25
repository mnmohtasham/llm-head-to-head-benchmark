# Phase 11 record

- Date: 2026-09-25
- Commit and tag: branch `phase-11`, merged into `main`, tagged `v1.1`.
- Machine: `test`, NVIDIA RTX 3060 12 GB, Studio v0.1.815-beta, unsloth/Qwen3.8-27B-GGUF
  UD-IQ2_XXS with speculative decoding auto (MTP), context 15,360, already loaded with 4 slots.
- The Lenovo stayed offline and the Mac unreachable.

## Gate

- [x] Clean start, dev and production builds. A copy of the repository without ignored files
      installs with `npm ci` and passes every check below.
- [x] Demo on mocks. `npm run demo`, Text tab, Throughput with 4 requests at once: pre-flight
      stops the race because the mocks load with 1 slot, **Reload with 4 slots** fixes both, and
      the race shows the aggregate speed, 4/4 requests, the comparison, the round table and the
      per-request table.
- [x] Typecheck, lint, unit, integration and end-to-end tests pass: 280 unit and integration
      tests, 46 browser tests.
- [x] Real-machine script done, on one machine: 1, 2 and 4 requests at once (below). It needed no
      reload, since the model already had 4 slots; the second machine is still offline.
- [x] No dead UI. Requests at once shows only in throughput mode; the reload shortcut only on a
      slot error.
- [x] Earlier data still opens. Sessions moved to schema version 8, adding the mode and the number
      of requests to the text config and the batch to each run; earlier files are latency races.
- [x] README, PLAN.md and ROADMAP.md updated.

## Real-machine results

The short preset, cold prefill, Max tokens 128, thinking off, a warm-up and two rounds, 2 s apart.
Two values per cell: round 1 and round 2.

| Requests at once | Total speed (tok/s) | Each request (tok/s) | First token, median (ms) | Tokens, all requests | Tokens per joule | Time for all (ms) |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 18.1, 17.7 | 24.0, 24.1 | 463, 514 | 34, 34 | 0.169, 0.166 | 1,881, 1,924 |
| 2 | 29.1, 27.9 | 19.8, 20.2 | 621, 645 | 68, 78 | 0.256, 0.227 | 2,341, 2,793 |
| 4 | 37.2, 38.0 | 12.7, 12.6 | 960, 1,035 | 136, 169 | 0.285, 0.278 | 3,659, 4,448 |

No request waited for a slot at any level: the monitor's queue showed up to 1, 2 and 4 busy of 4
slots and nothing queued.

## Findings

- **Four requests at once deliver about twice the tokens of one on the RTX 3060**, 37.6 against
  17.9 tok/s, while each request drops from 24 to 12.6 tok/s and the first token takes about twice
  as long. Energy efficiency rises with it, from 0.17 to 0.28 tokens per joule, because the GPU
  draws little more for four streams than for one.
- **The short prompt makes aggregate speed pessimistic.** Each answer was about 34 tokens, so the
  prompt processing of every request is a large share of the time. A longer answer, for example the
  fixed-length preset, shows the decode-bound curve.
- **`/v1/props` reports `n_ctx` 15,360 with 4 slots**, the same as the status's context length, so
  it is not clear from the API whether each slot gets the whole context or a quarter. Pre-flight
  therefore only warns when a prompt might not fit a quarter.
- **Speculative decoding was on (auto, MTP).** Its drafts help one stream more than four sharing
  the GPU, which may exaggerate the per-request slowdown. Load with speculative decoding off for a
  like-for-like curve.

- **Deleting a race just after it finished could be refused as still running,** because its end
  time shows before its file is saved. It showed up once the added tests loaded the CPU. Delete now
  waits for that last save, so the file cannot come back after it. The one timing test that checks
  the first token to 20 ms also retries twice now, since a busy test machine delays both clocks.

## Still to do

1. The same curve on the Lenovo or the Mac, when either is back, and with the fixed-length preset.
2. A curve with speculative decoding off, after Mani loads the model that way.
