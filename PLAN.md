# Model Duel v2: build plan

Status: draft v2.16, 2026-09-25. Supersedes the v1 "Model Duel" text. Build order: ROADMAP.md.
Unsloth facts below were verified against the Unsloth Studio backend source
(`studio/backend` in unslothai/unsloth, commit f9bffe2, 2026-09-24) and the public docs.
Re-verify them with the probe (section 3.1) against the versions actually installed.
v2.2 adds what phase 3 measured on two real machines: the streaming details in section 2.3, the
client and server agreement in section 4.1, and the per-run connection in section 8.
v2.3 records the session file, the stream messages and the measured send skew from phase 4, in
sections 3, 5.9 and 6. v2.4 records the RTT method and the gate as built in phase 5, in section 5. v2.5
records prefill, fixed length, pre-flight and the cache measurements of phase 6, in section 5. v2.6
records the telemetry measurements of phase 7, in sections 2.6 and 4.4. v2.7 records the report as
built in phase 8, in section 7. v2.8 records transcription as built in phase 9, in sections 2.4, 4.2,
6 and 9. v2.9 records image generation, verified from source and built in phase 10, in sections
2.5, 4.3, 6 and 9. v2.10 records throughput mode as built in phase 11, in sections 4.1, 6 and 9. v2.11 records the agent and the
command workload of phase 12, in sections 3, 6 and 7. v2.12 adds result files (phase 13), in section 7.1. v2.13 adds cloud reference models (phase 14), in
sections 2.7, 6 and 9. v2.14 adds the Results tab (phase 15), in sections 6 and 7.2. v2.15 allows up to 100 rounds summed up by
median or average (phase 16), in sections 5 and 6. v2.16 sends runs to a public results service
(phase 17), in sections 6 and 7.3.

## 0. Decisions so far

| Topic | Decision |
|---|---|
| Model servers | Unsloth Desktop / Studio on every machine (macOS and Linux). The app never runs models itself. |
| Controller placement | Any machine: a third one, or one of the two. Machine addresses and API keys are entered in the app. |
| Network | Wi-Fi. Every client-observed number is paired with a server-reported number so network noise is visible instead of hidden. |
| Workloads | Text generation, transcription, image generation now. Video encode later, through a command plugin that needs a small agent. |
| Models | Thinking models are in scope. Thinking is an explicit per-session switch, never the model default. |
| Quality | Word error rate for transcription, blind vote for text, side-by-side for images. |
| Concurrency | Single-stream latency is the core. A "parallel requests" mode is an optional later phase. |
| Telemetry | Live GPU, CPU, RAM, power and temperature come from Unsloth's own routes. No agent is needed for phases 1 to 3. |
| Cloud models | OpenAI, Anthropic and Google Gemini models join text races as references, never as machines (phase 14). |

Telemetry means the live hardware readings in the panes of the reference tool: GPU %, GPU power in watts,
CPU %, RAM used, GPU temperature. Unsloth Studio already collects these for its GPU monitor and serves them
over HTTP, so the app only polls.

## 1. Goal

A single-user local web app that runs the same AI workload on two or more machines that each run Unsloth
Studio, shows every machine live, and produces a fair comparison report. Workloads: text generation
(streaming, thinking models), speech-to-text, image generation. Look and feel follow the reference tool:
one config bar per workload, one pane per machine with live telemetry, a scoreboard with ratio headlines,
a results log.

## 2. Verified Unsloth Studio API surface

Everything below is what the app will call. Paths are relative to the machine's base URL.

### 2.1 Connection and auth

- Base URL `http://<ip>:8888` (default port). LAN exposure: Settings, API, Remote & LAN, Start
  ("Start automatically" keeps it on), or launch with `unsloth studio -H 0.0.0.0 -p 8888`.
  LAN traffic is plain HTTP; disable server-side tools on an exposed instance.
- Auth header `Authorization: Bearer sk-unsloth-...` (Settings, API, Create; the key is shown once).
  API keys are accepted by both `/v1/*` and `/api/*` routes. A few settings routes are UI-session-only,
  LAN start and stop among them, so LAN access is switched on in the Unsloth UI, not by the app.
- Keyless mode exists (off by default). Not relied on.

### 2.2 Discovery and provenance

| Route | Fields the app uses |
|---|---|
| `GET /api/health` | liveness; with bearer: `version`, `studio_version`, `device_type` |
| `GET /api/system` | `platform`, `device_backend`, `cpu.{logical_count,physical_count,usage_percent,frequency_mhz}`, `memory.{total_gb,available_gb,percent_used}`, `gpu`, `ml_packages` |
| `GET /api/system/hardware?include_details=true` | `gpu` summary, `gpus[]` (name, vram_total_gb), `versions`, `llama_cpp` |
| `GET /v1/models` | loaded and on-disk models with `id` and `loaded`; image and video models carry a `task`; a GGUF entry shows one `quant` only |
| `GET /api/models/local` | every model on disk: the `id` a load needs (a repo id, or an opaque `ref:` handle for LM Studio and other folders), `model_id`, `source`, `model_format`, `task`, `partial` |
| `GET /api/inference/status` | `active_model`, `model_identifier`, `is_gguf`, `is_mlx`, `gguf_variant`, `context_length`, `native_context_length`, `max_context_length`, `supports_reasoning`, `reasoning_style`, `reasoning_always_on`, `reasoning_effort_levels`, `reasoning_budget`, `cache_type_kv`, `speculative_type`, `spec_drafter_kind`, `spec_fallback_reason`, `parallel_slots`, `gpu_layers`, `memory_warning`, `llama_cpp_installed_tag`, `loading[]`, `loaded[]` |
| `GET /api/models/gguf-variants?repo_id=<load id>&offline=true` | the quants on disk, each with `downloaded` and `partial`; 404 "No cached GGUF variants available while offline." when none; never contacts Hugging Face |
| `GET /v1/props` | llama-server props: `default_generation_settings.n_ctx`, `total_slots`, `chat_template`, `build_info` |

### 2.3 Text generation

Lifecycle:

- `POST /api/inference/load` with `{model_path, max_seq_length (0 = backend picks), gguf_variant,
  n_parallel (1..64, GGUF only), cache_type_kv, reasoning_budget, speculative_type, llama_extra_args[],
  load_request_id, force_reload}`. `model_path` is the id from `/api/models/local`.
  Blocks until loaded and returns `LoadResponse` with `status: loaded` or `already_loaded`, `model`,
  `is_gguf`, `context_length`, `memory_warning`. The load duration is itself a metric.
- A load or unload that runs past 15 s answers 200 at once and pads the body with a space every 20 s.
  A later failure then arrives in the body as `{"_deferred_error": {"status_code", "detail"}}`, so the
  status line alone proves nothing. Early errors keep their status: 400 "Invalid model identifier", 400
  for a non-chat model, 409 with a `gpu_busy` object, 409 "Model load cancelled", 500 "Failed to load
  GGUF model". A disconnect does not stop a load.
- A load of files that are not on disk starts a download, so the app offers only complete quants.
- `GET /api/inference/load-progress` gives `{phase: mmap | ready | null, bytes_loaded, bytes_total, fraction}`.
- `POST /api/inference/unload` with `{model_path, force_cancel_active}`, or with
  `cancel_load_request_id` to cancel one load in flight. Answers `{status: unloaded, model}`.

Inference: `POST /v1/chat/completions`. The app always sends every sampling field explicitly so server
defaults cannot differ between versions or machines:

```json
{
  "model": "<id from /v1/models>",
  "messages": [{"role": "user", "content": "..."}],
  "stream": true,
  "stream_options": {"include_usage": true},
  "temperature": 0, "top_p": 0.95, "top_k": 20, "min_p": 0.01, "repetition_penalty": 1.0,
  "max_tokens": 1024,
  "enable_thinking": true,
  "reasoning_effort": "medium",
  "seed": 42
}
```

`enable_thinking`, `reasoning_effort` and `cancel_id` are Unsloth extensions; `stop` is available.
With no model loaded the route answers 400 "No model loaded. Call POST /inference/load first."
Stream shape (SSE, `data:` lines), verified against Unsloth 2026.9.11 on two machines in phase 3:

- The response carries `Connection: close`, so every streamed run opens a new TCP connection and a
  keep-alive agent cannot help. The handshake is part of the client's time to first token.
- The first chunk carries only `delta.role`.
- `delta.content` for answer text; `delta.reasoning_content` for thinking. Unsloth canonicalises the
  `reasoning` alias to `reasoning_content`, and reasoning-only deltas carry `content: ""`.
- A model can skip its thinking block even with `enable_thinking: true`. Its reasoning then arrives as
  plain `content`, with no tags to split on. Seen once in three runs of a 2-bit quant; the run is flagged.
- `: keep-alive` comments fill quiet gaps, for example during a long prompt.
- A chunk with `choices: []` may carry `context_truncated` when the prompt was cut to fit the context.
  The run is flagged.
- An error after the headers arrives in band as `data: {"error": {"message", "type", "code"}}`,
  followed by `[DONE]`.
- Final chunk with `choices: []`, `usage {prompt_tokens, completion_tokens, total_tokens,
  prompt_tokens_details.cached_tokens}` and `timings {prompt_n, prompt_ms, prompt_per_second,
  predicted_n, predicted_ms, predicted_per_second, cache_n}`. llama-server shape; the MLX backend maps
  its stats onto the same shape. Only sent when `stream_options.include_usage` is true. `prompt_n`
  counts only the prompt tokens processed; the cached ones are in `cache_n`. With speculative decoding
  on, `timings` also carries `draft_n` and `draft_n_accepted`.
- Then `data: [DONE]`.
- Chunks with a top-level `type` (Unsloth tool frames) or without `choices` or `usage` are ignored. Tool
  frames are only sent when the request has the `X-Unsloth-Events` header.
- `usage.completion_tokens_details.reasoning_tokens` reads 0 even when the model thought, so thinking is
  measured by timing and characters, not by that field.

Cancelling: closing the connection stops generation. `POST /api/inference/cancel {"cancel_id"}` stops a
request by the id it was sent with and answers `{"cancelled": N}`. The app does both.

Server-side observation: `GET /api/inference/monitor` returns `entries[]` with `endpoint`, `model`,
`status`, `started_at`, `duration_ms`, `ttft_ms`, `prompt_tokens`, `completion_tokens`,
`prompt_tok_per_sec`, `tok_per_sec`, `decode_ms`, `stop_reason` and `prompt_preview`
(`"user: <prompt>"`, cut at 360 characters), plus `server_time` and a `queue` object
`{capacity, active, queued, free}`. `DELETE /api/inference/monitor` clears the caller's own entries. The
app takes the newest chat completion whose `prompt_preview` starts with its prompt and that finished within
60 s of `server_time`, and retries briefly because the row can trail the stream.

Behaviours that matter:

- Prompt cache. llama.cpp's `cache_prompt` is on by default. Any request with a fixed `seed` turns it
  off for that request (Unsloth sets `cache_prompt = false` for seeded requests). The MLX backend keeps a
  six-entry prompt cache regardless of seed. So `seed` is not a symmetric cache switch; see section 5.
- Admission control is on by default: requests beyond `n_parallel` slots queue FIFO instead of failing.
  Slots are fixed at load time.
- Idle auto-unload is off by default for chat and media models. STT sidecars unload after five idle minutes.
- One GPU owner at a time. Loading an image or video model evicts the chat model and vice versa. STT runs
  alongside the chat model.
- Auto-switch and auto-download of models named in `/v1` requests are off by default. The app loads models
  explicitly and never relies on them.
- Speculative decoding. GGUF loads take `speculative_type`: `auto` (DSpark or DFlash when the model ships a
  drafter, MTP on MTP GGUFs, ngram-mod for small models), `mtp`, `dspark`, `dflash`, `ngram`, `mtp+ngram`,
  `off`. The engaged method depends on the model, the llama.cpp build and the platform, so two machines can
  decode with different methods. The desktop app keeps its own global choice in browser storage, which API
  loads do not inherit, so the app always sends `speculative_type` and reads back `speculative_type`,
  `spec_drafter_kind` and `spec_fallback_reason` from status. In phase 3, models loaded in the desktop app
  with `auto` ran MTP on both machines: the RTX 3060 kept 0 of 64 drafted tokens, and the Radeon 780M kept
  202 of 336. Kept drafts arrive together, so gaps between chunks become uneven.
- Partial offload. Status reports a `memory_warning` when the weights do not fit and llama.cpp pages
  them from disk. Such a load is not a fair GPU comparison. `gpu_layers` is only the manual-mode
  request; in the default auto mode it reads -1 whatever landed on the GPU.
- Token counting. `POST /v1/chat/count_tokens` with the chat messages returns `input_tokens` from the
  loaded tokenizer. It answers 503 while a generation is running, so it is only used before a round.

### 2.4 Transcription

- `GET /api/inference/audio/stt/status`: availability per engine and the resident model.
- `POST /api/inference/audio/stt/load` with `{model, engine, device}` returns `{loaded_model, device}`.
  Curated models: `tiny`, `base`, `small` (default), `large-v3-turbo`, `large-v3`, mapped to
  `unsloth/whisper-*` repos; a validated Hugging Face `owner/model` id also works.
  Engines: `transformers` (default, PyTorch; on Apple Silicon this runs fp32 on MPS and is slow),
  `gguf` (whisper.cpp `whisper-server`, about 2.5x faster on Apple Silicon and CPU, needs the binary built
  by `scripts/build_whisper_cpp.sh`; it silently falls back to transformers when the binary is missing),
  `mtmd` (llama.cpp, Qwen3-ASR). Device: `auto`, `cpu`, `gpu`.
- `POST /v1/audio/transcriptions`, multipart: `file`, `model` (curated id, HF id, or `whisper-1` for the
  default), `language`, `response_format`. `verbose_json` returns `{task, language, duration, text}` and
  requires `language`; there are no segment timestamps. `json` returns `{text}`.
- `POST /api/inference/audio/stt/unload`.
- Monitor rows exist for `/v1/audio/transcriptions`. Their `duration_ms` starts after the upload has been
  fully received, so it is the server-side processing time without the upload.
- Status as read from the RTX machine (Studio v0.1.815-beta): top level `{available, loaded_model, loading,
  device, keep_alive_seconds: 300, default_model: "small", models}`, and one object per engine
  (`transformers`, `gguf`, `mtmd`) with `{available, loaded_model, loading, device, models,
  downloaded_models, download}`. `mtmd` offers `qwen3-asr-0.6b` and `qwen3-asr-1.7b`. Loading a model that
  is not in `downloaded_models` starts a download, so pre-flight refuses it.
- `DELETE /api/inference/monitor` clears the caller's own monitor rows.
- **The OpenAI-shaped route ignores the loaded engine.** `/v1/audio/transcriptions` serves a Whisper id
  with the default engine, Transformers, whatever `stt/load` loaded; only Qwen3-ASR ids go to mtmd. A
  GGUF race through it failed on the RTX machine with "STT model 'large-v3-turbo' is not downloaded",
  because only the GGUF copy was on disk. Unsloth's own `POST /api/inference/audio/transcribe/raw` takes
  the audio as the raw body and `model`, `language`, `engine` and `device` in the query, and answers
  `{text, language, duration, model}`. Model Duel uses it, and falls back to the multipart route only
  when it answers 404 or 405. Only the multipart route leaves a monitor row, so Unsloth's own
  processing time is missing on the raw route. Loads and transcriptions of a model that is not on disk
  answer 409.

### 2.5 Image generation

Verified against the backend source (`routes/inference.py`, `models/inference.py`,
`core/inference/diffusion.py`, `gpu_arbiter.py`) and the RTX machine on 2026-09-25. All image routes
are under `/api/inference/images/` only.

- `POST .../load` with `{model_path, gguf_filename, model_kind, memory_mode, speed_mode, transformer_quant,
  text_encoder_quant, cpu_offload, ...}`. A GGUF image model is named by `gguf_filename`, the file inside the
  repo, which `GET /api/models/gguf-variants` lists; there is no `gguf_variant` field. The route **returns at
  once** with the status of whatever is resident; the load runs in a thread, so poll
  `GET .../load-progress` (`{phase: null|downloading|finalizing|ready|error, bytes_downloaded,
  bytes_total, fraction, error}`) until `ready` or `error`. A model that is not on disk is **downloaded**,
  so pre-flight must check the files first. Loading the same model again rebuilds it; there is no
  already-loaded shortcut. 409 for a load in flight, active training, or `gpu_busy` from another account.
- Load-progress reports no phase only when no load is in flight and no model is loaded. Model Duel waits
  30 s before treating that as a failed load, and trusts `images/status` in the meantime. A load of the
  full FLUX.2-klein-9B pipeline on the RTX machine ran past 30 minutes; Model Duel now stops a load it
  started after 20 minutes, or when the race is cancelled, with `POST .../unload`, so it cannot finish
  later and hold the GPU, and does not try a model that failed to load again in later rounds.
- **GPU hand-off:** a GPU image load evicts the chat model (llama-server) as the load starts, even if the
  load then fails. Nothing reloads it; an explicit `POST /api/inference/load` brings it back and evicts the
  image model in turn. STT is not part of this hand-off.
- `GET .../status` (`DiffusionStatusResponse`): `loaded, repo_id, family, base_repo, device, dtype,
  model_kind, gguf_filename, gguf_variant, cpu_offload, offload_policy, vae_tiling, memory_mode,
  speed_mode` (the effective one), `speed_optims[]` (those that engaged), `text_encoder_quant,
  transformer_quant, attention_backend, transformer_cache, workflows, engine: diffusers|sd_cpp,
  native_mode, fallback_reason`, and `resolved`, a map of `{value, requested, source, status, reason}` per
  setting. Another account's model shows as `{loaded: true, yours: false}`.
- `POST .../generate` with `{prompt, negative_prompt, width, height, steps, guidance, seed, batch_size}`:
  width and height 256 to 2752 in steps of 16 (the family may cap lower), steps 1 to 100 (default 9),
  guidance 0 to 20 (default 0), seed 0 to 2^53-1 (-1 is refused; null picks one). It blocks until the PNGs
  are saved and returns `{images: [GalleryImage]}` with `id, url, seed, steps, guidance, width, height,
  model, gguf_filename, transformer_quant, created_at, ...` and **no timing fields**. A second generate
  queues behind the first. 409 "No diffusion model is loaded."; 500 on failure, with an OOM hint.
  `POST .../generate/cancel` cancels.
- `GET .../generate-progress` gives `{active, step, total_steps, fraction, eta_seconds}`. `step` rises once
  per denoising step. After the last step it stays at `total_steps` through the VAE decode, then reads
  0 of 0 while the PNGs are saved, then `active` turns false. `total_steps` grows by `steps` when an out of
  memory error splits the batch. Polled at 10 Hz for the per-step timeline.
- Image bytes: `GET .../gallery/{id}/file`, always PNG.
- Image routes make no monitor rows (only the OpenAI-shaped route does), so every image time is measured
  by Model Duel.
- The OpenAI-shaped `POST /v1/images/generations` has no steps or seed control, so it is not used.
- Engine: diffusers on CUDA, ROCm and XPU; sd.cpp only for GGUF on CPU, or on Apple Silicon with
  `UNSLOTH_DIFFUSION_SD_CPP_MPS=1`. `speed_mode: off` is the bit-identical baseline; `eager`, `default` and
  `max` add optimisations and compilation, so they must match on both sides. Unset, GGUF runs `default`.
- The RTX machine has FLUX.2-klein-9B GGUF Q4_K_M and Qwen-Image-2.1 GGUF Q8_0 and Q4_K_M on disk.

### 2.6 Telemetry

- `GET /api/train/hardware` returns `{available, backend, devices: [{index, gpu_utilization_pct,
  temperature_c, vram_used_gb, vram_total_gb, vram_utilization_pct, power_draw_w, power_limit_w,
  power_utilization_pct}]}`. NVIDIA via nvidia-smi, AMD via amd-smi or rocm-smi, Apple Silicon via
  IOReport (GPU energy) and SMC (temperature) with no sudo. The first Apple power sample is null because it
  needs a delta. `GET /api/train/hardware/visible` lists every visible GPU.
- `GET /api/system` gives `cpu.usage_percent`, `memory.percent_used`, `memory.available_gb`.
- Poll both at 2 Hz during a run, stamp on arrival, store samples with the run. Polling adds a little load
  on the machine under test, so it can be switched off for a clean run.
- Verified in phase 7 on the RTX 3060: the hardware route answers in about 77 ms, and its readings matched
  `nvidia-smi` exactly (GPU %, power to 0.01 W, temperature, VRAM). Polling at 2 Hz costs Unsloth about 0.1
  CPU core with its child processes (1.22 s of CPU per 10 s polled against 0.26 s idle); decode speed and
  time to first token showed no difference beyond run-to-run noise. As built, each sample is stamped at the
  middle of its request, on fresh connections (reused ones stall 40 ms), and the next poll starts only when
  the last one is done. The `backend` of the hardware route tells unified memory (`mps`, `mlx`) apart, where
  there is no VRAM to report.

### 2.7 Cloud reference models

Not Unsloth, but raced beside it on the Text tab. Contracts as documented by each provider and
checked on 2026-09-25; `shared/src/cloud.ts` holds them and the fake providers in `mock/src/cloud.ts`
copy them.

- **Participants.** A cloud participant is a machine record with `cloud: {provider, model}`: its key
  is `apiKey` and its API address `baseUrl` (https unless typed otherwise). The provider cannot change
  after it is saved, and a saved key is used only for its own provider. `model` is chosen from the
  provider's list and keeps what the model accepts: context window, output limit, `thinking`
  (`always`, `optional`, `none`), the style of thinking control, effort levels and sampling fields.
- **Model lists.** OpenAI `GET /v1/models` (Bearer key) lists ids only, so what a model accepts comes
  from its family, and embedding, moderation, audio, realtime, image and video ids are dropped.
  Anthropic `GET /v1/models?limit=1000` (`x-api-key`, `anthropic-version: 2023-06-01`, pages by
  `after_id`) gives display names, token limits and capabilities: thinking types (adaptive, enabled)
  and effort levels. Gemini `GET /v1beta/models?pageSize=1000` (`x-goog-api-key`, pages by
  `pageToken`) gives limits, generation methods and `thinking`; only `generateContent` models that are
  not TTS, live, image, embedding and similar are kept.
- **Requests.** OpenAI: `POST /v1/responses` with `stream`, `store: false`, `max_output_tokens`,
  `reasoning {effort, summary: auto}`; temperature and top-p only for non-reasoning models or effort
  `none`; no seed or top-k. `minimal` is only for the first GPT-5 models. Anthropic: `POST /v1/messages`
  with `max_tokens`, `thinking {type: adaptive, display: summarized}` or `{type: disabled}` (or
  `enabled` on older models, with a budget of 60 percent of Max tokens and at least 1024, sent only
  when Max tokens is above 1024), `output_config.effort`, and no sampling fields, which newer models refuse. Gemini:
  `POST /v1beta/models/{id}:streamGenerateContent?alt=sse` with `maxOutputTokens`,
  `thinkingConfig {includeThoughts, thinkingLevel}` on Gemini 3 (which cannot stop thinking) or
  `thinkingBudget` on 2.5, sampling only before Gemini 3, and the seed with cold prefill.
- **Effort.** With Thinking on, the level asked for, or the nearest one the model takes. With Thinking
  off, the lowest (`none`, `minimal` or `low`), so a model that always thinks thinks as little as it can.
- **Streams.** Each provider's events become Unsloth's: OpenAI `response.output_text.delta`,
  `response.reasoning_summary_text.delta`, `response.completed` or `response.incomplete` with usage;
  Anthropic `content_block_delta` (`thinking_delta`, `text_delta`), `message_delta` with the stop reason
  and usage, `message_stop`; Gemini chunks with `parts[].thought`, `finishReason` and `usageMetadata`,
  finished by the end of the stream. `max_output_tokens`, `max_tokens` and `MAX_TOKENS` become
  `length`. Errors in every shape become a run error in words: a refused key, rate limiting,
  overload.
- **Tokens.** Output tokens count what streamed: thinking a provider kept hidden is subtracted from
  its billed output, while summarised thinking counts in full. The decode speed is then approximate for
  summarised thinking, and the report says so. The provider's own usage, request id and OpenAI's
  `openai-processing-ms` are kept in the run's server details.
- **Everything else.** No status, probe, telemetry, energy, slots or cancel id; the run ends by closing
  the connection. Pre-flight errors when no model is chosen or Max tokens is above the model's output
  limit, and notes the thinking mismatch and that times include the internet and the provider's queue.

## 3. Architecture

- Controller: Node 22.19 or newer (undici 8 needs it), TypeScript 6.0, Fastify. Serves the SPA, drives every Unsloth instance, owns
  all timestamps, persists sessions under `./data/`. The browser never talks to the machines.
- Client: React, Vite, TypeScript, plain CSS. Dark theme, one accent colour per machine.
- Packages: `server/`, `client/`, `shared/` (types, metric math, SSE parser, workload interfaces),
  `mock/` (mock Unsloth backend), `fixtures/` (recorded streams), `data/`.
- Machine record: `{id, name, baseUrl, apiKey, notes, probe}`. Keys live in `data/machines.json`
  (mode 600) and are never written into session files or exports. The controller binds to loopback
  and refuses requests addressed to unknown host names, which blocks DNS rebinding.
- Session record: `{id, workload, config, machines[], rounds[], provenance, telemetry, votes,
  schemaVersion}`. Sides are a list, not A and B. As built in phase 4, `data/sessions/<id>.json` holds
  `schemaVersion: 1`, `createdAt`, `finishedAt`, `state` (running, done, failed, cancelled or
  interrupted), `config` with the sampling sent, `machines[]` as they were at the time, `rounds[]` with
  `sendSkewMs` and one run per machine, `provenance[]` per machine (probe versions and GPUs, status
  before and after, the exact request body) and the event-loop lag. Each run keeps its raw events in a
  compact form, `[t, read, 'r' | 'c', text]` for tokens and `[t, read, event]` otherwise, with times
  from its own request, so metrics can be recomputed later. A file left `running` by a crash is marked
  interrupted at startup; unreadable files and files from a newer schema are skipped, not fatal.
- Workload plugin interface in `shared/`:

```ts
interface Workload<C> {
  id: 'text' | 'transcribe' | 'image' | 'command';
  configSchema: ZodSchema<C>;
  presets: Preset<C>[];
  prepare(machine: Machine, config: C): Promise<PrepareResult>;   // load model, warm engine, timed
  run(machine: Machine, config: C, ctx: RunContext): AsyncIterable<RunEvent>; // timestamped events
  metrics(events: RunEvent[], serverSide: ServerSide): RunMetrics;
  headline(a: RunMetrics, b: RunMetrics): Headline[];              // scoreboard sentences
}
```

- Agent (built in phase 12, `agent/`): a Fastify service started with `npm run agent` on a machine,
  port 8765, with a bearer token. `GET /health` names the agent to anyone and, with the token, lists
  its platform, ffmpeg version, the known encoders it has, which template each would use, its clips
  (name, size, SHA-256, frames, length, from ffprobe), macmon or nvidia-smi, and whether it is busy.
  `POST /jobs` takes `{template, clip, bitrateMbps, crf, x265Preset, maxSeconds}` and nothing else
  (a strict schema); the agent resolves the encoder, builds the ffmpeg argument list itself, runs it
  with `-progress pipe:1 -stats_period 0.1` into a temporary file, and deletes the file after
  measuring it. One job at a time (409 otherwise). `GET /jobs/:id/stream` sends every event so far and
  then the rest: `started {encoder, argv}`, `progress {frame, fps, outTimeMs, speed, totalSize, done}`,
  `telemetry {cpuPowerW, gpuPowerW, anePowerW, gpuPct, encoderPct}` and `finished {exitCode,
  cancelled, wallMs, outputBytes, stderrTail}`. `POST /jobs/:id/cancel` stops it. `--fake` adds a
  scripted encode and clip for the demo and tests.
- Command workload: templates `hevc-hardware` (hevc_nvenc, else hevc_videotoolbox), `prores-hardware`
  (prores_videotoolbox), `x265` (libx265) and `fake`. Pre-flight needs an agent on every machine that
  is free, accepts the token, has the encoder and has the clip with the same SHA-256; different
  encoders are a note. Metrics: encode time (the agent's `wallMs`), frames per second, speed, time to
  the first progress with a frame, output size, energy per encode from Unsloth's telemetry, and the
  agent's own power readings. Energy lines up with when the agent's events arrived, since its clock is
  its own. Sessions are schema version 9, with `command` on each run and the agent's health in the
  provenance. Machines keep `agentUrl` and `agentToken` beside the API key; the token never reaches
  the browser.

### 3.1 Probe

`POST /api/machines/:id/probe` calls health, system, hardware, status, models, props, stt status, image
status and one hardware telemetry read. It records which routes answered, versions, GPU inventory and engine
availability (whisper.cpp binary present or not). The machine card shows the result. Anything the probe
found missing is greyed out in the UI instead of failing during a session.

## 4. Workloads

### 4.1 Text generation

Config: model per machine (dropdown from `/v1/models`, Load button per machine, context length request),
prompt preset or custom prompt, `max_tokens`, thinking on or off plus effort, rounds, warm-up, prefill mode
(warm or cold), sampling fields.

Presets: Short (one-line question); 8K and 32K built from a public-domain text (Mill's On Liberty from
Project Gutenberg) with a fixed instruction, the token count confirmed from `usage.prompt_tokens` after the
first run and displayed; a reasoning puzzle; a code task.

Per-run timestamps on the controller, monotonic, relative to the moment the request is handed to the
network, connection setup included (Unsloth closes streaming connections): `t_headers`, `t_first_token`
(any kind), `t_first_reasoning`, `t_first_answer`, `t_last_token`, `t_end`.

Metrics: TTFT (first token of any kind), time to first answer (perceived wait), thinking duration, decode
tok/s as `(N - 1) / (t_last - t_first)`, end-to-end tok/s, prefill tok/s from Unsloth's
`timings.prompt_per_second` (a client estimate `prompt_tokens / (TTFT - RTT)` only means something for
long prompts, since Unsloth spends about 20 ms before its clock starts), characters per second, inter-chunk latency (mean, median, p95, max, with
coalesced reads flagged), reasoning versus answer token estimates from delta counting, and the exact totals
from `usage`.

Server-reported, shown in a second column per machine: `timings.prompt_per_second`,
`predicted_per_second`, `prompt_ms`, `predicted_ms`, `cache_n`, and the monitor's `ttft_ms`. The gap
between client and server TTFT is network plus HTTP overhead: in phase 3 it was 20 ms when the app
ran on the same computer as Unsloth, all of it Unsloth's own request handling, and 50 to 71 ms over
Wi-Fi. Client and server decode speeds agreed within 0.3 percent on both machines.

Flags on a run: `context_truncated` seen; `cache_n > 0` or `cached_tokens > 0` (prefix cache hit);
coalesced-read ratio; `stop_reason = length` (hit `max_tokens`); thinking requested but none arrived on
its own; speculative decoding engaged (`draft_n > 0`); the loaded model changed during the run.

Throughput mode (built in phase 11): N identical requests per machine, sent in the same tick, each with
its own `cancel_id` (the round's id and its number). The first streams into the pane; each is measured
on its own. Aggregate tok/s is every finished request's output tokens over the time from the first
request sent to the last done, so prompt processing and slot waits count against it. Also the median
request speed, TTFT median and 95th percentile (nearest rank), and the admission queue read from the
monitor's `queue` every 250 ms: peak active, peak queued, and the time at least one request waited.
Energy covers the whole batch, and tokens per joule uses every request's tokens. Pre-flight takes the
slots from `parallel_slots` in the status, else `total_slots` in `/v1/props`; more requests than slots
is an error with a "reload with N slots" shortcut, unknown slots a warning, and a prompt plus Max
tokens over the context divided by the slots a warning, since llama.cpp may split the context. On
the RTX machine, with 4 slots and a 15,360-token context, `/v1/props` also reported `n_ctx` 15,360.
Sessions are schema version 8: `mode` and `concurrency` in the text config, `throughput` on each run.

### 4.2 Transcription

Config: model, engine and device per machine (defaults identical on both); audio preset: a bundled
clip of LibriSpeech test-clean utterances (LibriVox recordings with verified transcripts, CC BY 4.0,
attributed in the README), "long" = the clip concatenated to N minutes,
or a user file with optional reference text; rounds; warm-up.

Sequence per round: ensure the STT model is loaded (`stt/status`, then `stt/load` if needed, because the
sidecar unloads after five idle minutes); clear the monitor; POST the file to `/v1/audio/transcriptions`
with `verbose_json` and an explicit `language`; stamp body-sent and response-start; read the monitor row.

Metrics: upload time; processing time (client: response start minus body sent; server: monitor
`duration_ms`); real-time factor (audio seconds per processing second); model load time; word error rate
against the reference (normalised text, word-level Levenshtein, implemented in `shared/`); the engine and
device that actually served.

As built in phase 9:

- Sessions carry a `workload`, `text` or `transcribe`, with the matching config (schema version 6; older
  files are text). One race runs at a time whatever its workload.
- Pre-flight per machine: speech-to-text missing, a model or engine loading, an engine the machine lacks,
  a curated model the engine does not offer, or a model not downloaded for the engine that would serve it
  are errors. GGUF falling back to transformers, and machines serving different engines, are warnings.
  Uploaded audio that is gone is an error.
- Each round: `stt/status` and `stt/load` per machine in parallel before anything is timed, with the load
  time kept on the run; clear the monitor; round trip; then the multipart POST, streamed so the moment the
  last byte leaves is stamped. Upload is request to last byte; processing is last byte to response
  headers; the monitor row gives Unsloth's own processing time. The warm-up sends the first 5 s of the
  clip.
- Word error rate is computed after the round, not while other machines are still being timed, because
  aligning a half-hour transcript takes a noticeable moment.
- Audio: the bundled clip (`server/assets/`), the clip repeated into one WAV of at least N minutes, or a
  file uploaded to `POST /api/audio` (up to 256 MB, stored in `data/audio/` by SHA-256).

### 4.3 Image generation

Config: model per machine (same repo and the same `gguf_filename` or quant on both), width, height,
steps, guidance, seed, `speed_mode` (default off), rounds, prompt preset.

Sequence per round: ensure loaded (`images/status`, else `images/load`, timed); POST `images/generate`
while polling `generate-progress` at 10 Hz; fetch the image bytes.

Metrics: model load time; time to first step; steps per second from the progress timeline; total wall time;
decode tail (end minus last step); seconds per image at the chosen batch size; energy per image.

Quality: side by side with identical seeds. Metal and CUDA produce different pixels even with the same
seed, so this is a sanity check, not a diff.

As built in phase 10:

- Config: repo and GGUF file (the same on every machine), prompt preset or custom prompt, negative
  prompt, width and height (256 to 2048, multiples of 16), steps (default 9), guidance (default 0), seed
  (default 42), memory mode (default auto), speed mode (default off), and whether to load the chat model
  again afterwards (default on). One image per run.
- Pre-flight: the file is checked on disk through `gguf-variants` (or the local list for a pipeline);
  missing is an error, uncheckable a warning. The chat model a load will push out is a **note**, a level
  that informs without needing "race anyway". Different platforms, or different resolved settings when
  the model is already resident everywhere, are a warning. Speed modes other than off get a note.
- Each round: `images/status`, and `images/load` only when the resident model, file, memory mode or speed
  mode differ; then load-progress until ready. The warm-up makes a two-step image at the same size. Then
  a round trip and `images/generate`, with `generate-progress` read every 100 ms on fresh connections;
  each reading is placed at the middle of its request. The image is fetched from the gallery after the
  timing ends and kept in `data/images/<session>/<run>.png`.
- Metrics: time per image (request to answer), time to first step, steps per second between the first
  and last step readings, decode and save (answer minus the last step reading), load time, energy per
  image, and mean power while denoising. A run whose `total_steps` grew was split for memory and is
  flagged.
- After the rounds, and after a cancel too, each machine whose chat model was pushed out gets it back
  through the load manager, with Model Duel's last load settings for it or the ones its status showed.
  Cancel answers once the rounds stop, without waiting for that reload.

### 4.4 Telemetry and energy

Poll per section 2.6 during every run and for five seconds before and after as baseline. Derived: peak
GPU %, peak VRAM, mean power during decode, energy per run (trapezoid integral of power), tokens per joule,
joules per image, joules per audio minute. Energy is labelled approximate: board power on NVIDIA, GPU rail
on Apple. As built, the integral skips pairs of samples more than 2 s apart or with a null reading, and a
run whose power readings cover under half of it gets no energy. On the RTX 3060 the integral came within 2
to 4 percent of mean power times duration, about 0.14 tokens per joule at 164 W.

## 5. Fairness and methodology

1. Identical request bodies except `model` and the machine's own key. Every sampling field explicit.
2. `max_tokens` always explicit and printed. It includes thinking tokens on these backends.
3. Thinking is an explicit switch (`enable_thinking`) plus `reasoning_effort` where the model uses it. Both
   appear in the report.
4. Warm-up: one short request per machine, discarded. It also opens the keep-alive socket and, for STT,
   warms the sidecar.
5. Rounds: N (default 3). Median plus min, mean and stdev; every raw round kept.
6. Prefill mode. Warm: same prompt every round, no seed, cache allowed on both. Cold (default): a random
   nonce line is prepended to the user message each round and a fixed seed is sent, so llama.cpp's cache is
   off by the seed and MLX's cache is defeated by the nonce. `cache_n` and `cached_tokens` are shown either
   way, so a cache hit is always visible. Measured in phase 6 on the RTX machine with the 8K preset: cold
   rounds reported 0 cached tokens and took 15.3 to 15.7 s to the first token; warm rounds 2 and 3 reused
   7,543 of 7,547 prompt tokens and took 285 and 258 ms. As built, a run counts as a cache hit above 64
   cached tokens, so a chat template (about 30 tokens) never triggers the flag. The nonce line is the same
   in every round (only the nonce changes), and all machines in a round get the same nonce and the same
   `cancel_id`, so their bodies differ only in `model`.
7. Output-length confound: ratio headlines only on TTFT, tok/s, characters per second and processing time.
   Totals are shown next to token counts. Optional fixed-length mode: `max_tokens = N` with a prompt that
   always overruns it; `stop_reason` must be `length` on both sides or the round is flagged. As built it is
   a preset: a request for an essay of at least 3,000 words. Endless-counting prompts do not work: the model
   counted to ten and stopped, and asked to write out 5,000 numbers it declined after 56 tokens.
8. RTT: three round trips before each round, shown per machine. As built in phase 5 they are TCP handshakes
   to the Unsloth port, not `GET /api/health` on a keep-alive socket: Unsloth's HTTP answers on a reused
   connection stall for about 40 ms (Nagle's algorithm meeting delayed ACKs), measured with curl and undici
   alike, while a fresh connection answers in 2.5 ms and the handshake itself takes 0.15 ms on loopback.
   When the controller runs on one of the machines, that side has near-zero RTT; compare the
   server-reported columns first.
9. Sequencing: concurrent across machines by default; sequential ABBA mode when two endpoints resolve to
   the same host. Every machine's status is read first, then all requests are handed to the network in one
   synchronous loop. The spread of those moments is recorded as the send skew: under 1 ms on the mocks,
   1.1 ms between the two real machines.
10. Timeouts: idle (no bytes) and total, both configurable. Cancel aborts the upstream socket. Settle delay
    between rounds. A failed side never stops the other.
11. Context: request the same `max_seq_length` on both, read `context_length` back from status into the
    report, abort the round if `context_truncated` appears. As built, pre-flight has each machine count the
    exact prompt with `POST /v1/chat/count_tokens` (verified on Unsloth 2026.9.11: it answers
    `{input_tokens, model}`) and refuses a race whose prompt plus `max_tokens` does not fit a context. A
    `context_truncated` that still arrives stops the round and the session, because every later round would
    be cut the same way.
12. Provenance per session: Unsloth version, llama.cpp version, backend (GGUF or MLX), model id, quant,
    context length, `n_parallel`, speculative decoding method and drafter, KV cache type, GPU memory mode,
    STT and image engine and device, GPU inventory, the `/api/system` snapshot, the exact request
    bodies, machine notes.
13. Self-checks: controller event-loop lag sampled during runs, coalesced-read ratio, admission queue state
    from the monitor. Rounds with lag over a threshold are flagged.
14. Winner gate: a winner is highlighted only when the per-round ranges do not overlap or the median gap
    exceeds ten percent; otherwise the scoreboard says tie. As built, the gap is the ratio of the two medians
    (more than 1.10), the leader is compared with the runner-up only, and ranges count only when both
    machines have at least two finished rounds. Phase 5 measured the noise floor on the RTX machine at a
    decode-speed standard deviation of 1.6 percent of the median over five rounds, well inside the gate.
    Since phase 16 the plan's `statistic` (`median` by default, or `mean`) picks what the gate, the
    comparison, the scoreboard, the exports and the result file compare; a finished race can switch,
    and races without the field used the median. A race runs 1 to 100 rounds.
15. Decoding path: `speculative_type` is sent explicitly and identically at load, `off` by default for
    benchmarks; `auto` can be tested as a labelled variant. Pre-flight compares the engaged speculative
    method, KV cache type, backend (GGUF or MLX) and GPU memory mode across machines, and a
    `memory_warning` blocks the run. As built, differences of model, quant, backend, context length,
    speculative method, KV cache type and GPU memory mode are warnings the user must accept with "Race
    anyway"; a machine that cannot race, a prompt that does not fit, a memory warning and thinking asked of
    a model that cannot think are errors.

## 6. Controller API (server to browser)

- Machines: `GET/POST/PUT/DELETE /api/machines`, `POST /api/machines/:id/probe`,
  `GET /api/machines/:id/models`, `GET /api/machines/:id/status`, `POST /api/machines/:id/load`
  (workload-aware: text, stt, image), `POST /api/machines/:id/unload`,
  `GET /api/machines/:id/telemetry` (SSE at 2 Hz).
- Sessions: `POST /api/sessions` with `{workload, config, machineIds[]}` returns the session (409 while
  another runs; one at a time); `GET /api/sessions/:id/stream` (SSE; the first event is a snapshot so a
  page reload resumes); `POST /api/sessions/:id/cancel`; `GET /api/sessions` (summaries, newest first);
  `GET /api/sessions/:id`; `DELETE /api/sessions/:id` (409 while running);
  `GET /api/sessions/:id/export.(json|csv|md)`; `POST /api/sessions/:id/vote`.
- Transcription (phase 9): `POST /api/audio?name=` takes the raw file and answers `{id, name, bytes,
  contentType, seconds}`; `GET /api/audio/clip.wav` serves the bundled clip; `GET /api/machines/:id/stt`
  answers a machine's STT status. `POST /api/preflight` and `POST /api/sessions` take `workload`, which
  defaults to `text`.
- Agents (phase 12): machines take `agentUrl` and `agentToken`; `GET /api/machines/:id/agent` answers
  the agent's health, and the probe includes it as `agent`.
- Cloud models (phase 14): machines take `cloud: {provider, model}`; `POST /api/cloud/models
  {provider, apiKey?, baseUrl?, machineId?}` answers `{models}` from the provider, with a saved
  participant's key when `apiKey` is empty, or 502 with the provider's refusal in words. A cloud
  participant answers 400 to a probe and is left out of hosts, status and telemetry.
- `POST /api/sessions/:id/statistic {statistic: median | mean}` switches a finished race and rewrites
  its result file (phase 16). Session summaries carry `statistic`.
- Sharing (phase 17): `GET /api/share/settings` (address, masked token, public key, fingerprint,
  what was sent), `PUT /api/share/settings {endpoint, token?}`, `POST /api/share/preview
  {sessionId, machineId, options}` answering `{record, sha256}`, and `POST /api/share/send` with the
  same and the preview's `sha256`. Every non-GET request is refused with 403 when `Origin` names
  another host or `Sec-Fetch-Site` says `cross-site` or `same-site`.
- Results (phase 15): `GET /api/runs` answers `{runs}`, one row per machine per finished race,
  newest race first (section 7.2).
- `POST /api/machines/:id/reload-slots {slots}` loads the machine's chat model again with that many
  slots and its other settings, through the load manager, and answers 202 with the load job.
- Images (phase 10): `GET /api/machines/:id/image` answers the image status and the image models on disk
  with their complete GGUF files; `GET /api/sessions/:id/images/:runId` serves a kept image. Sessions are
  schema version 7, with `image` on each run and `imageBefore`, `imageAfter` and `restore` in the
  provenance.
- SSE messages as built in phase 4: `snapshot {session}`, `delta {round, runs: [{machineId, state,
  reasoning, answer, live}]}` every 50 ms, `run {round, run}` when one machine finishes, and
  `finished {session}`. A snapshot and the deltas after it never repeat text: joining flushes pending
  text to the existing listeners first. The events below arrive with their phases.
- Planned SSE events: `session.started`, `prepare.progress {machine, phase, fraction}`, `round.started`,
  `run.token {machine, kind: reasoning | content, text, t_ms, coalesced}`,
  `run.progress {machine, step, total}`, `run.telemetry {machine, sample}`,
  `run.finished {machine, metrics, serverSide, flags}`, `run.error`, `round.finished`,
  `session.finished {report}`.
- Forwarding to the browser is batched every 50 ms. Timestamps are taken on arrival before anything else.
- `GET /api/health` answers `{ok, app, version, mode, build}`. `mode` is `dev` behind the Vite dev server.
  `build` is the id of the page build the server found at startup, from the `build.json` Vite writes next
  to the page. The page compares it with its own id and asks for a restart when they differ, because a
  server left running through a rebuild serves the new page without its new routes.
- An unknown `/api/` route answers 404 `{"error": "no_route"}`. The page reads that, and the bare
  "Not found." of servers before phase 3, as a server older than the page.

## 7. UI

Tabs: TEXT, TRANSCRIBE, IMAGE, COMMAND. Top bar: preset chips, rounds, START and CANCEL.
One pane per machine: name, model line, telemetry chips (GPU %, power W, CPU %, RAM, temperature), big live
numbers (first token, tok/s, elapsed), streamed text with the thinking block (expanded while thinking,
collapsed once the answer starts), or a progress bar and the image, or the transcript.
Below the panes: scoreboard sentences with ratios and the confidence gate; race chart (cumulative tokens
against time, both machines overlaid, reasoning in a lighter shade); comparison table with client and server
columns; per-round table; telemetry chart overlaying power on token rate; results log (history, reloadable);
blind-vote control that hides machine names until a vote is cast; export buttons. As built in phase 8: the
comparison, round and setup tables are shared table models that the page, the CSV and the Markdown all
render, so the three cannot disagree; each run keeps a token timeline of at most 400 points for the chart;
the blind vote shows only the answers, sides shuffled per round, records `{round, left, right, choice}` in
the session, and the tally counts per pair of model-and-quant labels across sessions; charts use uPlot.
Machine setup screen: cards with base URL, API key, name, notes, a Probe button showing versions, GPU and
engines, model dropdowns with Load buttons and load progress.

### 7.1 Result files

Every finished race is also written as a result file in `data/results/`, in a public, versioned format
meant for sharing (`format: "model-duel-result"`, `formatVersion: 1`), separate from the session file so
that the app's own storage can change freely. It holds the settings, the machines' hardware, software,
model state, exact request and setup table, every round and run with a uniform `metrics` map keyed by
`metricDefinitions`, the workload details, telemetry, token timelines and raw events, the statistics,
the scoreboard and the votes. Keys and tokens never enter it; machine addresses and notes are left out,
and local paths and network addresses in messages and settings are replaced. A SHA-256 over the file's
canonical JSON (sorted keys, no spaces) detects damaged or edited copies; it is not a signature. The
format, its privacy rules and its versioning are described in `docs/result-format.md`, with a JSON
Schema generated from the zod definition in `shared/src/result.ts`. Built in phase 13.

### 7.2 Results tab

A RESULTS tab lists every machine's run in every finished race, one row each, built by
`deviceRuns` in `shared/src/runs.ts` from the session's provenance and `sessionStats`, so its
numbers are the report's medians. A row holds the hardware from the probe taken with the race
(GPU names and memory added up, platform, RAM, system, versions); the model, quant and engine that
ran for the workload (the chat model for text, the STT model and engine for transcription, the
image repo and the quant in its GGUF file name for images, the encoder for commands); the chat
model's context, KV cache type, GPU layers, slots, speculative decoding and GPU memory mode; the
prompt, prompt tokens, prefill, thinking and Max tokens; the workload's other settings in a few
words; every metric's median and average; the metrics it won in its race; and its state (`done`, `partial`,
`failed`, `cancelled`, `interrupted`). Unsloth reports the KV cache's type, not its size.

The server builds a race's rows once and keeps them until the race is saved again or deleted. The
page picks a workload (each has its own metric columns; "all" shows one headline metric), filters
by search and by lists of the values present, each counted under the other filters, sorts by any
column, stars the best value of each metric among the rows shown, lets the viewer pick columns per
workload (kept in the browser), and downloads the rows shown as CSV with raw values. Column
definitions, shared by the page and the CSV, are `runColumns` in the same module.

### 7.3 Sending runs to a results service

Mani plans a public service that collects runs from anyone. Each Results row has a **Send** button
that sends that run, after a dialog shows the record exactly as it will go; the server builds,
checks, signs and sends it, and the browser supplies only which run, two options (a display name,
and whether to include a custom prompt) and the preview's checksum, so nothing but the previewed
record can leave. The format is `model-duel-run` version 1 (`shared/src/share.ts`, JSON Schema in
`docs/share-format.schema.json`): race, machine, model and settings as in the Results row, every
metric with its per-round values, and a submission id stable per sender, race and machine. It
holds no keys, machine names, addresses, notes, answers, thinking, file names or paths, the OS as
family and version only, and strings are cleaned of control and direction characters and redacted
like result files. The envelope adds the SHA-256 of the record's canonical JSON and an Ed25519
signature over the same bytes, with a key pair made per installation and kept in
`data/share.json` (mode 600) with the address and optional bearer token. The address must be https
(http only to loopback, for testing) without credentials; sends time out after 20 seconds, follow
no redirects, read at most 64 KB of the answer and use only a checked `id`, a `url` on the
service's host and a short plain-text `message`. `docs/share-api.md` is the contract and the
security checklist for the service; `mock/src/share.ts` is a working reference.

## 8. Timing discipline

`performance.now()` only. Stamp first in the data handler, then parse. Parse SSE events, not raw reads, and
mark events from the same read as coalesced. Each run gets its own connection, because Unsloth answers
streams with `Connection: close`; its headers and body timeouts are the run's idle timeout. An event-loop
delay histogram runs during every run, and the result warns above 50 ms. TTFB is recorded but labelled
diagnostic, since servers flush headers at different moments. Measure with the production build, not the
dev server; the dev server shows a banner.

## 9. Mock Unsloth backend

`mock/` implements the routes in section 2 with configurable startup delay, per-token latency, jitter, a
reasoning phase of N tokens, usage and timings in the final chunk, `context_truncated` injection, stalls,
dropped connections, in-band error frames, tool frames, keep-alive comments, thinking sent as answer text,
monitor rows and cancel by id, STT with per-engine availability by profile (no whisper.cpp on the Mac
profile), loads that refuse models not on disk, idle unload, a processing delay per audio second by
profile and engine, and transcripts with deterministic word errors, image loads that answer at once and finish in the
background, the chat and image hand-off, step progress that follows Unsloth's phases, a failing load,
a PNG per seed, and request slots with a first-in, first-out admission queue and a slowdown per
busy slot, image progress at a fixed steps per second, and telemetry that ramps during
runs. It can also replay recorded fixtures with their original timing. `npm run demo` starts two mocks on
different ports plus the app. `mock/src/cloud.ts` (`npm run mock -- --cloud <provider>`) is a fake OpenAI,
Anthropic or Gemini API: model lists with models to leave out, streaming in each provider's events,
usage, key checks, and each provider's error body on demand.

## 10. Recorder

`npm run record -- --machine <name> --effort low` saves the raw stream with the arrival time of every
network read, the request body, the metrics and the monitor row into `fixtures/streams/`, without the key.
It builds the test fixtures and is the first thing to run against a new Unsloth version. Phase 3 records
text with a custom prompt; `--workload` and `--preset` arrive with those workloads and presets, and
telemetry samples with phase 7.

## 11. Tests and acceptance

- Unit: SSE parser fuzzed by splitting fixtures at every byte offset, including inside multibyte
  characters; adapter on fixtures (GGUF, MLX, thinking, `context_truncated`, tool frame ignored); metric
  math with an injected clock; WER; aggregation; CSV and Markdown export equal the table.
- Integration on two mocks: one side timing out, cancel mid-stream, reload mid-session resumes, arbiter
  eviction handled (image load after text).
- Acceptance on the real machines: probe passes; a text session with a thinking model shows the thinking
  block and a report with client and server columns; a transcription session shows WER; an image session
  shows both images and the step timeline.

## 12. Phases

The build order lives in ROADMAP.md: seventeen phases in five milestones, each phase ending in a complete,
testable app.

## 13. Open questions

1. Which models exactly, and are the same GGUF quant files present on both machines? On a Mac, GGUF
   (llama.cpp on Metal) and MLX give different numbers and different cache behaviour; pick one backend for
   the comparison.
2. Is whisper-server built on each machine (`scripts/build_whisper_cpp.sh`)? Without it, Mac
   transcription runs the slow transformers path. The RTX machine: yes, its `gguf` engine is available and has
   `large-v3-turbo` downloaded (read 2026-09-25). The Lenovo and the Mac: not yet read.
3. Which image model? The same repo and quant must exist on both machines. Is `speed_mode: off` acceptable
   as the baseline? The RTX machine has FLUX.2-klein-9B Q4_K_M and Qwen-Image-2.1 Q8_0 and
   Q4_K_M as GGUF, plus the unsloth FLUX.2-klein-9B and Qwen-Image-2.1-FP8 pipelines (read 2026-09-25).
   Model Duel defaults to speed mode off.
4. Bundled public-domain audio and text, or your own files with a reference transcript?
5. Unsloth version on each machine (About screen), so the probe result can be checked against it.

## 14. Non-goals

No auth on the controller, no multi-user, no cloud models except as text references (section 2.7), no
model downloads, no training, no i18n.

## 15. Definition of done

`npm install && npm run dev` serves the app. Add two machines with URL and key; the probe is green; load a
model on each; run a text session with a thinking model; watch both streams with thinking blocks and
telemetry; get the report with client and server columns, scoreboard, race chart and exports. The same for
transcription and image sessions. The README covers Unsloth setup: LAN access, API key, whisper-server,
placing the same models on both machines.
