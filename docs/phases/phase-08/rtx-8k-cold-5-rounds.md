# Model Duel: test

Race of 2026-09-25 00:21 UTC, 5 rounds, state done.

## Comparison · medians of 5 rounds

| Metric | test |
| --- | --- |
| First answer word (lower is better) | 15.7 s<br>15.3 s to 15.8 s · sd 216 ms |
| Time to first token (lower is better) | 15.7 s<br>15.3 s to 15.8 s · sd 216 ms |
| Time to first token, Unsloth (lower is better) | 15.7 s<br>15.2 s to 15.7 s · sd 210 ms |
| Thinking time | n/a |
| Decode speed (higher is better) | 22.3 tok/s<br>20.9 tok/s to 25.1 tok/s · sd 1.6 tok/s |
| Decode speed, Unsloth (higher is better) | 22.3 tok/s<br>20.9 tok/s to 25.1 tok/s · sd 1.6 tok/s |
| End-to-end speed (higher is better) | 6.0 tok/s<br>5.9 tok/s to 6.2 tok/s · sd 0.1 tok/s |
| Characters per second (higher is better) | 123.7 chars/s<br>115.6 chars/s to 134.5 chars/s · sd 7.5 chars/s |
| Prompt processing, Unsloth (higher is better) | 500.0 tok/s<br>499.4 tok/s to 502.4 tok/s · sd 1.2 tok/s |
| Total time | 21.3 s<br>20.8 s to 21.8 s · sd 443 ms |
| Output tokens | 128<br>128 to 128 · sd 0 |
| Energy per run, approx. (lower is better) | 3443.7 J<br>3354.6 J to 3519.9 J · sd 65.6 J |
| Tokens per joule, approx. (higher is better) | 0.037 tok/J<br>0.036 tok/J to 0.038 tok/J · sd 0.001 tok/J |
| Mean power while decoding, approx. | 167.6 W<br>165.2 W to 168.9 W · sd 1.5 W |
| Peak GPU | 100%<br>100% to 100% · sd 0% |
| Peak GPU memory or RAM | 10.7 GB<br>10.7 GB to 10.7 GB · sd 0.0 GB |
| Finish reason | length ×5 |

## Rounds

| Round | test | Flags |
| --- | --- | --- |
| Warm-up, not counted | 0.48 s · n/a |  |
| Round 1 | 15.25 s · 22.3 tok/s · RTT 0.2 ms | test stopped at Max tokens. |
| Round 2 | 15.72 s · 21.4 tok/s · RTT 0.1 ms | test stopped at Max tokens. |
| Round 3 | 15.75 s · 22.8 tok/s · RTT 0.3 ms | test stopped at Max tokens. |
| Round 4 | 15.72 s · 25.1 tok/s · RTT 0.1 ms | test stopped at Max tokens. |
| Round 5 | 15.75 s · 20.9 tok/s · RTT 0.1 ms | test stopped at Max tokens. |

## Setup

| Setting | test |
| --- | --- |
| Model | unsloth/Qwen3.8-27B-GGUF |
| Quant | UD-IQ2_XXS |
| Backend | GGUF |
| Context | 15,360 tokens |
| Slots | 4 |
| Speculative decoding | auto · mtp |
| KV cache | Unsloth default |
| GPU memory mode | auto |
| Thinking | off |
| Unsloth Studio | v0.1.815-beta |
| llama.cpp | b11139-mix-a6922cc |
| GPU | NVIDIA GeForce RTX 3060, 12 GB |
| System | Linux-6.17.0-41-generic-x86_64-with-glibc2.42 |
| Memory | 30.24 GB |
| Notes | n/a |
| Address | http://192.168.99.150:8888 |

## Settings

- Prompt: 8K, 6,326 words, starting "CHAPTER I.  INTRODUCTORY.  The subject of this Essay is not the so-called Liberty of the Will, so unfortunately opposed to the misnamed doctrine of Philosophica…"
- Max tokens 128, thinking off
- Cold prefill: a fresh line started each round's prompt and the seed was sent, so no cached prompt helped
- Sampling: temperature 0.6, top-p 0.95, top-k 20, min-p 0, repetition penalty 1, seed 42
- Plan: 5 rounds, warm-up on, 2 s between rounds, machines together
- Telemetry: on, read twice a second

## How to read this

- Times are measured by Model Duel from the moment a request left it, so they include the network. "Unsloth" rows are what Unsloth measured on the machine itself.
- A machine wins a row only when its median is more than 10 percent better than the runner-up's, or its round-to-round range does not overlap the runner-up's. Otherwise the row is a tie. Failed rounds and the warm-up never count.
- Ratio headlines cover only time to first token, speeds, prompt processing and tokens per joule, which do not depend on how much each model chose to write.
- Energy is approximate: GPU board power on NVIDIA and the GPU rail on Apple, read twice a second and added up over the run.

Made with Model Duel.
