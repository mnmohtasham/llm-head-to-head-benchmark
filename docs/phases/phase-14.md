# Phase 14 record

- Date: 2026-09-25
- Commit and tag: branch `phase-14`, merged into `main`, tagged `v1.4`.
- Added after phase 12 at Mani's request: "bring support to cloud models like ChatGPT, Claude and
  Gemini as reference models. The user should be able to get the list of models and choose one."

## Gate

- [x] Clean start, dev and production builds. A copy of the repository without ignored files
      installs with `npm ci` and passes every check below.
- [x] Demo on mocks. `npm run demo` adds three fake cloud providers beside the two fake machines,
      one model each, ready to race on the Text tab.
- [x] Typecheck, lint, unit, integration and end-to-end tests pass: 337 unit and integration
      tests, 52 browser tests.
- [ ] Real cloud race: not run, since no provider key was available. Each provider's real API was
      asked for its model list with a fake key instead (below).
- [x] No dead UI. **Add cloud model** is on the Machines screen; cloud models show only where they
      work, on the Text tab.
- [x] Earlier data still opens: machines saved before this phase read as local machines.
- [x] README, PLAN.md (section 2.7), ROADMAP.md and `docs/result-format.md` updated.

## What was built

- Cloud participants are machine records with `cloud: {provider, model}`. Their key is kept like an
  Unsloth key, and the provider cannot change once saved, so a key never reaches another provider.
- **Add cloud model**: provider, key, optional API address, **Fetch models**, and a model list
  filtered to text models, with what each model takes. The name follows the model until typed.
- Races: OpenAI's Responses API, Anthropic's Messages API and Gemini's `streamGenerateContent` are
  read into Unsloth's stream events, so every metric is computed the same way. Thinking and effort
  map to each provider's controls; sampling fields a model refuses are left out.
- Pre-flight: no model chosen, or Max tokens above the model's limit, stops the race; thinking
  mismatches and the "reference" nature are notes. The Text tab now shows pre-flight notes.
- The report shows the provider's billed tokens next to what streamed, its request id, and whether
  thinking was hidden or summarised. Result files mark machines `local` or `cloud`.

## Real providers, fake key

With a fake key, each provider's real model list refused it, and Model Duel read the refusal in each
provider's shape:

| Provider | What Model Duel showed |
| --- | --- |
| OpenAI | OpenAI did not accept the API key: Incorrect API key provided: not-a-re\*\*\*…0000. |
| Anthropic | Anthropic did not accept the API key: invalid x-api-key |
| Google Gemini | Google Gemini did not accept the API key: API key not valid. Please pass a valid API key. |

Gemini refuses a bad key with HTTP 400, not 401, and is recognised by its message. OpenAI's message
repeats part of the key with stars; the result file's key filter already removes that form.

## Findings

- **OpenAI's `minimal` effort** belongs to the first GPT-5 models only; the model table offered it
  for later ones, which refuse it. Caught by a unit test and fixed before any request went out.
- **A model that always thinks** (Gemini 3, the newest Claude and GPT models) got no effort at all
  with Thinking off. It is now asked for its lowest level.
- **The Text tab never showed pre-flight notes**, only errors and warnings. Fixed, since the cloud
  notes say what a reference measures.
- **Summarised thinking** makes the decode speed approximate: providers bill every thinking token but
  stream only a summary, from its first token. The report says so on each such run.
- A fake server must watch the response's `close` event: Node fires the request's as soon as its body
  is read, which stopped every stream at once.
- **Closing the app did not wait for two background writes,** both from earlier phases: a finished
  model load's record, saved just after the load leaves the running list, and the result files
  written at startup for earlier races. Tests that removed their data folder right after closing
  failed now and then. Closing now waits for both.

## Still to do

1. A real race of one model per provider against the RTX machine, with Mani's keys.
2. Cloud transcription and image generation, if they prove useful as references.
