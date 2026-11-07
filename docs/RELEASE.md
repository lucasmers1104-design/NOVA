# Releasing NOVA

NOVA updates itself from a public GitHub repository. Every release is a signed NSIS installer in `releases/` plus a `releases/latest.json` manifest. Installed apps check that manifest at every start (also when started with Windows). When a newer version exists, they download it, verify its signature, close, update and reopen by themselves.

## One-time setup

1. **Signing key.** It lives outside the repository at `%USERPROFILE%\.nova\updater\nova-updater.key`; the public key is in `src-tauri/tauri.conf.json`.
   - **Back the private key up** (password manager or USB stick). Without it you can't sign updates, and existing installations can't update anymore.
   - The original key was lost with the first development PC, so 1.7.0 introduced the current one; versions before 1.7.0 have to install 1.7.0 by hand once.
   - Never commit it. To create a new pair: `npx tauri signer generate -w "%USERPROFILE%\.nova\updater\nova-updater.key"`. Installed apps keep trusting only the old public key until they are reinstalled.
2. **Public GitHub repository.** Create one, then connect and push:

   ```bash
   git remote add origin https://github.com/<owner>/<name>.git
   ```

   ```bash
   git push -u origin main
   ```

   It must be public: the app downloads `releases/` without logging in.
3. **Update source.** `DEFAULT_UPDATE_SOURCE` in `src/features/updates/store.ts` is `"lucasmers1104-design/NOVA"`, so installations from 1.2.0 on update out of the box. Version 1.1.0 had no default: enter `lucasmers1104-design/NOVA` once in Settings → Updates there.

## What stays out of this repository

This repository is public and every push reaches every installation. The statistics service and the private Developer Analytics plugin live in the private repository `nova-private`; `*.novaplugin` and `*.key` are ignored here, and `npm run release` stops if it finds one or anything named like the private plugin.

- **Plugin signing key:** `%USERPROFILE%\.nova\plugins\nova-plugins.key`, separate from the updater key. Back it up as well. Without it no new plugin can be signed; NOVA trusts the public key built into `src-tauri/src/plugins.rs`.
- **Usage statistics:** raise `CONSENT_SCOPE` in `src-tauri/src/telemetry.rs` when what is collected changes materially. Everyone is then asked again, and sending pauses until they answer. Keep the list in the popup, `PRIVACY_FACTS`, the README and the service's privacy page in step.

## Publishing a new version (e.g. 1.0.0 → 1.1.0)

1. Bump the version in `package.json` and `src-tauri/Cargo.toml`, and add a `## 1.1.0 — date` section to `CHANGELOG.md` (its bullets become the update notes).
2. Check: `npm run check`, plus `cargo clippy --all-targets` in `src-tauri`.
3. Build, sign and publish into `releases/`:

   ```bash
   npm run release
   ```

   The script reads the repository from the `origin` remote, or takes `--repo owner/name`. It writes `releases/NOVA_<version>_x64-setup.exe`, its `.sig` and `latest.json`. The optimized build takes 5–15 minutes.
4. Commit and push:

   ```bash
   git add -A
   ```

   ```bash
   git commit -m "Release 1.1.0"
   ```

   ```bash
   git push
   ```

   Within a minute or two, every NOVA with automatic updates on picks it up at its next start (or via Settings → Updates → Check now).

To refresh only `latest.json` (for example after creating the GitHub repository), run `npm run release -- --repo owner/name --skip-build`.

## Installing on another PC

Open the repository on GitHub, then `releases/` → `NOVA_<version>_x64-setup.exe` → **Download raw file**, and run it. The installer is unsigned, so Windows SmartScreen asks for confirmation the first time ("More info" → "Run anyway").

## Testing updates locally

`npm run release -- --local-test --base-url http://127.0.0.1:8765 --out <folder>` builds a variant that also accepts a plain-http server on localhost. Install it, publish a higher version into a folder served on port 8765, and set Settings → Updates → source to `http://127.0.0.1:8765/latest.json`. Production builds only ever accept HTTPS sources.
