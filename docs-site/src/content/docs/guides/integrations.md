---
title: Integrations
description: Connect opencodex to OpenCode, Pi, Hermes, OpenClaw, Kimi Code and Gajae Code from the dashboard — one switch per client, with a backup taken before every write.
---

The **Integrations** tab writes opencodex's provider block into a client's own config
file, and removes it again. Six clients work this way, each with a switch:

| Client | Config file | Format | When the change takes effect | Credential |
|---|---|---|---|---|
| OpenCode | `~/.config/opencode/opencode.json` | JSON | next direct launch | `OPENCODEX_OPENCODE_API_KEY` |
| Pi | `~/.pi/agent/models.json` | JSON | new sessions | `OPENCODEX_API_KEY` |
| Hermes | `~/.hermes/config.yaml` | YAML | new sessions | `OPENCODEX_HERMES_API_KEY` |
| OpenClaw | `~/.openclaw/openclaw.json` | JSON5 | immediately, on a running gateway | `OPENCODEX_OPENCLAW_API_KEY` |
| Kimi Code | `~/.kimi-code/config.toml` | TOML | on restart, or `/reload` | loopback placeholder |
| Gajae Code | `~/.gjc/agent/models.yml` | YAML | new sessions, or when you open `/model` |`OPENCODEX_GAJAE_API_KEY` |

Paths honor each client's own environment override where it has one, so a relocated
`HERMES_HOME` or `KIMI_CODE_HOME` is followed rather than guessed at.

## The other four surfaces are not switches

**API Keys** manages opencodex's own credentials and is not a client at all. **Codex
CLI** is wired by the proxy service itself — starting opencodex applies it, stopping it
restores native routing — so there is nothing to toggle per-file. **Claude** keeps its
own enable flag and Desktop's Save/Apply flow, and **Grok Build** keeps its
select-then-apply model fence. Those semantics predate this feature and are unchanged.

## Rollback

Every successful write takes a snapshot of your file *first*, so the state you had is
always recoverable:

- **Undo** appears on the newest operation when your file still matches what we wrote.
- **Restore this point…** appears on older operations, or when the file changed after
  that operation. Restoring across such a change asks a second time before replacing
  your newer edits — and backs them up too, so that restore is itself undoable.
- Ten backups are kept per client. Beyond that, the oldest snapshot files are removed
  and their history rows read **Backup expired**.

Disable removes only the entries opencodex recorded as its own. If your file changed
after we wrote it, the switch locks and disable refuses rather than guessing which
edits were yours.

## What to expect, honestly

**Formatting is not preserved.** Applying parses your config and writes it back out, so
every format may be reformatted, and YAML, JSON5 and TOML additionally lose their
comments. Your settings survive — every value you had is still there and equal — but the
bytes change. If you need the file exactly as it was, use Restore rather than Disable:
the snapshot is a verbatim copy.

**Pi, Kimi Code and Gajae Code only work against a loopback bind.** None of their config
schemas has a place for the `x-opencodex-api-key` header that a non-loopback bind
requires, so a generated config would simply be rejected — and writing one by hand does
not help, because there is nowhere in the file to put the header either. Reaching a
remote opencodex from these clients is not supported directly; give them loopback access
instead, through an SSH tunnel or a local forwarder that adds the header.

**Kimi Code cannot hold an environment reference,** so its config carries an
`opencodex-loopback` placeholder rather than a key. No real credential is ever written
into any client config.

**For `ocx opencode`, the launcher's provider block wins.** That launcher injects
`provider.opencodex` through `OPENCODE_CONFIG_CONTENT`, which outranks the same entry on
disk — the rest of your opencode config still applies as usual. The switch here is what
matters when you launch `opencode` directly.

## From the terminal

The same operations are available headlessly:

```bash
ocx integration client status
ocx integration client enable --client hermes
ocx integration client disable --client hermes
ocx integration client history --client hermes
ocx integration client restore --op <opId> [--confirm-drift]
```

`--confirm-drift` is never assumed. If the file changed after the operation you are
restoring, the command refuses and tells you, because replacing your newer edits is your
decision to make.

Client details were verified against each project's own configuration format; see the
research notes in `devlog/_plan/260802_client_toggle_api/002_client_toggle_matrix.md`
for what was checked and when.
