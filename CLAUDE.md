# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

This repository is Kotomimi, a fork of Sokuji; the text below is mostly upstream's. What the fork adds is in [FORK.md](FORK.md) and `docs/fork/`.

## Docs are not a work log

- A feature or fix does not earn a paragraph. Commit messages and Git history hold what happened; docs hold what is true now and why.
- Touch a doc only when a fact in it became false, and change that fact in place. No dated sections, measurement logs, review narrative or "what changed" notes. Measured numbers go in `docs/fork/measurements.md`, one row per subject, updated in place.
- Working notes go to `.dev/` or a scratchpad. A new `.md` needs the user asking for it.
- `scripts/check-docs.mjs` enforces this at commit and at release: `scripts/docs-ledger.json` holds each doc's byte cap and dated-line count, and a cap only goes down. Do not raise one, and do not use `--no-verify`, unless the user asked in words.

## Git Worktrees

Worktree directory: `.claude/worktrees/` (gitignored)

## Project Overview

Sokuji is a real-time AI-powered translation application available as both an Electron desktop app and a browser extension. It provides live speech translation through Kizuna AI (managed Soniox), free on-device inference, Google Gemini, Doubao AST 2.0, Qwen LiveTranslate, OpenAI Realtime, OpenAI Translate, OpenAI Live, Soniox and Palabra AI. Local Native, the Electron sidecar, still runs on the old provider path until kizuna-ai-lab/sokuji#578.

## Development Commands

```bash
npm run electron:dev     # Electron app in development mode
npm run dev              # React app only (browser extension development)
npm run electron:build   # Electron app for production
npm run test             # tests; test:ui with the UI; `npm run test -- path/to/test` for one
npm run build            # React app
npm run package          # package the Electron app
npm run make             # distributable packages
```

A private beta for testing before a stable release: `npm run make:beta`, see `docs/build/private-beta.md`.

### Version Update Process

All five version sites land in a single `chore(release): vX.Y.Z` commit BEFORE the tag: the release workflow checks out the tag verbatim, so every version-affecting file must be at the new version at the tagged commit.

1. Update `package.json`, `extension/package.json`, `extension/manifest.json`, and both lock files (`npm install` at the root and inside `extension/`).
2. Commit all five together, tag that commit (`git tag -a vX.Y.Z -m "Release vX.Y.Z"`), push.
3. Before pushing the tag, `git show vX.Y.Z:<file> | grep '"version"'` on the three non-lock files must print the same version. If not, `git tag -d` and re-tag.

## Architecture Overview

### Dual Platform Architecture
The codebase supports both Electron desktop app and Chrome/Edge browser extension from a shared React codebase: `src/` is shared, `electron/` is desktop-specific (virtual audio device management is Linux only), `extension/` holds the manifest and background scripts.

### Key Architectural Components

1. **Service Layer Pattern**
   - `ServiceFactory` hands out the one settings service (`SettingsService`, implementing
     `ISettingsService`), cached as a singleton; audio has no service object (5. below)
   - Platform detection via `src/utils/environment.ts` utilities

2. **Provider Architecture** (spec: `docs/superpowers/specs/2026-09-22-client-contract-design.md`)
   - One folder per provider, `src/providers/<id>/`: `provider.ts`, the definition
     (settings, credentials, languages, `check`, `session`, its `Settings` view; typed by
     `src/lib/provider/types.ts`), and `adapter.ts`, the L0 client of one leg: it speaks
     the provider's wire and emits segments, audio and lifecycle through `AdapterEvents`
     (`src/lib/contract/adapter.ts`); every adapter passes `src/lib/contract/conformance.ts`
   - `src/providers/registry.ts` lists them in UI order and compiles the `fake` providers
     into development builds only (D24); `src/lib/provider/presence.ts` (`isPresent`)
     decides what a build and platform offer: a definition's `platforms`, a flagged one by
     `VITE_ENABLED_PROVIDERS` (every one in a development build, or by its tester switch),
     the managed one by `VITE_ENABLE_KIZUNA_AI` (on in every development build)
   - `src/stores/providerStore.ts` holds each provider's settings and credentials, stored under
     `settings.<key>.*` (older keys through the definition's `legacyKeys` and `migrate`), and
     one language pair for every provider under `settings.common.sourceLanguage/targetLanguage`
     that only a pick writes (each provider shows it within what it offers); a load never writes
   - The runner (`src/lib/session/`, `src/app/`) runs the legs; L1
     (`src/lib/conversation/Conversation.ts`) folds each leg's events into segments
   - Local Native is the exception until kizuna-ai-lab/sokuji#578: `LocalNativeClient`
     implements the old `IClient` (`src/services/interfaces/IClient.ts`), registered as
     `LocalNativeProviderConfig` in `ProviderConfigFactory`, built through `ClientFactory`,
     and set up in the old settings shell (`ProviderSection`, `LanguageSection`,
     `ProviderSpecificSettings`), which nothing mounts;
     `src/providers/oldPath.consistency.test.ts` keeps every other file off that path.
     Its folders (`src/services/{clients,providers,interfaces}/`) also hold four shared
     leaves the new code takes — `ProviderConfig` (`LanguageOption`, `VoiceOption`),
     `astGuard`, `tutorialUrls` and `ISettingsService`, the guard's `SHARED` set — which
     stay or move when #578 lands; they are not Local Native's to delete

3. **Audio Processing Pipeline**
   ```
   Source (microphone, system audio, a tab) → runner → provider's adapter → L1 → playback → outputs
   ```
   - `ModernAudioRecorder` (`src/lib/modern-audio/`): captures the microphone with echo
     cancellation and noise suppression, AudioWorklet with a ScriptProcessor fallback
   - Playback (`src/lib/audio/playback.ts`): a clip queue per leg and one for replay, the
     routes kept live from the routing settings, the passthrough stream
   - `src/lib/audio/appAudio.ts`: one graph per page, and the virtual output per platform
     (Electron's virtual speaker, the extension's tabs, nothing on the web)

4. **State Management**
   - Zustand stores in `src/stores/`, with `subscribeWithSelector`: `settingsStore.ts` (common
     settings and Local Native's old slice), `providerStore.ts`, `sessionStore.ts` (the locked
     mode the kept old settings shell reads; nothing writes it), `audioStore.ts`, `logStore.ts`
   - React Context for UserProfileContext and PostHogContext

5. **Audio** (`src/lib/audio/`)
   - The runner's sources (`capture/`): the microphone (`mic.ts`, over `ModernAudioRecorder`)
     and system audio, each following its device or source during a run; a tab, fixed
     when it opens
   - The page's playback (`appAudio.ts`, `playback.ts`), the routing read live from
     `audioStore`, `routingStore` and `turnModeStore`

6. **Native runtime (`native/`)**
   - Upstream's sidecar stack, behind Local Native, which no Kotomimi release offers
     (`VITE_ENABLE_LOCAL_NATIVE` unset; the fork's `native-build` and `sidecar-bundles`
     workflows are disabled). The engines Kotomimi ships are others: `docs/fork/native-engines.md`.
   - One CMake super-project builds transcribe.cpp (ASR), llama.cpp (translation) and audio.cpp
     (TTS, nine families) on ONE pristine upstream ggml behind the `sk_*` C ABI
     (`native/include/sokuji_native.h`). `sokuji_sidecar/native.py` is the sidecar's one door
     in; `asr_backend.py`/`translate_backend.py`/`tts_backend.py` are what the catalog and
     engines talk to. Build, layout, stages, gates: `native/README.md`.
   - Two patch mechanisms keep three upstreams building on one ggml: `src/audiocpp_compat.h`
     (re-scan it on every ggml pin bump) and `native/patches/*.json`, exact-text patches that
     fail the build loudly when a pin moves.
   - Versions: native's in `CMakeLists.txt` and the `sk_version()` literal in
     `tests/test_common.cpp`, tag `native-vX.Y.Z`; the sidecar's in root `package.json`'s
     `sidecarVersion`, tag `sidecar-vX.Y.Z`; both publish as prereleases, never "latest". Order
     is fixed: native tag first, then `sidecar/requirements.txt`'s wheel URLs,
     `sidecar/tests/test_runtime_gate.py` and `sidecarVersion` in ONE commit, then the sidecar
     tag on that commit. Current native version is 1.2.0 (ABI 2).
   - Everything this bullet used to hold (SKUs, tiers, voice rules, thread policy, known gaps):
     `git show 62ef6af27:CLAUDE.md`.

7. **LAN caption sharing** (spec: `docs/superpowers/specs/2026-10-04-lan-caption-sharing-design.md`)
   - Desktop only. `src/lib/share/publisher.ts` mirrors the conversation view (reset by
     `ConversationSet.onReset`) over IPC to `electron/caption-share.js`, which runs a Node
     `http` server (`caption-share-server.js`, ports 7788–7797) pushing SSE to viewers.
   - The viewer and projector pages are the second Vite input `viewer.html` (`src/viewer/`):
     strings are the `viewer` subtree of each catalog, compiled in through the generated
     `src/viewer/strings.generated.ts` (`node scripts/gen-viewer-strings.mjs` after editing any
     `viewer.*` string; a test fails on drift); they load nothing from another origin and never
     import analytics. `scripts/check-viewer-bundle.mjs` checks a build, and
     `scripts/dev/caption-share-demo.mjs` serves a build with sample captions for a look.
   - Nothing about sharing is persisted; the host panel is `src/components/CaptionShare/`.

## Important Patterns and Conventions

### Code Organization
- `src/components/` - Functional React components with TypeScript
- `src/stores/` - Zustand state management stores
- `src/providers/<id>/` - One folder per provider: definition, adapter, `Settings` view
- `src/lib/contract/`, `src/lib/provider/`, `src/lib/session/` - The client contract, the
  definition's types, the runner
- `src/services/` - The settings service; Local Native's old path and the shared leaves (above)
- `src/lib/audio/` - The runner's sources (`capture/`) and the page's playback
- `src/lib/modern-audio/` - The recorders and the echo monitor
- `src/utils/` - Shared utilities including environment detection
- `src/contexts/` - React Context providers

### Error Handling

All API calls are wrapped in try-catch, and features degrade gracefully when
unavailable. Where a caught failure is *recorded* is decided here, once, rather
than at each call site:

**Record it with `reportError` / `reportWarning` from `src/lib/diagnostics/report.ts`,
never with `console.error` / `console.warn`.** One call writes both surfaces: the
console line fires synchronously with the raw `cause`, and a redacted one-sentence
message reaches LogsPanel one microtask later (only while diagnostic logs are on in
Help, off by default; English, pasted into bug reports). The deferral makes it safe
to call from any stack, including a Zustand getter React reaches during render.

```typescript
import { reportError, reportWarning, describeCause } from '../lib/diagnostics/report';

reportError('SettingsStore', `Failed to load settings: ${describeCause(error)}`, { cause: error });
reportWarning('AudioStore', 'No real microphone available', { dedupeKey: 'mic.missing' });
```

- **Severity.** `error` = what the user asked for did not happen. `warning` = it
  happened or will (a fallback ran, a retry is pending, state is in memory but
  unpersisted). `info` is not a failure — leave it on `console.info`.
- **The message is a string, always.** `Message<T>` rejects `any`, `unknown`,
  `string | undefined` and objects. The caught value goes in `cause`, which never
  leaves the console. Use `describeCause(err)` for one readable sentence.
- **`report()` never shows UI.** A failure the user must act on becomes state on
  the owning store and a component renders it; LogsPanel is never the surface a user
  relies on.
- **Don't record the same failure twice.** If it already reaches the panel by
  another route (an adapter's `failed` or `degraded` event, a start the runner
  reports, `validationMessage`, a provider's notices), add nothing.
- **Inside an adapter session** (`src/lib/contract/adapter.ts`), adapters never
  call `report()` and never `console.*` — only the runner knows which leg an
  adapter serves. Pick by what the failure did to the session:
  - `events.failed({ message, code?, cause? })` — the session is broken. L1 files
    an error notice on the leg, the run ends, and the runner tracks `api_error`.
  - `events.degraded({ code, message, cause? })` — the session continues,
    degraded. `code` comes from `CLIENT_DIAGNOSTICS`
    (`src/lib/diagnostics/clientDiagnostics.ts`), which also decides the severity;
    L1 files it once per window, and the runner tracks `api_error`.
  - `events.frame(...)` — wire traffic for the Logs panel, not a failure.
  - a `start()` that rejects (an `AdapterStartError` carries a notice code) — the
    session never started; the runner reports it once, for whichever leg it was.
  `src/providers/sessionSide.consistency.test.ts` holds every adapter's session side
  off the stores and the reporter, and its timers on the request's clock. Local
  Native's old `IClient` keeps the same rule through `handlers.onError`,
  `handlers.onDiagnostic` and `handlers.onRealtimeEvent`.
- **Hot paths** (per-audio-chunk, per-frame, per-poll-tick) never log per
  occurrence: return silently, or report the ok → failing transition. Bursts pass
  `dedupeKey`; the panel throttles per key on a 5s window.
- **Secrets are redacted at the sinks** (`logStore.addLog`, `sanitizeEvent`) from
  one list in `src/lib/diagnostics/redact.ts`, shared with PostHog error tracking.
- **Contexts that cannot import the store** — web workers, AudioWorklets,
  `extension/`, `electron/`, `sidecar/` — keep their existing message/IPC channel,
  and the renderer-side caller reports. They are outside this policy.
- **The ledger.** `src/lib/diagnostics/consoleLedger.consistency.test.ts` fails on any
  `console.error` / `console.warn` in `src/stores`, `src/services`, `src/contexts` or
  `src/providers`, and tracks the rest of `src/components`, `src/lib` and `shared/`
  file by file. Those counts are exact: removing a call means lowering its row in the
  same diff. Design: `docs/superpowers/specs/2026-08-25-diagnostics-reporting-design.md`.

### Platform-Specific Code
Use `isElectron()`, `isExtension()`, `isWeb()`, `getEnvironment()`, `getBackendUrl()` and `getApiUrl()` from `src/utils/environment.ts`.

### Zustand Store Patterns
Prefer the optimized selectors (`useUIMode()`, `useSetUIMode()`), which prevent re-renders; outside React, subscribe with a selector (`useSettingsStore.subscribe((s) => s.uiMode, fn)`).

### Audio Handling
- Capture through the runner's sources (`src/lib/audio/capture/`, the microphone over `ModernAudioRecorder`); play through `src/lib/audio/playback.ts`
- Passthrough: the microphone's processed voice, under the translation, into the meeting (the virtual output) on its own `passthrough` feed (`src/lib/audio/routes.ts`); off by default, its volume `audioStore`'s `realVoicePassthroughVolume`, default 0.2 — the settings show 20%, on a 0–60% slider
- Echo cancellation on by default, requesting the `'all'` mode (every sound the system plays, a meeting app's far end included — `AUDIO_CONSTRAINT_PROFILES` in `src/lib/config/performance.js`); Chromium 141+ grants it on Windows and macOS and falls back to `true` on Linux, an older browser reads the string as `true`, and `track.getSettings().echoCancellation` (logged at `begin()`) says which took effect. The Echo Cancellation control under Noise Suppression (`audioStore.echoCancellationMode`, `audio.echoCancellationMode`; Windows and macOS only) can ask for `true` instead ("Kotomimi only" — `fork.echoCancellationApp` —, or "Browser only" outside Electron): a loopback microphone such as BlackHole carries system playout, which `'all'` cancels to silence. A change mid-session reopens the microphone (`openMic`'s `follow`)

## Testing and Quality

- Vitest with jsdom; test files colocated (`*.test.tsx`); global setup in `src/setupTests.ts`
- TypeScript strict mode; English-only comments and docs; conventional commits; SASS

## Build Configuration

- Vite serves on port 5173 and builds to `build/`, with a relative base for Electron and the extension
- `VITE_BACKEND_URL`: Backend API URL (default: `https://sokuji.kizuna.ai`)
- `VITE_ENABLE_KIZUNA_AI`: Enable Kizuna AI provider in production (`true`/`false`)
- `VITE_ENABLED_PROVIDERS`: the comma-separated ids of the `flagged` providers a release
  offers (`enabledProviderIds` in `src/utils/environment.ts`, read by `isPresent`); no
  provider is flagged today
- `VITE_ENABLE_LOCAL_NATIVE`: Register Local Native in production builds; unset in releases.
  Tester's switch on a packaged Electron build: DevTools →
  `localStorage.setItem('debug:local-native', '1')` → restart; `removeItem` + restart hides it.
  Remove the switch with the gate when Local Native ships.

## Dependencies

- **zustand**, **@floating-ui/react**, **i18next & react-i18next**, **better-auth**, **lucide-react**
- **openai** (dev): the OpenAI SDK, for its realtime wire types and the socket
  `src/providers/openai/wire.oracle.test.ts` checks the hand-written wire against
- **@google/genai** (dev): the same for Gemini, `src/providers/gemini/wire.oracle.test.ts`
- **ws**: WebSocket client for the development wire probes (`scripts/dev/wire-probe/`)

### Internationalization
Complete translations in 30 locale catalogs (`src/locales/*/translation.json`). English and both Chinese are written by hand; after adding or rewording a string run `node scripts/translate-locales.mjs --model <name>` (Codex++ must be running), which fills the other 27 and keeps what it made in `scripts/locale-translations/`. `src/locales/translated.consistency.test.ts` fails on anything left in English.

## Common Development Tasks

### Adding a New AI Provider
What the spec's "What adding a provider then touches" lists
(`docs/superpowers/specs/2026-09-22-client-contract-design.md`), as the Stage 2 ports landed:
1. One folder, `src/providers/<id>/`: `provider.ts` (the definition, typed by
   `src/lib/provider/types.ts`: settings with their defaults — and `legacyKeys`/`migrate`
   when it reads keys an older build stored — credentials, languages, `check`,
   `session`), `adapter.ts` (the L0 client, `src/lib/contract/adapter.ts`, passing the
   conformance suite `src/lib/contract/conformance.ts`), its `Settings` view, and tests.
2. One line in `src/providers/registry.ts`, whose order is the picker's, and the order
   tests: `registry.test.ts` pins the whole list, and a neighbour's `provider.test.ts`
   may pin its place. `src/providers/sessionSide.consistency.test.ts` walks every
   `src/providers/*` folder; pin its session side there, as the ports did.
3. `providers.<id>.name` and `.description` in the 30 locale catalogs — or under the
   definition's `i18nKey` where the catalogs already spell it otherwise — only when new.
4. The extension manifest, when it uses a host the manifest does not list yet: MV3
   declares hosts statically (`host_permissions`, and the CSP's `connect-src`).
5. When it is flagged, its id in `VITE_ENABLED_PROVIDERS` at release.
`registry.test.ts`'s invariants fail loudly on anything missed. Local Native is the
exception until kizuna-ai-lab/sokuji#578.

### Adding a native model or TTS family
Upstream's sidecar catalog (`sidecar/sokuji_sidecar/catalog.py`), which Kotomimi does not release. The step-by-step recipes for an ASR model, an ASR architecture, a translation model, a TTS family and a quant rung: `git show 62ef6af27:CLAUDE.md`. If prose and code disagree, the code wins.

### Modifying Audio Pipeline
Test with both regular and passthrough audio, confirm echo cancellation, handle browser security restrictions and permissions, and test the AudioWorklet and ScriptProcessor paths.

### Debugging Audio Issues
- Check the DevTools console, device permissions and the audio context state (suspended/running)
- Monitor LogsPanel, and the AudioWorklet/ScriptProcessor callbacks
- Infinite loops in device switching: use `selectedInputDevice?.deviceId` in React dependencies, not the device object

### Dynamic Audio Device Switching
The microphone source (`openMic`, `src/lib/audio/capture/mic.ts`) reads its device and noise suppression live (`MicSettings`, bound to `audioStore` in `src/lib/audio/appCapture.ts`); when the device changes it ends the recorder and begins it again without interrupting the session. A switch in flight finishes before the source stops; a switch that fails ends the source with its reason.

## UI Components

- **Settings** (`src/components/Settings/Settings.tsx`): one panel with three categories, General, Audio and Provider (`AdvancedSettings.tsx`); `NAVIGATION_TAB_MAP` says which category a deep link opens
- **MainPanel**: Unified conversation panel with `uiMode`-driven layout (basic: status footer, advanced: waveform footer with controls)
- **Tooltip**: @floating-ui/react powered tooltips
- **ConnectionStatus**: Real-time connection state indicator

### UI Design System
- Two schemes, dark (the default, R1) and light, and an Appearance setting in Help
  (`settings.common.theme`: `system` | `light` | `dark`). Spec:
  `docs/superpowers/specs/2026-10-22-light-theme-design.md`.
- Every chrome colour is a `--sk-*` custom property that `src/styles/theme.scss` defines once
  per scheme (dark on `:root`, light on `:root[data-theme="light"]`); `src/lib/theme/theme.ts`
  resolves the setting (and the OS preference while it is `system`) and writes `data-theme` on
  every document the app owns, child-window popovers included; `public/theme-boot.js` paints the
  cached scheme before the first stylesheet. Components never write `var(--sk-…)`: they use the
  Sass aliases in `src/styles/_tokens.scss` (brand, people, status) and
  `src/components/Settings/shared/_variables.scss` (surfaces, text, lines, overlays), and a tint
  is `color-mix(in srgb, $token N%, transparent)`, never Sass's `rgba($token, a)` (a `var()` is not
  a colour). TypeScript that must name a colour (an icon prop, a canvas) uses `var(--sk-…)`.
- A user-coloured surface (the conversation, the subtitle view) keeps the user's colours in both
  schemes and carries `data-tone` from its own background (`toneOf` in `src/lib/view/tone.ts`);
  `theme.scss` repeats the token set under `[data-tone]`, so the palette inside follows the
  surface, not the app. A conversation colour the user never set is `null` in
  `conversationDisplayStore` and follows the scheme (`CONVERSATION_SCHEME_COLOURS`,
  `useConversationColours`, over `useScheme` in `src/lib/theme/`); the display popover's first
  chip in each conversation row is "Follow theme". The subtitle's defaults are fixed.
- Guards: `src/styles/theme.consistency.test.ts` (the four blocks agree, the dark block is pinned,
  the light block clears the contrast floors, every `--sk-` a stylesheet references is defined) and
  `src/styles/colourLedger.consistency.test.ts` (an exact count of colour literals per file; the
  allow-list is brand marks, the user colour presets and defaults, the viewer and the dev
  previews). Light accent `#007255` as a fill and `#006d51` as text; dark accent `#0fbb8f`; error `#e74c3c` / `#ad3327`. Light status text also clears 4.5:1 on its own 10–15% tint.
- Lucide React icons with consistent sizing (14-16px); component styles in colocated SCSS files

## Platform Requirements

- Electron app: Windows, macOS, Linux; Node.js LTS; Electron 34+; virtual audio devices need Linux with PulseAudio or PipeWire
- Browser extension: Chrome/Edge/Chromium 116+, Manifest V3, side panel API, content scripts for meeting platforms

## Extension-Specific Information

### Adding a Supported Meeting Platform
1. Add one row to `extension/platforms.ts` (`PLATFORMS`): hostname, matchPattern
   `https://<host>/*`, contentProfile (`standard` | `jitsi` | `zoom`), displayName,
   shortName, icon (base64), and — if applicable — group/groupLabel, guidanceKey, pluginKey.
2. If the platform needs a site plugin, add its plugin object to `site-plugins.js`
   and register the key in that file's `PLUGIN_BY_KEY` **and** `HOST_TO_PLUGIN_KEY`
   (this one map can't be generated — `site-plugins.js` runs in the page's MAIN
   world and can't see the isolated-world registry global; a consistency test
   parses the file and fails loudly if it drifts from the registry).
3. Add `<guidanceKey>Title` / `<guidanceKey>Guidance` to `_locales/*/messages.json`.
4. `manifest.json` stays hand-authored but is pinned by `extension/manifest.consistency.test.ts`
   against `deriveContentScripts()` / `deriveSubtitleWebAccessibleMatches()` — update its
   content_scripts and subtitle web_accessible_resources matches to match, or the test fails.

popup, the subtitle overlay surface, background.js, and content.js's guidance lookup all
derive from the registry automatically.

### Security Policy
Strict CSP for extension pages; connections allowed to the AI provider APIs (OpenAI, Google, Doubao, Qwen, Soniox, Palabra, Kizuna AI); PostHog analytics.

## Authentication and API Key Management

- User-managed keys: OpenAI (Realtime, Translate, Live), Gemini, Doubao AST 2.0, Qwen LiveTranslate, Soniox, Palabra AI
- Backend-managed keys: Kizuna AI, through Better Auth (`src/lib/auth-client.ts`, `src/lib/auth/`)

Kizuna AI's flow: the managed provider (`src/providers/soniox/kizuna.ts`) asks for the sign-in in place of a key, and for the balance floor its budget sets. At Start its lease (`src/providers/soniox/lease.ts`) buys the session's keys from the backend, one per stream; the run ends when the grant does, and the lease tells the backend when the session is over. It is offered where `isKizunaAIEnabled()` holds: every development build, and a release built with `VITE_ENABLE_KIZUNA_AI=true`.
