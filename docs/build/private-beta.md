# Private desktop beta

## Beta 4

`0.43.133-beta.4` adds VRCX friend-list CSV import to the personal glossary.
The importer accepts `UserID,DisplayName,Memo` files, including quoted commas
and line breaks. UserID values are retained as stable external identifiers, so
re-importing a list updates renamed friends without creating duplicate entries.
The settings panel also accepts the same CSV through a file picker or the
clipboard import action.

## Beta 3 follow-up

`0.43.133-beta.3` includes the muted gray-green selected-state palette, simplified
bilingual language controls, and log-only per-utterance transcription failures.
The Mac helper also fixes empty/punctuation-only bilingual candidates winning
against usable final text. See `docs/apple-speech-lan.md` for the audit scope and
remaining short-word language-attribution limitation.

Both packages were rebuilt from the current working tree on their target OS.
Existing beta profiles are retained; settings/authentication/browser-storage
snapshots are backed up before installation, and native model files are reused.
The Mac installation keeps the previous Beta 2 application in a separate backup.
Windows installation uses an external WMI-launched PowerShell 7 process, preserving
the normal installation directory and taskbar shortcut identity. Legacy Windows
PowerShell exited before executing the update script on this machine; do not
mistake a successful process-creation result for a completed installation.

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

### Windows installation repair after Beta 2

Independent diagnosis on 2026-10-30 confirmed that installation launched from
the Codex MSIX environment was redirected into its `LocalCache/Local/KotomimiBeta`
directory. The desktop shortcut and window icon metadata refer to the ordinary
`LocalAppData/KotomimiBeta` path. `CIM_DataFile`, queried through the external WMI
provider, finds the physical launcher and versioned executable but neither
logical path. The embedded icon is valid and the shortcut's AppUserModelID
matches the application. Supplying explicit icon metadata in Beta 2 did not
resolve the user's blank taskbar icon.

Node's `fs.realpathSync.native` resolves the physical path in this environment;
plain `fs.realpathSync` retains the redirected logical path. However, changing
only the launch target is insufficient: the current beta profile also resides
in `LocalCache/Roaming/kotomimi-beta`, and an Explorer launch can read a different
profile. A durable repair must install outside package virtualization and
preserve the current beta profile before switching launch context. Do not seed
from stable again or overwrite an existing destination profile. Verify the
taskbar icon and retained settings after launching from the desktop shortcut.

The PC installation was repaired on 2026-10-30 using a hidden PowerShell process
created through `Win32_Process.Create`, outside the Codex package context. A
read-only probe first confirmed the normal installation and profile directories
were absent. With Beta closed, the entire current profile was backed up under
`.dev/beta/windows-repair-20261030/profile-backup` and copied to normal Roaming
storage, excluding disposable caches and lock files. SHA-256 checks matched all
22 settings/authentication/IndexedDB files against both the backup and the
migrated profile. The existing Beta 2 installer then completed with exit code 0.

The old virtualized installation and profile were renamed with the suffix
`.before-normal-install-20261030` so they cannot shadow the repaired directories.
WMI now finds the normal launcher and profile. The regenerated desktop shortcut
points to that launcher for both its target and icon; launching this shortcut
produced a window whose executable path is outside `LocalCache`. The light
theme and language pair are present. The user confirmed that the BETA taskbar
icon is visible after this repair. Future installations must also run outside the
Codex package context; do not blindly launch the installer as a child of Codex.

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
