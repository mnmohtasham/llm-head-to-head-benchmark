# Phase 21 record

- Date: 2026-09-28
- Commit and tag: branch `phase-21`, merged into `main` by pull request #4, tagged `v2.1`.
- Asked by Mani: "Change the name of the docker from model-duel to llm-h2h. Work on the security of
  the app. Remove all mock or fake data and procedures and make it ready for production. Add an MIT
  license to the repo." Then: "Create smoke test files."

## Gate

- [x] Clean start: a copy of the repository without ignored files installs with `npm ci`, has no
      `npm audit` finding, passes every check below and builds. Its Docker image is 262 MB, runs
      Node 22.23.3 as the `node` user, and has no npm, npx, corepack or Yarn.
- [x] No-GPU tests: every feature works against the stand-ins in `test-servers/`.
- [x] Typecheck, lint, unit, integration and end-to-end tests pass: 401 unit and integration
      tests, 58 browser tests (one new: signing in to a copy of the app with a password).
- [x] Smoke tests pass: `npm run smoke` and `npm run smoke:browser` against a production build,
      without and with a password, and `npm run smoke:docker -- --browser`, both ways.
- [x] Real machines: nothing in this phase changes a measurement (below).
- [x] No dead UI: the sign-in form and **Sign out** appear only when a password is set.
- [x] Earlier data still opens: the data format is unchanged; `data/auth.json` is made only when a
      password is set. A phase 20 Docker volume needs the copy below.
- [x] README, SECURITY.md, LICENSE, PLAN.md (sections 3, 9 and 14), ROADMAP.md (the gate and
      phase 21) and `docs/share-api.md` updated.

This computer's own Node is 22.22.2, below the new minimum: npm warns about it, and the checks here
ran on it. CI and the Docker image use 22.23.3.

## What changed

**Docker names.** The compose project, service, container, image and volume are `llm-h2h`. An
installation from phase 20 keeps its data in the old volume, `model-duel_model-duel-data`; the
README's Docker section is written for new installations, and the command to carry old data over
is below.

**An optional password.** `DUEL_PASSWORD`, or `DUEL_PASSWORD_FILE` for a Docker secret, at least 8
characters. With one set, the page shows a sign-in form and every `/api` route but the health check
answers 401 without the session cookie. The cookie is HttpOnly and SameSite=Strict and lasts 30
days. It holds only an expiry, signed with a key made from a secret in `data/auth.json` (mode 600)
and the password, so a restart keeps people signed in and a new password signs everyone out. The
password is compared in constant time, and ten wrong ones from an address make it wait 15 minutes.
The check goes by the route Fastify matched, not the raw URL, so no spelling of a path gets past it.
Without a password nothing changes, and the startup message says to set one before opening the app
to the network.

**Security review.** Two reviews read the code, one of the server and one of the client and
deployment. Everything they found is fixed except where noted:

| Finding | Severity | Fix |
| --- | --- | --- |
| `POST /api/cloud/models` sent a saved cloud key to any address given with the machine's id | High | A saved key goes only to the address it was saved with; another address needs the key typed. A typed address without a scheme is https, not http on port 443 |
| Changing a machine's address kept its key, which then went to the new host | High | The change is refused until the key is typed again or removed |
| No framing protection or other security headers | Medium | A strict Content-Security-Policy (`default-src 'self'`, no inline code, `frame-ancestors 'none'`, `base-uri 'none'`), X-Frame-Options, nosniff, no-referrer, COOP, CORP and a Permissions-Policy on every answer; `Cache-Control: no-store` on the API |
| Answers from machines were read whole, and the stream parser rescanned a growing line on every read | Medium | Every body is read through size limits (16 MB for JSON, 128 MB for images, 64 KB for error bodies, 64 MB and 500,000 events per stream). The parser keeps reads that end no line aside and joins them once, so a long line costs linear time, and it stops at a 4 MB line or an 8 MB event. A too-large answer has its own message |
| The word error rate allocated reference × transcript words | Medium | Skipped above 25 million cells, which a half-hour transcript stays under |
| A gallery image was saved without a check | Medium | Only a PNG under 128 MB is kept |
| Audio uploads of 256 MB were buffered in parallel, with no request timeout | Medium | One upload at a time, and a 10-minute limit for any request body |
| Two races could start while pre-flight ran | Low | The race slot is held from the first request |
| Result files kept host names written without a scheme, and Windows paths | Low | The race machines' network host names and Windows paths are taken out; a machine's key is taken out of its run errors |
| Upload file names reached a multipart header with line breaks | Low | Control characters, quotes and backslashes are removed |
| Log redaction missed the cloud key headers and the signing key; share.json could be replaced quietly | Low | Both redacted; an unreadable share.json is set aside, a readable one is made mode 600; temporary file names are random |
| CSV exports could carry spreadsheet formulas; Markdown exports passed HTML through | Low | Text starting with `= + - @` gets an apostrophe; Markdown escapes HTML and link, emphasis and code characters in text from machines |
| The image ran Node 22.22.2, before the September 2026 security release (10 CVEs) | Medium | Node 22.23.3, and `engines` at 22.23.2 or newer |
| CI gave third-party code a token that could write | Medium | `permissions: contents: read`, no persisted credentials, actions pinned to commits, `npm audit`, CodeQL and Dependabot |
| The image shipped npm, npx, corepack and Yarn | Low | Removed from the final image; compose adds a process limit and rotated logs |

Checked and fine: no cross-site scripting (no raw HTML anywhere, one outside link with
`noopener`), `npm audit` clean, ids validated before any file path, redirects never followed,
keys never sent to the browser.

**No demo, no fake data in the app.** `npm run demo`, `npm run mock` and the stand-in servers'
command line are gone, and so is the README's "fake Unsloth" section. The stand-ins stay for the
tests only: `mock/` is now `test-servers/`, never built, shipped or started by the app, and
`e2e/serve.ts` starts them for the browser tests in the same process. `npm run build` compiles only
the page and the controller. The recorded fixtures stay: they are test data from real machines.

**Smoke tests.** `npm run smoke` checks a running install over HTTP without changing anything:
health, the page and its assets, the security headers, the host and cross-site refusals, the
password, that the API answers uncached and shows no key, and a clean 404. `npm run smoke:browser`
opens every tab in Chrome and fails on a script error or a Content-Security-Policy violation, which
it collects from the browser's own `securitypolicyviolation` events. `npm run smoke:docker` builds
the image from `docker-compose.yml` with `smoke/docker-compose.smoke.yml` on a spare port, runs the
smoke tests without and with a password, and removes the container, volume and image. CI runs it.

**Open source.** The MIT license, SECURITY.md with private reporting through GitHub and the threat
model, version 2.1.0 with the license and repository in `package.json`, and a README that starts
with Docker.

## Real-machine results

Nothing in this phase changes a measurement, so no race ran on Mani's machines and none was
contacted. The smoke tests ran against a production build on an empty data folder, and against the Docker
setup; every check passed with and without a password.

## What stayed, and why

- `test-servers/` and `fixtures/`: without them the tests would need GPUs and cloud keys. They
  are test code and test data, and nothing outside the tests starts or reads them.
- Load options, including extra llama.cpp arguments, still go to the machines as asked. With a
  password only the owner can send them; SECURITY.md says to add only servers you control.
- Uploaded audio stays until deleted by hand, with no quota; with a password only the owner can
  upload.
- The wait after ten wrong passwords is per address. Behind Docker's port forwarding every device
  can arrive from Docker's own address, so there the wait can apply to everyone at once; that
  slows guessing as intended, at the cost of making the owner wait too.
- The password, like everything else, travels over plain HTTP on the network. SECURITY.md says to
  use a VPN or an HTTPS reverse proxy for access from outside.

## Carrying Docker data over from phase 20

```bash
docker volume create llm-h2h_llm-h2h-data
docker run --rm --entrypoint sh -v model-duel_model-duel-data:/from:ro \
  -v llm-h2h_llm-h2h-data:/to node:22.23.3-trixie-slim -c 'cp -a /from/. /to/'
```

Compose then uses the copied volume. The old one stays until `docker volume rm
model-duel_model-duel-data`.

## Findings

- **Zod probes for `new Function`**, which a strict Content-Security-Policy reports as a violation
  even though zod catches the error. The page sets `z.config({ jitless: true })` first.
- **V8 flattens a growing string on every character read**, so scanning only the new part of a
  line was not enough: the parser had to stop touching the line until it ends.
- **A console-text check is not a CSP check.** A build without the zod setting still passed the
  first browser smoke test, so it was not clear the test could see a violation at all. It now
  counts the browser's own violation events, and a deliberate inline script and outside image were
  both caught.
