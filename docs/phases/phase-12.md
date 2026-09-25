# Phase 12 record

- Date: 2026-09-25
- Commit and tag: branch `phase-12`, merged into `main`, tagged `v1.2`, the last phase.
- Machine: `test`, NVIDIA RTX 3060 12 GB, Ubuntu with ffmpeg 7.1.1 (`hevc_nvenc`, `libx265`) and
  nvidia-smi, with its chat model still loaded. The agent ran on it, on 127.0.0.1:8798.
- The Lenovo stayed offline and the Mac unreachable.

## Gate

- [x] Clean start, dev and production builds. A copy of the repository without ignored files
      installs with `npm ci` and passes every check below.
- [x] Demo on mocks. `npm run demo` now also starts a fake agent beside each mock and adds it to
      the machine. The Command tab runs the fake encode on both, shows frames per second and speed
      live, and the report, frame chart, stats and setup work.
- [x] Typecheck, lint, unit, integration and end-to-end tests pass: 297 unit and integration
      tests, 49 browser tests.
- [ ] Real-machine script done. Partly: on the RTX machine, NVENC and x265 (below). The Mac's
      VideoToolbox, ProRes and macmon steps wait for the Mac.
- [x] No dead UI. Templates a machine cannot run show why in pre-flight; the fake template shows
      only when an agent offers it.
- [x] Earlier data still opens. Sessions moved to schema version 9, adding each run's encode and
      the agent's health; machines files without agent fields read as having no agent.
- [x] README, PLAN.md and ROADMAP.md updated.

## Real-machine results

The reference clip from `npm run agent -- --make-clip`: 1920×1080, 30 fps, 20 s, 600 frames,
22.7 MB, SHA-256 `3c69de52c335…`. Warm-up on, rounds 2 s apart.

| Encode | Rounds | Encode time | Frames per second | Speed | Output | Encoder use | Energy, GPU board |
| --- | --- | --- | --- | --- | --- | --- | --- |
| HEVC NVENC, 10 Mbit/s, whole clip | 3, then 2 again | 2.31 to 2.33 s | 258 to 260 | 8.6× | 25.3 MB | 100% | 74 to 90 J |
| x265 medium, CRF 28, first 10 s | 2 | 4.77, 4.78 s | 62.9, 62.7 | 2.1× | 5.0 MB | 0% | 50 J |

The second NVENC race, after progress moved to every 0.1 s, is kept as
[phase-12/rtx-hevc-nvenc.md](phase-12/rtx-hevc-nvenc.md). The chat model's GPU memory was the same
before and after (10,962 against 10,972 MiB in use).

## Findings

- **NVENC runs the whole clip in 2.3 s at 8.6× real time on the RTX 3060**, with its video
  encoder at 100% and the GPU otherwise at about 10%, next to a loaded 27B chat model. x265 on the
  16-thread CPU manages 2.1× on half the clip at medium.
- **Energy is the GPU board's only.** x265 works on the CPU, which Unsloth's telemetry does not
  measure on Linux, so its 50 J is the idle GPU, not the encode. nvidia-smi reads GPU power and
  encoder use only; macmon on a Mac would add CPU and Neural Engine power.
- **ffmpeg reports progress every half second by default**, which made the time to the first frame
  read about 553 ms on every run. The agent now asks for every 0.1 s: twenty readings per encode
  and a first frame at 352 ms.
- **The agent's clock is its own**, so energy is lined up with when its events reached Model Duel
  rather than with the times it stamped.

## Still to do

1. On the Mac: HEVC with VideoToolbox, ProRes, and macmon's power readings, with the same clip
   copied over.
2. The two-machine races of the real-machine script when the Lenovo or the Mac is back.
