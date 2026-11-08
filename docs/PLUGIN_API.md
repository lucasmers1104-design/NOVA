# Plugin API

Plugins add pages, dashboard widgets and accent colors to NOVA. They are web files in a sandbox: no native code, no access to NOVA's commands, the file system, the network or other plugins, except what a permission grants and NOVA's Rust side checks on every call.

The code lives in `src-tauri/src/plugins.rs` and `src/features/plugins/`. Working examples: `examples/plugins/system-pulse` (a widget) and `examples/plugins/aurora-themes` (data only).

## Package

A `.novaplugin` file is a ZIP:

```
manifest.json      what the plugin is and asks for
payload/…          html, js, css, json, images, fonts; nothing executable
signature          minisign signature over the list of all files and their SHA-256 hashes
```

Build one with:

```bash
node scripts/package-plugin.mjs manifest.json payload --out my.novaplugin
```

Release builds of NOVA only install packages signed with a key they trust. The key is at `%USERPROFILE%\.nova\plugins\nova-plugins.key`, outside any repository. Back it up. Debug builds also accept unsigned packages (`--unsigned`) and mark them.

NOVA refuses paths that leave the package, links, other file types, more than 2,000 files, more than 60 MB unpacked and an unknown permission, before anything reaches the disk.

## Manifest

```json
{
  "id": "dev.example.ticker",
  "name": "Ticker",
  "version": "1.2.0",
  "description": "Prices at a glance.",
  "author": "Example",
  "apiVersion": 1,
  "minNovaVersion": "1.10.1",
  "maxNovaVersion": "2.0.0",
  "channel": "public",
  "entry": "index.html",
  "permissions": [
    { "type": "network", "hosts": ["api.example.com"] },
    { "type": "storage", "quotaKb": 256 }
  ],
  "contributes": {
    "pages": [{ "id": "main", "title": "Ticker" }],
    "widgets": [{ "id": "price", "name": "Price", "description": "One price.", "w": 3, "h": 2 }],
    "themes": [{ "id": "green", "name": "Green", "accent": "#34d399" }]
  }
}
```

`entry` is needed for pages and widgets; a plugin with only themes has no code. The entry page learns what to show from `?view=page:<id>` or `?view=widget:<id>`.

## Permissions

The user sees them before installing and can turn each one off later on the Plugins page. An update that asks for something new shows that first; something the user turned off stays off.

| Permission | Grants | Methods |
| --- | --- | --- |
| `storage` (`quotaKb`) | Its own key/value data, deleted with the plugin | `storage.get`, `storage.set`, `storage.delete` |
| `network` (`hosts`) | HTTPS to exactly these public hosts, no redirects, carried out by Rust | `network.fetch` |
| `system.metrics` | CPU, memory and GPU load | `system.snapshot` |
| `developer.analytics` | NOVA's statistics; only signed plugins of the `private` channel, and only with a developer sign-in the server checks | `analytics.*` |
| `companion` | NOVA Companion: the phone connection, pairing, paired phones, the allowlist, the task log. Only plugins signed by NOVA, also in debug builds. Without such a plugin, installed, on and allowed, the phone connection doesn't run. The answer to “Pair this phone?” is never a plugin method: NOVA asks in its own window | `companion.*` |

There is deliberately no permission for files, process launch, the shell, credentials, the assistant or other plugins' data.

## Talking to NOVA

A plugin has no origin and no network (`connect-src 'none'`). It talks to the page around it by message:

```js
parent.postMessage({ nova: 1, ready: true }, "*");                    // within 30 seconds of starting
parent.postMessage({ nova: 1, id: 1, method: "storage.get", params: { key: "x" } }, "*");
addEventListener("message", ({ data }) => {
  // { nova: 1, id: 1, result } or { nova: 1, id: 1, error }
  // { nova: 1, event: "theme", data: { accent, accentText, accentSecondary, onAccent, reducedMotion } }
  // { nova: 1, event: "ping" }: answer with parent.postMessage({ nova: 1, pong: 1 }, "*")
});
```

A plugin that doesn't start or stops answering gets an error card; after three times it is turned off. Widgets only run while they are on screen. A page or widget should draw its own surfaces: a frame can't blur what's behind it. Set `:root { color-scheme: dark; }`, or the browser paints the frame white instead of transparent.

## Isolation

What keeps a plugin in, in layers:

- `<iframe sandbox="allow-scripts">`, also forced by a CSP `sandbox` header from the plugin protocol: no origin, no access to NOVA's DOM or storage.
- A strict CSP per response: scripts and styles only from the plugin's own files, `connect-src 'none'`, no `eval`, no frames, no forms.
- NOVA's own CSP: `frame-src http://novaplugin.localhost`, so a frame can't navigate itself anywhere else.
- `plugin_call` in Rust checks the plugin and its granted permission on every call. The plugin id comes from the host page, never from the message.

On Windows, wry injects Tauri's init scripts into every frame, so `window.__TAURI_INTERNALS__` exists inside a plugin. **That is known and tested:** no command gets through, because the IPC's `fetch` is blocked and its message channel isn't delivered from a subframe. `scripts/e2e/plugin-isolation.mjs` runs a hostile plugin against a build with the real CSP and counts what arrives outside. **Run it again after every Tauri or WebView2 update, and before any change to the CSP or the frame.**

```bash
node scripts/package-plugin.mjs scripts/e2e/hostile-plugin/manifest.json scripts/e2e/hostile-plugin/payload --out hostile.novaplugin --unsigned
```

```bash
node scripts/e2e/start-test-nova.mjs hostile.novaplugin
```

```bash
node scripts/e2e/plugin-isolation.mjs
```

Limits, measured: a plugin stuck in a loop stalled NOVA's window by about 110 ms, since the frame runs in its own process. It can still use a CPU core until it is turned off.

## Plugin list

Plugins → Available shows `releases/plugins/catalog.json`, next to `latest.json` on the update source. Each entry names a package in the same folder and its SHA-256; NOVA downloads only from there, compares the hash, then checks the signature and shows the install dialog as for a file. Debug builds read a local list from `NOVA_PLUGIN_CATALOG` (an absolute path).

Publishing a plugin (here NOVA Companion, whose source is `plugins/companion/`):

```bash
node scripts/package-plugin.mjs plugins/companion/manifest.json plugins/companion/payload --out releases/plugins/dev.nova.companion-1.0.0.novaplugin
```

```bash
node scripts/plugin-catalog.mjs plugins/companion/manifest.json releases/plugins/dev.nova.companion-1.0.0.novaplugin
```

Then commit and push `releases/plugins/`. A Rust test checks that every listed package matches its hash and installs as in a release build.

## Later
- Plugins contributing tools to NOVA AI. They would need the approval gates of the built-in tools.
- More permissions (`notifications`, `media.read`), once a plugin needs them.
