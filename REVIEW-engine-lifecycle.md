# Review: native engines hold video memory only while something uses them (6c76dd6)

Reviewed at commit `6c76dd6c6` against `FORK.md` › 原生识别引擎 › 什么时候占显存. Line numbers are those of that commit.

**Bottom line.** The design (the check only checks, `prepare` loads, legs hold, one minute of rest) is sound, and most of the bookkeeping is right: no double release, no negative count, and no hold leaked by sharing. There is one real hole, though. **Between the start of `prepare` and the moment a leg takes its own hold, nothing holds the engines.** In that window a pending one-minute rest can stop the engines this run is loading, or has just loaded (F1, F2). Because the translation and feedback addresses are frozen into the config at build time, an engine stopped or restarted after build stays broken for the whole session (F3). Holds stop an engine from being *stopped*, but not from being *switched to another model*, which is how sharing and a local session can break each other (F4). "Try again" on a card loads an engine that nothing ever releases (F5).

Failing tests were added for F1, F2 and F5 (see "Tests added"). Each passes with a small fix, which I tried and then reverted. No production code is changed.

---

## Confirmed defects (I traced the code path)

### F1. A pending rest stops the engines a starting run is loading — High

**Where:** `src/providers/openai/localai.ts:733-746` (`bringUp`) and `src/providers/openai/localaiNative.ts:265-281` (`restNative`).

**Cause.** `restNative`'s timer only checks `using.runs`, and that count goes up in the provider's `start` wrapper (`localai.ts:1078`), after `prepare` has finished. While `prepare` waits on `nativeUp` / `translatorUp` / `coachUp`, `using.runs` can be 0. A timer armed earlier then fires and stops every engine whose store state is not `stopped`. That includes an engine in `starting` or `warming`, and engines that `prepare` has already seen come up.

**Sequence (realistic):**
1. Start a session with grammar feedback on. The feedback engine fails to load (OOM). `bringUp`'s `finally` calls `ups.rest()`, so the rest is due at T+60 s.
2. At T+30 s, choose a smaller feedback model and press Start again. `prepare` starts the new feedback model, which takes about 40 s.
3. At T+60 s the timer fires with `using.runs === 0`. It calls `stop.asr()` (ready), `stop.translation()` (ready) and `stop.coach()` (still `starting`).
4. In the main process, `stop()` kills the child. `bringUp`'s poll loop sees `child !== mine` and returns the `stopped` status (`electron/native-engine.js:885`). `coachUp` gets a not-ready status and throws `notUp('native_coach_failed', …)` with an empty tail.

The same happens within a minute after any earlier release:
- the end of the last session;
- a shared device letting go of an engine (`holdNative` releases also call `restNative`);
- a failed or cancelled earlier start;
- the background start at sign-in.

**What the user sees.** The start ends with "The feedback engine could not start. In the Grammar feedback card, press 'Try again'". The card shows no failure, because the state is `stopped`, so there is no Try again button. Pressing Start again works. If only engines that were already up are stopped (their `start` answered `ready` at once), `prepare` can even succeed. The session is then built against a translator that is gone (port 0 or a stale port; see F3).

**Fix.** Hold the engines for the whole of `bringUp`:
```ts
const held = holdNativeForRun();
try { await Promise.all(starts); } finally { held(); ups.rest(); }
```
F2's fix covers this too.

### F2. Nothing holds the engines between `prepare` and the legs' holds — Medium

**Where:** `src/providers/openai/localai.ts:754-757` and `:1096` (`prepare` ignores the run's `signal`); `src/lib/session/run.ts:155-163` and `:438-443`.

**Cause.** After `prepare` returns, `bringUp`'s `ups.rest()` arms a fresh 60 s timer. The run then builds, admits, and for each leg first awaits `openSource(leg)` and only then calls `provider.start` (which takes the hold).

**Sequences:**
- **A leg's source takes more than a minute to open.** For example, a capture that waits on a permission or picker dialog the user leaves open. The timer stops all three engines. The ASR leg recovers by itself, slowly: `nativeAsr.init` calls `askNativeEngine('start')`. Translation and feedback do not: their `baseUrl` was read at build time (`localai.ts:927`, `:948`). **Every translation in the session fails** (connection refused, reported as per-sentence degradations).
- **The run is refused after `prepare`** (build refusal, admit refusal, a source that fails). The engines are let go by the rest that `prepare` armed. **Not leaked and not released twice.** This path is correct today, but only by accident of the timer.

**Fix.** `prepare` already receives the run's `AbortSignal` (`run.ts:159`). `Run.close()` and `Run.abandon()` abort it on every ending: stop, refusal, failed start, page hide. Take the hold in `prepare` and give it back when the signal aborts:
```ts
session: { admit: admitLocalAI, prepare: (shape, s, signal) => prepareLocalAI(shape, s, UPS, signal) },
// in prepareLocalAI:
const done = holdNativeForRun();
if (signal.aborted) done(); else signal.addEventListener('abort', done, { once: true });
```
This also makes the per-leg holds in the `start` wrapper redundant (they are harmless if kept).

### F3. The translator and feedback addresses are frozen at build time — Medium

**Where:** `src/providers/openai/localai.ts:927` (`translatorBaseUrl()`), `:948` (`coachBaseUrl()`); `electron/native-engine.js:851` (`freePort()` on every start).

Every start of an engine picks a new free port. The address the session uses is read once, at build time. So any stop or restart of the translation or feedback engine during a session breaks that stage for the rest of the session: F1, F2, F4 below, or a crash. A restarted engine is on a different port, so even "it came back" does not help.

**Can a session be built with port 0?** Yes, through F1. Scenario:
- Only the translator was already up; its `start` answered `ready` at once.
- The ASR is loading, and a shared device holds `asr`, so the timer skips the ASR.
- The timer stops the translator. `prepare` still succeeds, and `build` reads `http://127.0.0.1:0/v1` or the old port.

Without F1/F2 a fresh build reads the right port. `translatorUp` writes the `ready` status into the store just before build.

**What the user sees.** Recognized text with no translations. Each sentence gets a degradation notice. Nothing tells them to restart.

**Fix.** Resolve the address per request. Either give the stage a marker (for example `native: 'translator' | 'coach'`) and let the pipeline call `translatorBaseUrl()` / `coachBaseUrl()` for each request, or keep the engine's port stable across restarts (reuse the last port when it is free). Then fix F1, F2 and F4, so that a session's engines are not restarted under it.

### F4. Holds stop a stop, but not a model switch: sharing and a local session break each other — Medium (partly pre-existing, now more likely)

**Where:** `src/lib/lan/nativeShare.ts:39-54` (`nativeRecognizerFor`), `:57-68` (`nativeTranslatorFor`), `:76`, `:113-114`; `src/providers/openai/localaiNative.ts:217-228` (`nativeUp`); `electron/native-engine.js:835-846` (`start` of another id runs `stop()` first).

The engine the app downloads runs one model at a time. `holdNative('asr' | 'translation')` keeps an engine from being stopped. But any `start(otherId)`, from the local `prepare` or from a shared device, kills the running model and its live recognitions.

**Sequence (local session breaks a shared device):**
1. Before this commit, the readiness check kept the local user's chosen model up all the time. `nativeRecognizerFor` therefore usually found it `running` and reused it.
2. Now the engine is usually stopped while idle. A device asks for Japanese with no model named, so `nativeRecognizerFor` picks the first downloaded model in `NATIVE_MODELS` order (`qwen3-asr-1.7b-q8`) and starts it. The device holds `asr`.
3. The local user, who chose `r2t2-q8`, presses Start. `nativeUp` calls `start('r2t2-q8')`, the main process stops Qwen, and the device's streams end with "The recognition engine stopped." Its later recognitions run on R2T2, which its session never asked for.

**Sequence (shared device breaks a local session):**
1. A local session translates with translator A on port p1.
2. A device asks for a pair A does not translate. `nativeTranslatorFor` returns B, and `nativeOrOwnTranslator.init` calls `start(B)`.
3. The main process stops A and starts B on port p2. The local session keeps posting to p1 (F3): no translations until it is restarted.

**Also.** If the switch happens while a local `prepare` waits on A, `start(A)` resolves with B's status. `nativeReady(A)` is false, so the start ends with `native_failed` and B's log tail.

**Fix.** Treat a held engine's model as fixed:
- Have holds carry the model id.
- Make `nativeRecognizerFor` / `nativeTranslatorFor` answer "no model" (or the held one) instead of switching.
- Make `prepare` refuse with a notice of its own (for example "the engine is in use by a shared device with another model") rather than kill the other user's streams.

The main process could also refuse `start(other)` while it has open streams, unless told to force it.

### F5. "Try again" on a card loads an engine that nothing releases — Medium

**Where:** `src/providers/openai/NativeEngineCard.tsx:121`.

`onClick={() => { void store().start(model.id); }}` brings the engine up outside any run. No hold is taken and no `restNative` is armed. `nativeIdle` / `translatorIdle` / `coachIdle` only stop an engine when the settings do not use it, and the card is for the selected model, so they never do here.

**Sequence.**
1. A start fails (or the sign-in background start fails). The notice says to press Try again in the card.
2. The user presses Try again. The model loads.
3. The user does not start a session, or starts one much later.

**What the user sees.** About 2–4 GB of video memory stays held until the app quits or a session starts and ends. That is exactly what this commit set out to stop.

**Fix.** `store().start(model.id).finally(() => restNative())`. Or make "Try again" only clear the failure, so the next session's `prepare` does the loading.

### F6. The background start at sign-in waits forever for a check that may never come — Low/Medium

**Where:** `src/routes/Home.tsx:60`; `src/providers/openai/localai.ts:765-771`, `:806-810`.

`primeNativeOnce()` with no `lastNeeds` sets `primeWanted = true`. Only `checkLocalAIWithNative` clears it, and that check runs only while LocalAI is the selected provider (`src/app/readiness.ts` checks the selected one only).

**Sequence.**
1. The computer starts the app hidden at sign-in. The selected provider is not LocalAI (say Gemini), so `primeWanted` stays `true`.
2. Hours later, perhaps during a game, the user switches the provider to LocalAI. The first check primes: it loads every native engine the settings name, holds them for a minute, then stops them.

**What the user sees.** An unexplained multi-gigabyte load and GPU spike at an arbitrary moment. The panel shows no "Loading" message, because the run is not `starting`.

**Answers to the question.**
- *Load twice?* No. The store dedupes `start` per id, and a StrictMode double effect only re-arms the timer.
- *Never release?* No. `bringUp` always calls `rest()` in `finally`, and the start IPC is bounded by `autostart.quiet` (≤ 60 s) and the main process's ready deadline.

**Fix.** Make the prime one-shot with a short lifetime: drop `primeWanted` after a few minutes, or on the first readiness check of *any* provider. Better, compute the needs at prime time from the provider store, and do nothing when the selected provider is not `localai`. (Minor, test seam only: the deferred path calls `primeNow(lastNeeds)` with the default `UPS` and ignores the `ups` passed to `primeNativeOnce`.)

### F7. The "Loading the models…" message is hidden whenever a conversation is on screen — Low

**Where:** `src/components/MainPanel/MainPanel.tsx:219`, `:301`; `src/components/Conversation/ConversationList.tsx:74`.

The message is the list's `empty` placeholder, so it only shows when there are no items. The new run's conversations replace the old ones in `host.conversations`, which runs after build, after `prepare`. So for every session after the first in an app session, the previous conversation stays on screen during the 30 s load, and nothing says why Start has not turned into Stop. The user is not stuck, though: the phase goes back to `idle` on failure (see "Checked and found correct").

A second, smaller issue: `useNativeEnginesComing()` is true for *any* engine starting, including a shared device's. So "Loading the models…" also shows while another provider's run is starting.

**Fix.** Show the loading state in the footer or toolbar, driven by `run.phase === 'starting' && run.step === 'preparing'` and the selected provider being LocalAI, not by the empty list.

### F8. Failure notices that point at a button that is not there — Low

**Where:** `src/providers/openai/localaiNative.ts:209`, `:226`, `:234`, `:241`; `electron/native-engine.js:885`, `:897`, `:912`.

`notUp` turns any not-ready status into `native_*_failed`, including `stopped` (our own stop interrupted the start, F1/F4) and another model's status (F4). The notice text says "press Try again in the … card". The card shows Try again only when `run.state === 'failed'` for that model.

There is a second way the notice and the card disagree. After a genuine failure, `bringUp`'s `rest()` stops every engine that is not `stopped` a minute later, `failed` included. The main process's `stop()` resets the state to `stopped`. So the card's Try again disappears and the check passes again a minute after a failure, while the notice still asks for it.

That auto-reset is arguably the better behaviour, but it contradicts `nativeGap`'s doc ("A start that failed is said, and not tried again by itself").

**Fix.** Check `status.run.state === 'failed' && status.run.model === id` before using the failure code. Otherwise use a separate code ("the engine was stopped while it started; press Start again"), or retry once. Decide whether the rest should clear `failed`, and make the doc match.

---

## Suspicions and lower-confidence notes

- **S1. macOS `joinEngines` has an idle timer of its own (`electron/native-engines.js:25`, `:130-146`).** It stops the engine that was not started last after 10 minutes with no recognition open. This predates the commit, but now conflicts with the page's holds.
  - In a two-leg run where one leg hears through Apple Speech and the other through the downloaded engine, `active` is whichever `start` ran last.
  - The other engine is stopped once its leg has been silent for 10 minutes. `usedAt` starts at 0, so 10 minutes after the run starts if that leg never spoke.
  - That leg's next utterance then gets `openStream → null`, and the recognition fails for the rest of the session.
  - The same happens when a shared device's `start` makes the downloaded engine `active` while a local session hears through Apple Speech.

  *Recommendation:* now that the page owns the lifecycle, drop this idle logic (or make it skip while the page holds `asr`).

  `joinEngines.stop()` stopping **both** engines is correct given the page's single `asr` counter: it is only called when `using.asr === 0` and `using.runs === 0` (rest, `nativeIdle`), so neither engine is in use.
- **S2. A stop can be lost while the main process looks for a port** (`native-engine.js:846-855`). `bringUp` has already stopped the old child, so `child` is null and the state is `stopped`. A `stop()` arriving during `await freePort()` does nothing, and `bringUp` then spawns. The page's `restNative` also skips the engine, because the store still says `stopped`. It heals itself, since whoever started it calls `rest()` afterwards. Low.
- **S3. Cancelling during `prepare` does not cancel the load.** `untilAborted` drops the answer, the engines finish loading, and they are let go a minute later. Pressing Start again meanwhile joins the in-flight start (deduped by id). Acceptable, but worth a line in FORK.md.
- **S4. A shared device holds the translator for 11 minutes, not one.** `LanTranslator` keeps a loaded translator until `TRANSLATOR_IDLE_MS` (10 min) of no use (`src/lib/lan/translator.ts:41`), and only its dispose releases the hold. FORK.md says it is stopped "一分钟后" after the device is done. Recognition is released when the socket closes, as documented. Code or doc should be aligned.
- **S5. Every LocalAI leg takes a run hold, even in runs with no native stage** (`localai.ts:1077-1094`). That is harmless. It also means the rest is re-armed at the end of every LocalAI run, which incidentally cleans up after F5.
- **S6. Start failures from `prepare` count as `api_error` with `error_type: 'server'`** and are reported as "The session did not start" (`runner.ts:222-240`). That is reasonable, but local engine OOMs will show up in provider-error analytics.

---

## Checked and found correct

- **Double or negative release.** `release()` is idempotent per handle (`let_go`), so a count cannot go below zero.
  - A leg whose `adapter.start` throws releases in the wrapper's `catch`.
  - A leg whose start settles after the run unwound has its `session.stop` run at once by the unwound stack, which releases.
  - Two legs take one hold each and both are released on unwind. A leg that ends on its own ends the whole run, so they never close at different times in practice.
- **Build, admit or leg-open refusal after `prepare` succeeded.** Nothing is held (no leg took a hold). The rest armed by `prepare` lets the engines go a minute later: not leaked, not released twice. See F2 for why relying on that timer is fragile.
- **Can the readiness check stop an engine a starting session needs?**
  - `driveReadiness` only checks while the runner is `idle` (`src/app/readiness.ts:59`, `:75-76`). Changes heard during `starting` or `running` mark it stale and re-check once idle.
  - The run's own `ensureReady` runs *before* `prepare`, with the same frozen settings `prepare` reads, so `nativeIdle` / `translatorIdle` / `coachIdle` can only stop engines the run does not need.
  - After the run, a stale re-check stops an engine the edited settings no longer use. That is intended ("换了设置…马上把它停掉；会话进行中不会").
- **Check loops.** None. `watchNativeEngine` fires on a change of the `stamp` string. The check's `refresh()` stores the same status, and an `*Idle` stop changes the state once (to `stopped`), after which the idle functions return early.
- **Sharing holds.** `LanTranscriber` disposes its engine:
  - on a reconfigure,
  - on an init that loses the race,
  - on `end()` (load failure, fatal error),
  - on socket close,
  - on sharing stop (`host.ts` `drop`).

  `LanTranslator` disposes:
  - on init failure (`forget`),
  - after the idle sweep,
  - on `trim`,
  - on `dispose`.

  `nativeRecognizer` / `nativeOrOwnTranslator` take one hold per engine (`release ??=`) and release it on dispose. I found no path that keeps a count up forever.
- **Failure reporting.** An `AdapterStartError` from `prepare` passes through `untilAborted` and `Run.open()`. In `runner.ts:218-249` it becomes `end(run, { reason: 'start-failed', notice: { code } })`, with `native_failed` / `native_translator_failed` / `native_coach_failed` mapped in `src/lib/view/noticeText.ts:114-122`. The phase goes `starting → stopping → idle` with `lastEnd`, so the spinner (`phase === 'starting'`) clears and the notice shows. The wording problems are in F8.
- **Background start at sign-in.** No double load and no leak; see F6 for the deferred-prime problem.
- *Dead code, not a defect:* the `native_warming`, `native_translator_warming` and `native_coach_warming` mappings in `noticeText.ts:113`, `:117`, `:121` (and their locale strings) are no longer produced by anything.

---

## Tests added (fail at 6c76dd6)

Run with `npx vitest run <file>` (after `npm ci`).

| Test | File | Fails because | Passes with |
|---|---|---|---|
| `…the engines a starting run loads, against the minute's rest (review)` › *are not stopped by a rest that comes due while the run's first step is still loading them (F1)* | `src/providers/openai/localaiNative.test.ts` | `stop.asr` is called while `prepareLocalAI` waits on `hears` | the `holdNativeForRun()` around `Promise.all(starts)` in `bringUp` |
| same block › *stay held from the run's first step until the run ends, whether or not a leg ever opens (F2)* | `src/providers/openai/localaiNative.test.ts` | the store's `stop` is called 61 s after `session.prepare` with the run's signal still live | `prepare` holding until its `signal` aborts (sketch in F2) |
| *lets an engine that "Try again" brought up go again a minute later, when no run or device uses it* (F5) | `src/providers/openai/NativeEngineCard.test.tsx` | `stop` is never called after the retry's load | `.finally(() => restNative())` on the card's retry, or a retry that loads nothing |

I applied each fix locally to confirm that all 52 + 4 tests in the two files pass, then reverted it. The rest of these suites (`localaiNative`, `nativeCoaches`, `nativeTranslators`, `NativeEngineCard`) still pass, and `tsc --noEmit` reports nothing for the edited test files.
