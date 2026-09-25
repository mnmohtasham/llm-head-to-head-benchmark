# Model Duel result format, version 1

A result file records one finished race: the settings, the machines and what they ran, every
round and run with its measurements, and the statistics the report shows. It is the format for
sharing results, for example on a public results website. The app's own session files
(`data/sessions/`) can change between versions; this format changes only with a new
`formatVersion`.

- Written to `data/results/model-duel-<date>-<id8>.json` when a race ends, rewritten after a blind
  vote, and removed with the race. Races from before result files get theirs when Model Duel
  starts.
- Downloaded from a race's report with **Result file**, or `GET /api/sessions/<id>/result.json`.
- Defined in `shared/src/result.ts` (zod). The JSON Schema is
  [result-format.schema.json](result-format.schema.json), draft 2020-12, regenerated with
  `npm run result-schema`.
- Checked with `npm run verify-result -- <file>`: the schema, then the checksum.

## Top level

| Field | Meaning |
| --- | --- |
| `format`, `formatVersion` | Always `"model-duel-result"` and `1` for this version. |
| `id` | The race's id (UUID), the same in every copy. Use it to spot duplicates. |
| `createdAt`, `finishedAt` | ISO 8601 times on the controller. |
| `state`, `error` | `done`, `failed`, `cancelled` or `interrupted`, and why when not done. |
| `generator` | `app`, `version`, `build` (the page build id) and `sessionSchemaVersion`. |
| `workload` | `text`, `transcribe`, `image` or `command`. |
| `kind` | The metric set: the workload, with text split into `text` (latency) and `throughput`. |
| `settings` | `config` (the workload's settings as sent, full prompt included), `plan` (rounds, warm-up, pause, order) and `telemetry.enabled`. |
| `machines` | One entry per machine, described below. Runs refer to machines by `index`. |
| `metricDefinitions` | The metrics of `kind`: `key`, `label`, `unit`, and `better` (`lower`, `higher` or `null`). |
| `rounds` | The warm-up (with `warmup: true`) and every counted round, in order. |
| `summary` | `stats` per metric, the `scoreboard` sentences, and blind `votes`. |
| `privacy.removed` | What was taken out, in words. |
| `sha256` | The checksum, described below. |

## Machines

| Field | Meaning |
| --- | --- |
| `index`, `label`, `color` | The machine's position, the name the user gave it, and its colour in the app. |
| `kind`, `cloud` | `local` for a machine running Unsloth, `cloud` for a provider's model raced as a reference. For a cloud model, `cloud` has `provider` (`openai`, `anthropic` or `gemini`) and `model` (the provider's model id), and `hardware`, `software` and `state` are empty. Files from before cloud models have neither field. |
| `hardware` | `os`, `backend` (for example `cuda`), `memoryTotalGb`, and `gpus` with `name` and `memoryGb`, from the machine's last probe. |
| `software` | Unsloth, Unsloth Studio and llama.cpp versions. |
| `state` | What the machine's own routes said: `textBefore`/`textAfter` (the chat model's status), `sttBefore`/`sttAfter`, `imageBefore`/`imageAfter`, `restore` (the chat model loaded again after an image race) and `agent` (the command agent's health). Each is `null` when it does not apply. |
| `request` | The exact request body the machine received, without keys: for a cloud model, the body of the provider's own API. |
| `setup` | The report's setup table for this machine: `key`, `label`, `value` and `differs` (true when a setting that matters differs between the machines). |

## Rounds and runs

A round has `index` (−1 for the warm-up), `warmup`, `startedAt`, `finishedAt`, `sendSkewMs`
(between the first and last request when the machines ran together), `order` (machine indexes as
their requests left), `nonce` (the fresh line that opened a cold-prefill prompt), `loopLagMs` and
`flags` (`machine`, `kind`, `text`), and `runs`, one per machine.

| Run field | Meaning |
| --- | --- |
| `machine` | Index into `machines`. |
| `state`, `error` | `done`, `failed` or `cancelled`, and why. |
| `startedAt`, `finishedAt`, `sendOffsetMs` | When it ran, and how long after the first machine's request its own left. |
| `modelBefore`, `modelAfter` | The model the machine had in memory. |
| `rtt` | Round trips just before the round: `samplesMs` and `medianMs`. |
| `loopLagMs` | How late the controller's event loop ran: large values make the timings suspect. |
| `metrics` | The run's value for each key in `metricDefinitions`, or `null`. |
| `details` | Everything measured, by workload: `client` (the stream as Model Duel timed it), `server` (Unsloth's own timings and monitor row; for a cloud model, `server.cloud` with the provider's `usage`, `requestId` and `processingMs`), `transcription`, `image`, `throughput` and `command`. The ones that do not apply are `null`. |
| `text` | Text runs: `reasoning` (the thinking) and `answer`. |
| `telemetry` | Hardware samples around the run and the energy they add up to (`energy`), when telemetry was on. |
| `timeline` | Text runs: `[ms since the request, tokens so far, 1 while thinking]`. |
| `events` | Text runs: every streamed event, compact, as `[ms, read, "r" or "c", text]` for tokens and `[ms, read, event]` otherwise, with `headersAtMs` and `endAtMs`. Enough to recompute every client metric. |

## Metrics by kind

Times are in milliseconds, measured by Model Duel from the moment a request left it, so they
include the network. Keys ending in `Server`, and "Prompt processing", are what Unsloth measured on
the machine. Energy is approximate: GPU board power on NVIDIA and the GPU rail on Apple, sampled
twice a second.

| Kind | Keys |
| --- | --- |
| `text` | `firstAnswer`, `ttft`, `ttftServer`, `thinking`, `decode`, `decodeServer`, `endToEnd`, `chars`, `prompt`, `total`, `output`, `energy`, `tokensPerJoule`, `decodePower`, `peakGpu`, `peakMemory`, `finish` (a string) |
| `throughput` | `aggregate`, `perRequest`, `ttftMedian`, `ttftP95`, `batchTime`, `queued`, `outputTokens`, `energy`, `tokensPerJoule`, `peakGpu`, `peakMemory` |
| `transcribe` | `rtf`, `processing`, `processingServer`, `wer` (percent), `upload`, `load`, `energy`, `joulesPerMinute`, `peakGpu`, `peakMemory` |
| `image` | `imageTime`, `stepsPerSec`, `firstStep`, `decodeTail`, `load`, `energyPerImage`, `power`, `peakGpu`, `peakMemory` |
| `command` | `encodeTime`, `encodeFps`, `encodeSpeed`, `firstFrame`, `outputSize` (MB), `energyPerEncode`, `agentCpuPower`, `agentGpuPower`, `encoderUse`, `peakGpu` |

`metricDefinitions` in each file carries the label, unit and direction, so a reader need not keep
this table.

## Statistics

`summary.stats` has one entry per metric: `key`, `machines` (per machine: `n` counted rounds,
`median`, `min`, `max`, `mean`, `stdev`) and `verdict`. A verdict is `win` only when the leader's
median is more than 10 percent better than the runner-up's, or their round-to-round ranges do not
overlap (at least two rounds each); otherwise `tie`, or `none` with fewer than two machines.
`leader` and `runnerUp` are machine indexes, `ratio` is "times better", and `reason` is `gap` or
`ranges`. Failed rounds and the warm-up never count.

## Privacy

Taken out before a file is written:

- API keys, cloud keys included, and agent tokens. They never enter a session in the first place,
  and anything shaped like a key in a message is replaced with `<key>`.
- Machine addresses and notes.
- Local paths and network addresses inside messages, statuses and settings: home folders become
  `~`, other absolute paths keep only their file name after `<path>/`, and URLs and IP addresses
  become `<address>`.

Kept as they are, because they are the result: machine names, prompts (including custom ones),
answers, thinking, uploaded audio file names and transcripts. Remove a custom prompt yourself before
sharing if it is private.

## Checksum

`sha256` is the SHA-256 of the file's canonical JSON with the `sha256` field left out. Canonical
JSON sorts object keys at every depth, writes no spaces, and drops `undefined`. It shows that a copy
is the file Model Duel wrote; it is not a signature, so anyone can write a new file with a matching
checksum. A results website that needs trust should check files in other ways too, for example that
the numbers are consistent with the raw `events`.

```js
// Node: check a result file's checksum.
import { createHash } from 'node:crypto';
const { sha256, ...rest } = result;
const canonical = (v) =>
  v === null || typeof v !== 'object'
    ? JSON.stringify(v)
    : Array.isArray(v)
      ? `[${v.map(canonical).join(',')}]`
      : `{${Object.keys(v)
          .filter((k) => v[k] !== undefined)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
          .join(',')}}`;
const ok = createHash('sha256').update(canonical(rest)).digest('hex') === sha256;
```

## Versions

A reader should check `format` and `formatVersion` first. Fields may be added to version 1 without
a new version, so readers should ignore fields they do not know. A field that is removed or changes
meaning comes with version 2.
