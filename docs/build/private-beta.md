# Private desktop beta

A beta is a local build for the maintainer's own machines: it installs beside the stable
app, keeps its own profile, and is tested in real use before a stable release. Nothing is
uploaded or published.

## Build

`npm run make:beta` builds a local `X.Y.Z-beta.1` from the stable version in `package.json`.
Set `KOTOMIMI_BETA_VERSION=X.Y.Z-beta.N` for later builds. Build on the target OS: Windows
needs the Visual Studio C++ build tools, Apple Speech the macOS 26 SDK. The script builds
with the release workflow's `VITE_*` values.

The Windows build uses Forge and Squirrel and lands in `out/make/squirrel.windows/x64`. The
Mac build uses electron-builder, produces an Apple Silicon ZIP in `out/beta-mac`, and defaults
to a local ad-hoc signature; set `CSC_NAME` when a signing certificate is available.

## Installation identity

| Property | Stable | Beta |
| --- | --- | --- |
| Display name | Kotomimi | Kotomimi Beta |
| Windows install directory | `%LOCALAPPDATA%/Kotomimi` | `%LOCALAPPDATA%/KotomimiBeta` |
| Windows executable | `kotomimi.exe` | `kotomimi-beta.exe` |
| Mac application | `/Applications/Kotomimi.app` | `/Applications/Kotomimi Beta.app` |
| Mac bundle identifier | `io.github.rizumu85.kotomimi` | `io.github.rizumu85.kotomimi.beta` |
| Profile directory name | `kotomimi` | `kotomimi-beta` |

The beta icon carries a BETA badge. The beta sets its profile before loading any
persistent store, has its own single-instance lock, and blocks stable update checks,
downloads and installs. Stable packaging keeps its version and identity.

Quit stable while testing the beta if both would use the same audio devices or LAN
sharing port.

## Install

- **Windows:** run `Kotomimi Beta-<version> Setup.exe --silent`. Squirrel strips the dot, so
  the folder is `app-X.Y.Z-betaN`. Run it from an ordinary process: an installer started
  from an MSIX-packaged app such as Codex lands in that package's `LocalCache`, and so does
  the desktop shortcut.
- **Mac:** build on the Mac, check the app with `codesign --verify --deep --strict`, quit the
  running beta, keep the previous app in a backup rather than deleting it, move the new one
  to `/Applications`, and open it.

An update keeps the existing beta profile and its native models. Back up the profile's
`Local Storage`, `IndexedDB` and `Preferences` first if the build changes how they are read.

## Seed personal settings

Close stable, then copy its `Local Storage`, `IndexedDB`, `Local State`, `Preferences`,
`_better_auth` (when present) and the three `native-*` model directories to a new beta
profile on the **same machine**, before the beta's first launch. Do not overwrite an existing
beta profile. Omit database `LOCK` files and native engine transient `run.json`, `server.json`,
logs and partial downloads. Keep LevelDB `.log` files in the browser storage directories.

Profile roots are `%APPDATA%` on Windows and `~/Library/Application Support` on macOS. Make
independent copies, not links. Model files can take several gigabytes. Personal data is never
included in the installer or committed.

Settings are a snapshot, not live synchronization. Device selections stay local to their
machine, and first-launch OS permissions may need granting again.
