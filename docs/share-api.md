# Sending runs to a results service

The Results tab's **Send** button sends one machine's run in one race to a results service, a web
service that collects runs from anyone and shows them in a public table. This page is the contract
between Model Duel and such a service, and a checklist for building the service safely.

- Format: `model-duel-run`, version 1, defined with zod in `shared/src/share.ts`.
- JSON Schema: [share-format.schema.json](share-format.schema.json) (draft 2020-12), regenerated
  with `npm run result-schema`.
- A working reference: `test-servers/src/share.ts`, the stand-in service the tests send records
  to.
- The service: Model Duel sends to LLM Bench, `https://llm-bench.selfhostapps.com/api/runs`
  (`SHARE_SERVICE_ENDPOINT`), and to no other. LLM Bench needs a token from its account page, so
  Model Duel sends nothing without one. It publishes runs without names, so every record has
  `displayName` null, and it sends only runs with a standard prompt (below), so every result on
  LLM Bench answered the same request.

## The request

Model Duel's server, not the browser, sends each record:

```
POST https://llm-bench.selfhostapps.com/api/runs
Content-Type: application/json
Accept: application/json
User-Agent: ModelDuel/<version>
Idempotency-Key: <record.submissionId>
Authorization: Bearer <token>        (from the user's LLM Bench account page)

{ "record": { ... }, "sha256": "<hex>", "signature": { "algorithm": "Ed25519", "publicKey": "<base64url>", "value": "<base64url>" } }
```

- The address must be https; Model Duel allows plain http only to this computer, for testing.
- The body is at most 256 KB (`SHARE_MAX_BYTES`). A three-round text run makes about 3 to 6 KB,
  and each further round adds a few hundred bytes.
- There are no cookies and no browser: the service needs no CORS headers and should send none.
- Model Duel waits up to 20 seconds and does not follow redirects.

## The record

| Field | Meaning |
| --- | --- |
| `format`, `formatVersion` | `"model-duel-run"` and `1`. |
| `submissionId` | 32 hex characters, from the sender's public key, the race and the machine. The same run from the same sender always has the same id, so sending again replaces rather than duplicates. |
| `raceId` | The race's random UUID; records of machines in the same race share it. |
| `raceDate` | When the race started, ISO 8601 in UTC. |
| `generator` | `app` (`model-duel`), `version`, `build`. |
| `displayName` | Always `null`: LLM Bench shows runs without names. The format keeps the field. |
| `race` | `workload`, `kind` (the metric set), `state` (`done` or `partial`), `rounds`, `roundsDone`, `warmup`, `sequencing`, `statistic` (`median` or `mean`), `machines` (how many raced; they are not named). |
| `machine` | `kind` (`local` or `cloud`), `provider` (for cloud), `gpus` (name and memory in GB), `gpuMemoryGb`, `platform` (CUDA, ROCm, MLX…), `memoryGb`, `os` (family and version only), `studio`, `llamaCpp`. |
| `model` | `id`, `quant`, `engine`, `contextLength`, `kvCache` (type, not size), `gpuLayers` (−1 is automatic), `totalLayers`, `slots`, `speculative`, `gpuMemoryMode`. |
| `settings` | `prompt` (the standard prompt's id, below), `promptText` (that prompt's text, or `null` where it is too long to carry), `promptTokens`, `prefill`, `thinking` (`off`, `on`, `on, high` with the reasoning effort, or `model default` on LM Studio), `maxTokens`, `concurrency`, `sampling`, and `summary` for transcription and image races. |
| `metrics` | Per metric: `key`, `label`, `unit`, `better` (`lower`, `higher` or `null`), `n`, `median`, `mean`, `min`, `max`, `stdev`, and `values`, one per counted round (`null` where the round failed). Both the machine's server's numbers and Model Duel's own are sent, each under its own key (below). |
| `finish` | Text runs: how the counted rounds ended, such as `{"stop": 3}`. |

Never in a record: API keys and tokens, machine names, addresses and notes, answers and thinking,
file names and paths, uploaded audio names, and the sender's own prompts. Strings that look like
keys, addresses or paths are redacted before anything is built.

### Standard prompts

Model Duel sends a run only when it answered a standard prompt, one every sender has, so runs
compare like for like. A race with the sender's own prompt, image prompt or audio is refused before
anything is sent (`409 not_standard` from Model Duel's own API).

| Workload | `settings.prompt` | `settings.promptText` |
| --- | --- | --- |
| Text and throughput | `short`, `puzzle`, `code`, `fixed-length` | The preset's text, from `shared/src/presets.ts`. |
| Text and throughput | `long-8k`, `long-32k` | `null`: the opening of Mill's *On Liberty*, about 7,600 or 30,400 tokens, then a request for a five-point summary. |
| Image | `lighthouse`, `market`, `portrait` (`IMAGE_PRESETS` in `shared/src/images.ts`), with no negative prompt | The preset's prompt. |
| Transcription | `librispeech` (the bundled 70-second clip) or `librispeech-long` (the clip repeated; `summary` gives the length) | `null`. |

A service should keep its own copy of these texts and refuse a record whose `promptText` differs,
so no one can publish other text under a preset's name.

### Server numbers and Model Duel's numbers

Where the machine's server measures something itself, the record carries that number under its own
key next to Model Duel's measurement, which includes the network and Model Duel's handling:

| Model Duel's measurement | The server's own number | Source |
| --- | --- | --- |
| `ttft` | `ttftServer` | Unsloth's monitor, or LM Studio's stats |
| `decode` | `decodeServer` | llama.cpp's timings via Unsloth, Unsloth's monitor, or LM Studio's stats |
| (none) | `prompt` | llama.cpp's prompt processing speed via Unsloth |
| `rtf` | `rtfServer` | the audio's length over Unsloth's processing time, from its monitor |
| `processing` | `processingServer` | Unsloth's monitor, which has it only for its OpenAI-shaped route, so it is often missing |

Headlines should use the server's number when every run compared has it, and Model Duel's
measurement for all of them otherwise, never one against the other. Cloud models report no server
numbers.

## Verifying a record

1. Parse the body with a size limit, then validate it against the JSON Schema with unknown fields
   refused (the schema is strict).
2. Compute the canonical JSON of `record`: object keys sorted at every depth, no spaces, `undefined`
   dropped. Its SHA-256 in hex must equal `sha256`.
3. Verify `signature.value` (base64url, 64 bytes) over the same canonical JSON bytes (UTF-8) with
   the Ed25519 public key `signature.publicKey` (base64url, 32 raw bytes).

```js
// Node 22: verify an envelope. `canonical` is the same function as for result files.
import { createHash, createPublicKey, verify } from 'node:crypto';

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

export function checkEnvelope({ record, sha256, signature }) {
  const text = canonical(record);
  if (createHash('sha256').update(text, 'utf8').digest('hex') !== sha256) return 'bad checksum';
  const key = createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: signature.publicKey },
    format: 'jwk',
  });
  const ok = verify(null, Buffer.from(text, 'utf8'), key, Buffer.from(signature.value, 'base64url'));
  return ok ? null : 'bad signature';
}
```

What the signature proves, and what it does not: that the record was not changed after the sender
signed it, and that later records with the same key come from the same sender. It does **not** prove
the numbers are true. Anyone can make a key and sign made-up numbers. Show every run as
self-reported.

## The answer

Model Duel reads at most 64 KB of the answer, and only these fields of a JSON object:

| Field | Use |
| --- | --- |
| `id` | Shown to the sender; 1 to 100 characters of `A-Z a-z 0-9 . _ -`, otherwise ignored. |
| `url` | A link to the run, shown only when it is on the service's own host and scheme. |
| `message` | Shown to the sender as plain text, up to 300 characters. |

Answer `201` for a new record and `200` for a replaced one. Any other `2xx` counts as taken. For a
refusal, answer `4xx` or `5xx` with a `message` saying why; the sender sees it. A redirect is
reported to the sender as a mistake in the address.

## Security checklist for the service

The service is public and anyone can send it anything, including records Model Duel never made.

**Input**
- [ ] Limit the body size (256 KB) before parsing, and time out slow uploads.
- [ ] Validate against the strict schema; refuse unknown fields, wrong types and out-of-range
      numbers. Refuse `formatVersion` values you do not know.
- [ ] Check the checksum and the signature, and refuse records that fail.
- [ ] Check plausibility: `values` agree with `median`, `mean`, `min`, `max` and `n`;
      `roundsDone` ≤ `rounds`; speeds, times and memory sizes within sane bounds; a race date not in
      the future. Flag or refuse outliers rather than showing them as records.

**Storage**
- [ ] Key records by `(signature.publicKey, submissionId)`. Only the same public key may replace a
      record; a different key with the same id is a different record.
- [ ] Use parameterised queries; never build SQL or shell commands from record fields.
- [ ] Store the received JSON as data, and keep the public key and the time received with it.

**Display**
- [ ] Treat every string (`displayName`, `model.id`, GPU names, `promptText`, `summary`…) as
      untrusted text: escape it for HTML, never render it as HTML or Markdown, and never put it in
      a script, a style or a URL without encoding.
- [ ] Show runs as self-reported. Consider a "verified" mark only for keys you have reason to trust.
- [ ] Set a strict Content-Security-Policy on the site, with no inline scripts.

**Abuse**
- [ ] Rate-limit per IP address and per public key, and cap records per key per day.
- [ ] Keep a way to hide records and to block a key.
- [ ] Check `settings.prompt` and `settings.promptText` against your copy of the standard prompts,
      so no free text can be published under a preset's name. `displayName` is always `null` from
      Model Duel; moderate it if you accept it from anything else.

**Transport and privacy**
- [ ] Serve https only, with HSTS. Do not send CORS headers: browsers never call this endpoint.
- [ ] If you ask senders for a token, compare it in constant time and never log it.
- [ ] Log as little as possible about senders: IP addresses are personal data in many places.
      Publish what you keep and for how long.
- [ ] Offer deletion. A later version can accept a delete request signed with the sender's key;
      until then, delete by `submissionId` on request.

## What Model Duel does on its side

- Sends a record only when the user presses **Send** on a row and then confirms in a dialog that
  shows the whole record exactly as it will go. The server builds the record; the browser sends only
  which run, plus the checksum of the preview. If the record changed since the preview, nothing is
  sent.
- Leaves out everything listed under "Never in a record", and always the display name, and sends
  only runs with a standard prompt.
- Sends only to LLM Bench, and only with a token; a token an earlier version saved for another
  service is dropped, never sent to LLM Bench.
- Keeps the signing key and the token in `data/share.json`, readable by the user only. The private
  key and the token never reach the browser, the logs or a record.
- Refuses redirects, answers over 64 KB, and links to other hosts.
- Refuses requests that change anything when a browser says they come from another web site, so a
  web page cannot make Model Duel send a record.
