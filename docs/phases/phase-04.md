# Phase 04 record

- Date: 2026-09-25
- Commit and tag: not committed yet. Tag `v0.4`, milestone M1, when commits are wanted.
- Unsloth version per machine: Studio v0.1.815-beta with llama.cpp b11139-mix-a6922cc on both
  Linux machines. The Mac is still unreachable, see phase 2.
- Machines and models at the race, as the saved setup recorded them:

  | Name in the app | Hardware | Model | Quant | Context | Speculative decoding | KV cache |
  | --- | --- | --- | --- | --- | --- | --- |
  | test | NVIDIA RTX 3060 12 GB | deepreinforce-ai/Ornith-1.0-9B-GGUF | Q4_K_M | 136,192 | off | Unsloth default |
  | lenovo (780M) | AMD Radeon 780M | unsloth/Qwen3.8-27B-GGUF | Q4_0 | 178,176 | auto, MTP | q4_0 |

- Controller location: the RTX machine, on 2.4 GHz Wi-Fi.

## Gate

- [x] Clean start, dev and production builds. A copy of the repository without ignored files
      installs with `npm ci` and passes every check below.
- [x] Demo on mocks. `npm run demo`, then the Text tab with both fake machines ticked: they race
      side by side, the faster Linux profile wins, and the race reopens from the results log.
- [x] Typecheck, lint, unit, integration and end-to-end tests pass: 181 unit and integration
      tests, 28 browser tests.
- [x] Real-machine script done on the two Linux machines. The Mac waits on its firewall.
- [x] No dead UI. Every control on the Text tab works: machine checkboxes, prompt, max tokens,
      thinking, effort, Start, Cancel, Open, Delete, the measurement details.
- [x] Earlier data still opens. Machines, probes and loads load unchanged. Races are new files in
      `data/sessions/`. Phase 3 kept runs in memory only, so there is nothing to migrate.
- [x] README, PLAN.md and ROADMAP.md updated.

## Real-machine results

The race used the Text tab of a scratch copy of the app, with a copy of `data/`. The prompt was
the default one, thinking on, max tokens 2048. The two models share no effort levels, so effort
was the model default.

Before the start, the form warned that the machines run different models and that speculative
decoding is on for the Lenovo.

| Machine | First token, measured / Unsloth | First answer word | Decode speed, measured / Unsloth | Output tokens | Finish |
| --- | --- | --- | --- | --- | --- |
| test | 202.5 / 173 ms | none | 54.87 / 54.87 tok/s | 2048 | length |
| lenovo (780M) | 3296.1 / 2948 ms | 93.2 s | 9.56 / 9.55 tok/s | 1031 | stop |

- The requests left 1.1 ms apart.
- The Lenovo kept 646 of 770 drafted tokens, 84 percent.
- The event loop was late by at most 12.6 ms.
- The race took 112 s and was saved as a 101 KB file with 3,084 raw events and no API key.

Checks:

1. **Race:** done, as above.
2. **Reopen:** after restarting the scratch server, the results log listed the race, and **Open**
   showed it again under its own address.
3. **Provenance:** the Setup table names both models, both quants and both backends. It marks
   model, quant, speculative decoding and KV cache as different.

## Findings

- **A thinking model can use all of Max tokens without answering.** Ornith thought for all 2048
  tokens. In the earlier single-machine runs, every thinking run on both machines did the same at
  the default effort. The answer box
  used to stay empty with no reason given, while the thinking block held the model's drafts. It
  now says the model used all the tokens thinking and what to change. The measurements note the
  Max tokens stop, and effort starts at low where the models offer it.
- **Joining a race mid-stream could repeat text.** A snapshot already held text that the next
  update also carried. Joining now flushes pending text first. An integration test joins a race
  mid-stream and checks that the text adds up for every machine.
- **Wi-Fi delay varies a lot.** The Lenovo's first token came 348 ms after Unsloth's own clock
  here, against 50 to 71 ms in phase 3. Ping to the Lenovo was 18 to 144 ms, averaging 64 ms,
  against 1.6 to 164 ms before. Decode speed still agreed within 0.1 percent.
- **Total time and token counts are not starred.** Ornith's total looked best only because it
  stopped at Max tokens.
- **The two machines no longer run the same model.** The RTX machine now has Ornith 9B with
  speculative decoding off, and the Lenovo has Qwen3.8 27B with MTP. That race compares models
  as well as hardware, and the form says so.

## Still to do

1. Mac: open the firewall as described in phase 2, add it again, and race it against a Linux
   machine.
2. For a hardware race, load the same model and quant on both machines with speculative decoding
   off, then race with thinking off or with enough Max tokens.
3. Commit and tag `v0.4` when commits are wanted.
