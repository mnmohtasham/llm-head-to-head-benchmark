# Benchmark suites

Two pieces for phase 22, to be folded into README.md and PLAN.md: the README section, and a design
note in the plan's style.

## For README.md

## Run a benchmark suite

The **Suites** tab queues a text race for every combination of prompts, thinking settings and Max
tokens values you pick, runs them one after another while you do something else, and sums them up
in one table at the end.

1. Tick the machines. Every race of the suite runs on all of them.
2. Pick one or more **Prompts**. A suite takes the standard prompts only (Short, 8K, 32K, Puzzle,
   Code, Fixed length), so every race compares with the others and with LLM Bench.
3. Pick one or more **Thinking** settings: **Off**, **On** at the model's own effort, or **On** at
   an effort level, such as **On, low**, where every picked model offers the same levels.
4. Give one or more **Max tokens** values, separated by commas: `512, 2048`.
5. Set what every race shares: **Mode** (latency, or throughput with **Requests at once**),
   **Prefill**, **Rounds**, **Sum up rounds by**, **Warm-up**, **Pause between rounds** and
   **Order**. Sampling is the default: temperature 0.6, top-p 0.95, top-k 20, min-p 0.
6. The form counts the races as you go, such as "8 races: 2 prompts × 2 thinking settings × 2 Max
   tokens values", and the requests they send. A suite runs at most 50 races.
7. Press **Start**. The page follows the suite: which race is running, a link to watch it on the
   **Text** tab, and the table filling in as races end.

Each race goes through pre-flight first, exactly as from the Text tab.

- A race pre-flight refuses, such as a prompt and Max tokens that do not fit a machine's context,
  is **skipped**, with pre-flight's reasons under the table, and the suite goes on.
- A race pre-flight warns about, such as machines with different quants, is skipped too, unless
  you tick **Accept pre-flight warnings** before starting: then it runs, as with **Race anyway**.
- A race in which every machine fails is kept as **failed** with the reason, and the suite goes on.
  A machine that fails while the others finish shows as failed in its own row.

**Cancel suite** stops the race in progress, as its own **Cancel** would, and every race after it.
Cancelling a single race on the Text tab stops only that race; the suite goes on with the next.

One suite runs at a time, and while it runs nothing else races: a race started from the Text,
Transcribe or Image tab is refused with a note that a suite is running, and a suite cannot start
while a race runs. Leave the Models tab alone meanwhile: while a model loads on one of the
machines, pre-flight skips every race that would start. A suite that was running when Model Duel
stopped is marked **interrupted** when it starts again. It never resumes by itself; start it again
from the form.

The table has a row for each race and machine: the prompt, thinking and Max tokens, the machine,
how its race went, its rounds, and the race's headline numbers, the same as its scoreboard. Time to
first token and decode speed are the machines' servers' own numbers, marked "server", when every
machine in that race reported them; otherwise every machine shows Model Duel's measurement, marked
"Model Duel" (see [Which numbers count](#which-numbers-count)). Prompt processing is Unsloth's own,
and energy needs **Telemetry**. Each number is the race's median or average, as **Sum up rounds by**
says. A throughput suite shows aggregate speed, time to first token under load and tokens per joule
instead. **Open** shows the race on the Text tab, and **Download CSV** saves the table with raw
numbers, units and whose number each one is.

Every race of a suite is an ordinary race: it is in the results log, in **Results** and in
`data/results/`, and can be sent to LLM Bench. The suite itself is a small file in `data/suites/`.
**Past suites** lists them newest first; **Open** shows one again and **Delete** removes the suite's
file only. Its races stay.

## For PLAN.md

### 7.4 Benchmark suites

A suite queues a matrix of text races and runs them unattended, one after another. Its axes are
one or more standard presets (`SUITE_PRESET_IDS` in `shared/src/suite.ts`: every preset but
`custom`), one or more thinking settings (`{thinking, reasoningEffort}`: off, on at the model's
default, or on at a level) and one or more Max tokens values. The machines, the run plan, the mode
and concurrency, the prefill and whether to accept pre-flight warnings are fixed for the suite, and
sampling is `DEFAULT_SAMPLING`. `suiteRequestSchema` validates the request with the text config's
own limits (`maxTokensSchema`, `concurrencySchema`, `machineIdsSchema`), refuses repeated values and
caps the product at `MAX_SUITE_RACES` (50), saying how many it would be. `expandSuite` orders the
races prompt by prompt, then by thinking setting, then by Max tokens, and `comboRequest` turns each
into the request `POST /api/sessions` takes, with the preset's prompt filled in by the server.

Every race now starts through `RaceStarter` (`server/src/races.ts`), the one race slot: the
machine check, the busy check (a race running or in pre-flight), pre-flight and its refusals are
the same for a tab and a suite. A suite claims the slot when it starts, if no race or other suite
has it, and holds it until it ends; meanwhile only races carrying its id start, and anything else
answers 409 `suite_running`. A suite asked for while a race runs answers 409 `busy`. The checks and
the claim run without an await between them, so a race and a suite asked for at the same moment
cannot both start.

`SuiteManager` (`server/src/suites.ts`) runs the races in order. A refusal (pre-flight errors,
warnings without `acknowledgeWarnings`, a machine deleted since) makes the race `skipped` with the
refusal's message and pre-flight's errors and warnings; a race whose session ends `failed` is
`failed`; either way the next race starts. When a race ends, `suiteResults` keeps each machine's
state, rounds and headline numbers in the suite: for each metric of `headlineMetrics(kind)`, the
row `headlineRows` picks, so the servers' number (`SERVER_METRICS`) where every machine reported
it and Model Duel's for all otherwise, summed up by the race's own statistic, with `source`
`server`, `measured`, or null for a metric with one kind. The suite keeps this snapshot rather than
reading the sessions again, so it still shows after a race is deleted or switched to averages.
`suiteColumns`, `suiteRows` and `suiteCsv` build the page's table and the CSV from the same column
definitions; the CSV adds a "from" column after each metric with a server and a measured kind.

Cancel sets the suite cancelled and cancels the race in progress through
`SessionManager.cancel`, so the machines stop generating; a race that pre-flight was still checking
is cancelled the moment it starts. Races not yet started become `cancelled`. On shutdown the
manager starts no more races and does not write the suite again, so its file still says
`running`; `SuiteStore.init` marks such a suite `interrupted` at the next start, its running race
`interrupted` ("Model Duel stopped during this race") and the races after it `interrupted`
("before this race started"). Nothing resumes by itself.

Suites are `data/suites/<id>.json`, schema version 1: `{schemaVersion, id, createdAt, finishedAt,
state, error, machines: [{id, name, color}], settings, races: [{index, combo, state, sessionId,
startedAt, finishedAt, error, issues, results}]}`, with suite states `running | done | cancelled |
failed | interrupted` and race states `queued | running | done | failed | skipped | cancelled |
interrupted`. They are written atomically with `writeFileAtomic` (mode 600, directory 700), ids are
checked against the UUID pattern before a path is built, and files that are not suites, or come
from a newer version, are skipped with a warning. The races themselves are ordinary sessions and
result files.

API, behind the same sign-in and cross-site checks as every route: `POST /api/suites` (201 with
the suite; 400 for a bad request, 404 for an unknown machine, 409 `suite_running` or `busy`),
`GET /api/suites` (`{suites}`: summaries newest first, with a count of races per state),
`GET /api/suites/:id`, `POST /api/suites/:id/cancel` (the suite as it ended) and
`DELETE /api/suites/:id` (204; the suite's file only, never its races; 409 while it runs). An id
that is not a UUID answers 404 like an unknown one. The **Suites** tab (`#/suites`, `#/suites/<id>`)
reads a running suite every 2 seconds rather than streaming it: a suite changes once per race, and
each race has its own stream on the Text tab.
