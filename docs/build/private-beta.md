# Private desktop beta

## Beta 2 UI follow-up

`0.43.133-beta.2` retains the existing beta profile. It supplies explicit Windows
taskbar relaunch/icon metadata and keeps the native window title as Kotomimi Beta.
Light-theme selected rows and VRChat options use the shared selection palette;
the session-lock notice uses neutral status colors. Switch endpoints derive from
track geometry. Chromium's custom scrollbars no longer switch to native scrollbars
on hover, and the conversation area reserves scrollbar space.

Validation: 105 focused tests passed, including three save/reload tests for the
bilingual speaker preference. A fixture compiled from production SCSS verified
selection colors, scrollbar geometry on hover, and switch endpoints at 100%,
125%, and 150% zoom. Reduced-motion checks confirmed zero-duration switch
transitions. The fixture does not replace live conversation testing.

`npm run make:beta` builds a local `X.Y.Z-beta.1` package from the stable version
in `package.json`. Set `KOTOMIMI_BETA_VERSION=X.Y.Z-beta.N` for subsequent builds.
Build on the target OS. Windows requires the Visual Studio C++ build tools;
Apple Speech requires the macOS 26 SDK. No upload or release publication occurs.

The Windows build uses Forge and Squirrel. The Mac build uses electron-builder
and produces an Apple Silicon ZIP. Outputs are under `out/make/squirrel.windows/x64`
and `out/beta-mac` respectively. Mac builds default to a local ad-hoc signature;
set `CSC_NAME` only when an accessible signing certificate is available.

## Installation identity

| Property | Stable | Beta |
| --- | --- | --- |
| Display name | Kotomimi | Kotomimi Beta |
| Windows install directory | `%LOCALAPPDATA%/Kotomimi` | `%LOCALAPPDATA%/KotomimiBeta` |
| Windows executable | `kotomimi.exe` | `kotomimi-beta.exe` |
| Mac application | `/Applications/Kotomimi.app` | `/Applications/Kotomimi Beta.app` |
| Mac bundle identifier | `io.github.rizumu85.kotomimi` | `io.github.rizumu85.kotomimi.beta` |
| Profile directory name | `kotomimi` | `kotomimi-beta` |

The beta icon includes a BETA badge. The beta establishes its profile before
loading persistent-store modules. It has a separate single-instance lock and
blocks stable update checks, downloads, and installs. Stable packaging keeps its
existing version and identity.

## Seed personal settings

Close the stable app, then copy its `Local Storage`, `IndexedDB`, `Local State`,
`Preferences`, `_better_auth` (when present), and the three `native-*` model
directories to a new beta profile on the **same machine**, before the beta's
first launch. Do not overwrite an existing beta profile. Omit database `LOCK`
files and native engine transient `run.json`, `server.json`, logs, and partial
downloads. Preserve LevelDB `.log` files in the browser storage directories.

Profile roots are `%APPDATA%` on Windows and `~/Library/Application Support` on
macOS. Make independent copies, not symbolic links or hard links. Model files
can require several gigabytes of additional storage. Personal data is never
included in the installer or committed to the repository.

Settings are a snapshot, not live synchronization. Device selections stay local
to their original machine. First-launch OS permissions may need to be granted
to the beta. Quit stable while testing beta if both would use the same audio
devices or LAN sharing port.

## Verification for 0.43.133-beta.1

- Windows installer and installed ASAR identify `kotomimi-beta`, version
  `0.43.133-beta.1`; the running renderer uses `Roaming/kotomimi-beta`.
- macOS application passes `codesign --verify --deep --strict`, identifies the
  beta bundle and version, and starts from `/Applications/Kotomimi Beta.app`.
- The installed Mac beta serves its copied LAN sharing configuration and lists
  the existing models, including Apple Speech's `bilingual` capability.
- Windows startup was visually checked with the copied light theme, language
  pair, fonts, VRChat settings, and an active conversation.
- 32 focused tests pass, covering private beta update isolation, existing
  update payload/download behavior, tray behavior, and microphone entitlements.
- This verifies packaging and startup. User testing still determines live audio
  quality and usability under the user's normal conversation conditions.
