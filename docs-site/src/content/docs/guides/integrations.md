---
title: Integrations
description: Connect opencodex to OpenCode, Pi, OMP, Hermes, OpenClaw, Kimi Code, Gajae Code, DeepSeek Harness, MiniMax Code, ZCode, Prime Agent and Aside from the dashboard — one switch per client, with a backup taken before every write.
---

The **Integrations** tab writes opencodex's provider block into a client's own config
file, and removes it again. Twelve clients work this way, each with a switch:

| Client | Config file | Format | When the change takes effect | Credential |
|---|---|---|---|---|
| OpenCode | `~/.config/opencode/opencode.json` | JSON | next direct launch | `OPENCODEX_OPENCODE_API_KEY` |
| Pi | `~/.pi/agent/models.json` | JSON | new sessions | loopback placeholder |
| OMP | `~/.omp/agent/models.yml` | YAML | after restarting OMP | `opencodex-loopback` placeholder |
| Hermes | `~/.hermes/config.yaml` | YAML | new sessions | `OPENCODEX_HERMES_API_KEY` |
| OpenClaw | `~/.openclaw/openclaw.json` | JSON5 | immediately, on a running gateway | `OPENCODEX_OPENCLAW_API_KEY` |
| Kimi Code | `~/.kimi-code/config.toml` | TOML | on restart, or `/reload` | loopback placeholder |
| Gajae Code | `~/.gjc/agent/models.yml` | YAML | new sessions, or when you open `/model` |`OPENCODEX_GAJAE_API_KEY` |
| DeepSeek Harness (DSH) | `$DSH_HOME/settings.yaml` (default `~/.dsh/settings.yaml`) | YAML | hot reload | non-secret loopback bearer placeholder |
| MiniMax Code | `~/.minimax/config.yaml` | YAML | new sessions, or after opening the model picker | loopback placeholder |
| Prime Agent | `~/.prime/agent/models.json` | JSON | new sessions | loopback placeholder |
| ZCode | `~/.zcode/v2/config.json` | JSON | on restart | loopback placeholder |
| Aside | `~/.aside/u/<account>/models.json` | JSON | after fully quitting and reopening Aside | loopback placeholder |

The managed OpenCode integration owns two fragments: `provider.opencodex` (opencode V1) and
`providers.opencodex` (opencode V2). Only the V2 block carries the per-model reasoning-effort
variants, so both are written and kept in sync; they name the same provider and model ids, and
opencode V2 merges them into one provider entry. Apply, Refresh, Disable, and Restore act on both
fragments, and your other providers, agents, keybinds, and MCP entries stay untouched.

Managed DSH support has a compatibility floor of **DSH 0.1.0-rc.6**. OpenCodex owns only
`llm-pi-ai.providers.opencodex`; Apply and Refresh replace that fragment, Disable removes only that
fragment, and Restore puts back a recorded snapshot. DSH hot reloads provider changes. These
operations do not change the user's default model or the native `deepseek-official` provider.
The managed DSH integration is currently loopback-only and never writes a real credential.

MiniMax Code follows `MINIMAX_DATA_DIR`, then `MAVIS_DATA_DIR`, before falling
back to `~/.minimax`. Its managed block owns only `custom_provider.opencodex`.
It does not change `defaultModel`, the selected MiniMax credential source, or
the user's MiniMax login. Choose a `custom_provider:opencodex/<provider/model>`
entry in MCode after connecting it. Refreshing the integration also refreshes
authoritative per-model context windows and reasoning-effort choices; unknown
capabilities are omitted, and MCode's session-owned current effort is preserved.

Prime Agent follows `PRIME_AGENT_CODING_AGENT_DIR` before falling back to
`~/.prime/agent`; a relative value is refused so the proxy and the agent cannot
disagree about which file is meant. Its managed block owns only
`providers.opencodex`, so other providers and any `modelOverrides` you have set
stay untouched. Prime Agent reads `models.json` when a session starts, so start
a new session after connecting it.

Aside is per-account: its state lives under `~/.aside/u/<account>/` and opencodex
writes the catalog of whichever account Aside's own `accounts.json` names as
current. If that manifest is missing or unreadable the integration refuses rather
than guessing an account, because a guess on a multi-account machine would write
into a different account's catalog. Its managed block owns only
`providers.opencodex`, so your other Aside providers stay untouched.

One caveat specific to Aside: the running app rewrites `models.json` itself, so
fully quit and reopen Aside after applying, the same way Claude Desktop needs a
restart. Aside's block is loopback-only and never carries a real credential.

Cursor has a tab but is not one of these switches. Regular Cursor calls custom endpoints from
its own backend, so a loopback proxy is unreachable without a public tunnel, and Cursor's
separate Private Inference build is configured inside Cursor. The **Cursor** tab is read-only:
it detects which build is installed, shows the Base URL and API Key to paste into Cursor, and
reports the last request Cursor made to the proxy. See
[Cursor Private Inference](/guides/cursor-private-inference/).

Paths honor each client's own environment override where it has one. For OMP,
`OMP_PROFILE` wins over `PI_PROFILE` by presence, even when explicitly empty. A named profile
uses `PI_CONFIG_DIR` as a directory name relative to the user's home and ignores `PI_CODING_AGENT_DIR`; without a named profile,
`PI_CODING_AGENT_DIR` wins. OMP supports provider-level headers, but this initial integration
is deliberately loopback-only; remote `x-opencodex-api-key` wiring is deferred. Relocated
`HERMES_HOME`, `KIMI_CODE_HOME`, and `XDG_CONFIG_HOME` paths are likewise followed rather than
guessed at. The table lists each client's default.

For native OpenAI models, the generated OMP block selects its model-level Responses API, preserving
image input and reasoning-effort controls. Routed models retain the provider's Chat Completions
dialect so their existing adapters remain compatible.

OpenClaw has several, and they do different jobs. `OPENCLAW_CONFIG_PATH` selects the
file; `OPENCLAW_STATE_DIR`, `OPENCLAW_PROFILE` and `OPENCLAW_HOME` select the state
directory, which is also what detection looks at — so a profile or relocated home
still reads as installed, while a config-path override moves only the file. If you
are still on the older `.clawdbot` layout, that is found too: the modern directory
wins when it exists, and the legacy one is used when it is the only one there.

These must be **absolute paths** or start with `~`. A relative one is refused rather
than resolved, because it would mean whatever directory each process happened to
start in — and that path is stored with the backup, so it has to name the same file
tomorrow as it did today.

opencodex reads these from its own environment. If your gateway runs with a profile
or a relocated home, start opencodex with the same variables set, or it will
correctly follow a different installation.

## The other five surfaces are not switches

**API Keys** manages opencodex's own credentials and is not a client at all. **Codex
CLI** is wired by the proxy service itself — starting opencodex applies it, stopping it
restores native routing — so there is nothing to toggle per-file. **Claude** keeps its
own enable flag and Desktop's Save/Apply flow, and **Grok Build** keeps its
select-then-apply model fence. Those semantics predate this feature and are unchanged.
**Cursor** writes nothing at all: its tab shows detection, the gateway values, and the last
request seen, and the rest happens inside Cursor Private Inference.

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
after we wrote it, what happens depends on whether our own entries are still intact
and on the file's format. For strict-JSON configs (OpenCode, Pi), an edit **next to**
our block — adding an MCP server, a provider of your own — shows as **Update needed**:
refreshing merges around your entries and keeps them, though formatting may be
normalized. The exception is something JSON cannot rewrite exactly — a non-finite
number like `1e999`, a number a rewrite would round (a very large integer, or one
so small it collapses to zero), `-0`, the same key written twice in one object, or nesting deeper
than 1000 levels — which locks the switch instead, so nothing is silently changed or dropped.
**OMP** is unaffected by sibling edits too, for a different reason: its writer
patches only its own `providers.opencodex` range byte-wise, so the rest of the
file is never rewritten. For the remaining formats that can carry comments
(Hermes, OpenClaw, Kimi Code, Gajae Code, MiniMax Code — YAML, JSON5 and TOML
written as whole documents), or
whenever our own entries were edited, the switch locks and disable refuses rather
than guessing which edits were yours.

That lock is no longer a dead end. A conflicted client shows **Replace** next to its
switch, on both the overview card and the client's own page. It replaces whatever
holds our settings with the block opencodex would write, and it asks first: the
dialog names the file, says what is lost, and points at the snapshot that makes it
undoable. The switch itself stays locked, because the switch cannot know which edits
you meant to keep — only you can say so. Nothing else is relaxed: a file we cannot
parse, or one whose structure we cannot reason about, still refuses.

## What to expect, honestly

**Formatting is generally not preserved.** Applying parses a config and writes it back
out, so JSON, JSON5 and TOML may be reformatted and comments in JSON5 or TOML are lost.
OMP and DSH are the exceptions: their YAML writers patch only `providers.opencodex` and
`llm-pi-ai.providers.opencodex`, respectively, preserving
unrelated provider comments and formatting byte-for-byte. If that exact source range
cannot be identified safely, the operation refuses instead. For other clients, use
Restore when you need the previous file bytes: the snapshot is a verbatim copy.

**If a value cannot be rewritten faithfully, the switch refuses instead.** The round
trip covers the value kinds these formats use in practice, and where it does not —
a TOML file using `inf` or `nan`, for instance, which the parser available to us
cannot read back accurately — applying stops and says so rather than writing a
changed value and calling it success. You will see the file named and nothing on
disk will have moved. Editing that file by hand still works; it is only our
automatic rewrite that declines.

**Pi, Kimi Code, Gajae Code, MiniMax Code, Prime Agent and the managed DSH integration only work against a loopback bind.**
The first four have no config field for the `x-opencodex-api-key` header a non-loopback bind
requires. DSH has a generic headers map, but rc.6 does not document that dedicated admission
header as a supported integration contract, so the managed writer fails closed instead of
guessing. Prime Agent's provider block does accept headers, but remote credential wiring is
deferred from its initial integration. Give them loopback access through an SSH tunnel or a local forwarder that adds the header.

**The generated OMP integration is also deliberately loopback-only.** OMP does support
provider-level headers, but this initial integration does not emit remote
`x-opencodex-api-key` credential wiring. Manual remote OMP configuration is outside the
managed integration for now.

**Kimi Code cannot hold an environment reference,** so its config carries an
`opencodex-loopback` placeholder rather than a key. No real credential is ever written
into any client config.

**For `ocx opencode`, the launcher's provider blocks win.** That launcher injects
`provider.opencodex` and `providers.opencodex` through `OPENCODE_CONFIG_CONTENT`, which
outranks the same entries on disk — the rest of your opencode config still applies as
usual. The switch here is what matters when you launch `opencode` directly.

## From the terminal

The same operations are available headlessly:

```bash
ocx integration client status
ocx integration client enable --client hermes
ocx integration client disable --client hermes
ocx integration client history --client hermes
ocx integration client restore --op <opId> [--confirm-drift]
```

`--overwrite-conflict` is the terminal form of **Replace**:

```bash
ocx integration client enable --client zcode --overwrite-conflict
```

Like `--confirm-drift`, it is never assumed — without it a conflict is still refused.
It applies only to `enable`; forcing a *disable* over a conflict would delete a block
we never wrote, so that combination is rejected.

For MiniMax Code, connect the provider once and launch through the checked wrapper:

```bash
ocx integration client enable --client mcode
ocx mcode
```

Once connected, `ocx sync` also refreshes the owned MCode block with current context
windows and reasoning-effort ladders. It leaves missing, foreign-edited, unsafe, and
never-owned blocks untouched; re-enable explicitly when you intend to reconnect one.

The separate MiniMax platform CLI (`mmx`) is not a file-toggle integration. Its text
commands use MiniMax's Anthropic-compatible endpoint, so OpenCodex provides a
credential-isolated, loopback-only launcher:

```bash
ocx mmx text chat --model anthropic/claude-opus-5 --message "Hello"
ocx mmx text repl --model openai/gpt-5.6-sol
```

Only `mmx text chat` and `mmx text repl` are proxied. Run plain `mmx` for
MiniMax-native image, video, speech, music, vision, search, quota, auth, config, file
and update commands. The wrapper uses a temporary config containing only a non-secret
loopback placeholder; it never loads your `~/.mmx` OAuth or API-key credentials, and
it refuses `--api-key`, `--base-url` and `--region` overrides. See
[MiniMax clients](/guides/minimax/) for the complete workflow and limits.

`--confirm-drift` is never assumed. If the file changed after the operation you are
restoring, the command refuses and tells you, because replacing your newer edits is your
decision to make.

Client details were verified against each project's own configuration format; see the
research notes in `devlog/_fin/260802_client_toggle_api/002_client_toggle_matrix.md`
for what was checked and when.
