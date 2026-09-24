# Phase 05 record

- Date: 2026-09-25
- Commit and tag: branch `phase-05`, merged into `main`, tagged `v0.5`.
- Unsloth version: Studio v0.1.815-beta with llama.cpp b11139-mix-a6922cc on the RTX machine.
- Machine and model for the real-machine run:

  | Name in the app | Hardware | Model | Quant | Speculative decoding |
  | --- | --- | --- | --- | --- |
  | test | NVIDIA RTX 3060 12 GB | unsloth/Qwen3.8-27B-GGUF | UD-IQ2_XXS | auto, MTP |

- The Lenovo was offline during this phase: no answer to ping or to Unsloth. The Mac is still
  unreachable.
- Controller location: the RTX machine.

## Gate

- [x] Clean start, dev and production builds. A copy of the repository without ignored files
      installs with `npm ci` and passes every check below.
- [x] Demo on mocks. `npm run demo`, then the Text tab: three rounds with a warm-up give a round
      table and medians, and equal speeds give a tie.
- [x] Typecheck, lint, unit, integration and end-to-end tests pass: 194 unit and integration
      tests, 31 browser tests.
- [ ] Real-machine script done. Partly: five rounds on the RTX machine alone, see below.
- [x] No dead UI. Every new control works: rounds, warm-up, pause, order, the take-turns
      suggestion, and picking a round in the round table.
- [x] Earlier data still opens. Sessions moved to schema version 2, and version 1 files are
      migrated on read. `fixtures/sessions/phase4-race-v1.json`, a race saved by phase 4, backs
      the migration test.
- [x] README, PLAN.md and ROADMAP.md updated.

## Real-machine results

Five rounds after a warm-up, 2 seconds apart, on the RTX machine. The prompt was the default
one, thinking off, max tokens 256.

| Round | RTT median | First token, measured / Unsloth | Decode speed, measured / Unsloth | Output tokens | Cached prompt tokens |
| --- | --- | --- | --- | --- | --- |
| 1 | 0.176 ms | 426.6 / 395 ms | 22.83 / 22.73 tok/s | 230 | 0 |
| 2 | 0.154 ms | 367.3 / 347 ms | 22.44 / 22.32 tok/s | 179 | 30 |
| 3 | 0.217 ms | 369.2 / 340 ms | 22.48 / 22.37 tok/s | 202 | 30 |
| 4 | 0.132 ms | 371.7 / 343 ms | 22.57 / 22.43 tok/s | 170 | 30 |
| 5 | 0.106 ms | 366.2 / 338 ms | 23.29 / 23.18 tok/s | 210 | 30 |

Baseline noise level of this setup:

| Measure | Median | Range | Standard deviation |
| --- | --- | --- | --- |
| RTT | 0.154 ms | 0.106 to 0.217 ms | 0.042 ms |
| First token, rounds 2 to 5 | 368.2 ms | 366.2 to 371.7 ms | 2.4 ms |
| Decode speed | 22.57 tok/s | 22.44 to 23.29 tok/s | 0.35 tok/s |

- Decode speed varies by 1.6 percent of the median from round to round. The winner gate's
  10 percent is well above that, so a win means something here.
- The first token of round 1 took 58 ms longer, because rounds 2 to 5 found the prompt's first
  30 tokens in Unsloth's cache. Phase 6 adds cold prefill to take the cache out of the result.
- MTP kept 1 to 6 of every 64 to 128 drafted tokens.
- The controller's event loop was late by at most 14.7 ms.

## Findings

- **Unsloth's HTTP answers stall for about 40 ms on a reused connection.** A health request on a
  fresh connection answered in 2.5 ms. On one kept-alive connection, every request after the
  first took 42 to 45 ms, with curl and with undici alike. That is Nagle's algorithm meeting
  delayed ACKs on Unsloth's side. The roadmap's "health requests on the keep-alive socket"
  therefore measured the stall, 43 ms, not the network. The RTT is now three TCP handshakes to
  the Unsloth port: 0.15 ms on loopback. Streams are not affected, because each run opens a new
  connection.
- **Prompt caching crosses rounds.** Rounds after the first reuse the cached start of the prompt,
  so their first tokens come sooner. The notes under the measurements show the cached count.
- **Two machines at the same speed now tie.** On the mocks with the same speed pattern, every
  timing row says tie. One round alone can only win on the 10 percent gap.

## Still to do

1. Race the Lenovo, and the Mac once it is reachable, for five rounds against the RTX machine,
   and add the RTT and spread of each to this record.
