# Phase 13 record

- Date: 2026-09-25
- Commit and tag: branch `phase-13`, merged into `main`, tagged `v1.3`.
- Added after phase 12 at Mani's request: "record the result of runs in a json file with all
  details; in the future I am going to make this tool public and allow people to share the results
  on a website."

## Gate

- [x] Clean start, dev and production builds. A copy of the repository without ignored files
      installs with `npm ci` and passes every check below.
- [x] Demo on mocks. Every race in `npm run demo` writes a result file; **Result file** in the report
      downloads it.
- [x] Typecheck, lint, unit, integration and end-to-end tests pass: 305 unit and integration
      tests, 49 browser tests.
- [x] Real data: Model Duel started on a copy of Mani's `data/` wrote result files for all 9 of his
      races, text, transcription and image, finished, failed and cancelled (below).
- [x] No dead UI. **Result file** is in every report; **Raw JSON** is the old export, renamed.
- [x] Earlier data still opens, and gets result files at startup.
- [x] README, PLAN.md, ROADMAP.md and `docs/result-format.md` updated.

## Real data

Started on a copy of `data/`, Model Duel wrote 9 result files within its first seconds, from 16 KB
(a failed transcription race) to 1.1 MB (a three-round, two-machine text race with an 8,000-token
limit, most of it raw events). `npm run verify-result` found every file valid with a matching
checksum. No file holds `192.168.` addresses, `/home/mani` paths, `sk-unsloth-` keys or agent tokens.

## Findings

- **A race could look finished before its files were written.** The end time appeared in the API
  while the session and now the result file were being saved, so a vote in that moment was refused
  as "still running" and a reader could miss the result file. Reads, votes and deletes now wait for
  that last save. The same window caused the delete fix of phase 11.
- **Mani's real races show three problems of earlier phases,** fixed separately after this phase:
  the transcription load said large-v3-turbo was not downloaded although the status listed it; an
  image load of the full FLUX.2-klein-9B was given up after 2 seconds while Unsloth was still
  loading it; and a load that fails is retried every round.
- The checksum shows a copy is unchanged, but it is not a signature: a results website that needs
  trust must check files other ways too. `docs/result-format.md` says so.

## Still to do

1. Signing or other trust for shared results, when the website exists.
2. An option to anonymise machine names and drop custom prompts before sharing.
