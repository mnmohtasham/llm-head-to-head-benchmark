# Phase 03 record

- Date: 2026-09-25
- Commit and tag: not committed yet. Tag `v0.3` when commits are wanted.
- Unsloth version per machine: Studio v0.1.815-beta with llama.cpp b11139-mix-a6922cc on both
  Linux machines. The Mac is still unreachable, see phase 2.
- Machines and loaded models, as used on 2026-09-25:

  | Name in the app | Hardware | Model | Quant | Context | KV cache | Speculative decoding |
  | --- | --- | --- | --- | --- | --- | --- |
  | test | NVIDIA RTX 3060 12 GB | unsloth/Qwen3.8-27B-GGUF | UD-IQ2_XXS | 14,336 | default | auto, MTP engaged |
  | lenovo (780M) | AMD Radeon 780M, 26.6 GB | unsloth/Qwen3.8-27B-GGUF | Q4_0 | 178,176 | q4_0 | auto, MTP engaged |

  Both models were loaded in the Unsloth desktop app at about 00:28, not through Model Duel, so
  there is no load record in `data/loads/`. Unsloth's monitor shows the loads took 17.5 s on the
  RTX machine and 25.7 s on the Lenovo.
- Controller location: the RTX machine, on 2.4 GHz Wi-Fi with power saving off.

## Gate

- [x] Clean start, dev and production builds. A copy of the repository without ignored files
      installs with `npm ci` and passes every check below. `npm run dev` needs port 3000 free.
- [x] Demo on mocks. `npm run demo`, then the Text tab: thinking streams and folds at the first
      answer word, the table fills, cancel works.
- [x] Typecheck, lint, unit, integration and end-to-end tests pass: 164 unit and integration
      tests, 21 browser tests.
- [x] Real-machine script done on both Linux machines. The Mac waits on its firewall.
- [x] No dead UI. Every control on the Text tab works: machine chips, prompt, max tokens,
      thinking on and off, reasoning effort, Start and Cancel.
- [x] Earlier data still opens. The machines and probes from phases 1 and 2 load unchanged.
      Phase 3 adds no files to `data/`: runs stay in memory until phase 4.
- [x] README, PLAN.md and ROADMAP.md updated.

## Real-machine results

All runs used the same request, through the same code as the Text tab: a thinking prompt asking
for about 150 or 200 words on why memory bandwidth limits generation speed. Settings were thinking
on, effort low, max tokens 1500, temperature 0.6, top-p 0.95, top-k 20 and min-p 0.

| Run | Time to first token, measured / Unsloth | Gap | Decode speed, measured / Unsloth | Gap | Output tokens | First answer word |
| --- | --- | --- | --- | --- | --- | --- |
| test, app run | 596.5 / 576 ms | 20.5 ms | 22.85 / 22.82 tok/s | +0.14% | 702 | 19.3 s |
| test, recording | 452.5 / 432 ms | 20.5 ms | 22.60 / 22.55 tok/s | +0.23% | 419 | 8.3 s |
| test, recording, thinking in answer | 681.7 / 661 ms | 20.7 ms | 22.86 / 22.80 tok/s | +0.28% | 743 | 0.7 s |
| lenovo, app run | 3337.3 / 3266 ms | 71.3 ms | 8.34 / 8.34 tok/s | +0.06% | 439 | 24.9 s |
| lenovo, recording | 2692.9 / 2643 ms | 49.9 ms | 8.05 / 8.05 tok/s | +0.05% | 371 | 25.2 s |

### Agreement

- **Decode speed** agreed within 0.3 percent in all five runs. The roadmap allows 10 percent.
- **Time to first token** was 20 ms longer on the controller when the app ran on the same
  computer as Unsloth. The round trip there is 0.1 ms, and the headers arrived after 20 to 25 ms.
  So those 20 ms are Unsloth's own request handling before its clock starts, not network.
- Over Wi-Fi to the Lenovo, the gap was 50 and 71 ms. During the session, ping to the Lenovo
  ranged from 1.6 to 164 ms, averaging 48 ms. The Wi-Fi delay accounts for the extra 30 to 50 ms.
- The roadmap expected a gap of about one round trip. Two things add to it. Unsloth's handling
  costs a fixed 20 ms. Each run also opens a new connection, which costs one more round trip.
  With both, the gaps fit.

### Recordings

These are in `fixtures/streams/`, without the key:

- `linux-rtx3060-thinking.json`: 420 reads, thinking and then the answer. 58 of the 62 prompt
  tokens came from Unsloth's prompt cache, because the same prompt had just run.
- `linux-rtx3060-thinking-in-answer.json`: 745 reads. The model skipped its thinking block and
  wrote its reasoning into the answer, so the first answer token came at 0.7 s. This happened in 1
  of 3 identical RTX runs.
- `linux-radeon780m-thinking.json`: 297 reads, of which 72 arrived together with the chunk before.

`shared/test/stream.test.ts` checks each recording in five ways:

- Splitting the stream at every byte offset gives the same events. Large recordings use sampled
  offsets.
- Replaying it gives the metrics measured when it was recorded.
- Its measurements agree with Unsloth's.
- Its prompt cache and draft counts parse correctly.
- The skipped-thinking warning fires only on the right recording.

## Findings

- **Each run gets a new connection.** Unsloth answers streams with `Connection: close`, so a
  keep-alive agent cannot help. ROADMAP.md and PLAN.md are corrected.
- **Speculative decoding was on for every run.** The models were loaded with speculative
  decoding on `auto`, which engaged multi-token prediction (MTP) on both machines.
  - On the RTX, MTP kept 0 of 64 drafted tokens, so it only cost time.
  - On the Lenovo, MTP kept 202 of 336, so tokens arrived in groups. There were 84 gaps under
    5 ms and 130 gaps between 200 and 300 ms.
  - The table now shows the draft counts and warns when speculative decoding is on.
  - For the phase 4 race, load both machines with speculative decoding off. The Models tab does
    this by default.
- **The two machines run different quants.** The RTX 3060 has 12 GB, which holds UD-IQ2_XXS of
  this 27B model but not Q4_0. A race between these loads compares hardware and quant together.
  For a like-for-like race, pick a model small enough that both machines load the same quant.
- **A model can skip its thinking block.** The 2-bit model did this once in three runs, and its
  reasoning arrived as answer text. The results now warn when thinking was on but none arrived
  on its own.
- **Unsloth counts cached prompt tokens separately.** Its `prompt_n` leaves out the cached tokens,
  which are in `cache_n`. The table adds them back, so the two prompt-token columns agree. A note
  says when the prompt cache made the first token early.
- **Unsloth's reasoning-token count reads 0.** It reports no reasoning tokens even when the model
  thought. The app measures thinking by time and characters instead.
- **Unsloth's monitor reports its queue as counts:** capacity, active, queued and free. The fake
  Unsloth now does the same.
- **The recorder saves the machine's LAN address.** The address goes into the recording file, but
  the key does not.
- **A server left running through a rebuild breaks the page.** The copy started on 24 September
  served the phase 3 page without the phase 2 routes, so the Models tab said "Not found." for
  both machines. Each build now has an id. The page compares it with the id the server read at
  startup and shows a banner when they differ. A route the server lacks now reads as "probably
  older than this page". The app on port 3000 was restarted with the current build on
  25 September at 01:04, and the Models tab then listed the models on both machines.

## Still to do

1. The app on port 3000 now runs in the background with its output in `model-duel.log`. To run
   it in a terminal again, stop that process first, then start it:

   ```bash
   kill $(ss -ltnp | grep ':3000 ' | grep -o 'pid=[0-9]*' | cut -d= -f2)
   npm start -- --host 0.0.0.0
   ```

2. Load through Model Duel on the real machines once, per machine and on all machines. The Models
   tab is verified on the fake machines, but loading on the real ones would have replaced the
   models you loaded, so it was left to you.
3. Mac: open the firewall as described in phase 2, add the Mac again, then record a stream:

   ```bash
   npm run record -- --machine "<name>" --effort low --max-tokens 1500 --name mac-m4-thinking
   ```

4. Before phase 4, load the same quant with speculative decoding off on every machine.
5. Commit and tag `v0.3` when commits are wanted.
