# Phase 10 record

- Date: 2026-09-25
- Commit and tag: branch `phase-10`, merged into `main`, tagged `v1.0`, milestone M3.
- Machine: `test`, NVIDIA RTX 3060 12 GB, Studio v0.1.815-beta, with
  unsloth/Qwen3.8-27B-GGUF UD-IQ2_XXS loaded for chat.
- The Lenovo stayed offline and the Mac unreachable.

## Gate

- [x] Clean start, dev and production builds. A copy of the repository without ignored files
      installs with `npm ci` and passes every check below.
- [x] Demo on mocks. `npm run demo`, Image tab: race both mocks with FLUX.2-klein Q4_K_M for two
      rounds with a warm-up. Pre-flight notes the chat hand-off and warns about Apple Silicon
      against CUDA; the panes show the steps, then both images; the scoreboard, step chart, power
      chart, stats, rounds and setup work, and both chat models are loaded again afterwards.
- [x] Typecheck, lint, unit, integration and end-to-end tests pass: 269 unit and integration
      tests, 45 browser tests.
- [ ] Real-machine script done. Partly: the model list and pre-flight on the RTX machine (below).
      A race unloads the chat model there, which waits for a go-ahead.
- [x] No dead UI. Models and quants come from each machine's disk; the blind vote stays on text.
- [x] Earlier data still opens. Sessions moved to schema version 7, adding each run's image and
      the image status and chat restore in the provenance; earlier files get empty fields.
- [x] README, PLAN.md and ROADMAP.md updated.

## Real-machine results

Read-only, through a scratch server on port 3075 with a copy of `data/`:

| Check | Result |
| --- | --- |
| Image status | nothing loaded; engine diffusers |
| Image models listed | FLUX.2-klein-9B (pipeline), FLUX.2-klein-9B-GGUF (Q4_K_M), Qwen-Image-2.1-FP8 (pipeline), Qwen-Image-2.1-GGUF (Q8_0, Q4_K_M) |
| Left out | Wan2.2-TI2V-5B (video), Qwen/Qwen-Image-2.1 (partly downloaded) |
| Pre-flight, FLUX.2-klein Q4_K_M | no errors or warnings; a note that the load unloads unsloth/Qwen3.8-27B-GGUF |
| Pre-flight, FLUX.2-klein Q8_0 | stopped: not fully downloaded |

## Findings

- **The image API differs from the plan in ways that matter for timing.** Verified from the
  backend source: `images/load` answers at once and loads in the background, so Model Duel follows
  load-progress; loading the same model again always rebuilds it, so a round loads only when the
  resident model or its settings differ; a GGUF image model is named by `gguf_filename`, not a
  variant; seed -1 is refused; and there are no timing fields or monitor rows, so every image time
  is Model Duel's own. PLAN.md section 2.5 now records all of this.
- **Loading an image model downloads what is missing**, so pre-flight checks the file first.
- **The chat model goes when the image model loads, and nothing brings it back.** Model Duel loads
  it again after the race through the load manager, so the Models tab shows the load and the
  next pre-flight waits for it.
- **After the last step, progress still reads the last step during the decode, then 0 of 0 while
  the PNG is saved.** The decode tail runs from the first reading of the last step to the answer,
  so it includes saving.
- **Spec order in the browser tests.** The image spec runs before the machines spec, which starts
  from no machines, so it removes the machines it added.

## Still to do

1. With a go-ahead: race FLUX.2-klein-9B Q4_K_M at 1024 by 1024 for three rounds with a fixed
   seed on the RTX machine, record the resolved settings, and check the chat model comes back.
2. When the Lenovo or the Mac is back: the two-machine race of the real-machine script.
