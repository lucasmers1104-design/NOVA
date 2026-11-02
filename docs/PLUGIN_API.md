# Plugin & Agent API — Design

Status: design only. NOVA 1.0 runs exclusively its own built-in widgets and has no agent tools. This document fixes the security model before any third-party code can run.

## Goals

- Community widgets and data sources without giving them access to NOVA, the file system or the network by default.
- Every capability is declared up front, shown to the user, and granted per plugin.
- A misbehaving plugin can't crash, slow down or read data from NOVA or other plugins.

## Packaging

A plugin is a signed `.novaplugin` archive:

```
manifest.json        id, name, version, author, entry, permissions[], widgets[]
widget.html          entry document (no remote scripts)
assets/…             static files
signature            detached signature over the archive hash
```

```json
{
  "id": "com.example.crypto-ticker",
  "version": "1.2.0",
  "entry": "widget.html",
  "permissions": [
    { "type": "network", "hosts": ["api.coingecko.com"] },
    { "type": "storage", "quotaKb": 256 }
  ],
  "widgets": [{ "id": "ticker", "name": "Crypto ticker", "defaultSize": { "w": 4, "h": 2 }, "configSchema": [] }]
}
```

## Isolation

- Each widget renders in a sandboxed `<iframe sandbox="allow-scripts">` served from a per-plugin custom protocol (`novaplugin://<id>/`). It has an opaque origin and no access to NOVA's DOM, storage or IPC.
- A strict per-plugin CSP is generated from the manifest: `connect-src` lists only the declared hosts; there is no `eval` and no remote scripts.
- Communication goes through `postMessage` only, via a typed broker in NOVA that checks each request against granted permissions.
- CPU and memory: the iframe is unloaded when off-screen, and runaway frames are throttled and reported.

## Permissions

| Permission | Grants | Broker API |
| --- | --- | --- |
| `network` (hosts) | HTTPS requests to listed hosts, executed by Rust | `nova.fetch(url, init)` |
| `storage` (quota) | Private key/value store | `nova.storage.get/set` |
| `system.metrics` | Read-only CPU/memory/GPU snapshot | `nova.system.snapshot()` |
| `media.read` | Now-playing metadata | `nova.media.state()` |
| `notifications` | Post to the notification center (rate-limited) | `nova.notify(title, body)` |

There is deliberately no permission for files, process launch, shell, credentials or other plugins' data.

The user sees the permission list at install time and can revoke any permission later in Settings → Plugins. Updates that add permissions require a fresh consent.

## Agents

NOVA AI may later run multi-step agents. The model is the same: tools are capabilities, not code.

- **Agent profiles** define the model, a system prompt and an allowlist of tools.
- **Tools** are Rust-implemented actions with typed inputs: `tasks.create`, `notes.search`, `apps.launch`, `files.search`, `weather.today`.
- **Approval gates:** any tool that changes data, launches a program or contacts an external service pauses the run and shows the exact action (tool, arguments, target) for explicit approval. Approval is per action and never remembered across runs.
- **Read-only tools** (search, list, read metrics) can be pre-approved per profile.
- **Progress & logs:** every step (prompt, tool call, arguments, result, approval decision) is written to an execution log stored locally and shown live.
- **Files:** agents never receive file contents unless the user selects specific files for that run and confirms sending them.
