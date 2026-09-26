# Fixes after real use, 2026-09-25

- Commit and tag: branch `fix-real-use`, merged into `main`, tagged `v1.3.1`.
- Found in Mani's own races of 2026-09-25, 07:26 to 08:44 UTC, on `test` (RTX 3060) and
  `lenovo (780M)`, read from their session files. No machine was loaded or unloaded to find them.

## What went wrong, and the fix

1. **Transcription with the GGUF engine could not work.** Every round failed with "STT model
   'large-v3-turbo' is not downloaded", although the status listed it as downloaded for GGUF. The
   backend source shows why: `/v1/audio/transcriptions` serves Whisper ids with the Transformers
   engine whatever was loaded, and only the GGUF copy was on disk. Model Duel now sends the audio to
   Unsloth's own `/api/inference/audio/transcribe/raw` with the engine and device, and uses the
   multipart route only on Unsloth versions without it. Unsloth's own processing time is missing on
   the raw route, since only the multipart route logs to the monitor.
2. **An image load was given up after 2 seconds.** The full FLUX.2-klein-9B pipeline showed no load
   phase at first and Model Duel called the load failed; later rounds then found "A diffusion load
   is already in progress". Model Duel now waits 30 seconds of silence and trusts the image status,
   gives loads their own 20-minute limit, and stops a load it started when that runs out.
3. **A load that failed was tried again every round.** The Lenovo's 780M has too little memory for
   the full pipeline (Unsloth said 34 GB needed, 22 GB usable), and each of the three rounds asked
   again. A model that did not load now sits out the rest of the race, for images and speech.
4. **Cancelling during an image load left the load running.** It finished later: the RTX machine
   still had FLUX.2-klein-4B-GGUF in memory and no chat model afterwards. Model Duel now stops the
   load it started when a race is cancelled. Mani's machine was left as it is.

The image pane also shows the load's progress now, instead of nothing while a large model loads.

## Tests

310 unit and integration tests and 49 browser tests pass. New: the multipart fallback, which serves
with Transformers as Unsloth does; a failed load not retried; a load with no phase; the load time
limit stopping the load; and a cancel stopping the load.

## Still to do

1. With Mani's go-ahead, repeat the GGUF transcription race on the RTX machine.

## v1.7.1, 2026-09-26: changes refused under `npm run dev`

Mani tried an image race on the RTX 3060 and the 780M, both with FLUX.2-klein-4B Q4_K_M, and
pre-flight said "Model Duel refuses changes asked for by another web site." He was running
`npm run dev`, where Vite serves the page on port 3000 and forwards `/api` to the app on 3001.
Vite's shorthand for that forward turns on `changeOrigin`, which rewrites the Host header to
`127.0.0.1:3001`; the cross-site check added in v1.7 compares the page's Origin with the Host
header, saw two hosts, and refused every change: pre-flight, starting a race, loading a model. The
tests missed it because none ran through the dev server; the production server was never
affected.

The forward now keeps the Host header (`changeOrigin: false`), and a new test sends requests
through the real Vite dev proxy with the project's own settings: the page's requests reach the app
and another site's are refused. With the old setting the test fails. Afterwards, pre-flight on
Mani's two machines ran and gave only the expected warning that CUDA and ROCm may render the same
seed differently.

## v1.7.2, 2026-09-26: a speech model loaded with another engine

Mani loaded large-v3-turbo by hand on the RTX 3060 and the 780M, and pre-flight said it "is not
downloaded for gguf on lenovo (780M)". Both statements were true but the message hid why: on the
Lenovo the model was loaded with Transformers (on ROCm), and only its Transformers copy is on disk;
the RTX had loaded the GGUF copy with whisper.cpp and has both. Each engine keeps its own copy, so a
GGUF race would have started a download on the Lenovo.

Pre-flight now says when a machine has the model loaded with another engine, and the Transcribe tab
offers **Race with Transformers** (or whichever engine is loaded) next to it. On Mani's machines,
switching to Transformers gave an all clear.
