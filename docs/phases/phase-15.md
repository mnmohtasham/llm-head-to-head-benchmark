# Phase 15 record

- Date: 2026-09-25
- Commit and tag: branch `phase-15`, merged into `main`, tagged `v1.5`.
- Added at Mani's request: "bring a new tab to show the results for each device run with filtering
  functionality in a table. The table should show GPU model, VRAM size, local AI model, quant,
  context size, KV cache size, GPU layers, slots, and all the details that make sense."

## Gate

- [x] Clean start, dev and production builds. A copy of the repository without ignored files
      installs with `npm ci` and passes every check below.
- [x] Demo on mocks. Every race in `npm run demo` shows up in the Results tab.
- [x] Typecheck, lint, unit, integration and end-to-end tests pass: 346 unit and integration
      tests, 55 browser tests.
- [x] Real data: the tab on a copy of Mani's `data/` (below).
- [x] No dead UI.
- [x] Earlier data still opens: every race since phase 4 has rows.
- [x] README, PLAN.md (section 7.2) and ROADMAP.md updated.

## Real data

On a copy of Mani's `data/`, the tab listed 41 runs from 20 races: 34 text, 6 image and 1
transcription; 26 done, 3 partly failed, 4 failed and 8 cancelled. It showed five machines: the RTX
3060 (12 GB), the Radeon 780M (28 GB shared), the Radeon 890M on Sina's machine (29.2 GB shared) and
two Gemini references. Every one of 385 medians in the table equals the same machine's median in
the race's result file.

The table shows at a glance what one race's report does not: across the medgemma 1.5 4B Q8_0 races
the RTX decodes at about 57 tok/s and the 780M at about 18, whatever the context length (20,000 to
131,072); and in two races Sina's machine ran `medgemma-4b-it` while the others ran
`medgemma-1.5-4b-it`.

## Findings

- **Unsloth reports the KV cache's type, not its size.** `cache_type_kv` (or MLX's KV bits) is all
  the status gives, and it is unset unless chosen at load, so the column shows the type or
  "default". The memory it takes would need the model's layer and head counts, which Unsloth does
  not report either.
- **GPU layers is always "auto" on Mani's machines:** Unsloth fits the layers itself (`gpu_layers`
  −1) and does not say how many landed on the GPU. The column shows it with the model's layer count.
- **Integrated GPUs report shared memory as GPU memory,** 28 GB for the 780M on a 32 GB machine.
  The column's hint says so.
- With every filter shown, the panel had 23 lists; the main ten are shown and the rest wait under
  **More filters**.

## Still to do

1. Charts across races, for example decode speed by GPU for one model.
2. A machine against itself over time, as Unsloth and llama.cpp update.
