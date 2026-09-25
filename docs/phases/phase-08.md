# Phase 08 record

- Date: 2026-09-25
- Commit and tag: branch `phase-08`, merged into `main`, tagged `v0.8`, milestone M2.
- Machine and model: `test`, NVIDIA RTX 3060 12 GB, unsloth/Qwen3.8-27B-GGUF UD-IQ2_XXS,
  speculative decoding auto (MTP), Studio v0.1.815-beta.
- The Lenovo stayed offline and the Mac unreachable, so the report is of one machine.

## Gate

- [x] Clean start, dev and production builds. A copy of the repository without ignored files
      installs with `npm ci` and passes every check below.
- [x] Demo on mocks. `npm run demo`, race two machines for a few rounds: the scoreboard, both
      charts, the setup with request bodies, the three exports and the blind vote all work.
- [x] Typecheck, lint, unit, integration and end-to-end tests pass: 236 unit and integration
      tests, 38 browser tests.
- [ ] Real-machine script done. Partly: one machine, so no scoreboard and no blind vote on real
      answers.
- [x] No dead UI. The Blind vote button appears only for finished races between two machines.
- [x] Earlier data still opens. Sessions moved to schema version 5, adding votes and each run's
      token timeline and request time; earlier files migrate with none of them.
- [x] README, PLAN.md and ROADMAP.md updated.

## Real-machine results

The 8K preset, cold, five rounds after a warm-up, 2 seconds apart, thinking off, max tokens 128.
The race took 130 seconds. The Markdown export is kept as
[phase-08/rtx-8k-cold-5-rounds.md](phase-08/rtx-8k-cold-5-rounds.md).

| Measure | Median | Range |
| --- | --- | --- |
| Time to first token | 15.7 s | 15.3 to 15.8 s |
| Decode speed | 22.3 tok/s | 20.9 to 25.1 tok/s |
| Prompt processing, Unsloth | 500.0 tok/s | 499.4 to 502.4 tok/s |
| Energy per run | 3,444 J | 3,355 to 3,520 J |
| Tokens per joule | 0.037 | 0.036 to 0.038 |
| Mean power while decoding | 167.6 W | 165.2 to 168.9 W |

Reading the Markdown outside the app, it stands alone. It says what ran and when, gives every
result with its spread, each round, the full setup and every setting, and explains the gate,
the network share and what "approx." means. The JSON export has the 5 rounds with their raw
events, telemetry samples and timelines, and no API key.

## Findings

- **Prompt processing is the whole wait for a long prompt.** On the 8K preset the first token
  took 15.7 s at 500 tokens per second of prompt, while the 128 tokens of output took about 5.7 s.
  The scoreboard's prompt-processing line exists for this.
- **Energy is dominated by prefill here too.** About 3,400 J per run, of which the decode part is
  about 5.7 s at 168 W, near 960 J.
- **One model on both mocks makes the tally a pair of one.** Votes between two machines running
  the same model and quant count under one label; the tally is meant for different models.

## Still to do

1. Produce the report with two machines and read its scoreboard, when the Lenovo or the Mac is
   back.
2. Blind-vote a race between two different models on real hardware.
