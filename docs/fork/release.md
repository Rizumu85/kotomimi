# Building and releasing

## Build

```bash
npm ci
npm run build
npm run build:audio-host   # Windows needs the C++ components of the VS Build Tools
npx electron-forge make --arch=x64
```

The macOS build uses electron-builder, on a Mac: `scripts/kotomimi-mac-release.sh`. The Windows installer is not code-signed.

On Windows, keep the checkout on a short path such as `C:\src\kotomimi`, as the installer tools fail past 260 characters, and do not package from a drive root, where files go missing.

`npm ci --ignore-scripts` leaves three steps to run by hand:

```bash
node node_modules/electron/install.js
bash scripts/copy-ort-wasm.sh
cd node_modules/electron-winstaller && node script/select-7z-arch.js
```

An unpackaged Electron reads these variables; a packaged app ignores them.

| Variable | Effect |
|---|---|
| `KOTOMIMI_PROFILE=<dir>` | Separate profile, clear of the installed app |
| `KOTOMIMI_DEBUG_PORT=9333` | DevTools protocol port, to drive the UI by script |
| `KOTOMIMI_LOAD_BUILD=1` | Loads the build output, where the dev server keeps restarting |

## Versions

A version is upstream's version plus a two-digit build number: the first fork build on upstream 0.42.2 is `0.42.201`. A build meant to install over an earlier one needs a higher number, or the installer treats it as already installed.

All five sites change in one `chore(release): vX.Y.Z` commit: `package.json`, `extension/package.json`, `extension/manifest.json`, `package-lock.json`, `extension/package-lock.json`. CLAUDE.md's "Version Update Process" is upstream's; the flow below is the fork's.

## Releasing

```bash
git tag -a vX.Y.Z -m "Kotomimi X.Y.Z" && git push origin vX.Y.Z
```

`.github/workflows/kotomimi-release.yml` refuses a tag that is not `v` plus the `package.json` version, because the updater builds its download address from the tag. It runs the fork's test list (upstream's whole suite has failures of its own), builds Windows and creates a draft Release. On the Mac, in a Terminal window (the keychain is locked over SSH), run `scripts/kotomimi-mac-release.sh` on a checkout of the tag and upload what it leaves in `out/make-mac` to the draft. Then publish it: "Check for updates" sees published releases only. A manual `workflow_dispatch` run is a rehearsal that leaves Releases alone.

The update feed is this repository's Releases (`electron/update-manager.js`). The app does not check at startup; Help has the check.

Upstream's three workflows are disabled in this repository's Actions settings: `build.yml` also listens for `v*` tags.

macOS builds are not notarized, as the fork has no Apple Developer ID: the first launch takes right-click, Open.

### Release notes

The Release body is what the app's update dialog shows, so write it for users. Put `v<version>.md` in the release-notes folder, in the version commit: `## 更新内容` first, then `## What's new`, one or two sentences per item on what a user sees change.

Without that file the workflow lists first-parent commit titles since the last `v<number>` tag, so none of upstream's. Its filter drops `chore(<scope>): version ...` titles, which `chore(release): vX.Y.Z` does not match.

## Private beta

`npm run make:beta` builds a local beta that installs beside the stable app: `docs/build/private-beta.md`.

## macOS signing

macOS ties keychain and microphone permissions to the signature, and Squirrel.Mac accepts only an update signed like the running app. An ad-hoc signature differs on every build, so each update is a new app to macOS: permissions are asked again and the app cannot update itself.

The answer is a self-signed certificate (reasoning in `docs/build/macos-auto-update.md`) named `Kotomimi Code Signing` (`build.mac.identity` in `package.json`), imported into the Mac's login keychain and trusted for code signing. `scripts/kotomimi-mac-signing-cert.sh` makes it. The key lands beside the script, which refuses to run from `scripts`, so copy it out:

```bash
mkdir -p ~/kotomimi-signing && cp scripts/kotomimi-mac-signing-cert.sh ~/kotomimi-signing/make-cert.sh
bash ~/kotomimi-signing/make-cert.sh
```

On Windows, run it with Git Bash. A second run keeps the certificate and only stores it again.

electron-builder skips signing without failing when it finds no identity, so the script checks the signature is pinned to the certificate before anything is uploaded; the `.zip`, `.blockmap` and `latest-mac.yml` are what in-place updates read.

Always use the same certificate: a new one means installed apps cannot update and permissions are asked again. Back up the folder and keep it out of the repository.

## macOS keychain

The fixed signature does not cover the "kotomimi Safe Storage" prompt. That item is Chromium's key for encrypting local cookies. For an app with no Apple team, macOS records "Always Allow" against the program's hash, which every build changes, so it would ask after every update.

Kotomimi keeps nothing of its own under that key, so `electron/main.js` sets Chromium's `use-mock-keychain` switch on macOS: the key becomes Chromium's fixed one and nobody is asked (`docs/fork/measurements.md`). The cost is that cookies have no encryption at rest tied to this Mac. `safeStorage` would protect nothing there, so `electron/mac-keychain.test.js` rejects it. An existing keychain item is left unread; Keychain Access can delete it.

## Naming and icons

- The name lives in `forge.config.js` (install directory, executable, app ID), `productName` in `package.json`, and `app.setName` in `electron/main.js` (profile directory).
- Catalogs keep Sokuji; `src/lib/brand.ts` swaps in Kotomimi when a string is shown. The virtual audio devices keep Sokuji, as that is their name.
- `scripts/fork-localai-locales.cjs` writes the fork's strings from its tables, `scripts/fork-locale-groups.cjs` and `scripts/fork-best-effort-locales.cjs`. Edit those, then regenerate.
- `node scripts/translate-locales.mjs --model <name>` fills the other 27 locales; Codex++ must be running, or a request waits for ever. `src/locales/translated.consistency.test.ts` fails on anything left in English.
- About keeps the credit to Sokuji and Kizuna AI Lab. Help's feedback link goes to this repository's issues.
- `node scripts/fork-make-icons.cjs assets/logo-source.svg` makes every icon from one picture. A white-background PNG also works; a transparent one takes `--keep-background`.

## Speed test

It shows whether each stage keeps up with speech, wherever the stage runs. It runs only when asked, and a session starting stops it. A suggestion to change model appears only after a test finds a stage behind.

`src/providers/openai/speedTest.ts` starts each leg as a session does and feeds it a recording at speaking pace, then silence, with automatic turns. Recognition is timed from the end of speech to the last source sentence closed, translation and feedback from each sentence closed to its answer closed. A sentence begun after the recognizer has closed all it had begun is left out: Qwen3-ASR writes a 「はい。」 into the trailing silence.

`src/providers/openai/speedResults.ts` calls recognition behind when its text comes later than the speech lasted, plus a pause, and an answer behind when it averages longer than saying its sentence. Results stay in `localStorage` (`kotomimi.speedTest`), and show only while what decides a stage's speed is unchanged.

`scripts/dev/build-speed-clips.py` makes the 50 recordings and `src/providers/openai/speedClips.generated.ts`. Japanese is the phone's self-check clip, so the two can be compared; the others come from FLEURS. Timings: `docs/fork/measurements.md`.

## Live tests

These need real devices and models. Without their variables they skip, so the ordinary suite contacts no server. WAVs are 24 kHz, mono, PCM16, a few seconds. Each file's header explains its variables.

```bash
# LocalAI
LOCALAI_LIVE=<host>:8080 LOCALAI_LIVE_WAV=speech.wav npx vitest run src/providers/openai/localai.live.test.ts
# Another Kotomimi with sharing on
KOTOMIMI_LIVE=<host>:8790 KOTOMIMI_LIVE_WAV=speech-ja.wav KOTOMIMI_LIVE_SOURCE=ja \
npx vitest run src/providers/openai/kotomimi.live.test.ts --disable-console-intercept
```

`src/providers/openai/coachPrompt.live.test.ts` compares grammar-feedback prompts and models.

Japanese test speech must be real Japanese: a Chinese voice speaks only the kanji. On macOS, make it with `say -v Kyoko` and `afconvert -f WAVE -d LEI16@24000 -c 1`.

## Following upstream

The fork has merged upstream through v0.43.1; nothing later is in.

```bash
git fetch upstream
git checkout -b sync/upstream-<date> main
git merge upstream/main                 # never rebase: main's history is not rewritten
node scripts/fork-localai-locales.cjs   # catalog conflicts: take upstream's, then run this
```

`upstream` here is the remote. The `upstream` branch is a GitHub mirror the merge does not use.

Then run the full command of the workflow's "Run the fork's tests" step and `npx tsc --noEmit -p .`, and open a PR to `main`.

Keep the fork's side of:

- The version sites. `extension/manifest.json` also carries the fork's added hosts.
- Identity and updates: `forge.config.js`, `package.json`, `electron/update-manager.js`, `electron/update-payload.js`, and no update check at startup.
- `src/providers/registry.ts`: Kotomimi first, and "Recommended" follows a provider's `recommended` flag.
- `AccountButton.tsx`: Sign In only with a managed provider chosen, or for someone signed in.
- VB-CABLE: no dialog at start on Windows; `src/components/Banner/useBanners.tsx` offers the install.
- `src/lib/local-inference/selection/measuredRank.ts`: recognizers ranked as measured, the in-page SenseVoice builds not offered for Japanese.

In `electron/main.js`, `electron/preload.js` and `src/routes/Home.tsx`, keep both sides' additions.

Dropped on every merge: upstream's finished plans under docs/superpowers/plans, except those still cited.
