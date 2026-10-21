# Phase 22 record

- Date: 2026-10-21
- Commit and tag: branch `phase-22`, merged into `main` by pull request #16, tagged `v2.2`.
- Asked by Mani: "Review code completely and: 1. implement new ideas and relevant features, 2.
  improve performance and make it a production ready app, 3. check and fix security flaws, 4. do a
  complete bug sweeping." Asked which features, Mani chose all four offered: more engines
  (Ollama and OpenAI-compatible servers), benchmark suites, comparing any runs, and a machine's
  history; work on a branch with a pull request, published as v2.2, checked against stand-in
  servers only.

## Gate

- [x] Clean start: `npm ci`, every check below, `npm run build`, and the Docker image from a clean
      build (`npm run smoke:docker -- --browser`, without and with a password).
- [x] No-GPU tests: every feature works against the stand-ins in `test-servers/`, which gained
      Ollama, llama-server and vLLM.
- [x] CI on the pull request: checks, Docker and CodeQL. CodeQL's first run found a quant pattern
      that could backtrack on a made-up model name, and stand-ins echoing a test's input; both
      fixed.
- [x] Typecheck, lint, unit, integration and end-to-end tests pass: 502 unit and
      integration tests (410 before the phase), 73 browser tests (58 before).
- [ ] Real machines: not run, at Mani's choice. The new servers were built from their
      documentation (Ollama's `docs/api.md`, llama.cpp's `tools/server/README.md`, vLLM's docs,
      read on 2026-10-21) and checked against stand-ins made from the same documents. Before relying
      on them, probe a real Ollama and a real llama-server and race each once; the open points are
      listed below.
- [x] No dead UI: the new tab, panes, comparison and history are complete; nothing is disabled for
      later.
- [x] Earlier data still opens: machines, sessions, result files and share settings keep their
      formats. `auth.json` moves to schema 2 and old session cookies stop working, so everyone signs
      in once more after the update.
- [x] README, SECURITY.md, PLAN.md (sections 2.9, 3, 7.2, 7.4 and 8), ROADMAP.md (phase 22) and
      `docs/share-api.md` updated.

## What changed

**Ollama and OpenAI-compatible servers.** Two more kinds of machine next to Unsloth Studio and LM
Studio, for text and throughput races. Ollama goes through its own `/api/chat`, whose answer is one
JSON object per line; a new `NdjsonParser` reads it with the SSE parser's byte-level timing, and
Ollama's eval timings become llama.cpp's, which they mean the same as, so its decode and prompt
speeds are the server's own numbers. The Models tab loads and unloads Ollama models. A run whose
timings show Ollama loaded the model fails rather than counting the load, races keep the model
loaded for 30 minutes, and the context is never sent, since another one reloads the model.
OpenAI-compatible servers go through `/v1/chat/completions`: llama-server is recognised by its
`/props` and reports llama.cpp's timings, vLLM and SGLang by their model list and report token
counts only. Every check that meant "not Unsloth" now covers all three other servers.

**Benchmark suites.** The **Suites** tab queues a race for every combination of standard prompts,
thinking settings and Max tokens values, up to 50, runs them one after another through the same
race slot and pre-flight as the tabs, records skipped and failed races and goes on, and sums them
up in one table with the scoreboard's headline rule, downloadable as CSV.

**Compare runs and a machine's history.** In Results, ticking 2 to 6 runs of one kind compares
them side by side, with differences marked, the best value starred, ratios to a baseline and a note
when they were not asked the same thing. **History** follows one machine, model, quant and engine
over time, charts its headline numbers and marks the version and setting changes between runs with
how the numbers moved. Both open from links.

**The review.** Four reviewers read the code: security, the measurement core, performance, and the
page. What they found and what changed:

| Finding | Severity | Fix |
| --- | --- | --- |
| Reading or joining a running race copied every raw token event: seconds of blocked event loop on a large race, late-stamping the tokens of the race in progress | High | The public view is taken first and copied; finished races stay in memory as views only |
| Stopping the app with a browser watching hung until Docker killed it, losing the round in progress | High | Races are cancelled and saved in `preClose`, live streams ended, a hanging stop exits after 20 s; Compose waits 30 s; a chat-model reload after an image race is skipped when stopping |
| A race's raw events had no limit: past about 11 large runs the save failed, and several kept races could exhaust memory | High / medium | At most about 64 MB of raw events per race; later runs keep their measurements and how many events were left out; large result and export files are written compact |
| Startup re-read every stored race to write missing result files, also during a race | Medium | Only races without a result file are read, and not while a race runs |
| Telemetry was attached at the end of a race only: lost past the 3-hour buffer, and on a crash | Medium | Attached after every round and saved with it |
| Energy counted only the covered part of a run, so a missed poll inflated tokens per joule | Medium | Gaps are filled at the covered mean power |
| The client re-rendered every page on every live update; one 650 kB bundle | Medium | Live text applied once per animation frame, the static parts memoized, one cached date formatter (1,000 dates: 47 ms to 1.5 ms), and each tab's code loaded when first opened: 244 kB for the entry, 416 to 506 kB on a first visit |
| Large JSON answers uncompressed; bundles not cached; route cache headers overwritten; source maps linked | Medium / low | Gzip on the thread pool from 16 KB; brotli and gzip copies of the bundle; bundles cached for good; routes keep their headers; maps hidden |
| A key a machine or provider echoed back reached the page | Low | Masked in the machine client and cloud errors |
| A signed-out session cookie kept working; no Secure flag; throttling bypassable with many addresses, and a proxy made everyone one address | Low | Revocable sessions, Secure behind HTTPS, `DUEL_TRUST_PROXY`, IPv6 by /64, untracked addresses wait, a slowdown after 100 failures from all addresses |
| Markdown exports turned bare URLs into links | Low | URLs, www. names and e-mail addresses escaped |
| A finish reason such as "constructor" broke share records | Low | Counted in a Map |
| Votes or statistic changes at the same moment overwrote each other | Low | One change at a time per race |
| A model changed mid-race was neither refused nor flagged | Low | Loads and unloads wait for a race on the machine; a run whose model changed fails |
| Cancel waited for a speech-model load; a cancelled image load marked runs failed | Low | Cancel stops waiting; such runs are cancelled |
| One damaged session file stopped the app from starting | Low | Skipped and logged; a file without a workload migrates as text |
| Headlines fell back to measured numbers when one machine failed every round | Low | A machine with neither number does not count |
| Uploaded audio was never removed | Low | Kept within 2 GB and 50 files |
| Results rows carried long prompts whole (150 KB per 32K row); the CSV did not say median or average | Low | A long prompt is its start and a fingerprint; the CSV says which, names the headline metric, writes "auto" |

**The page.** The page review found 18 problems, all fixed: "Race anyway" now applies only to the
warnings it was ticked for; a race whose stream drops reconnects with backoff, or shows how it
ended, or the sign-in form; a failed race says why; selects no longer stick on a value they cannot
show; a blank number field is missing, not zero, and only fields that are sent are checked; server
field errors reach their fields; a model list fetched for another provider is dropped; votes wait
for each other; the telemetry switch reads its state with no Unsloth machine in view; dialogs keep
their errors while busy and return focus; a failed pre-flight offers **Check again**; Cancel shows
it is cancelling; cancelled rounds are counted apart from failed ones; warm-up runs are named in the
log; idle panes stop ticking; and polls stop with their page and never overlap.

Checked and fine: the password gate (every spelling of a route, both live streams, uploads), the
cross-site and DNS-rebinding refusals, keys bound to their address, nothing secret at rest outside
the data folder, no raw HTML anywhere, `npm audit --omit=dev` clean.

Not changed: telemetry polls each machine on fresh connections twice a second, deliberately, since
Unsloth's answers on a reused connection stall; anyone who can use the app can make it call any
address, which the password guards; a slow upload can hold the one upload slot for the 10-minute
request limit.

## Open points for the real machines

- Ollama: whether `/api/ps` reports `context_length` on the installed version, whether `/api/show`
  lists `thinking` among the capabilities, which models take a level for `think`, and the error
  body's shape.
- llama-server: the final chunk's `timings` and `reasoning_content` deltas as the stand-in copies
  them, and whether `chat_template_kwargs.enable_thinking` turns thinking off for the model raced.
- vLLM: whether `/v1/models` has `max_model_len` and whether thinking arrives as
  `reasoning_content` or `reasoning` (both are read).
