# Phase 06 record

- Date: 2026-09-25
- Commit and tag: branch `phase-06`, merged into `main`, tagged `v0.6`.
- Unsloth version: Studio v0.1.815-beta with llama.cpp b11139-mix-a6922cc on the RTX machine.
- Machine and model for the real-machine run:

  | Name in the app | Hardware | Model | Quant | Context | Speculative decoding |
  | --- | --- | --- | --- | --- | --- |
  | test | NVIDIA RTX 3060 12 GB | unsloth/Qwen3.8-27B-GGUF | UD-IQ2_XXS | 15,360 | auto, MTP |

- The Lenovo stayed offline and the Mac unreachable, so every step ran on the RTX machine.
- Controller location: the RTX machine.

## Gate

- [x] Clean start, dev and production builds. A copy of the repository without ignored files
      installs with `npm ci` and passes every check below.
- [x] Demo on mocks. `npm run demo`, then the Text tab: warm prefill shows cache hits from round
      two while cold shows none, and the 32K preset against a 16K context is stopped by
      pre-flight.
- [x] Typecheck, lint, unit, integration and end-to-end tests pass: 213 unit and integration
      tests, 34 browser tests.
- [ ] Real-machine script done. Partly: on the RTX machine alone, and without an MLX Mac.
- [x] No dead UI. Every new control works: preset chips, prefill, the sampling panel, the
      pre-flight panel and Race anyway.
- [x] Earlier data still opens. Sessions moved to schema version 3. Versions 1 and 2 migrate on
      read as warm races with a custom prompt and their four sampling fields; the phase 4
      fixture and a unit test back this.
- [x] README, PLAN.md and ROADMAP.md updated.

## Real-machine results

Every run used thinking off and max tokens 128.

1. **32K preset.** Pre-flight counted 30,390 prompt tokens against the 15,360-token context and
   refused the race: "The prompt alone is 30,390 tokens, longer than test's context of 15,360."
   The 8K preset counted 7,606 tokens and passed.

2. **8K preset, cold, three rounds.** Cached tokens stayed at 0 in every round, well under the
   64-token threshold.

   | Round | Nonce | First token | Prompt tokens | Cached |
   | --- | --- | --- | --- | --- |
   | 1 | 78f488af9afb | 15,284 ms | 7,564 | 0 |
   | 2 | 5dd681d3cbac | 15,670 ms | 7,564 | 0 |
   | 3 | f05b4c8eb55f | 15,704 ms | 7,565 | 0 |

3. **8K preset, warm, three rounds.** Cache hits from round two, each flagged.

   | Round | First token | Prompt tokens | Cached |
   | --- | --- | --- | --- |
   | 1 | 15,600 ms | 7,547 | 0 |
   | 2 | 285 ms | 7,547 | 7,543 |
   | 3 | 258 ms | 7,547 | 7,543 |

4. **Fixed length, two rounds.** Both rounds stopped on length at 128 tokens, with no flags,
   at 22.44 and 22.64 tok/s.

## Findings

- **The cache is worth 60 times on this prompt.** A warm round of the 8K preset reached its
  first token in about 270 ms, against about 15.5 s cold. A race that mixes the two measures the
  cache, not the machine, which is why cold is the default and a warm hit is flagged.
- **The first fixed-length prompt did not work.** Asked to count upward forever, the model
  counted to ten and stopped. Asked to write out 5,000 numbers, it declined after 56 tokens. It
  keeps writing a 3,000-word essay it was asked for, which ran to Max tokens at 128 and 512
  tokens, thinking on or off. The preset now asks for that essay.
- **`/v1/chat/count_tokens` works as the plan says.** It answers `{input_tokens, model}` and
  counted the 8K preset as 7,606 tokens, with the nonce line.
- **Mill's prose is about 1.2 tokens a word** on Qwen3.8's tokenizer. The presets were sized with
  it: 6,300 words for 8K and 25,300 for 32K.
- **Machine checkboxes could undo a click.** A click at the moment the default choice arrived was
  reverted. The checkboxes now wait for the default choice.

## Still to do

1. Run the 32K preset cold for three rounds on a machine with a 32K context, and on an MLX Mac,
   and check that cached tokens stay under the threshold there too.
