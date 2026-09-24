# Phase 02 record

- Date: 2026-09-24
- Commit and tag: not committed yet. Tag `v0.2` once the real-machine script below is done.
- Unsloth version per machine: Linux development machine 2026.9.11, Studio v0.1.815-beta,
  llama.cpp b11139-mix-a6922cc. The Mac is pending.
- Machines, as probed on 2026-09-24:

  | Name in the app | Address | Hardware | Unsloth backend | Probe |
  | --- | --- | --- | --- | --- |
  | test | 192.168.99.150 | NVIDIA RTX 3060 12 GB, 30 GB RAM | CUDA | all green |
  | lenovo (780M) | 192.168.99.240 | AMD Radeon 780M, 26.6 GB RAM | ROCm | all green |
  | macbook M4 | 192.168.99.91 | not known yet | not known yet | connection cut off |

- Controller location: the Linux development machine.

## Gate

- [x] Clean start, dev and production builds. A copy of the repository without ignored files
      installs with `npm ci` and passes every check below.
- [x] Demo on mocks. `npm run demo`, then the Models tab: both fake machines load, cancel, fail
      and warn on demand.
- [x] Typecheck, lint, unit, integration and end-to-end tests pass: 117 unit and integration
      tests, 12 browser tests.
- [ ] Real-machine script done. Partly: see below.
- [x] No dead UI. The Models tab has only working controls. Loading is blocked only where it would
      download or collide with a running load, and the pane says why.
- [x] Earlier data still opens. Phase 1 machines and probes load unchanged. Load results are a new
      file per machine in `data/loads/`.
- [x] README, PLAN.md and ROADMAP.md updated.

## Real-machine results

### Done, read-only

Everything below was read from the Linux machine with its API key. Nothing was loaded or
unloaded, because that would change what sits in its GPU memory. The answers are recorded in
`fixtures/models/real-linux-rtx3060.json`, and `shared/test/models.test.ts` runs the model list
logic on them.

- `/api/models/local` lists 16 entries. The app keeps 5 text models: it drops image and video
  models, partly downloaded ones, and `Qwen-Image-2.1-GGUF`, which Unsloth leaves without a task.
- LM Studio models have an opaque `ref:` load id and appear twice, as `lmstudio` and `custom`.
  The app lists each once.
- `gguf-variants` with the load id and `offline=true` lists the quants on disk for both Hugging
  Face cache and LM Studio models, without contacting Hugging Face. For
  `unsloth/Qwen3.8-27B-GGUF` it reports UD-IQ2_XXS complete and UD-Q4_K_S partial, so only
  UD-IQ2_XXS is offered.
- `/v1/models` names only one quant per GGUF model, which is why the app reads the variants.
- The load progress route answers `{"phase":null,"bytes_loaded":0,"bytes_total":0,"fraction":0}`
  when idle.

### The MacBook

From the Linux machine, port 8888 on the Mac accepts a connection and resets it as soon as a
request arrives, and the Mac does not answer ping. That is how the macOS firewall behaves when it
blocks an app, so Unsloth is probably running but not allowed to accept connections. On the Mac:
System Settings → Network → Firewall → Options, allow incoming connections for Unsloth, and check
that LAN access is started in Unsloth under Settings → API → Remote & LAN. Then probe it again.

### Still to do

1. Make the Mac reachable as above, then download the same thinking-model GGUF quant on the
   machines you want to compare.
2. On the Models tab, press **Load on all machines** with speculative decoding off. Compare the
   two load times.
3. Check that context length and speculative method read back as requested, with no memory
   warning.
4. Unload, then load again with a different context length. Try **Cancel load** once.
5. Decide GGUF or MLX for the Mac (open question 1) and record the model, quant, backend and load
   settings here.
6. Tick the real-machine gate item, then commit and tag `v0.2`.

## Findings

- `/api/models/list`, which the roadmap first named, lists Unsloth's suggested models plus the
  loaded one, not what is on disk. `/api/models/local` is the right source. PLAN.md and ROADMAP.md
  are corrected.
- A load of files that are not on disk would start a download, so only complete quants are
  offered, and a machine without them is skipped with a reason.
- Loads and unloads that run past 15 seconds answer 200 at once, padded with spaces, and report a
  later failure inside the body. The controller parses the body instead of trusting the status.
- `gpu_layers` in the status is only the manual-mode request. In auto mode it is always -1, so
  the memory warning is the only sign of a model that does not fit. PLAN.md and ROADMAP.md now
  compare the GPU memory mode instead.
- Unsloth drops the old model as soon as a new load starts, so a pane hides the old model's
  details while loading.
