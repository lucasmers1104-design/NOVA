# Releasing NOVA

## Versioning

The version lives in `package.json` (Tauri reads it via `"version": "../package.json"`) and in `src-tauri/Cargo.toml`. Bump both together, following semantic versioning, and add an entry to `CHANGELOG.md`.

## Pre-release checks

```bash
npm run check
```

This runs strict TypeScript, all frontend tests, `cargo check` and all Rust tests. Also run `cargo clippy --all-targets` in `src-tauri`; it is expected to be warning-free.

## Build the installer

```bash
npm run desktop:build
```

- Builds the frontend (`npm run build`), then an optimized Rust release binary (LTO, single codegen unit — expect 15–30 minutes on a dual-core laptop).
- Produces `src-tauri/target/release/bundle/nsis/NOVA_<version>_x64-setup.exe`.
- On first use the Tauri bundler downloads the NSIS toolchain from Tauri's official release repository.

## Clean-machine test

1. Copy the setup `.exe` to a Windows 10/11 machine without NOVA, and run it. WebView2 is present on current Windows; the installer bootstraps it otherwise.
2. Launch NOVA from the Start menu and check:
   - Home shows live CPU/memory; Customize can move and resize widgets.
   - System lists processes; Apps launches an app; Productivity saves a task across a restart.
   - Settings → Privacy lists no external connections until you set any up.
3. Uninstall from Windows Settings. The local database in `%APPDATA%\dev.nova.commandcenter` is kept, so reinstalling restores your data; delete that folder to remove all data.

## Code signing

The installer is unsigned, so Windows SmartScreen will warn on first run. For public distribution, sign `nova.exe` and the installer with an Authenticode certificate (`bundle.windows.certificateThumbprint` in `tauri.conf.json`).
