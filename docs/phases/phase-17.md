# Phase 17 record

- Date: 2026-09-25
- Commit and tag: branch `phase-17`, merged into `main`, tagged `v1.7`.
- Added at Mani's request: "I will have a separate application that gets the results through an
  API and shows them in a table. In the Results page, in front of each record put a button that
  sends the record detail to my service. This service will be public and everyone can send the
  results, so make sure all security aspects are considered."

## Gate

- [x] Clean start, dev and production builds. A copy of the repository without ignored files
      installs with `npm ci` and passes every check below.
- [x] Demo on mocks: `npm run demo` starts a fake results service and points **Results service**
      at it, so **Send** works out of the box.
- [x] Typecheck, lint, unit, integration and end-to-end tests pass: 370 unit and integration
      tests, 57 browser tests.
- [x] Real data: every sendable run in a copy of Mani's `data/` sent to the fake service (below).
- [x] No dead UI.
- [x] Earlier data still opens; nothing is sent unless asked.
- [x] README, PLAN.md (section 7.3), ROADMAP.md and the new `docs/share-api.md` updated.

## Real data

From a copy of Mani's `data/`, all 29 sendable runs (done or partly failed, local and cloud) were
previewed and sent to the fake service, which checked each one's schema, checksum and signature.
Together they are 150 KB, about 5 KB each. The received records were then searched for everything
private in `data/`: machine names, addresses, API keys, the `192.168.99.` network, `/home/mani`,
Google keys and the custom prompts' words. None was there; the only near-hit was "test", Mani's
name for the RTX machine, inside the model name `gemini-flash-latest`.

## Security, as built

- **What leaves.** A strict schema lists every field a record may have; the builder parses its
  own output with it, so nothing else can leave. Machine names, addresses, notes, answers,
  thinking, file names, paths and uploaded audio names are never in it; the OS goes as family and
  version; strings are cleaned of control and direction characters and redacted like result files.
  A custom prompt goes only when the sender ticks the box.
- **What was shown is what is sent.** The server builds the record for the preview and again for
  the send, and sends only when the SHA-256 matches the one the sender saw.
- **Integrity.** An Ed25519 key pair per installation signs each record's canonical JSON; the
  private key stays in `data/share.json` (mode 600). The service can reject tampered records and
  let only the same key replace a record. It proves nothing about the numbers themselves, which
  `docs/share-api.md` says plainly.
- **Transport.** https only (http only to this computer, for testing), no credentials in the
  address, no redirects, 20-second limit, at most 64 KB of the answer read, and only a checked id, a
  link on the service's own host and a short plain-text message used. An optional bearer token is
  kept like API keys, masked in the page, redacted from logs, and dropped when the address changes.
- **The app itself.** Found while building: any web page open in the same browser could post to
  Model Duel's API, for example to cancel a race or unload a model, since only the Host header was
  checked. Requests that change anything are now refused when `Origin` names another host or
  `Sec-Fetch-Site` says another site. Tools outside a browser, which send neither, still work.
- **The service.** `docs/share-api.md` has the contract, a verification snippet and a checklist:
  size limits, the strict schema, checksum and signature, plausibility checks, one record per key
  and submission id, parameterised storage, escaping on display, a Content-Security-Policy, rate
  limits, moderation, https with HSTS, no CORS, minimal logging and deletion.

## Findings

- The tool that writes these files decoded `\u` escapes in regular expressions into the invisible
  characters themselves; lint caught it, and the patterns are now written as escapes.

## Still to do

1. The results service itself, by Mani, following `docs/share-api.md`.
2. Deleting a sent record: a delete request signed with the same key.
3. Sending several rows at once.
