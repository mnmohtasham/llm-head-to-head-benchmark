# Phase 22: compare runs and follow a machine's history

Two sections to go under "Compare every run in the Results tab" in the README, after its list,
then a short design note. They are kept here until they are folded in.

## For the README

### Compare runs

Tick the box at the start of 2 to 6 rows of one workload, Text, Throughput, Transcribe or Image,
and press **Compare** in the bar that appears above the table. The bar says how many runs are
ticked and, while **Compare** is off, why: too few, more than 6, or runs of different workloads,
which measure different things. **Clear** unticks them all. The boxes work from the keyboard, and
each one names its machine and date.

The comparison opens above the filters, one column per run, in the order they were ticked. The
first run is the **baseline**; **Make baseline** on another column puts that run first.

- **Setup** has a row for each thing a run depends on: machine, GPU, GPU memory, GPU platform,
  RAM, system, server, Unsloth Studio and llama.cpp versions, model, quant, engine, context, KV
  cache, GPU layers, slots, speculative decoding, GPU memory mode, prompt, thinking, Max tokens,
  prefill, requests at once or the workload's settings, and rounds. A value that differs from the
  first run's is marked with ≠, and its row says **differs**. Rows no run has a value for are left
  out.
- **Medians of each run's counted rounds** has a row for every measurement of the workload, the
  servers' numbers and Model Duel's each in their own row, as in the table. The best value is
  starred, and under each value is how the run compares with the first: "1.84× faster", "2.10×
  slower", "1.50× less energy", or "same" within half a percent. Measurements without a better
  direction, such as total time or output tokens, have no ratio and no star. **Rounds summed up
  by** switches the comparison between medians and averages too.
- When the runs did not answer the same request, a note says so and names what differs: the
  prompt, thinking, Max tokens or prefill, the number of requests at once in throughput mode, or
  the settings of a transcription or image race. These change the numbers as much as the
  hardware, so read such a comparison with care.

The address of a comparison opens it again: `#/results?compare=<run>,<run>…`, where each run is
written as its race and machine ids, `<session id>/<machine id>`. **Copy link** copies the whole
address. Browsers allow the clipboard only on https and on this computer's own address, so
elsewhere the link appears, selected, to copy by hand. A link to a run whose race was deleted
opens the others and says how many are left out. **Close** closes the comparison and keeps what
is ticked.

### History of a machine

**History**, after the machine's name in a row or under a run in a comparison, shows every
finished run of that machine with the same model, quant and engine, oldest to newest. Ticked by
default, **Same prompt** and **Same thinking** keep only the runs asked the same thing as the run
you started from; untick them to take in the others. Throughput adds **Same requests at once**,
and transcription and image races have **Same settings** instead.

- A chart for each headline number shows one point per run in race order: decode speed and time
  to first token for text, aggregate speed and the median request's time to first token for
  throughput, the real-time factor for transcription, and denoising speed for images. A filled
  dot is the number as the machine's server reported it; a hollow dot is Model Duel's own
  measurement, for a run whose server gave none. Hovering a point shows its value, date and
  source, and clicking it opens its race.
- Above each chart, the latest run is set against the best: "Latest 59.3 tok/s on 2026-10-21 is
  51% slower than the best, 121.6 tok/s on 2026-10-14." Like the headlines, this uses the servers'
  numbers only when every run has one, and Model Duel's measurements otherwise, and says which.
- A dashed, numbered line on the charts comes before each run that changed something, and
  **What changed** lists it under the charts: Unsloth Studio or llama.cpp versions, the system,
  GPU or platform, the GPU memory mode, KV cache, context, GPU layers, slots or speculative
  decoding, and what the run was asked when the history takes in any prompt. Each line reads like
  "llama.cpp b9601 → b9650 on 2026-10-02", followed by how the numbers moved from the run before:
  "Decode speed 121.6 tok/s → 61.1 tok/s, 50% slower". A version that one of the two runs does not
  know, because the machine was not probed, is not counted as a change. LM Studio does not report
  its version, so for LM Studio machines only the settings show.
- **Every run** lists the runs newest first with their numbers, where each came from, and the
  number of the change they came with. The date opens the race.

The address `#/results?history=<session id>/<machine id>` opens a history again; **Copy link**
copies it. A comparison and a history can be open at once.

## Design note

- **Where the logic lives.** `shared/src/comparison.ts` builds a comparison from Results rows
  (`compareRuns`), checks what can be compared (`cannotCompare`, 2 to 6 runs of one kind), finds
  what the runs were asked differently (`requestDifferences`, `likeForLikeNote`), works out ratios
  (`ratioTo`, `ratioText`, with words per unit from `ratioWords`) and reads and writes the hash
  (`resultsLink`, `parseResultsLink`). `shared/src/history.ts` picks a history's runs
  (`inHistoryOf`, `runHistory`), builds one series per headline number with the source of each
  point, sets the latest against the best, and finds and numbers the changes between consecutive
  runs (`runChanges`, `marks` with each change's effect). Both are tested in `shared/test`; the
  client only draws them.
- **One definition of a setting.** Setup rows and changes reuse the Results table's columns
  (`runColumns`), so a value reads the same in the table, the comparison and the history, and
  "default" KV cache or "auto" GPU layers need no second formatter. Differences compare the
  column's raw value, except the prompt, which compares the whole prompt text, so two custom
  prompts that start alike still differ.
- **Server numbers.** The comparison keeps the servers' and Model Duel's numbers in separate rows,
  so no cell sets one against the other. The history's chart shows the server's number where the
  run has it, as asked, and marks each point's source by shape; the latest-against-best line and
  each change's effect compare only numbers of the same source, by the headlines' rule.
- **The address is the state.** The comparison and the history are opened by the hash, so Back
  closes them, a link opens them, and opening a history keeps the comparison. The ticked runs are
  page state; a comparison opened from a link ticks its runs.
- **Speed with hundreds of rows.** The table's filtering, sorting, facets and best values are
  memoized, and each row is a memoized component with stable callbacks, so ticking a box draws one
  row again. The history scans the runs once per change of its filter.
- **Charts.** The history uses the existing uPlot `Chart` component: evenly spaced points in race
  order, so many runs on one day stay readable, a y axis from zero, so noise does not look like a
  collapse, change marks drawn in a `draw` hook, and a tooltip in uPlot's overlay. No new
  dependency.
- **Left out.** The comparison and history do not pick their own median or average; they follow
  the page. Failed and cancelled runs have no point in a history. LM Studio versions are not
  recorded by Model Duel, so they cannot be marked. The history's filter toggles are not part of
  the link.
