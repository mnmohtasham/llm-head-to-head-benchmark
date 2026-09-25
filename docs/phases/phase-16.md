# Phase 16 record

- Date: 2026-09-25
- Commit and tag: branch `phase-16`, merged into `main`, tagged `v1.6`.
- Added at Mani's request: "when doing several runs the app says '1 to 10. Results are medians.'
  What about I do more? Bring both average and median options."

## Gate

- [x] Clean start, dev and production builds. A copy of the repository without ignored files
      installs with `npm ci` and passes every check below.
- [x] Demo on mocks: a race with more than ten rounds, summed up by average, then switched.
- [x] Typecheck, lint, unit, integration and end-to-end tests pass: 352 unit and integration
      tests, 56 browser tests.
- [x] Real machines: nothing to run; averages come from the rounds already measured. On a copy of
      Mani's `data/`, his races open with medians, as before, and switch to averages.
- [x] No dead UI.
- [x] Earlier data still opens: races without a statistic read as medians, and their result files
      are unchanged until switched.
- [x] README, PLAN.md, ROADMAP.md and `docs/result-format.md` updated.

## What changed

- Rounds go from 1 to 100.
- **Sum up rounds by** (Median or Average) sits next to **Rounds**. The choice is kept with the
  race as `plan.statistic`, and the gate, the comparison, the scoreboard, the results log, the
  exports and the result file use it. The race's **Comparison** table can switch it afterwards.
- The Results tab shows every row's medians or averages, whichever the viewer picks; each row
  carries both.

## Findings

- An average can reverse a verdict: with one slow round, a machine that wins on the median can lose
  on the average. That is the point of offering both; the unit tests keep such a case.
- A long race makes a large session file, since every round keeps its raw events: a
  few hundred kilobytes per round for two machines writing a few thousand tokens. The README says so.
