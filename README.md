# Model Duel

Model Duel benchmarks local AI models on two or more machines that run
[Unsloth Studio](https://unsloth.ai/docs/new/studio) or [LM Studio](https://lmstudio.ai). A browser app talks to Unsloth on every
machine through its API, runs the same workload on each, and compares the results.

Model Duel is free and open source under the [MIT license](LICENSE). Run it on any computer on
your network, with Docker or Node.js, and open it in a browser.

**Status: phase 21 of [ROADMAP.md](ROADMAP.md).** The app registers machines, probes what each one
supports, loads models, and races a text prompt on several machines at once, side by side, over
several rounds, with medians, spread and an honest tie when the difference is within noise. It
has prompt presets up to 32K tokens, cold or warm prefill, full sampling control, and a pre-flight
check that stops races that would not be fair. Every machine's GPU, power, CPU, RAM and
temperature show live, and every run gets its energy. A finished race reads as a scoreboard with
charts and its full setup, exports as JSON, CSV or Markdown, and can be judged in a blind vote.
Speech-to-text races the same way, with real-time factor and word error rate, and so does image
generation, with a live step timeline and the images side by side. Throughput mode measures how
many tokens a machine delivers with several requests at once. Every race is kept as a JSON result file in a documented format, ready
to share. Models from OpenAI, Anthropic and Google Gemini can join text races as references, picked
from each provider's own model list. The **Results** tab puts every machine's run from every race in
one table to filter, sort and download, and sends a run to a public results service when you ask. [PLAN.md](PLAN.md) is the full specification.

## Requirements

- Docker, or Node.js 22.23.2 or newer with npm 10. Node 22.23.2 is the first Node 22 release with
  the fixes of its September 2026 security release.
- Unsloth Studio, desktop app or `unsloth studio`, on every machine you want to benchmark.
- For the browser tests: Google Chrome, or run `npx playwright install chromium` once.

## Quick start

With Docker, on Linux, macOS or Windows (details in [Run it with Docker](#run-it-with-docker)):

```bash
git clone https://github.com/mnmohtasham/llm-head-to-head-benchmark.git llm-h2h
cd llm-h2h
docker compose up -d --build
```

With Node.js:

```bash
npm ci
npm run build && npm start    # the production build, the one to use for measurements
```

Both serve the app at http://localhost:3000. Then [connect your machines](#connect-your-machines).
After `npm run build`, restart a running `npm start`: it keeps the routes it started with, and the
page warns when they no longer match. `npm run smoke` checks that a running app is healthy.

## Run it with Docker

Nothing to install but Docker: Docker Desktop on Windows or macOS, or Docker Engine with the
Compose plugin on Linux.

```bash
git clone https://github.com/mnmohtasham/llm-head-to-head-benchmark.git llm-h2h
cd llm-h2h
docker compose up -d --build
```

Open http://localhost:3000. The container is called `llm-h2h`: `docker compose logs -f` shows its
log, `docker compose down` stops it. To update, `git pull`, then `docker compose up -d --build`
again.

- **Settings.** Every one is in the `environment` section of
  [docker-compose.yml](docker-compose.yml), with what it does. Change it, then run
  `docker compose up -d`.
- **Your data** (machines, API keys, races, results, the signing key) is in the Docker volume
  `llm-h2h-data`. It survives `docker compose down` and rebuilds; `docker compose down -v`
  deletes it. To copy it out: `docker compose cp llm-h2h:/app/data ./llm-h2h-backup`.
- **Machines on other computers**: add them by IP address, as always. Names ending in `.local`
  usually do not resolve inside a container, so use the IP address.
- **Unsloth or LM Studio on the same computer as Docker**: use `host.docker.internal` instead of
  `127.0.0.1`, for example `host.docker.internal:8888`. Inside the container, `127.0.0.1` is the
  container itself. The server must listen on the network, not only on this computer: turn on
  Unsloth's LAN access, or LM Studio's **Serve on Local Network**. On Linux with a firewall such as
  ufw, its port must also be open to Docker's network, as it already is for other computers.
- **A password**: put `DUEL_PASSWORD='your password'` in a file named `.env` next to
  `docker-compose.yml`, then run `docker compose up -d`. The single quotes keep `$` and spaces as
  typed. Git and the image build leave `.env` out, so the password never reaches the repository,
  as it could if typed into `docker-compose.yml`.
- **Opening the page from another device**: set a password first, then in the `ports` line
  change `127.0.0.1:3000:3000` to `3000:3000`. To open it by a name such as `my-pc.local`, add the
  name to `DUEL_ALLOW_HOSTS`. See [Security](#security).
- **Using the `data` folder of a native install instead of the volume**: replace
  `llm-h2h-data:/app/data` with `./data:/app/data`. On Linux, the container runs as user id
  1000, so the folder must belong to that user.

### Docker and measurements

The container measures the same way as `npm start`: the same Node version and code, with every time
taken inside the controller. Docker only adds its own network hop between the container and your
network. Measured on Linux: 30 rounds on each of two stand-in machines gave the same first-token times
and decode speeds within 0.1 %, and a round trip to another computer on the network took 25 µs
longer, where normal variation is 1.2 to 3 ms. On an RTX 3060 running Qwen3.8 27B, the time between
Unsloth's first token and Model Duel's was 20 to 29 ms both ways. On macOS and Windows, Docker Desktop runs containers
in a small virtual machine, which adds a little more to each round trip; that is not measured yet. To
check your own setup, race the same machines once with `npm start` and once in Docker. The
[phase 20 record](docs/phases/phase-20.md) has the numbers.

## Connect your machines

1. On each machine, open Unsloth and go to **Settings → API → Remote & LAN**. Press **Start**
   and turn on **Start automatically**. From a terminal, `unsloth studio -H 0.0.0.0 -p 8888`
   does the same.
2. On the same screen, create an API key and copy it. Unsloth shows it only once.
3. In Model Duel, press **Add machine**. Enter a name, the machine's IP address and the key.
   The app adds `http://` and port 8888 when you leave them out.
4. The app probes the machine straight away. Press **Probe** again at any time.

The app can run on any computer that reaches the machines, including one of them. For the
Unsloth on the same computer, use `127.0.0.1` as the address, or `host.docker.internal` when the
app runs in Docker.

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
  length** asks for an essay of at least 3,000 words, so every machine writes exactly **Max
  tokens** and output length drops out of the comparison, as long as Max tokens is shorter than
  the essay: keep it at about 2,000 or less. A machine that finishes first is flagged. With thinking
  off it compares hardware most cleanly. **Custom** is your own prompt.
- **Prefill** is **Cold** by default: a fresh line starts each round's prompt and a fixed seed is
  sent, so no machine can reuse a cached prompt. llama.cpp turns its cache off for seeded
  requests, and the nonce defeats MLX's cache. **Warm** sends the same prompt every round and no
  seed, so rounds after the first can reuse the cache; a round is flagged when a machine reused
  more than 64 cached prompt tokens.
- **Output length moves a lot between rounds** of a thinking model: cold prefill changes the prompt
  every round, so the seed cannot repeat an answer, and the same question can take 150 tokens in one
  round and 2,000 in the next. First answer word, thinking time and total time follow the length.
  To compare machines, go by decode speed, time to first token and prompt processing, use **Fixed
  length**, or run more rounds.
- **Sampling** holds temperature, top-p, top-k, min-p, repetition penalty and seed. Every field
  goes to every machine, so server defaults can never differ.

### Throughput mode

**Mode** on the Text tab switches from **Latency**, one request per machine, to **Throughput**:
each machine gets **Requests at once** copies of the prompt in the same moment, as a server would
from several users.

- A model serves as many requests at once as it was loaded with slots. Pre-flight stops a race
  that asks for more, since the rest would only wait in Unsloth's queue, and offers **Reload with N
  slots**, which loads the same model again with the same settings and more slots.
- Each pane shows the **aggregate** speed, every request's tokens over the time from the first sent
  to the last done, and how many requests are done. The text is the first request's; the others run
  alongside it.
- The comparison adds each request's own speed, the median and 95th-percentile time to first
  token, and how long a request waited for a slot, read from Unsloth's monitor. Under
  **Measurements** a table lists every request.
- Run the same prompt at 1, 2 and 4 requests at once to see the curve: the total rises while each
  request slows.

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

One race is noisy, so a race runs several rounds and sums them up by their median or average.

- **Rounds** sets how many, 1 to 100. The default is 3. Every round is kept with the race, so a
  long race makes a larger file: a few hundred kilobytes per round for two machines writing a few
  thousand tokens each.
- **Sum up rounds by** is **Median**, the middle round, which one unusually slow or fast round
  does not move, or **Average**, the mean of every round, outliers included. Median is the default.
  A finished race can switch between them from its **Comparison** table; the exports and the result
  file follow.
- **Warm-up** sends one short request to each machine first and does not count it. It wakes up a
  machine that sat idle.
- **Pause between rounds** lets the machines settle, 2 seconds by default.
- **Order** is **Together**, all machines at once, or **Take turns**, one at a time in ABBA order
  so that no machine always goes first. Machines on the same computer compete for it, so the
  form suggests taking turns when two of them share one.
- Before each round, Model Duel measures the round trip to each machine with three TCP
  handshakes. HTTP is no good for this: Unsloth's answers on a reused connection stall for about
  40 ms.

The **Comparison** table shows the medians or averages, with the range and standard deviation
under each. A machine wins a row only when its median (or average) is more than 10 percent better,
or its range does not overlap the runner-up's; otherwise the row says **Tie**. Failed rounds and the warm-up never
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

### Result files

Every finished race is also written to `data/results/` as a **result file**: one JSON file with
the settings, the machines' hardware, software and model settings, every round and run with its
measurements, the raw token events, telemetry, the statistics and the scoreboard. It is Model
Duel's public format for sharing results, described in
[docs/result-format.md](docs/result-format.md) with a JSON Schema beside it. **Result file** in a
race's report downloads it.

- It never holds API keys or tokens, machine addresses or notes, and local paths and network
  addresses in messages are replaced. Prompts and answers stay, since they are the result: remove a
  private custom prompt before sharing.
- Each file carries a SHA-256 checksum of its content. `npm run verify-result -- <file>` checks a
  file against the format and the checksum.
- **Raw JSON** downloads the session as the app stores it, for debugging.

Every race is saved in `data/sessions/`, one file each, with the raw timing of every token. The
**Results log** lists them newest first. **Open** shows a race again and loads its settings, so
**Start** runs it again. **Delete** removes it. The address changes to the race, so reloading the
page mid-race picks it up where it was. A race that was running when Model Duel stopped is marked
interrupted.

- Measure with `npm start`. The dev server shows a banner, because hot reload makes timings
  noisier.
- A run stops when Unsloth sends nothing for 2 minutes, or after 30 minutes in total.
- One race runs at a time.

## LM Studio machines

A machine can run [LM Studio](https://lmstudio.ai) 0.4 or newer instead of Unsloth Studio. It races
on the Text tab, in latency and throughput mode, next to Unsloth machines and cloud models.

1. In LM Studio, open **Developer**, start the server, and turn on **Serve on Local Network** in the
   server settings (headless: `lms server start --bind 0.0.0.0`). LM Studio listens on port 1234.
2. In Model Duel, press **Add machine**, pick **LM Studio**, and enter the machine's address. Port
   1234 is added when you leave it out. Add an API token only if **Require Authentication** is on.
3. The probe checks it is LM Studio, lists its models, and says which is loaded. LM Studio reports no
   hardware, so when Unsloth runs on the same computer and was probed, the card takes its GPU,
   memory and system from there, and says so.
4. On **Models**, the LM Studio pane lists what is downloaded and loaded. **Load** takes a context
   length, how many requests it serves at once, and flash attention, and unloads the loaded model
   first unless you untick that. **Unload** frees the memory. You can also load in LM Studio itself.

Races use LM Studio's own chat API, so the report shows **Reported by LM Studio** next to Model
Duel's own numbers: LM Studio's time to first token, its decode speed and its token counts.

- **One model at a time.** Pre-flight stops a race when LM Studio has more than one chat model
  loaded, since they would share the GPU, or none.
- **No loading mid-race.** LM Studio loads a model on its own when asked for one that is not loaded.
  Model Duel asks only for the loaded one, and a run where LM Studio starts loading anyway fails
  instead of timing the load.
- **Thinking** maps onto LM Studio's reasoning setting: off, on, or an effort the model offers (such
  as low, medium or xhigh).
- **What LM Studio does not report:** KV cache type, GPU layers, speculative decoding and GPU
  memory mode show as "not reported" and are not compared. It cannot count tokens before a race, so
  pre-flight cannot check the prompt fits; it says so. It sends no stop reason, so a run whose
  output reached Max tokens is taken to have stopped there. It takes no seed; cold prefill still
  starts each round's prompt with a fresh line.
- **Unsloth against LM Studio** on the same computer and the same GGUF compares the two servers.
  Pre-flight warns that the race compares servers as well as hardware, and suggests taking turns.
- Transcription, images and telemetry need Unsloth, so LM Studio machines are left out of
  those tabs.

## Cloud models as references

ChatGPT, Claude and Gemini models can race on the **Text** tab next to your machines, to show how
a local model compares with a hosted one. They are references, not machines: their times include
the internet and the provider's own queue, and each request is billed to your key.

1. Create an API key with the provider: OpenAI at platform.openai.com under **API keys**,
   Anthropic in the Claude Console under **API keys**, Google in AI Studio under **Get API key**.
2. On **Machines**, press **Add cloud model**, pick the provider and paste the key.
3. Press **Fetch models**. Model Duel asks the provider for the models this key can use and keeps
   the text models: embedding, image, audio, realtime and moderation models are left out.
4. Choose a model. The dialog shows its context window, how many tokens it writes at most, whether
   it thinks and which effort levels it takes. The name follows the model until you type one.
   **Edit** picks another model later; the provider stays.

On the Text tab, cloud models show with their provider and model and are not picked by default.

- **Measured the same way.** Each provider's stream (OpenAI's Responses API, Anthropic's Messages
  API, Gemini's `streamGenerateContent`) is turned into the same events as Unsloth's, so first token,
  first answer word, thinking time, decode speed and token counts mean the same thing. The run's
  **Measurements** show what the provider billed next to what streamed, and its request id.
- **Thinking.** **Thinking** and **Reasoning effort** map onto each provider's own controls. A model
  that always thinks is asked for as little as it allows when Thinking is off, and pre-flight says
  so. With only cloud models picked, the effort list offers their levels; next to local models,
  each cloud model gets the nearest level it takes.
- **Summaries.** Providers stream a summary of the thinking, not all of it, but bill every thinking
  token. The decode speed then counts all of them from the first streamed token, so read it as
  approximate; the Measurements say so. Thinking a provider does not show at all is left out of the
  decode speed.
- **Sampling.** Only the fields a model's API takes are sent. Newer Claude and Gemini 3 models take
  none, and OpenAI's reasoning models take temperature and top-p only with effort `none`. The exact
  request is in the report under **Request sent to …**.
- **Pre-flight** stops a race when no model is chosen or Max tokens is above what the model writes,
  and notes the rest. Throughput mode works too; it sends that many requests to the provider at once.
- Telemetry, energy, the Models tab and the other workloads skip cloud models.
- **Result files** mark each machine as `local` or `cloud`, with the provider and model.
- **API address.** Leave it empty for the provider's API. Change it only for a gateway that speaks
  the same API. A saved key goes only to the address it was saved with: after changing the
  address, enter the key again.

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

## Compare every run in the Results tab

**Results** lists every machine's run in every finished race, one row each, so runs from different
races can be compared: which GPU runs a model fastest, what a quant or a context length costs.

- **What a row holds.** The machine, its GPU, GPU memory, GPU platform (CUDA, ROCm, MLX), RAM, system
  and Unsloth and llama.cpp versions, as probed before the race; the model, quant, engine, context,
  context per slot, KV cache type, GPU layers, slots, speculative decoding and GPU memory mode it
  ran with; the prompt, its length in tokens, prefill, thinking and Max tokens; and the medians of
  its counted rounds, the same numbers as the race's report. **Rounds summed up by** shows every
  row's medians or averages, whatever each race was set to.
- **Workload** picks the kind of race, since each has its own measurements: Text, Throughput,
  Transcribe or Image. **All** shows every kind with one headline number each.
- **Filter** by typing in **Search**, which matches the cells shown and the full prompt, or with the
  lists: machine, GPU, model, quant, engine, context, KV cache, slots, prompt and thinking, and more
  under **More filters**. Each list shows how many rows each value has with the other filters set.
  Failed and cancelled runs are left out unless you tick **Include failed and cancelled runs**.
- **Sort** by any column header; press it again to reverse. The best value of each measurement
  among the rows shown is starred.
- **Columns** picks what the table shows, for each workload separately. The choice is kept in this
  browser; **Reset columns** goes back to the default.
- **Download CSV** saves the rows and columns shown, with raw numbers and units in the headers.
- The date opens the race.
- **Send**, at the start of a row, sends that run to a results service (below).

Unsloth reports the KV cache's type (for example `q8_0`, or the bits on MLX), not how much memory it
takes, so the table shows the type; "default" means none was set at load. GPU layers shows "auto"
when Unsloth fitted the layers to the GPU itself, as it does unless told otherwise. Integrated GPUs,
such as AMD's 780M, report the memory they may share as their GPU memory.

### Send a run to a results service

Runs go to **LLM Bench** (https://llm-bench.selfhostapps.com), the public results site for Model
Duel, which shows them without names. Model Duel sends a run there only when you ask, one row at a
time, and to no other service.

1. Sign in at https://llm-bench.selfhostapps.com/account with Google and make a token.
2. On **Results**, press **Results service** and paste the token.
3. Press **Send** at the start of a row. The dialog shows the record exactly as it will be sent.
4. Press **Send to llm-bench.selfhostapps.com**. The row's button then reads **Sent ✓**; sending
   again replaces the record there.

A record holds the hardware, the model and how it was loaded, the race's settings and every
measurement with its per-round values. It never holds API keys or tokens, your name, machine names,
addresses or notes, your prompt, answers or thinking, or file names or paths. Every record is signed
with a key made on this computer, so LLM Bench can tell it was not changed on the way and let only
you replace your records; the private key never leaves `data/share.json`.
[docs/share-api.md](docs/share-api.md) describes what LLM Bench receives and how it checks it.

## Security

Model Duel is built to run on a home or office network you trust. [SECURITY.md](SECURITY.md) has
the full picture and how to report a vulnerability.

- **Who can open it.** `npm start` binds to 127.0.0.1, so only this computer can open the page;
  `--host` opens it wider and prints a warning. In Docker, the `ports` line of
  `docker-compose.yml` decides the same, and it starts as this computer only.
- **Password.** Set `DUEL_PASSWORD` (8 characters or more), or `DUEL_PASSWORD_FILE` for a Docker
  secret, and the app asks for it before anything else. In Docker, keep it in `.env`, not in
  `docker-compose.yml`. Set one before opening the app to your
  network. Sessions last 30 days in an HttpOnly, SameSite=Strict cookie; a restart keeps them and a
  new password ends them all. Ten wrong passwords from one address make it wait 15 minutes. The
  password travels over plain HTTP on your network, like everything else, so for access from
  outside use a VPN or an HTTPS reverse proxy.
- **API keys** live in `data/machines.json`, readable by your user only (mode 600). They never
  reach the browser, the logs, a result file or an export; the app shows only `sk-unsloth-…1234`.
  A key goes only to the address it was saved with: changing a machine's address, or asking a
  provider's models from another address, needs the key typed again. A cloud key goes only to its
  own provider, over HTTPS unless the address says otherwise.
- **Web pages cannot use it.** It answers only requests addressed to localhost, an IP address or
  this computer's name, which stops DNS rebinding; `--allow-host` or `DUEL_ALLOW_HOSTS` adds a
  name. Requests that change anything are refused when a browser says another site made them.
  Every answer carries a strict Content-Security-Policy, and no other site can frame the page.
- **Untrusted answers.** What machines, providers and the results service send is read with size
  limits and never shown as HTML. A stream larger than any real answer is stopped, CSV exports
  cannot carry spreadsheet formulas, and Markdown exports carry no HTML or links from machines.
- **Sending a record** needs your click and a confirmation showing the record. The server builds
  it, so the page cannot slip anything else in. It goes to LLM Bench only, over https, with no name
  or prompt; redirects are not followed, and only a short message, an id and a link on LLM Bench's
  own host are read back. The signing key and your LLM Bench token stay in `data/share.json` (mode
  600).
- **Docker.** The image holds no data and no keys, and no npm or other package manager. The
  container runs as an unprivileged user, with no Linux capabilities, a read-only file system
  apart from its data volume, a process limit and rotated logs.
- **Your network.** Unsloth's LAN access is plain HTTP, so anyone on the same network can read the
  traffic, including the key. Use it on a network you trust.

## Commands

| Command                                                 | What it does                                                         |
| ------------------------------------------------------- | -------------------------------------------------------------------- |
| `npm run build`                                         | Builds the page and the controller                                   |
| `npm start`                                             | Serves the build. Options: `--port`, `--host`, `--data-dir`, `--allow-host`, or the environment variables `npm start -- --help` lists |
| `docker compose up -d --build`                          | Builds the image and runs the app in Docker on http://localhost:3000 |
| `npm run smoke -- --url <address>`                      | Checks a running app: health, page, headers, host and cross-site refusals, password, API. Set `SMOKE_PASSWORD` when it has one |
| `npm run smoke:browser`                                 | Opens every tab of a running app in Chrome (`SMOKE_URL`, `SMOKE_PASSWORD`) and fails on script errors or blocked content |
| `npm run smoke:docker`                                  | Builds the image, runs it on a spare port without and with a password, smoke-tests it and removes it; `-- --browser` adds the browser checks |
| `npm run dev`                                           | Vite on port 3000 with hot reload, API on 3001                       |
| `npm run typecheck`, `npm run lint`, `npm run format`   | TypeScript, ESLint and Prettier                                      |
| `npm test`                                              | Unit and integration tests                                           |
| `npm run test:e2e`                                      | Builds, then runs the browser tests against the app and its test servers on ports 3100, 3101, 18891, 18892, 18911 to 18913 and 18915 |
| `npm run record:probe -- --url <address> --name <name>` | Probes a machine and saves a fixture; key from `UNSLOTH_API_KEY`     |
| `npm run record -- --machine <name> --effort low`       | Streams one prompt from a saved machine into `fixtures/streams/`, without the key |
| `npm run verify-result -- <file>`                       | Checks result files against the format and their checksum            |
| `npm run result-schema`                                 | Rewrites the JSON Schemas in `docs/` from the formats' definitions   |

## Development and tests

`npm run dev` serves the page with hot reload on port 3000 and the API on 3001. Measure with
`npm start` only: the dev server shows a banner, because hot reload makes timings noisy.

The automated tests need no GPU and no cloud key. `test-servers/` holds stand-ins for Unsloth
Studio, LM Studio, the three cloud providers and a results service, which answer as the real ones
do, with shapes taken from their source and from recordings of real machines in `fixtures/`. Only
the tests start them: they are not part of the build, the Docker image or the app. `npm test` runs
the unit and integration tests, and `npm run test:e2e` the browser tests, which race the stand-ins
through the production build, and sign in to a second copy of the app that has a password.

The smoke tests check a real install instead, with no stand-ins: `npm run smoke` and
`npm run smoke:browser` only read, so they are safe against your own machines, and
`npm run smoke:docker` checks the Docker setup from a clean build. Continuous integration runs the
checks, the tests and the Docker smoke test on every push, CodeQL on every change to `main`, and
Dependabot keeps npm packages, the Node image and the workflow actions up to date.

## Troubleshooting

- **"Nothing is listening at …"**: Unsloth is not running, LAN access is off, or the port is
  wrong.
- **"… did not answer in time"**: wrong IP address, different network, or a firewall.
- **"The connection to … was cut off."**: something accepted the connection and dropped it. On a
  Mac this is usually the macOS firewall: allow incoming connections for Unsloth under System
  Settings → Network → Firewall → Options.
- **"The API key was rejected."**: the key was deleted or mistyped. Create a new one and paste
  it with **Edit**.
- **"Model Duel refuses changes asked for by another web site."**: the browser said the request
  came from a page on another host. Either a page you visited really tried to use Model Duel, or
  something between your browser and Model Duel changed the Host header: a reverse proxy must pass
  it through unchanged (nginx: `proxy_set_header Host $host;`). Opening Model Duel directly at its
  own address always works.
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
- **`npm run dev` says "Port 3000 is already in use"**: `npm start` or the Docker container is
  still running. Stop it first.
- **"Enter the API key again: a saved key goes only to the address it was saved with."**: you
  changed a machine's address. Type its key again, or remove the key if the new address needs
  none.
- **The page asks for a password**: the app was started with `DUEL_PASSWORD`. **"Too many wrong
  passwords"** means ten wrong tries from your address; wait 15 minutes. To change the password,
  change `DUEL_PASSWORD` and restart, which signs everyone out.
- **"The password must be at least 8 characters long."** when starting: choose a longer
  `DUEL_PASSWORD`, or leave it empty for no password.
- **"… sent an answer larger than any real one."**: the address answers with far more than
  Unsloth or LM Studio ever send. Check that it is the right server.
- **Docker says the port is already allocated or in use**: something else, often `npm start`, has
  port 3000. Stop it, or change the middle number of the `ports` line in `docker-compose.yml`.
- **In Docker, "Nothing is listening at 127.0.0.1:…" or "… did not answer in time" for a server on
  the same computer**: use `host.docker.internal` as the address, turn on the server's network
  access, and on Linux open its port in the firewall to Docker's network.
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
| `test-servers/` | Stand-in Unsloth, LM Studio, cloud and results-service servers for the tests only |
| `e2e/`        | Playwright browser tests and the launcher that starts their test servers |
| `smoke/`      | Smoke tests for a running install and for the Docker setup        |
| `scripts/`    | Build, and the probe and stream recorders                         |
| `fixtures/`   | Recorded probes, model lists and streams used by the tests        |
| `docs/phases` | One record per finished phase                                     |
| `data/`       | Your machines, probes, last loads and saved races. Not in git     |

## License

[MIT](LICENSE). Copyright (c) 2026 Mani Mohtasham.
