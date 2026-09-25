# Sending runs to a results service

The Results tab's **Send** button sends one machine's run in one race to a results service, a web
service that collects runs from anyone and shows them in a public table. This page is the contract
between Model Duel and such a service, and a checklist for building the service safely.

- Format: `model-duel-run`, version 1, defined with zod in `shared/src/share.ts`.
- JSON Schema: [share-format.schema.json](share-format.schema.json) (draft 2020-12), regenerated
  with `npm run result-schema`.
- A working reference: `mock/src/share.ts`, the fake service the tests and `npm run demo` use.
  `npm run mock -- --share --port 18888` starts it on its own.

## The request

Model Duel's server, not the browser, sends each record:

```
POST <the service address the user entered>
Content-Type: application/json
Accept: application/json
User-Agent: ModelDuel/<version>
Idempotency-Key: <record.submissionId>
Authorization: Bearer <token>        (only when the user entered a token)

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
| `displayName` | A name the sender chose to show, or `null`. Plain text, at most 60 characters. |
| `race` | `workload`, `kind` (the metric set), `state` (`done` or `partial`), `rounds`, `roundsDone`, `warmup`, `sequencing`, `statistic` (`median` or `mean`), `machines` (how many raced; they are not named). |
| `machine` | `kind` (`local` or `cloud`), `provider` (for cloud), `gpus` (name and memory in GB), `gpuMemoryGb`, `platform` (CUDA, ROCm, MLX…), `memoryGb`, `os` (family and version only), `studio`, `llamaCpp`. |
| `model` | `id`, `quant`, `engine`, `contextLength`, `kvCache` (type, not size), `gpuLayers` (−1 is automatic), `totalLayers`, `slots`, `speculative`, `gpuMemoryMode`. |
| `settings` | `prompt` (a preset id or `custom`), `promptText` (only when the sender opted in), `promptTokens`, `prefill`, `thinking`, `maxTokens`, `concurrency`, `sampling`, and `summary` for transcription, image and command races. |
| `metrics` | Per metric: `key`, `label`, `unit`, `better` (`lower`, `higher` or `null`), `n`, `median`, `mean`, `min`, `max`, `stdev`, and `values`, one per counted round (`null` where the round failed). |
| `finish` | Text runs: how the counted rounds ended, such as `{"stop": 3}`. |

Never in a record: API keys and tokens, machine names, addresses and notes, answers and thinking,
file names and paths, uploaded audio names, and a custom prompt the sender did not opt in to.
Strings that look like keys, addresses or paths are redacted before anything is built.

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
- [ ] Moderate `displayName` and `promptText`, the only free text people choose. Keep
      `promptText` hidden or reviewed if you do not want to host arbitrary text.

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
  which run and the two options, plus the checksum of the preview. If the record changed since the
  preview, nothing is sent.
- Leaves out everything listed under "Never in a record", and the machine's name unless the user
  types a name to show. The prompt goes only when the user ticks the box, for custom prompts.
- Keeps the signing key, the token and the service address in `data/share.json`, readable by the
  user only. The private key and the token never reach the browser, the logs or a record.
- Refuses non-https addresses (except to this computer), addresses with a user name or password,
  redirects, answers over 64 KB, and links to other hosts.
- Refuses requests that change anything when a browser says they come from another web site, so a
  web page cannot make Model Duel send a record.
