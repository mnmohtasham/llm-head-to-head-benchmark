# Model Duel

Model Duel benchmarks local AI models on two or more machines that run
[Unsloth Studio](https://unsloth.ai/docs/new/studio). A browser app talks to Unsloth on every
machine through its API, runs the same workload on each, and compares the results.

**Status: phase 10 of [ROADMAP.md](ROADMAP.md), milestone M3.** The app registers machines, probes what each one
supports, loads models, and races a text prompt on several machines at once, side by side, over
several rounds, with medians, spread and an honest tie when the difference is within noise. It
has prompt presets up to 32K tokens, cold or warm prefill, full sampling control, and a pre-flight
check that stops races that would not be fair. Every machine's GPU, power, CPU, RAM and
temperature show live, and every run gets its energy. A finished race reads as a scoreboard with
charts and its full setup, exports as JSON, CSV or Markdown, and can be judged in a blind vote.
Speech-to-text races the same way, with real-time factor and word error rate, and so does image
generation, with a live step timeline and the images side by side. Throughput mode and a command
agent come next. [PLAN.md](PLAN.md) is the full specification.

## Requirements

- Node.js 22.19 or newer, with npm 10.
- Unsloth Studio, desktop app or `unsloth studio`, on every machine you want to benchmark.
- For the browser tests: Google Chrome, or run `npx playwright install chromium` once.

## Quick start

```bash
npm install
npm run demo                  # two fake Unsloth machines plus the app, no GPU needed
npm run dev                   # development with hot reload
npm run build && npm start    # production build, the one to use for measurements
```

All three serve the app at http://localhost:3000. After `npm run build`, restart a running
`npm start`: it keeps the routes it started with, and the page warns when they no longer match.

## Connect your machines

1. On each machine, open Unsloth and go to **Settings → API → Remote & LAN**. Press **Start**
   and turn on **Start automatically**. From a terminal, `unsloth studio -H 0.0.0.0 -p 8888`
   does the same.
2. On the same screen, create an API key and copy it. Unsloth shows it only once.
3. In Model Duel, press **Add machine**. Enter a name, the machine's IP address and the key.
   The app adds `http://` and port 8888 when you leave them out.
4. The app probes the machine straight away. Press **Probe** again at any time.

The app can run on any computer that reaches the machines, including one of them. For the
Unsloth on the same computer, use `127.0.0.1` as the address.

### What the probe checks

| Chip      | Green means                                           | When it is not green                                       |
| --------- | ----------------------------------------------------- | ---------------------------------------------------------- |
| Reachable | Unsloth answered its health check                     | Nothing listening, no answer, unknown host, not Unsloth    |
| Key       | A key-protected route accepted the key                | Key missing, key rejected, first-run setup not finished    |
| Text      | The inference status answers, with the loaded model  | Status route missing or failing                            |
| STT       | At least one speech-to-text engine is available       | No engine; a missing whisper.cpp is noted separately       |
| Image     | The image generation status answers                   | Route missing in this Unsloth version                      |
| Telemetry | GPU readings are available                            | CPU-only machine, or route missing                         |

A grey chip was not checked because an earlier step failed. A hollow chip marks a feature this
machine or Unsloth version does not have. **Export probe** saves the raw answers and the report
as JSON, without the key.

## Load models

The **Models** tab shows one pane per machine: the loaded model with its context length,
speculative decoding, KV cache and thinking support, the last load time, and the models on disk.

- **Load on all machines** loads one model and quant everywhere. A machine that lacks that quant
  is named in the dialog and skipped.
- **Load model** on a pane, or **Load** next to a model in its list, loads on that machine only.
- Only models and quants fully downloaded on a machine are offered. Model Duel never starts a
  download.
- Speculative decoding is **Off** by default, so every machine decodes the same way. The other
  settings are sent explicitly too, so Unsloth's own defaults cannot differ between machines.
- A running load shows its progress and can be cancelled. **Unload** frees the memory after asking.
- The load time is measured on the controller, from the request to Unsloth's answer. The last one
  per machine is kept in `data/loads/`.

## Race machines on a text prompt

The **Text** tab sends the same prompt to every machine you pick, at the same moment, and shows
them side by side. Pick one machine for a single run.

1. Tick the machines. Each chip shows the model and quant loaded there. **Start** stays off while
   a picked machine has no model, is loading one, or does not answer, and the form says which.
2. Before you start, the form warns when the machines run different models, quants or backends,
   or when speculative decoding is on. These make a race compare more than the hardware. You can
   still start.
3. Write the prompt and set **Max tokens**. Thinking models also offer **Thinking** on or off, and
   **Reasoning effort** when every picked model has the same levels. Effort starts at low where
   offered. Sampling is fixed for now: temperature 0.6, top-p 0.95, top-k 20, min-p 0.
4. Press **Start**. Every machine gets an identical request in the same instant, apart from its
   model name. **Cancel** stops all of them and tells Unsloth to stop generating.

### Prompts, prefill and sampling

- **Prompt** offers presets. **Short** is a one-line question. **8K** and **32K** are the opening
  of Mill's *On Liberty*, about 7,600 and 30,400 tokens, followed by a request for a five-point
  summary. **Puzzle** and **Code** are a reasoning puzzle and a small coding task. **Fixed
  length** asks for a long essay no model finishes, so every machine writes exactly **Max
  tokens** and output length drops out of the comparison. **Custom** is your own prompt.
- **Prefill** is **Cold** by default: a fresh line starts each round's prompt and a fixed seed is
  sent, so no machine can reuse a cached prompt. llama.cpp turns its cache off for seeded
  requests, and the nonce defeats MLX's cache. **Warm** sends the same prompt every round and no
  seed, so rounds after the first can reuse the cache; a round is flagged when a machine reused
  more than 64 cached prompt tokens.
- **Sampling** holds temperature, top-p, top-k, min-p, repetition penalty and seed. Every field
  goes to every machine, so server defaults can never differ.

### Live hardware and energy

While a machine card or a race pane is on screen, Model Duel reads that machine's hardware twice a
second through Unsloth's own routes and shows it as chips: GPU load, GPU power, GPU temperature,
VRAM on GPUs with their own memory, CPU load and RAM. A reading the machine does not report shows
**n/a**; Apple's first power reading is always empty. A machine that stops answering is retried
after 1, 2, 4 and up to 30 seconds.

A race records 5 seconds of readings before its first run and after its last, and gives every
run its energy by adding up power over time, its mean power while decoding, tokens per joule and
peak GPU load, power, temperature and memory. The numbers are approximate: board power on NVIDIA,
the GPU rail on Apple, read twice a second. Energy and tokens per joule join the comparison.

**Telemetry** on the Machines screen and in the race form turns all of it off. Polling costs
Unsloth about a tenth of a CPU core on an RTX 3060, because each reading runs `nvidia-smi`, so
turn it off for the cleanest timings.

### Pre-flight

Before a race starts, pre-flight reads each machine's status and has each machine count the
prompt with its own tokenizer.

- **Errors** stop the race: a machine that does not answer, has no model, is loading one, or is
  short of memory for it; a prompt and Max tokens that do not fit a machine's context; thinking
  asked of a model that cannot think.
- **Warnings** mean the race compares more than the hardware: different models, quants,
  backends, context lengths, speculative decoding, KV cache types or GPU memory modes. Tick
  **Race anyway** to start regardless.
- If Unsloth still cuts a prompt to fit, the race stops and says so.

### Rounds

One race is noisy, so a race runs several rounds and reports medians.

- **Rounds** sets how many, 1 to 10. The default is 3.
- **Warm-up** sends one short request to each machine first and does not count it. It wakes up a
  machine that sat idle.
- **Pause between rounds** lets the machines settle, 2 seconds by default.
- **Order** is **Together**, all machines at once, or **Take turns**, one at a time in ABBA order
  so that no machine always goes first. Machines on the same computer compete for it, so the
  form suggests taking turns when two of them share one.
- Before each round, Model Duel measures the round trip to each machine with three TCP
  handshakes. HTTP is no good for this: Unsloth's answers on a reused connection stall for about
  40 ms.

The **Comparison** table shows medians, with the range and standard deviation under each. A
machine wins a row only when its median is more than 10 percent better, or its range does not
overlap the runner-up's; otherwise the row says **Tie**. Failed rounds and the warm-up never
count. The **Rounds** table has a row per round with each machine's first word, speed and round
trip, and flags a round when this computer was too busy, when many chunks arrived together, or when
a machine failed. Pick a row to see that round in the panes.

Each machine has a pane, two to four across, wrapping beyond that:

- **First word** is the wait until the first word of the answer. The first token of any kind,
  thinking included, is shown under it.
- **Speed** is the decode speed in tokens per second, from the first token to the last.
- **Total** ticks while the run goes and holds the full time at the end.
- The thinking block stays open while the model thinks and folds away at the first word of the
  answer. Both boxes follow the newest text unless you scroll up.
- A machine that fails or drops out shows **Failed** with the reason and whatever it measured.
  The others carry on.
- When there is no answer, the answer box says why. Usually the model spent all of **Max tokens**
  thinking; raise it, lower the effort, or turn thinking off.

When the race ends:

- **Comparison** has a row per metric and a column per machine, with a **Result** column that
  names the winner and by how much, or says **Tie**. Total time and token counts have no winner,
  because they depend on how much each model chose to write. A note gives how far apart the
  requests left.
- **Measurements for each machine** puts what Model Duel measured next to what Unsloth reported.
  Model Duel's times start when the request leaves this computer, so they include the network.
  The notes say how much the network added, how far the decode speeds differ, and whether this
  computer was too busy to time well. They also warn when the model changed, the prompt was cut,
  the run hit **Max tokens**, the thinking ended up in the answer, speculative decoding was on, or
  part of the prompt came from Unsloth's prompt cache.
- **Setup** lists what each machine ran: model, quant, backend, context, speculative decoding,
  KV cache, thinking, versions and GPU. Differences that change the comparison are marked.

### The report

- The **Scoreboard** puts the race into sentences, such as "Linux decodes 1.85× faster". It
  covers only what does not depend on how much each model wrote: time to first token, decode
  speed, characters per second, prompt processing and tokens per joule. The winner gate applies,
  so a close result reads as a tie.
- **Charts** show the round in the panes: tokens against time for each machine, with the
  thinking lighter and filled, and GPU power against token rate when telemetry was on.
- **Setup** lists everything the result depends on, with differences marked, and under it the
  exact request each machine received.
- **Export** gives the race as **JSON** (the whole session, with the timing of every token and
  telemetry sample), **CSV** (the comparison and round tables) or **Markdown** (a summary that
  reads on its own). None of them contains an API key.
- **Blind vote** shows each round's two answers side by side in a random order, with nothing on
  the page that names a machine, and asks which is better. After every round has a vote,
  **Reveal** says which was which and adds your votes to a tally per model pair across all your
  races. It needs a race between two machines.

Every race is saved in `data/sessions/`, one file each, with the raw timing of every token. The
**Results log** lists them newest first. **Open** shows a race again and loads its settings, so
**Start** runs it again. **Delete** removes it. The address changes to the race, so reloading the
page mid-race picks it up where it was. A race that was running when Model Duel stopped is marked
interrupted.

- Measure with `npm start`. The dev server shows a banner, because hot reload makes timings
  noisier.
- A run stops when Unsloth sends nothing for 2 minutes, or after 30 minutes in total.
- One race runs at a time.

## Race machines on speech-to-text

The **Transcribe** tab sends the same audio to every machine's Unsloth speech-to-text and compares
how fast and how accurately each one writes it down.

1. Pick the machines. Each chip says which speech model is in memory, if any.
2. Pick the audio:
   - **LibriSpeech clip**, 70 seconds of one speaker, bundled with its checked transcript. Listen
     to it and read what is said from the form.
   - **Long audio** repeats the clip into one file of 1 to 30 minutes, to see how speed holds up.
   - **Upload a file**, WAV, MP3, FLAC, M4A, OGG or WebM up to 256 MB. Paste what was said to get
     a word error rate, or leave it empty. The file is kept in `data/audio/`.
3. Pick the engine, model, device and language. **GGUF** runs Whisper on whisper.cpp, the fastest
   on most machines; a machine without it falls back to **Transformers**, and pre-flight says so.
   **Qwen3-ASR** runs on llama.cpp. The model must already be downloaded for that engine on every
   machine: pre-flight stops a race that would start a download.
4. **Start**. A machine without the model in memory loads it first, and that time is shown apart,
   not counted in the race. Unsloth unloads a speech model after five idle minutes, so every
   round checks.

Each pane shows:

- **Real-time factor**: seconds of audio per second of processing. 40× writes a minute of speech
  in 1.5 seconds.
- **Word error rate**: wrong, missed and extra words over the words said, after lower-casing,
  removing punctuation and spelling out numbers. The transcript marks each one: a highlighted word
  is wrong (hover to see what was said), a red one is extra, a struck-through one was missed.
  **Show the text as returned** shows the machine's own text.
- **Upload** and **processing** apart. Processing runs from the last byte of the file sent to the
  first byte of the answer. Unsloth's own processing time, from its monitor, is in the
  measurements.

Rounds, statistics, telemetry, the scoreboard, charts and exports work as for text. The scoreboard
compares real-time factor, word error rate and energy per audio minute. The Transcribe tab's
results log lists only transcription races.

The clip is utterances 6930-75918-0000 to 0005 of LibriSpeech test-clean: V. Panayotov, G. Chen,
D. Povey and S. Khudanpur, "LibriSpeech: an ASR corpus based on public domain audio books",
ICASSP 2015, licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). The six
utterances were decoded from the corpus's FLAC to 16 kHz mono WAV and joined end to end, with no
other change. The file is `server/assets/librispeech-6930-75918.wav`.

## Race machines on image generation

The **Image** tab sends the same prompt, size, steps and seed to every machine's Unsloth image
generation.

1. Pick the machines. Each chip says which image model is in memory, or which chat model is.
2. Pick the model and, for a GGUF model, the quant. The list holds the image models on the picked
   machines' disks; "(on 1 of 2)" marks one some machines lack. Pre-flight stops a file that is not
   fully downloaded, because loading it would start a download.
3. Pick a prompt, the size, steps, guidance and seed. Unsloth's defaults are 9 steps and guidance
   0, which suit distilled models such as FLUX.2 klein.
4. **Speed mode** stays **Off** unless you want Unsloth's optimisations: Off is the baseline that
   gives the same pixels every time. The others compile the model during the first images, so keep
   the warm-up on.
5. **Start**. The image model loads where it is not in memory, and that time is kept apart.

**Unsloth gives the GPU to one kind of model at a time:** loading the image model unloads the
chat model on that machine. Pre-flight says which. With **Load each machine's chat model again
after the race** on, Model Duel loads it back with the settings it had once the race is over, even
after a cancel, and the setup table says whether that worked.

Each pane shows the step it is on while it runs, then:

- **Speed** in denoising steps per second, and **time per image** from request to answer.
- The **time to first step** (reading the prompt), and the **decode and save** after the last
  step.
- The image itself, kept in `data/images/` so the race still shows it later.

Unsloth reports no timing for images, so Model Duel reads its progress about ten times a second,
and step times are good to about 100 ms. The chart shows each machine's steps against time. The
setup lists what each machine resolved to: engine, device, precision, speed mode and the
optimisations that engaged, quantisation and offload. Apple Silicon and CUDA resolve differently,
and the same seed gives different pixels on them, so pre-flight warns and the images are a sanity
check rather than a comparison.

## Security

- The app has no login. It binds to 127.0.0.1 unless you pass `--host`, and then prints a
  warning, because anyone who reaches it can use your machines through it.
- It answers only requests addressed to localhost, an IP address or this computer's name, which
  stops web pages from reaching it through DNS rebinding. `--allow-host <name>` adds a name.
- API keys live in `data/machines.json`, readable by your user only (mode 600). They never reach
  the browser, the logs or an export. The app shows only `sk-unsloth-…1234`.
- Unsloth's LAN access is plain HTTP. Anyone on the same network can read the traffic,
  including the key. Use it on a network you trust.

## Commands

| Command                                                   | What it does                                                       |
| --------------------------------------------------------- | ------------------------------------------------------------------ |
| `npm run dev`                                             | Vite on port 3000 with hot reload, API on 3001                     |
| `npm run build`                                           | Builds the client, the controller and the fake Unsloth             |
| `npm start`                                               | Serves the build. Options: `--port`, `--host`, `--data-dir`        |
| `npm run demo`                                            | Builds, then starts two fake machines and the app with both added  |
| `npm run mock -- --profile mac-mlx --port 18881`          | Starts one fake Unsloth                                            |
| `npm run record:probe -- --url <address> --name <name>`   | Probes a machine and saves a fixture; key from `UNSLOTH_API_KEY`   |
| `npm run record -- --machine <name> --effort low`          | Streams one prompt from a saved machine into `fixtures/streams/`, without the key |
| `npm run typecheck`, `npm run lint`, `npm run format`     | TypeScript, ESLint and Prettier                                    |
| `npm test`                                                | Unit and integration tests                                         |
| `npm run test:e2e`                                        | Builds, starts the demo on ports 3100, 18891, 18892, runs browser tests |

## The fake Unsloth

`mock/` answers like Unsloth Studio. Its response shapes follow the Unsloth backend source, and
its key errors match what a real server returned. There are two profiles, `mac-mlx` and
`linux-cuda`. Control routes change its behaviour while it runs:

```bash
# Reject every key, as if it had been deleted in Unsloth
curl -X POST http://127.0.0.1:18882/__mock/config -H 'content-type: application/json' \
     -d '{"rejectKey": true}'
# Make a route disappear, hang, or answer with an error
curl -X POST http://127.0.0.1:18882/__mock/config -H 'content-type: application/json' \
     -d '{"routes": {"/v1/props": {"missing": true}, "/v1/models": {"hang": true}}}'
# Slow loads, a failing load, a memory warning, a busy GPU
curl -X POST http://127.0.0.1:18882/__mock/config -H 'content-type: application/json' \
     -d '{"loadMs": 20000, "failNextLoad": "Failed to load GGUF model", "memoryWarning": "Does not fit"}'
curl -X POST http://127.0.0.1:18882/__mock/config -H 'content-type: application/json' \
     -d '{"gpuBusy": true}'
# Streaming: prompt time, time per token, how much it thinks and answers
curl -X POST http://127.0.0.1:18882/__mock/config -H 'content-type: application/json' \
     -d '{"stream": {"startupMs": 800, "tokenMs": 30, "reasoningTokens": 200, "answerTokens": 300}}'
# Streaming faults: go silent, drop the connection, send Unsloth's error frame
curl -X POST http://127.0.0.1:18882/__mock/config -H 'content-type: application/json' \
     -d '{"stream": {"stallAfterTokens": 20}}'
curl -X POST http://127.0.0.1:18882/__mock/config -H 'content-type: application/json' \
     -d '{"stream": {"disconnectAfterTokens": 20}}'
curl -X POST http://127.0.0.1:18882/__mock/config -H 'content-type: application/json' \
     -d '{"stream": {"errorAfterTokens": 20}}'
# Back to normal
curl -X POST http://127.0.0.1:18882/__mock/reset
```

Speech-to-text has its own settings: how long a model takes to load, processing time per second
of audio, and how soon an idle model unloads. Its transcripts get every 30th to 50th word wrong,
the same words every time, so the word error rate differs by profile and engine.

```bash
curl -X POST http://127.0.0.1:18882/__mock/config -H 'content-type: application/json' \
     -d '{"stt": {"loadMs": 2000, "msPerAudioSecond": 40, "idleUnloadMs": 10000}}'
```

Image generation has a load time, a time per step at 1024 by 1024 (smaller images take
proportionally less), a decode time, and a load that fails. Loading an image model unloads the
mock's chat model and the other way round, as in Unsloth. Its images are coloured shapes that
depend only on the seed.

```bash
curl -X POST http://127.0.0.1:18882/__mock/config -H 'content-type: application/json' \
     -d '{"image": {"loadMs": 3000, "stepMs": 200, "decodeMs": 500, "failNextLoad": "Out of memory"}}'
```

Other stream settings are `jitterMs`, `tokensPerChunk`, `keepaliveEveryMs`, `errorMessage`,
`toolFrames` (Unsloth's UI frames, which clients must ignore), `truncated` (the prompt was cut to
fit), `thinkingInAnswer` (the model skipped its thinking block), `cachedPromptTokens` and
`draftAcceptRate` (reported prompt cache and speculative decoding numbers).

Each profile has a model inventory like a real machine: complete and partial quants, an LM Studio
model behind a `ref:` handle, an MLX or safetensors model, and image models the Models tab leaves
out.

## Troubleshooting

- **"Nothing is listening at …"**: Unsloth is not running, LAN access is off, or the port is
  wrong.
- **"… did not answer in time"**: wrong IP address, different network, or a firewall.
- **"The connection to … was cut off."**: something accepted the connection and dropped it. On a
  Mac this is usually the macOS firewall: allow incoming connections for Unsloth under System
  Settings → Network → Firewall → Options.
- **"The API key was rejected."**: the key was deleted or mistyped. Create a new one and paste
  it with **Edit**.
- **A model is missing from the Models tab**: it is partly downloaded, or it is an image or video
  model. Finish the download in Unsloth, then press **Refresh** on the pane.
- **"Load of … failed."**: the message after it is Unsloth's own. A load that loses its connection
  may still finish on the machine; press **Refresh** to see.
- **A red banner says the page and the server come from different builds**, or a pane says the
  server is probably older than the page: the app was rebuilt while it kept running. Stop it and
  start it again with `npm start`, then reload the page.
- **"No model is loaded on …"**: load one on the **Models** tab first.
- **"… sent nothing for 120 s, so the run was stopped."**: Unsloth stopped sending in the middle
  of a run. Check the machine; it may have gone to sleep or run out of memory.
- **"The stream from … broke after N chunks"**: the connection dropped during the run, for
  example because of Wi-Fi or an Unsloth restart.
- **"Unsloth reported: …"**: the message after it is Unsloth's own, for example that the context
  is full. Shorten the prompt, lower **Max tokens**, or load the model with a longer context.
- **The network adds tens of milliseconds to the first token**: Wi-Fi delay varies a lot, and
  power saving on the machine's Wi-Fi is a common cause. For benchmarks, turn power saving off (on
  Linux, `sudo iw dev <wifi> set power_save off`) or use Ethernet. Decode speed is not affected.
- **Chunks arrive in groups, with uneven gaps between them**: speculative decoding is on, and the
  tokens it keeps arrive together. The notes under the table say how many drafts Unsloth kept.
  Load the model with speculative decoding off to compare machines like for like.
- **`npm run dev` says "Port 3000 is already in use"**: `npm start` or `npm run demo` is still
  running. Stop it first.
- **"whisper.cpp is not installed on this machine."**: Whisper will run on the slower
  Transformers engine. Unsloth's `scripts/build_whisper_cpp.sh` builds the faster engine.
- **"… is not downloaded for gguf on …"**: download that speech model in Unsloth Studio on that
  machine, or pick one it has. Model Duel never starts a download during a race.
- **"… is not fully downloaded on …"** on the Image tab: download that quant in Unsloth Studio,
  or pick one the machine has.
- **The chat model is gone after an image race**: loading an image model unloads it. Turn on
  **Load each machine's chat model again after the race**, or load it on the **Models** tab.
- **"… cannot run GGUF speech models"**: that machine will use Transformers, so the race compares
  engines as well as hardware. Build whisper.cpp there, or pick **Transformers** for every machine.
- **Browser tests find no browser**: run `npx playwright install chromium`, or set
  `E2E_BROWSER=chromium` to force Playwright's own Chromium.

## Project layout

| Folder        | Contents                                                          |
| ------------- | ----------------------------------------------------------------- |
| `shared/`     | Types, validation, the probe classifier, the stream parser and metrics |
| `server/`     | The controller: Fastify API, Unsloth client, probe, machine store |
| `client/`     | The React app                                                     |
| `mock/`       | The fake Unsloth backend                                          |
| `e2e/`        | Playwright browser tests                                          |
| `scripts/`    | Build, demo, and the probe and stream recorders                   |
| `fixtures/`   | Recorded probes, model lists and streams used by the tests        |
| `docs/phases` | One record per finished phase                                     |
| `data/`       | Your machines, probes, last loads and saved races. Not in git     |
