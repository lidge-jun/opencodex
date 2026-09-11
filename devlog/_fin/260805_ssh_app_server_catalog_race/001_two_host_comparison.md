# 001 — Two SSH hosts, same software, opposite pickers

The user's decisive observation: *"본 머신의 ssh는 잘 작동하거든"* — the Codex App
on this Mac opens an SSH workspace on `macbookpro-2` and shows routed models
fine, while the SSH workspace on `suji` shows only native `gpt-*` entries. Same
app, same client. Any root cause that does not explain **that asymmetry** is the
wrong root cause.

## What is identical on both hosts

Measured 2026-08-05, both reachable over Tailscale SSH:

| | `suji` (broken) | `macbookpro-2` (working) |
|---|---|---|
| opencodex | 2.10.0 | 2.10.0 |
| SSH-session `codex` | 0.146.0 | 0.146.0 |
| `openai_base_url` | `http://127.0.0.1:10100/v1` | same |
| `model_catalog_json` | present, absolute | present, absolute |
| `model` root key | `anthropic/claude-opus-5` | `anthropic/claude-opus-5` |
| Routed entries in catalog | present, `visibility: "list"` | present, `visibility: "list"` |
| Routed entries in `models_cache.json` | present (11 rows) | present (39 rows) |
| `models_cache` sentinel stamp | `0.0.0` / `2000-01-01` | `0.0.0` / `2000-01-01` |
| `control socket is already in use` in app-server log | yes | **yes** |
| ChatGPT.app bundled `codex` | 0.146.0-alpha.9.2 | 0.147.0-alpha.1.2 |
| Routed model reachable via `codex exec` | yes (`FABLE_OK`) | n/a (not retested) |

Every disk-level and network-level check passes on the broken host. Note in
particular that the socket-collision error and the `0.0.0` cache sentinel appear
on **both** hosts — neither can be the discriminator, which is why `000` files
them under "not the cause".

## The one thing that differs

Process start time of the SSH `app-server`, relative to the catalog mtime:

```
suji           app-server --listen unix://   started 15:37:42
               ~/.codex/opencodex-catalog.json  mtime 15:42:09   <-- catalog is NEWER

macbookpro-2   app-server --listen unix://   started 14:09:10
               ~/.codex/opencodex-catalog.json  mtime 11:48:19   <-- app-server is NEWER
```

On the working host the app-server booted 2h21m *after* the last catalog write,
so it read the finished file. On the broken host the catalog was rewritten
4m27s *after* the app-server booted, so the app-server holds a list that no
longer exists on disk. The picker renders the in-memory list; every check we ran
reads the file. That is the entire discrepancy.

This is the same in-memory-vs-disk divergence as #476 and #857. What is new here
is the trigger: not a user-run `ocx sync`, but a **proxy restart**.

## What rewrote the catalog at 15:42

`~/.opencodex/service.log` on the broken host:

```
🛑 Shutting down opencodex proxy...
⚠️  Previous session (PID 47571) did not shut down cleanly. Codex state restored from journal.
🚀 opencodex proxy running on http://localhost:10100
[opencodex] Codex runtime: /Users/[USER]/.local/bin/codex (version=0.146.0, source=configured)
   + 2 models appended to Codex catalog (/Users/[USER]/.codex/opencodex-catalog.json)
```

Read the order literally: `proxy running on` is printed by
`src/server/index.ts:1100`, and `+ N models appended` by `src/codex/sync.ts:93`.
The catalog write happens **after** the listener is up, because `ocx start`
awaits `syncModelsToCodex(port)` at `src/cli/index.ts:319` — well past
`startServer()`. The listening socket is therefore not a safe signal that the
catalog has settled.

Note also the `+ 2 models appended` line: it appears on both hosts' logs
(`+ 29`, `+ 32` on the working one), so a catalog rewrite on every proxy start is
normal and expected. The race is not caused by anything unusual happening on
`suji`.

## Why an SSH workspace is the exposed surface

A local Codex App workspace and an SSH workspace differ in who owns the
app-server lifecycle:

- **Local:** the app spawns and supervises `ChatGPT.app/Contents/Resources/codex
  app-server`. Quitting and reopening the app restarts it.
- **SSH:** the app runs a bootstrap over the connection that `nohup`s
  `codex ... app-server --listen unix://` on the remote host, detached from the
  app (`ppid 1`). Reconnecting the workspace reuses the surviving process — the
  observed command line includes the `pkill -9 ... desktop-ssh-websocket-v0.sock`
  guard and `nohup ... &`, so it is explicitly built to outlive one connection.

So on a remote host the app-server routinely outlives both the app session and
the proxy restart, and there is no user-visible action that restarts it.
"Quit and reopen the app", the fix that works locally, does nothing here. This
matches the report in #851 (SSH workspaces specifically) and is why the same
defect is far more likely to be noticed over SSH than locally.

## Confirmation

On the broken host, with nothing else changed:

```
$ pkill -f "app-server --listen unix://"
$ rm -f ~/.codex/app-server-control/app-server-control.sock
```

The replacement app-server started at 15:37:42 → later re-verified at 15:42:16
against a 15:42:09 catalog, and the routed Anthropic models appeared in the
picker. The user confirmed: *"지금 잘 나와"*.

Note the socket removal was needed for a clean start (the previous process had
left the control socket bound), but per the table above it is not part of the
root cause — the healthy host logs the same collision.
