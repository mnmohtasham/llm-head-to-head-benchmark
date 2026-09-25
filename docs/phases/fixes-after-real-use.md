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
