# Review: the native engines (audio.cpp, llama-server, Apple Speech)

Branch `localai` at `6c76dd6` ("the native engines hold video memory only while something uses them").
Reviewed: `electron/native-engine.js`, `electron/native-engines.js`, `electron/apple-speech.js`,
`native/apple-speech/SpeechHelper.swift`, the wiring in `electron/main.js` / `preload.js` / `ipc-channels.js`, and the
renderer side (`src/lib/native/nativeEngine.ts`, `src/providers/openai/nativeAsr.ts`, `src/stores/nativeEngineStore.ts`,
plus `src/providers/openai/localaiNative.ts` and `src/lib/lan/nativeShare.ts` where they decide behaviour).

**How this was checked.** Each finding is marked:

- **Confirmed (test)**: a new test in the neighbouring test file fails on the current code. Production code is unchanged.
- **Confirmed (run)**: shown with a small script or by running the tool in question.
- **Inferred**: from reading the code, a platform's documented behaviour, or upstream source, without running on the target system.

The review ran on Linux (Node 22, bsdtar 3.7.2 installed for the archive tests). Nothing was run on Windows or macOS,
and no runtime or model was downloaded.

**New tests.** Eight tests, under a `describe('review: what the code should do and does not yet')` block at the end of each file:

| File | Test | Finding |
|---|---|---|
| `electron/native-engine.test.js:527` | does not call a runtime ready that was unpacked only halfway | M2 |
| | leaves one runtime running, not two, when another model is started while one is being started | M1 |
| | is not started after a stop that was asked for while the start was under way | M1 |
| | takes no id for a model that is not one of its own: none of the names every object has | L1 |
| | tells an open recognition when the runtime under it is stopped… | M9 |
| `electron/native-window.test.js:300` | does not take speech that repeats a character eight times for a model that lost its way | M3 |
| | reads once more when the voice went on after the last reading, though more softly than its loudest moment | M8 |
| `electron/apple-speech.test.js:198` | reads the helper's last line even when its exit is heard first | L9 |

`npx vitest run electron` → 8 failed (exactly these), 730 passed. The 67 tests already in the four native test files
still pass.

---

## Summary

Download integrity holds up well. Every file goes through one path (`fetchFile`) that checks size and SHA-256 before
the file gets its final name, and model URLs are pinned to commits. Most of the real problems are in **lifecycle**:

- a runtime process can be orphaned and keep holding gigabytes of video memory (M1, M4);
- a half-unpacked runtime is reported as "ready" from then on, and the UI cannot repair it (M2);
- macOS never gets the runtime's priority back (M6).

There are also two **text-loss** problems in `openWindow`:

- the loop guard treats ordinary repetition (a long number, laughter, 对对对…) as a model loop, and drops everything after it (M3);
- the "nothing new since the last reading" shortcut can drop a softly spoken last word (M8).

The llama-server instances accept requests from any web page in the user's browser (M5).

| # | Severity | Status | Finding |
|---|---|---|---|
| M1 | Medium | Confirmed (test) | Two starts that overlap leave an orphaned runtime that is never killed, even at quit; a stop during a start is undone |
| M2 | Medium | Confirmed (test) | Unpacking that fails or is interrupted after the exe is written leaves the engine "ready" for good |
| M3 | Medium | Confirmed (test + run) | The `LOOP` regex fires on legitimate repetition and truncates the text after it, including the final text |
| M4 | Medium | Inferred | Runtimes outlive the app on SIGINT/SIGTERM, an uncaught exception or a crash; nothing reaps them on the next launch |
| M5 | Medium | Confirmed (upstream source) | llama-server runs without an API key and with CORS that echoes any origin: any website, or a DNS rebind, can use it |
| M6 | Medium (macOS) | Confirmed (run, Linux) / Inferred (macOS) | `setPriority(NORMAL)` after warm-up fails for non-root on macOS, so the runtime stays at nice 10 for its whole life |
| M7 | Medium (Windows) | Inferred | `tar.exe` gets the full archive and target paths; a user folder outside the ANSI code page likely breaks unpacking |
| M8 | Medium | Confirmed (test) | `restIsQuiet` compares new sound to 10 % of the loudest sample ever, so a soft last word after the last reading is dropped |
| M9 | Medium | Confirmed (test) | `stop()` (and a start of another model) drops open recognitions silently; the page keeps feeding a dead id |
| M10 | Medium | Inferred | `joinEngines` idle-stops the non-active engine under a session that still uses it (Mac, two languages) |
| M11 | Low–Medium | Inferred | Open streams are never cleaned up when the renderer reloads or crashes |
| M12 | Low–Medium | Inferred | `stop()` does not wait for exit: `remove` of the running model fails on Windows, and video memory overlaps on restart |
| L1–L16 | Low | various | See below |

---

## 1. Download integrity

**What holds (confirmed by reading and the existing tests; disk-full confirmed by running):**

- Every runtime and model download goes through `fetchFile` (`native-engine.js:733`). The final name is given only by
  `renameSync(part, dest)` (`:771`), after `sizeOf(part) === bytes` and `hash(part) === sha256` (`:767`).
  A `.part` file is never treated as complete. A cancelled download keeps its `.part` (AbortError is not recorded as a
  failure, `:805`), and the next attempt verifies whatever results.
- A `.part` larger than the whole file is dropped (`:738`). A `.part` of exactly the right size is hashed without
  fetching (`:743`).
- A server that ignores `Range` and returns 200 restarts the file from zero (`:746`; existing test "starts over…").
- Redirects are followed by `net.fetch`. `Range` survives redirects, and the hash makes any mix-up harmless.
- Disk full (ENOSPC) while writing: I ran `fetchFile` against a write stream on `/dev/full`. The download resolves as
  `failed` with `ENOSPC: no space left on device, write`, and nothing is left "downloading".
- Hugging Face URLs are pinned to 40-hex commits (tested in `native-engine.test.js:101,146,156`). GitHub URLs are
  release *tags* (`releases/download/v0.9.0/…`, `b11401/…`). An owner can re-upload an asset under a tag, but the pinned
  SHA-256 makes that a failed download, not a different binary.
- The renderer can only name a catalog id; URL, size and hash all come from the catalog.

**Low findings:**

- **L2. A clean but short body throws away all progress.** `native-engine.js:767-769`.
  - Scenario: a proxy or CDN ends a chunked response cleanly at 2.9 of 3.1 GB, so `reader.read()` returns `done`, not an error.
  - Effect: the size check fails and the whole `.part` is deleted, so the next attempt starts at 0. A dropped
    connection, or a `Content-Length` mismatch (Chromium raises `ERR_CONTENT_LENGTH_MISMATCH`), throws instead and
    keeps the `.part`. So this only happens without a length.
  - Fix: delete only when `size === bytes && hash !== sha256` or `size > bytes`. When `size < bytes`, keep the `.part`
    and report "incomplete, will resume".
- **L3. A 206 response's `Content-Range` is not checked.** `native-engine.js:746-749`.
  - Scenario: a server or proxy answers `bytes=N-` with a 206 for another range, or a 206 to a request without `Range`.
  - Effect: the wrong bytes are appended; the hash fails at the end and the whole file is downloaded again. Integrity
    holds; only bandwidth is wasted.
  - Fix: require `Content-Range: bytes N-…/bytes` on a 206, otherwise restart from 0.
- **L4. The response body is not cancelled when writing fails, and is not capped.** `native-engine.js:752-763`.
  - Effect: on a write error the network body is left half-read. Chromium keeps the connection until it is collected.
    A body longer than `bytes` keeps being written; the hash catches it, but it can fill the disk first.
  - Fix: `control.abort()` / `reader.cancel()` in the `finally`; stop with an error once `state.received > bytes`.
- **L5. `cancel(id)` and `remove(id)` abort the engine download whatever `id` is.** `native-engine.js:811-815`.
  - Scenario: model A's download is fetching the runtime; the person deletes another model B.
  - Effect: A's download stops with no error shown (AbortError), as if it had been cancelled.
  - Fix: remember which id started the engine fetch, and abort it only for that id (or for `cancel()` with no id).
- **L6. `remove(id)` during "verifying" cannot stop the hash.**
  - Scenario: remove is pressed during the ~10 s hash of a 3 GB file.
  - Effect: `rmSync(part)` runs, then `renameSync` fails (ENOENT on POSIX, EPERM on Windows), so the model shows
    "failed" with a system error message instead of "absent". Likewise, cancel during "verifying" finishes the download
    anyway.
  - Fix: make `hash` abortable (destroy the read stream on `control.signal`) and treat abort as cancel.
- **Info.**
  - An installed file is trusted by existence alone (`has(fileOf(id))`, `:707`); it is never re-verified.
  - The `.part` name is not keyed by hash: after a catalog bump that keeps the file name, an old partial is resumed,
    fails the hash and is downloaded again (correct, just wasteful). Keying the part by `sha256.slice(0, 12)` avoids it.
  - The translator and the coach each download their own copy of llama-server (`native-translator/engine-b11401` and
    `native-coach/engine-b11401`).

## 2. Archive extraction

**What holds:**

- The archive is verified (size and SHA-256) before it is unpacked. `ensureEngine` (`:777`) unpacks only the file that
  `fetchFile` renamed.
- System tar is called by full path with no shell (`systemTar`, `untar`, `:253-262`).
- I built a crafted zip and tar.gz and ran **bsdtar 3.7.2** on them. That is the libarchive version Windows 11's
  `tar.exe` ships; macOS ships 3.5.x/3.7.x. Confirmed (run):
  - `../x` is refused ("Path contains '..'").
  - `/tmp/x` is rewritten to `into/tmp/x`.
  - A file written through an archived symlink is refused ("Cannot extract through symlink").
  - An absolute hard-link target is refused.

  Nothing was written outside the target folder.

### M2. A half-unpacked runtime is "ready" for good. Medium. Confirmed (test)

`native-engine.js:713` (`has(exe) ? 'ready'`), `:778` (`if (has(exe)) return;`), `:784-790`.

- **Scenario.** Unpacking writes `audiocpp_server.exe` / `llama-server`, then stops before the libraries beside it
  (`ggml*.dll`, `*.dylib`): the app is quit, the disk fills, the machine sleeps or crashes, or tar exits non-zero.
  bsdtar exits 1 when it refuses any one entry, but extracts the rest; I confirmed this by running it. Truncation of
  the exe itself counts too. `extract` rejects or never returns; `finally` deletes the archive (`:788`).
- **User-visible effect.** From then on `status().engine === 'ready'`. A new `download(id)` skips the runtime
  (`:778`), downloads the model, and `start` spawns a binary that cannot load its DLLs. On Windows that means exit
  `0xC0000135`, possibly a loader error dialog, and an empty tail. "Delete" removes only the model, so nothing in the
  UI repairs it; the person has to find and delete `…/native-engine/engine-0.9.0/` by hand.
- **Fix.**
  1. Unpack into `engine-<version>.tmp/`.
  2. Check `lstat(exe).isFile()`, and that every file the release needs is there.
  3. Write a marker file (for example `ready.json` with the archive's SHA-256).
  4. Rename the folder to `engine-<version>`.

  Use the marker, not the exe, as the "ready" signal. On a failed unpack, delete the temp folder.

**L7. A symlink in the archive is extracted, then followed by `statSync` and `chmodSync`. Low (needs a malicious archive that also matches the pinned hash). Confirmed (run).**

`native-engine.js:691,791`.

- **Scenario.** bsdtar happily extracts an entry `audiocpp_server -> /Users/x/anything` (only *writing through* a
  symlink is refused). I confirmed that `fs.statSync(exe).isFile()` is then `true`, and that
  `fs.chmodSync(exe, 0o755)` changed the mode of the file outside the folder.
- **Effect.** Arbitrary user files can be chmodded, or another binary run. This requires the hash-pinned upstream
  release to be malicious, so it is defence in depth only.
- **Fix.** After unpacking, `lstat` the exe (it must be a regular file), and check that `realpath` of everything in
  the folder stays inside it. Alternatively, unpack with `--no-same-owner` and reject archives with links (bsdtar has
  no flag for that; list the entries with `tar -tvf` first).

### M7. Windows: tar.exe is given full paths that may be outside the ANSI code page. Medium. Inferred

`native-engine.js:260`: `execFile(systemTar(), ['-xf', archive, '-C', into])`.

- **Scenario.** The Windows user folder is `C:\Users\测试ユーザー` on a system whose code page cannot represent it
  (or holds an emoji). `tar.exe` is a C program with ANSI `argv`, so the characters arrive as `?`.
- **Effect.** The runtime never unpacks ("The engine could not be unpacked."). The comment at `:296-300` shows the code
  already avoids exactly this for the runtime, but not for tar.
- **Fix.** `execFile(systemTar(), ['-xf', build.archive, '-C', '.'], { cwd: engineDir, … })`; libuv passes `cwd` as
  UTF-16. Verify on Windows with such a profile.

## 3. Process handling

**What holds:**

- No shell anywhere. The audio.cpp arguments are constant (`--config server.json --no-ui`); the config is written
  with `JSON.stringify`.
- llama's arguments are the catalog file name and a number (`:338-340`), so model ids and paths cannot inject anything.
- The runtime is started in `modelsDir` and given relative names, so the runtime itself never sees a non-ASCII path.
- Both runtimes are told `127.0.0.1` (`:305`, `:339`).
- stdout and stderr are drained into a 30-line tail (`:726-730`), so pipes never fill.
- A process that exits during warm-up is handled: `ended` marks the run failed, warm-up resolves false, and bringUp
  returns at `:897`.

### M1. Overlapping starts orphan a runtime; a stop during a start is undone. Medium. Confirmed (test, two tests)

`native-engine.js:835-902`. `starting` only dedupes the *same* id, and `bringUp` awaits `freePort()` (`:851`) between
its `stop()` (`:846`) and its `spawn` (`:859`).

- **Scenario A.** `start('qwen3-asr-1.7b-q8')`, then within those milliseconds `start('qwen3-asr-0.6b-q8')`: the
  settings and a session, or the page and a LAN device, each starting a different model. Both stops find nothing;
  both processes are spawned; `child` points at the second; the first is never killed.
  - Its `ended` returns early (`child !== mine`, `:868`).
  - `stop()` and the `will-quit` handler kill only `child`.
  - It keeps one to three GB of video memory until reboot.

  The test shows two live children; after `engine.stop()` one is still alive.
- **Scenario B.** `start(id)` then `stop()` during the same window. The engine starts anyway and ends "ready".
  `remove(id)` in that window does not stop it either (`run.model` is not yet `id`, `:820`).
- **Fix.** Give each bringUp a generation number. Bump it in `stop()` and in every `start()`. After every `await` in
  `bringUp`, return if the generation moved, and if a child was already spawned, kill it. Alternatively, serialise
  `start`/`stop` through one promise chain.

### M4. Runtimes outlive the app on signals, uncaught exceptions and crashes. Medium. Inferred

- **Where.** `main.js:679-698` (`cleanupAndExit`, `handleExit`) and `main.js:708-717`: SIGINT, SIGTERM,
  `uncaughtException` and `unhandledRejection` all call `process.exit()`.
  - The engines are stopped only in `will-quit` handlers (`main.js:1412,1447,1481`), which `process.exit()` skips.
  - Children are spawned without a job object (Windows) or a parent-death signal (macOS has none), so they survive a
    crash or "End task" too.
  - FORK.md says "退出应用时引擎一起退出"; that holds only for a normal quit.
- **Effect.** After a crash, an update-restart through a signal, or a dev Ctrl-C, up to three servers (about 4–6 GB of
  video memory together) stay running. The next launch picks new ports and loads the models again, so a gaming PC hits
  out-of-memory. Nothing ever reaps the old ones.
- **Fix.**
  1. Call `nativeEngine?.stop()`, `nativeTranslator?.stop()` and `nativeCoach?.stop()` synchronously from
     `cleanupAndExit`; `kill()` is synchronous.
  2. Write `{pid, exe}` to `<dir>/run.json` at spawn. On the next `bringUp`, kill that pid if it is alive and its
     image path is the engine's exe.
  3. On Windows, consider assigning children to a kill-on-close job object.

### M6. macOS: the runtime stays below normal priority forever. Medium (macOS). Confirmed (run, Linux non-root) / Inferred (macOS)

`native-engine.js:881,898` and the `setPriority` default at `:666`.

- **Why.** `os.setPriority(pid, PRIORITY_BELOW_NORMAL)` sets nice 10. Going back to `PRIORITY_NORMAL` (nice 0) lowers
  the nice value, which POSIX allows only to root. As uid 65534 I got `ERR_SYSTEM_ERROR`, and the child stayed at 10.
  macOS has the same rule (setpriority(2): "EACCES: a non super-user attempted to lower a process priority"). The
  error is swallowed by the `try/catch` at `:666`. Windows is unaffected: `SetPriorityClass` can raise again.
- **Effect.** On a Mac every recognition, translation and feedback request runs at nice 10. When something else
  is busy (a game, a video call, an export), the runtime's CPU threads (decoding, sampling, submitting GPU work) are
  starved, and partials and translations lag. This is exactly what the comment at `:880` says should not happen.
- **Fix.** On POSIX, don't lower the priority at all. If background loading must yield, do it inside the runtime, or
  run the load at normal priority. If it is kept, at least `log` the failure, so it is visible.

### M12. `stop()` does not wait for the process to exit, and never escalates. Low–Medium. Inferred

`native-engine.js:904-914`. `mine.kill()` is fire-and-forget. `remove()` then deletes the model file at once
(`:820-821`), and `bringUp` spawns the next runtime at once.

- **Windows.** llama.cpp and audio.cpp hold the model open or mapped without `FILE_SHARE_DELETE`, so `rmSync` will
  likely throw EBUSY/EPERM. The IPC call then rejects, and the store sets `NO_NATIVE_ENGINE`: the settings show "no
  engine" until the next status event. A second press works.
- **Any system.** The old process's video memory is still allocated while the new model loads, so a tight GPU fails
  to load the new one.
- **No SIGKILL.** A process wedged in a GPU driver keeps running.
- **Fix.** `stop()` returns once `exit` has fired. Send SIGTERM, then SIGKILL (or `taskkill /T /F`) after about 3 s.

**Other process findings (Low):**

- **L8. No API key and inherited environment.** `LLAMA_RUNTIME` spawns with the full `process.env`.
  - A person who runs their own llama-server may have `LLAMA_API_KEY` set. The app's own server then requires it,
    the renderer's `Authorization: Bearer no-key` is refused with 401, and translation fails with no clear reason.
  - Command-line flags override `LLAMA_ARG_*`, so host and port are safe.
  - Fix: pass `env` with `LLAMA_*` and `LLAMA_ARG_*` removed (and see M5).
- **L10. Port race.** `freePortOf` closes its probe before the runtime binds (`:238-247`).
  - Another process, or another of the three engines started in parallel, can take the port.
  - The runtime then exits on the bind error, the run shows "failed", and a retry works. The health check accepts any
    200 on that port, so in theory it could greet another server, but the exit normally arrives first.
  - Fix: retry `bringUp` once on an early exit.
- **L11. Log files grow without limit.** `native-engine.log`, `native-translator.log` and `native-coach.log`
  (`main.js:1367-1372` and the others) are opened with `flags: 'a'` and never rotated. llama-server logs every
  request. Fix: truncate when over a few MB at open.
- **Minor.**
  - `note` decodes each chunk on its own (`String(chunk)`, `:727`), so a UTF-8 character split across chunks becomes
    mojibake in the tail.
  - `openLive` has no request timeout (`:363`); it relies on the page aborting.

## 4. IPC surface

**What holds:**

- The renderer cannot pass a URL, a path or a binary. It sends an id; the engine looks up `MODELS_[id]`; URL, file
  name, hash and exe all come from the catalog.
- `remove` deletes `path.join(modelsDir, MODELS_[id].file)` and its `.part`, nothing else.
- Apple Speech maps an id to `LOCALES[language]` before passing it to the helper.
- Channels are allow-listed in `ipc-channels.js:80-104` and `preload.js:88-94`.

**L1. Catalog lookups accept the names every object has. Low. Confirmed (test)**

`native-engine.js:683,796,818,836` (`MODELS_` is a plain object, and `!MODELS_[id]` is the only check) and
`apple-speech.js:147,173,184` (`LOCALES[language]`).

- **Scenario.** The page sends `download('constructor')` or `start('__proto__')`.
  - `download('constructor')` fetches and unpacks the runtime, then throws a TypeError at `path.join(…, undefined)`.
  - `start('__proto__')` **stops the running engine** (`bringUp` begins with `stop()`), then throws.
  - `remove('toString')` throws before deleting anything, so no arbitrary path can be reached. On the Apple side,
    `spawn` throws on a function argument, which is harmless.
- **Effect.** A renderer bug or an XSS can stop engines or trigger downloads with odd ids. No file outside the catalog
  is touched.
- **Fix.**
  - Use `Object.hasOwn(MODELS_, id)` (and `Object.hasOwn(LOCALES, language)`) everywhere, or build the maps with
    `Object.create(null)` / `Map`.
  - `joinEngines` already uses `hasOwnProperty` (`native-engines.js:101,150`).

**L12. Stream inputs are not validated against the model.** `native-engine.js:918-948`.

- `language` is not checked against `model.languages`. `languageCode('ja\r\nX')` keeps the CR/LF and goes into the
  multipart field (`:426`). The boundary is random, so a part cannot be closed, but the runtime gets junk.
- `openStream({model})` ignores `model` entirely and serves `run.model`. If another model was started in the meantime,
  the page is served by a model it did not ask for.
- There is no cap on concurrent streams or on the size of one `pcm`.
- Fix: return null unless `!model || model === run.model`. Accept only `modelHears(run.model, language)` codes. Cap
  streams at a few, and each write at, for example, 1 MB.

**IPC sender.** `ipcMain.handle` never checks `event.senderFrame`. That is fine while only the main window loads app
content; worth a check if any other frame or `webview` ever gets the preload.

### M5. llama-server is open to every web page in the browser. Medium. Confirmed (upstream source at `b11401`)

`LLAMA_RUNTIME.launch` (`native-engine.js:338-340`) passes no `--api-key`, `--cors-origins` or `--no-slots`. In
llama.cpp `b11401`:

- `tools/server/server-http.cpp:331-334`: with the default `--cors-origins *` and `--cors-credentials` on,
  `Access-Control-Allow-Origin` is set to the request's own `Origin`.
- `tools/server/server.cpp:340`: the server itself warns "security: no API key is set and CORS allows all origins".
- `/slots` is enabled by default (README: `--slots, --no-slots … default: enabled`).

What follows:

- **Any web page.** A page open in the user's browser can scan `127.0.0.1` ports. Fetches are cheap, and the port is
  random but in the ephemeral range. Once it finds the port, it can run completions on the GPU, read the answers, and
  query `/props` and `/slots`.
- **DNS rebinding.** This works regardless of CORS, because llama-server does not check `Host`.
- **Other local users** on a shared machine can do the same.
- audio.cpp's server is in a similar position for simple multipart POSTs. I don't know whether it sends CORS headers
  (not checked).

Fix:

- Generate a random key per run, and pass `--api-key <key>` and `--no-slots`.
- Expose the key to the renderer with the port, through status. The renderer already sends
  `Authorization: Bearer …` (`nativeShare.ts`, `nativeTranslators`), so only the value changes.
- Optionally add `--cors-origins` with the app's own origin.

## 5. `openWindow`, read line by line against `native-window.test.js`

**What holds (confirmed by reading; the existing 17 tests pass):**

- **No concurrent readings.** `start` is reached only from the timer (guarded by `reading`, `:611`), from `end()`
  (guarded at `:636`), or from inside the previous reading's `then` after `reading = null`. `plan()` returns while a
  reading is in flight (`:608`).
- **No double terminal event.** `finish` checks and sets `over` (`:537-543`). `abort()` sets `over` without emitting.
  A reading's `then` checks `over` before doing anything (`:587`, `:553`). So `end`→`abort`, `abort`→`end` and
  timeout→done all emit at most one terminal event. The engine (`:929`) and `joinEngines` (`:54`) forget the id on
  the first one.
- **Nothing lost at the end.** `end()` with a reading in flight lets that reading decide: if the voice went on, it
  reads once more (`:595-599`). Writes after `end()` are ignored, as they should be.
- **Failure handling.** A failed reading on the way keeps the last partial and reads again. A failed last reading is
  an `error` event.
- **Regex speed.** `LOOP` is linear in practice. Confirmed (run), on 400,000-character inputs (the `readWhole` cap):
  random kana took 94 ms, a near-miss pattern (each unit length from 1 to 20 repeated 7 times) 30 ms, and `ab`×7+`c`
  2 ms. Real readings are under 1,000 characters (< 1 ms). No catastrophic backtracking: the unit is bounded to 20 and
  `\1{7,}` either reaches 7 or fails quickly.

### M3. The loop guard fires on legitimate repetition and cuts the text there. Medium. Confirmed (test + run)

`native-engine.js:461` `LOOP = /(.{1,20}?)\1{7,}/su` (any unit of 1–20 characters seen 8 times in a row), used for
partials (`:602`), for the "lost" decision (`:589`), and to truncate (`unloop`, `:467-470`). What a run printed:

| Input | `loopAt` | `unloop` |
|---|---|---|
| `人口は1400000000人です。` | 5 | `人口は140` |
| `予算は100000000円です。` | 4 | `予算は10` |
| `哈哈哈哈哈哈哈哈，太好笑了。` | 0 | `哈` |
| `ははははははははは、面白い。` | 0 | `は` |
| `对对对对对对对对，就是这样。` | 0 | `对` |
| `はいはいはいはいはいはいはいはい、わかりました。` | 0 | `はい` |
| `네네네네네네네네, 알겠어요.` | 0 | `네` |
| `すごーーーーーーーーい！` | 2 | `すごー` |
| `えっと........そうですね` | 3 | `えっと.` |
| `はいはいはいはい…` (4×), `对对对对对` (5×), `0120000000` (7 zeros) | −1 | unchanged |

- **Scenario.** Someone says a number of 100 million or more and the model writes digits, laughs with 8 or more 哈 or
  は, or says 对 / はい / 네 eight times.
- **Effect.**
  - **Partials:** everything after the repetition disappears for the rest of the stretch, and the number is shown
    wrongly (`140`).
  - **Final text:** the reading counts as "lost", so `reread` runs: up to three more readings. The text still repeats,
    so each half is cut at the repetition, and **everything after it in each half is dropped from the final text**,
    which then goes to translation.
  - **Time:** the extra readings also add seconds to the end of the stretch (see L13).
- **Fix.** A real loop runs until the model's token limit, so it reaches the end of the reading; legitimate repetition
  is followed by more speech. Anchor the match at the end:
  `/(.{1,20}?)\1{7,}.{0,20}$/su` (a partial unit may trail). Optionally also require the repeated stretch to be
  longer (for example ≥ 40 characters), or exclude digit-only units. The existing `LOST` fixture ends in its loop, so
  it still matches.

### M8. A soft last word after the last reading is dropped. Medium. Confirmed (test)

`native-engine.js:545` `restIsQuiet`: what no reading has heard counts as "the closing silence" when it is at most
3 s long and its loudest sample is at most `max(600, 10 % of the loudest sample of the whole stretch)`. It is used at
`:598` (a reading in flight at the end) and `:638` (`end()`).

- **Scenario.** A laugh, a plosive or a desk knock reaches 30,000. A reading of the first 2 s comes back. The speaker
  ends with a soft "…ね" / "…吧" at about 2,500 (−22 dBFS: ordinary quiet speech), then the pause. 2,500 ≤ 3,000, so
  `end()` finishes with the old reading.
- **Effect.** The last word of the sentence is missing from the final text and from its translation. FORK.md calls
  this shortcut "只多了静音"; the threshold relative to the all-time peak makes it "anything 20 dB below the loudest
  moment".
- **Fix.**
  - Use an absolute floor tied to the page's VAD (for example, re-read if anything above about 1,000 came after the
    last reading), not a fraction of the peak.
  - Or skip the shortcut only when the unread part is shorter than the page's own trailing pad plus a margin.
  - Or ask the page: it knows when its VAD last heard speech.

**Other `openWindow` findings (Low):**

- **L13. The final reading chain can outlast the page's wait.**
  - After `end()` there can be, in series: the reading in flight, a last reading, and for a loop a lead reading plus
    two halves. Each is limited to 30 s (`WINDOW_READ_TIMEOUT_MS`, `:512`).
  - The page waits 15 s for windowed models (`WINDOW_LIMITS.lastWordsMs`, `localaiNative.ts:63`) and then uses the
    last partial.
  - On an M2, by the timings in the code (about 1.5 s per 10 s of speech; a looping reading takes 3 s more), a 24 s
    stretch with a loop is about 4 × 3.6 s + 2 × 3 s ≈ 20 s, so the page gives up and keeps the stale partial.
  - Meanwhile the page's queue (`nativeAsr.ts:180-204`) holds the next stretch's sound until this one is over.
  - Fix: bound the whole post-end chain (for example, skip the halves when the time spent exceeds about 8 s), and
    lower the per-read timeout once ended.
- **L14. A timed-out reading slows the rest of the stretch.** `lastTook` (`:588`) is also set by a reading that failed
  or timed out. After a 30 s timeout the next reading waits 30 s (`:614`), so no partial appears for the rest of the
  stretch. Fix: update `lastTook` only on success.
- **L15. The two halves of a re-read are joined with an ASCII space** (`:572`). Japanese and Chinese finals get a stray
  space (the test at `native-window.test.js:219` asserts `…波で 結構…`). Fix: join with `''` when either side ends or
  begins with a CJK character.
- **L16. Growth is bounded only by the caller.** `chunks` grows until `end` or `abort`, and each reading re-concatenates
  all of it (`:582`).
  - The page rolls at 24 s for these models, so this is about 0.8 MB per read. But main has no limit of its own: a
    renderer bug, or a page that reloads mid-stream (M11), keeps a stream that grows forever and polls every 600 ms.
  - The WAV size field is 32-bit.
  - Fix: a hard cap (for example 120 s, as the Swift helper has) that ends the stream with an error.

### M9. `stop()` drops open recognitions silently. Medium. Confirmed (test)

`native-engine.js:904-908`. `stop()` aborts every stream without an event. In contrast, `ended()` (`:870`) tells each
one "The recognition engine stopped.". `bringUp` starts with `stop()`, so starting another model does the same, and so
do `remove(runningModel)` and `apple-speech.js:196-198`.

- **Scenario.** The person picks another native model in the settings, or deletes the running one, mid-sentence.
- **Effect.** The page's stream keeps receiving `write` calls that return `false` (ignored, `nativeEngine.ts:155`).
  The page waits for the pause, then up to `lastWordsMs`, and finishes with whatever partial it had. No error is
  shown, and the words of that stretch are lost.
- **Fix.** Emit `{ id, type: 'error', message: 'The recognition engine was stopped.' }` for each stream in `stop()`,
  as `ended()` does. Do the same in `apple-speech.js` `stop()`.

### M11. Streams are not cleaned up when the renderer reloads or crashes. Low–Medium. Inferred

`main.js:1408-1411`. No `render-process-gone` / `did-navigate` handler aborts streams.

- A windowed stream left open keeps its PCM and polls every 600 ms forever (L16).
- A live (R2T2) stream keeps its chunked request to audio.cpp open. If audio.cpp serves one live session at a time
  (not checked), the reloaded page's recognitions are refused until the engine is restarted.
- Fix: record the opening `webContents` id per stream, and abort those streams on `render-process-gone`,
  `did-start-navigation` (main frame) and `destroyed`.

## 6. `joinEngines`

**What holds:**

- Streams are routed by `hasOwnProperty` on each engine's last model list (`native-engines.js:150`).
- An engine that is not up returns `null`, never another engine's stream (tested at `native-engines.test.js:136-144`).
- The page's ids are remapped per engine (`:43,156-157`), and terminal events forget them (`:54`).
- The idle stop never touches the active engine, an engine with an open stream, or one used within `idleMs`
  (`:138`). The stop runs synchronously inside the timer callback, so a `start()` right after it starts afresh.

### M10. A session that uses both engines can lose one under it. Medium. Inferred

`native-engines.js:131-146`. "Idle" is measured only by open streams. Holds from the page (`holdNativeForRun`,
`holdNative`, which FORK.md describes as keeping engines up while a session or a LAN device uses them) are invisible
here.

- **Scenario.** On a Mac:
  1. The person's microphone is Japanese, on Apple Speech.
  2. The other participant is Russian, on Qwen through the downloaded engine (Apple has no `ru`).
  3. Apple was started last, so it is `active`.
  4. The Russian side is silent for 10 minutes: no stream opens on Qwen.
  5. The idle timer stops the downloaded engine.
- **Effect.** The next Russian utterance's `open()` returns null, and `nativeAsr` calls `onFatal('The recognition
  engine of this computer is not running.')`, so the session ends mid-meeting. The existing test
  `native-engines.test.js:146-166` asserts exactly this stop; whether it may happen under a live session is the
  question.
- **Fix.** Let the page say which models are held: `start` per leg, plus a `release(id)` channel. Idle-stop only
  engines that no hold names. Alternatively, drop the idle stop here and leave rest to `restNative`, which already
  knows the holds.

## 7. The Swift helper and `apple-speech.js`

**What holds:**

- One process per stretch.
- The helper exits when its parent changes (`SpeechHelper.swift:211-217`, polled every 2 s), when stdin closes without
  `end` (`:188`), and after 120 s of sound (`:93,184`).
- No speech assets: `stream` checks `installedLocales` and emits a clean error (`:141-143`), which `apple-speech.js`
  turns into an `error` event (`:226`).
- Memory: each stretch is a new process, so nothing accumulates across a session. Within one stretch, the two
  `AsyncStream`s are unbounded but fed in real time and capped at 120 s (about 7.7 MB).

**L9. `exit` is used where `close` is meant. Low. Confirmed (test) / Inferred (that it happens on macOS)**

`apple-speech.js:232` (stream) and `:122` (`runHelper`). Node documents that at `'exit'` "the child process stdio
streams might still be open". The helper writes its `final` line, or `inventory`, then exits at once.

- **If `exit` is handled first.** A stream ends with "The speech recognizer closed before it finished" and the final
  text is lost. `inventory()` resolves before `installed` is set: `status()` lists no languages, and `start()` reports
  "The language is not installed".
- **Reproduction.** Not reproduced on Linux in 1,300 runs. libuv's ordering differs on kqueue, so it is unconfirmed
  on macOS.
- **Fix.** Finish on `'close'` (it carries the exit code too), and update the test fake to emit it.

**Low, Inferred (from the macOS 26 API, not run):**

- `stream` calls `AssetInventory.reserve(locale:)` on every stretch (`:144`). If the language is installed but
  reserving fails (`maximumReservedLocales` reached by other apps' or the system's reservations), every stream fails
  although `start` said "ready". Reserving belongs to `install` only.
- The `kept` task throws on overlapping final ranges (`:154`), which discards the whole stretch's text instead of
  skipping one result.
- An installed language whose transcriber offers no Int16 / 16 kHz / mono format fails every stream (`:66-68`), while
  `start` reports ready. Check it once in `inventory`.
- Cancelling an install kills the helper, but the system's asset download may go on in its daemon.
  `fetching.delete` makes the UI say "absent" while the system keeps fetching.

---

## Suggested order of fixes

1. **M1 + M12:** a start/stop generation and a `stop()` that waits for exit. Small, and fixes two orphan and
   race paths.
2. **M2:** unpack into a temp folder with a ready marker. Small.
3. **M3:** anchor `LOOP` at the end. One line plus the test.
4. **M4:** stop engines in `cleanupAndExit`, and reap by pidfile.
5. **M5:** a per-run API key and `--no-slots`.
6. **M6:** drop the priority dance on POSIX.
7. **M9, M8, M10, M11, M7:** in that order. M7 needs a Windows machine with a non-ASCII profile to confirm.

## Not checked

- Behaviour on real Windows or macOS (Windows-only and macOS-only findings are marked Inferred).
- audio.cpp's own server: whether it allows concurrent live sessions, and its CORS behaviour.
- Whether `/slots` at `b11401` includes prompt text.
- Downloading the actual runtimes or models.
