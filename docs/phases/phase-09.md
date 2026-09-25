# Phase 09 record

- Date: 2026-09-25
- Commit and tag: branch `phase-09`, merged into `main`, tagged `v0.9`.
- Machine: `test`, NVIDIA RTX 3060 12 GB, Studio v0.1.815-beta, with
  unsloth/Qwen3.8-27B-GGUF UD-IQ2_XXS loaded for chat.
- The Lenovo stayed offline and the Mac unreachable.

## Gate

- [x] Clean start, dev and production builds. A copy of the repository without ignored files
      installs with `npm ci` and passes every check below.
- [x] Demo on mocks. `npm run demo`, Transcribe tab: race both mocks on the LibriSpeech clip for
      two rounds with a warm-up; real-time factor, word error rate with the wrong words marked,
      the scoreboard, upload and processing bars, the power chart, the stats, the setup and the
      exports all work. An uploaded file with pasted text gets a word error rate.
- [x] Typecheck, lint, unit, integration and end-to-end tests pass: 255 unit and integration
      tests, 42 browser tests.
- [ ] Real-machine script done. Partly: pre-flight only, on the RTX machine (below). A race loads
      a Whisper model next to the loaded chat model, and loading models on Mani's machines waits
      for a go-ahead.
- [x] No dead UI. Engines, models and devices come from each machine's STT status; the blind
      vote is offered for text only, where there is no reference to score against.
- [x] Earlier data still opens. Sessions moved to schema version 6, adding the workload, each
      run's transcription, and the STT status before and after; earlier files open as text.
- [x] README, PLAN.md and ROADMAP.md updated.

## Real-machine results

Read-only, through a scratch server on port 3073 with a copy of `data/`:

| Check | Result |
| --- | --- |
| STT status | available; nothing in memory; keep-alive 300 s |
| Engines | transformers, gguf and mtmd available; only gguf has a model on disk, `large-v3-turbo` |
| Pre-flight, clip, `large-v3-turbo` on gguf | all clear; audio 70.295 s, 2,249,484 bytes |
| Pre-flight, clip, `small` on gguf | stopped: "small is not downloaded for gguf on test (it has large-v3-turbo)" |

So whisper.cpp is built on the RTX machine, which answers open question 2 for it.

## Findings

- **Loading a model that is not on disk downloads it.** Unsloth's STT load starts a download
  rather than failing, so pre-flight treats a model missing from `downloaded_models` as an error.
- **Scoring must wait for the round.** Aligning a 30-minute transcript word by word takes a
  moment of CPU. Done while another machine is still transcribing, it would delay that machine's
  timestamps, so word error rate is computed after every machine has answered.
- **Four tabs overflowed a phone.** The page tabs now wrap, with narrower padding under 560 px.
- **A running race read "failed" in the results log** for machines that had not finished a run
  yet. It reads "starting" now. This was there since phase 4.
- The Text tab moved onto shared race code (`useRace`, `usePreflight`, `RaceParts`), which the
  Transcribe tab and later workloads reuse. Its 38 browser tests pass unchanged apart from the
  schema version.

## Still to do

1. With a go-ahead: race `large-v3-turbo` on gguf, three rounds, on the RTX machine, and confirm
   the served engine and device read back as gguf on CUDA.
2. When the Mac is back: confirm it falls back to transformers when whisper.cpp is missing, and
   that pre-flight warns.
