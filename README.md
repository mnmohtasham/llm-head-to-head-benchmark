# Model Duel

Model Duel benchmarks local AI models on two or more machines that run
[Unsloth Studio](https://unsloth.ai/docs/new/studio). A browser app talks to Unsloth on every
machine through its API, runs the same workload on each, and compares the results.

**Status: phase 5 of [ROADMAP.md](ROADMAP.md).** The app registers machines, probes what each one
supports, loads models, and races a text prompt on several machines at once, side by side, over
several rounds, with medians, spread and an honest tie when the difference is within noise.
Presets and cache control arrive in phase 6, and the transcription and image benchmarks later.
[PLAN.md](PLAN.md) is the full specification.

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

Every race is saved in `data/sessions/`, one file each, with the raw timing of every token. The
**Results log** lists them newest first. **Open** shows a race again and loads its settings, so
**Start** runs it again. **Delete** removes it. The address changes to the race, so reloading the
page mid-race picks it up where it was. A race that was running when Model Duel stopped is marked
interrupted.

- Measure with `npm start`. The dev server shows a banner, because hot reload makes timings
  noisier.
- A run stops when Unsloth sends nothing for 2 minutes, or after 30 minutes in total.
- One race runs at a time.

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
