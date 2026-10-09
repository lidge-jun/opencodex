---
title: Integrations
description: Connect opencodex to OpenCode, Pi, OMP, Hermes, OpenClaw, Kimi Code, gjc, DeepSeek Harness, MiniMax Code, ZCode, Prime Agent, Aside, Raycast, omo, Cline CLI, Kilo, Command Code and Factory Droid from the dashboard — one switch per client, with a backup taken before every write.
---

The **Connect** page writes opencodex's provider block into a client's own config
file, and removes it again. Eighteen clients work this way, each with a switch:

| Client | Config file | Format | When the change takes effect | Credential |
|---|---|---|---|---|
| OpenCode | `~/.config/opencode/opencode.json` | JSON | next direct launch | `OPENCODEX_OPENCODE_API_KEY` |
| Pi | `~/.pi/agent/models.json` | JSON | new sessions | loopback placeholder |
| OMP | `~/.omp/agent/models.yml` | YAML | after restarting OMP | `opencodex-loopback` placeholder |
| Hermes | `~/.hermes/config.yaml` | YAML | new sessions | `OPENCODEX_HERMES_API_KEY` |
| OpenClaw | `~/.openclaw/openclaw.json` | JSON5 | immediately, on a running gateway | `OPENCODEX_OPENCLAW_API_KEY` |
| Kimi Code | `~/.kimi-code/config.toml` | TOML | on restart, or `/reload` | loopback placeholder |
| gjc | `~/.gjc/agent/models.yml` | YAML | new sessions, or when you open `/model` |non-secret loopback placeholder |
| DeepSeek Harness (DSH) | `$DSH_HOME/profiles/desktop/cordis.patch.yml` (default `~/.dsh/profiles/desktop/cordis.patch.yml`); `$DSH_HOME/settings.yaml` until DSH Desktop creates that profile | YAML | hot reload | non-secret loopback bearer placeholder |
| MiniMax Code | `~/.minimax/config.yaml` | YAML | new sessions, or after opening the model picker | loopback placeholder |
| Prime Agent | `~/.prime/agent/models.json` | JSON | new sessions | loopback placeholder |
| ZCode | `~/.zcode/v2/provider_config.json` (schemaVersion 1); legacy fallback: `~/.zcode/v2/config.json` | JSON | on restart | loopback placeholder |
| Aside | `~/.aside/u/<account>/models.json` | JSON | after fully quitting and reopening Aside | loopback placeholder |
| Raycast | `~/.config/raycast/ai/providers.yaml` | YAML | immediately on save — Raycast watches the file | none — loopback only |
| omo (Pi / senpi) | `~/.omo/agent/models.json` | JSON | new sessions | loopback placeholder |
| Cline CLI | `~/.cline/data/settings/providers.json` and sibling `models.json` | JSON pair | after stopping and restarting Cline | loopback placeholder |
| Kilo | first existing `kilo.jsonc`, `kilo.json`, `opencode.jsonc`, `opencode.json`, or `config.json` under `~/.config/kilo` | JSONC | new sessions | `OPENCODEX_KILO_API_KEY` |
| Command Code | `~/.commandcode/providers.json` (on Windows with the default home: use `HOME ?? USERPROFILE` only if nonblank and Windows-absolute, otherwise `homedir()`; a separately supplied home is preserved; append `.commandcode\providers.json`) | JSON | next launch of Command Code | none — keyless loopback (`apiKey: false`) |
| Factory Droid | `~/.factory/settings.json` (`%USERPROFILE%\.factory\settings.json` on Windows) | JSON | immediately via file watching | none — keyless loopback |

"omo" names three products that share the `~/.omo` folder. The **omo** tab manages Pi-based omo
(the senpi engine) through `~/.omo/agent/models.json`, as in the table above. Codex-based omo
(LazyCodex) gets its own section on the same tab, shown only when LazyCodex is detected, described in
[omo (Codex / LazyCodex) role models](#omo-codex--lazycodex-role-models). OpenCode-based omo
(oh-my-opencode) keeps its own config under OpenCode; opencodex does not read or write it.

Generated catalogs include only enabled models from each provider selection. This applies to both
downloads and managed integrations, including Pi and Aside. The management model list still shows
the full roster so you can enable additional models.

`ocx uninstall` disables recorded integrations, including all owned Aside profiles, before deleting
OpenCodex's recovery state. Unreadable ownership, missing profile registration or a conflicting edit
stops that deletion. Cleanup is sequential: earlier successful disables are not undone when a later
one fails. If compensation also fails, a client file may be left in an intermediate state. Inspect
the reported client files and retained recovery snapshots before retrying; retained state does not
mean every client was restored or left unchanged.

For Gajae built-in presets, keep the routing choice in `~/.gjc/agent/config.yml`:

```yaml
modelProfile:
  proxyProvider: opencodex
  proxyMode: always
```

Keep your chosen `modelProfile.default` to apply it when plain `gjc` starts. The managed integration owns only `providers.opencodex` in `models.yml`; refreshing or disabling that provider does not rewrite your preset choice. Refresh the integration after changing the exported model selection.

GJC models with a supported reasoning-effort ladder export `reasoning: true`, `thinking.levels`, and `compat.supportsReasoningEffort`, so GJC can offer an effort choice. Native Codex models receive their standard ladder even when the catalog omits it. Models without a known ladder omit these fields; `none` and `ultra` are not offered because `none` sends no effort and `ultra` folds to `max` on the wire. Refresh the integration to update these model options.

The managed OpenCode integration owns two fragments: `provider.opencodex` (opencode V1) and
`providers.opencodex` (opencode V2). Both carry the same declared per-model reasoning choices and
defaults — the legacy block spells a model's default in its options and its choices as a variant
map, the V2 block uses the model's settings and a native variant array — so both are written and
kept in sync; they name the same provider and model ids, and opencode V2 merges them into one
provider entry. Apply, Refresh, Disable, and Restore act on both fragments, and your other
providers, agents, keybinds, and MCP entries stay untouched.

Both fragments are built from the effective canonical model metadata — as are the Kilo export and
the `ocx opencode` launcher. An explicit custom override always wins, and a ladder you cleared to
empty stays empty; a reasoning ladder or default is never invented for a model that declares none.
An authoritative context limit is carried with an output budget beside it: a known output value —
explicit or from catalog metadata — wins, otherwise the schema-required 32000 fallback clamped to
the context, and without an authoritative context the whole limit block is omitted. Capabilities,
effort ladders, defaults, and an optional input limit appear only when known; the V2 block's
native capabilities object requires a known tools value, so when tool support is unknown it is
omitted entirely rather than written partially, and the legacy modality declarations stand.
"No ladder invented" still writes the controls, never choices: the V2 block always carries an
explicit variant array — empty when nothing is declared, because omitting it would make OpenCode
synthesize low/medium/high — and a model with known fixed reasoning but no adjustable ladder gets
disabled-only suppression instead of an effort: the legacy OpenCode block and Kilo both disable
every rung id the client would otherwise generate. Neither adds a selectable effort. The
selectable variants override the per-model
default — `none` included, offered only when the model's own declared ladder contains it. Whatever
the client selects, the proxy's pinned upstream reasoning policy still governs the request that
leaves it.

Managed DSH support has a compatibility floor of **DSH 0.1.0-rc.6**. DSH 0.1.7+ reads provider
routes from `[id=llm-pi-ai].config.providers.opencodex` in the Desktop profile patch,
`$DSH_HOME/profiles/desktop/cordis.patch.yml`, which DSH hot reloads. OpenCodex writes that row when the Desktop profile and its patch exist. If
`$DSH_HOME/profiles/desktop/package.json` exists but `cordis.patch.yml` is missing, Apply refuses:
create `cordis.patch.yml` containing `[]` (the empty patch DSH writes for a new profile), then
enable the integration again. Only when there is no Desktop profile does OpenCodex use
`llm-pi-ai.providers.opencodex` in `$DSH_HOME/settings.yaml`. OpenCodex owns only that provider
fragment: Apply and Refresh replace it, Disable removes it, and Restore puts back a recorded
snapshot. These operations do not change the user's default model or the native
`deepseek-official` provider.
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

Aside keeps a separate model catalog for each registered profile, including local profiles. OpenCodex lists
all registered profiles, including local profiles, and can synchronize them together or control
one profile at a time. Switching an integration never changes Aside's active account. A prior
Aside connection enables all profiles by default; individual exclusions survive later syncs.

One caveat specific to Aside: the running app rewrites `models.json` itself, so
fully quit and reopen Aside after applying, the same way Claude Desktop needs a
restart. Aside's block is loopback-only and never carries a real credential.

The managed Raycast integration supports **macOS and Windows**. Custom Providers
is a **Raycast Pro** feature: on a free plan the file is still written, but
`ocx integration client status --client raycast` and the **Connect** page report
a warning, because Raycast will not read it. On macOS or Windows, open Raycast →
Settings → AI → **Reveal Providers Config** once so the `ai` folder exists.
On these supported platforms, opencodex uses that folder as its install signal
and reports the client as not installed until it exists. Linux is unsupported,
even if the folder exists.

The status field `aiDirPresent` reports only whether `~/.config/raycast/ai` exists,
independently of whether the Raycast app is installed or the platform is supported.
It does not prove that Raycast is installed or usable. The CLI prints `plan` on a
separate line and adds the macOS/Windows setup instruction when `aiDirPresent` is
false; `--json` preserves the raw status, including the nested `raycast` block.
Raycast reads `~/.config/raycast/ai/providers.yaml` on macOS and Windows alike and
does not honor `XDG_CONFIG_HOME`, so that path is not relocatable.

The managed block is one element, `id: opencodex`, in the file's `providers`
sequence: `name: OpenCodex`, `base_url: http://<host>:<port>/v1`, and every
routed model with its `abilities` — the exporter sets `tools` and `system_message` to
`true` as a client-export convention, `vision` follows the catalog's input modalities, `reasoning_effort`
is set when the model has an effort ladder, and `temperature` is turned off for
reasoning models. Other providers in the file are preserved, and disable removes
only the OpenCodex element. Raycast picks up the change as soon as the file is
saved, no restart needed; the models appear in Raycast's model picker grouped
under **OpenCodex**. Raycast supports optional `api_keys`, but OpenCodex intentionally
omits them and refuses non-loopback or admission-authenticated targets; this integration
cannot supply OpenCodex's required admission header.

The macOS private preference is only an advisory Pro hint; Windows never reads it and
reports the plan as unknown. Plan detection does not authorize or block a write.
The export metadata has no authoritative tool-support flag, so `tools: true` does not
prove every routed model supports tools. Vision and effort flags follow catalog metadata;
turning temperature off for an effort ladder is conservative export behavior.
Provider values are preserved; YAML formatting and comments are not guaranteed to survive.
The format is documented at
[manual.raycast.com/ai/custom-providers](https://manual.raycast.com/ai/custom-providers).

Raycast CLI exports and dashboard downloads use the running server's destination and
admission policy, including a configured unauthenticated loopback listener. `ocx ensure`
does not refresh Raycast from its saved configuration snapshot: that can differ from the
running server. Server startup and explicit sync remain the catalog refresh paths.


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
**OMP, DSH and Hermes** are unaffected by sibling edits too, for a different reason: their writers
patch only their own managed provider ranges byte-wise, so the rest of the
file is never rewritten. For the remaining formats that can carry comments
(OpenClaw, Kimi Code, gjc, MiniMax Code, Raycast — JSON5 and TOML
written as whole documents, or generic YAML without source preservation), or
whenever our own entries were edited, the switch locks and disable refuses rather
than guessing which edits were yours.

That lock is no longer a dead end. A conflicted client shows **Replace** next to its
switch, on both the overview card and the client's own page. It replaces whatever
holds our settings with the block opencodex would write, and it asks first: the
dialog names the file, says what is lost, and points at the snapshot that makes it
undoable. The switch itself stays locked, because the switch cannot know which edits
you meant to keep — only you can say so. Nothing else is relaxed: a file we cannot
parse, or one whose structure we cannot reason about, still refuses.

## Hermes session affinity

The generated `providers.opencodex` block includes `session_affinity_header: session-id` for all
models. This names a header; Hermes supplies its dynamic conversation identifier. OpenCodex does
not write a shared static identifier or change `api_mode` to enable affinity.

Use a Hermes version supporting [per-provider request options](https://hermes-agent.nousresearch.com/docs/user-guide/configuring-models#per-provider-request-options).
Older versions may ignore or discard the option; a valid configuration alone does not prove that
Hermes sends the header. Conversation isolation, compaction lineage and auxiliary/child requests
follow Hermes' affinity semantics. This setting does not guarantee a particular cache-hit rate.

For an existing managed integration, open **Connect → Hermes**, review **Apply**, and confirm
the update. Until then, it shows **Update needed** and implicit catalog refresh leaves it unchanged,
including its model list. Reading the page does not upgrade the configuration. After Apply, normal
catalog refresh resumes and retains the setting; **Replace** also includes it.

If you already added exactly `session_affinity_header: session-id` inside the managed block, Apply
can adopt it when all other managed settings still match the ownership record. This is the narrow
exception to the conflict rule above: other edits, a different header name, or a block without a
matching ownership record still require conflict resolution. Unrelated YAML settings and comments
remain untouched, and the existing snapshot and Restore workflow applies to the upgrade.

## Preview and confirm changes

In the dashboard, Apply, Replace, Disable, and Restore begin with a preview. The dialog shows exactly which
managed settings will change, including the bounded change paths and whether each change adds,
updates, or removes a value. Review that plan before confirming.

When a plan reports no changes, it means the managed client document already has the requested
state. For a selected Aside profile, confirming can still save that profile's sync preference even
though the managed document does not change.

If the file changes after you review it, the write is refused as stale. The dialog replaces the
old plan with the updated one and asks you to confirm again; it never retries the write
automatically. If a preview is temporarily unavailable, reload the page normally and start the
action again.

Aside uses the same preview and confirmation flow for one selected profile at a time. **Sync all
profiles** remains a separate bulk action and is not bound to one combined preview.

## What to expect, honestly

**Formatting is generally not preserved.** Applying parses a config and writes it back
out, so JSON, JSON5 and TOML may be reformatted and comments in JSON5 or TOML are lost.
OMP, DSH and Hermes are the exceptions: OMP and Hermes patch only `providers.opencodex`.
DSH patches only `[id=llm-pi-ai].config.providers.opencodex` in the Desktop profile patch,
or `llm-pi-ai.providers.opencodex` in `settings.yaml` when there is no Desktop profile.
Their YAML writers preserve unrelated provider comments and formatting byte-for-byte. If that exact
source range cannot be identified safely, the operation refuses instead. For other clients, use
Restore when you need the previous file bytes: the snapshot is a verbatim copy.

**If a value cannot be rewritten faithfully, the switch refuses instead.** The round
trip covers the value kinds these formats use in practice, and where it does not —
a TOML file using `inf` or `nan`, for instance, which the parser available to us
cannot read back accurately — applying stops and says so rather than writing a
changed value and calling it success. You will see the file named and nothing on
disk will have moved. Editing that file by hand still works; it is only our
automatic rewrite that declines.

TOML dates and times also refuse managed rewrites: the merge step would turn these
typed values into quoted strings. This includes values inside arrays and inline
tables. Quoted date strings remain supported; an unquoted date must be preserved
by editing the configuration manually.

**Pi, Kimi Code, gjc, MiniMax Code, Prime Agent, Aside, Raycast, omo and the managed DSH integration only work against a loopback bind.**
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
usual. Those blocks are built from the same effective canonical model metadata as the
exports, so the launcher and the managed integration describe the same models, limits, and
reasoning choices. The switch here is what matters when you launch `opencode` directly.

## From the terminal

The same operations are available headlessly:

```bash
ocx integration client status
ocx integration client enable --client hermes
ocx integration client disable --client hermes
ocx integration client history --client hermes
ocx integration client restore --op <opId> [--confirm-drift]
```

### Preview and bind a terminal write

The existing direct commands remain supported. To bind a write to a reviewed
observation, inspect status and save a preview first:

```bash
ocx integration client preview --help
ocx integration client status --client hermes --json
ocx integration client preview --client hermes --operation apply --json > hermes-preview.json
```

Review `state`, `foreignEdit`, structural `changes`, `canApply` and `willChange`.
Valid refused and no-op plans exit 0 because inspection succeeded; nothing was
applied. The plan contains no secret values or full file diff. It uses existing
passive catalog evidence and never secretly refreshes providers. If unavailable,
resolve catalog availability separately before requesting a new preview.

Only after reviewing an applicable plan and choosing the write:

```bash
PLAN_FINGERPRINT="$(jq -er 'select(.canApply == true) | .fingerprint' hermes-preview.json)"
ocx integration client enable --client hermes --plan-fingerprint "$PLAN_FINGERPRINT" --json
ocx integration client status --client hermes --json
```

Fingerprint is concurrency evidence, not authorization. Commit accepts `pN:`
followed by 32 lowercase hex digits; a refused `pN:unbound` cannot commit. Repeat
exact client/action/profile/options. Preview `overwrite` maps to enable with
`--overwrite-conflict`; preview `disable` maps to disable. Stale commit exits 5,
prints re-preview guidance on stderr and leaves stdout empty. It never adopts a
replacement fingerprint or retries. Other failures use usage 2, not-found 4,
runtime/malformed 1, with safe stderr rather than a JSON error envelope.

### Inspect restoration drift before replacing it

Use a real history opId; `op-example` below is fictional:

```bash
ocx integration client history --client aside --profile 1 --json
ocx integration client restore --op op-example --client aside --profile 1 --preview --json
```

If drift is refused, inspect the edits. When replacing them is explicitly intended,
preview with `--confirm-drift`, review, then bind that same intent:

```bash
ocx integration client restore --op op-example --client aside --profile 1 --preview --confirm-drift --json > restore-preview.json
```

After review:

```bash
RESTORE_FINGERPRINT="$(jq -er 'select(.canApply == true) | .fingerprint' restore-preview.json)"
ocx integration client restore --op op-example --client aside --profile 1 --confirm-drift --plan-fingerprint "$RESTORE_FINGERPRINT" --json
ocx integration client status --client aside --profile 1 --json
```

Aside preview/bound writes require one profile, not an aggregate target. Generic
restore omits client/profile; the server derives the non-Aside client from opId.
The returned plan does not contain opId or all original command inputs, so retain
that context. `--preview` cannot combine with `--plan-fingerprint`.

### Retire an old recovery record

This permanently retires the record and backup; it does not restore or disable
the integration. After inspecting history and choosing to lose that recovery point:

```bash
ocx integration client history remove --op op-example --client aside --profile 1 --yes --json
ocx integration client history --client aside --profile 1 --json
```

Use the actual selected opId. No selector addresses the global journal; `--client aside`
addresses aggregate Aside history and optional `--profile` narrows it. Other client
selectors are refused for deletion. The newest row is protected. A receipt with
`snapshotRemoved:false` is committed retirement with incomplete cleanup and exit 1;
it is not rollback and must not trigger repeated deletion. `journal remove` is an alias.

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

Once connected, `ocx sync` and `POST /api/sync` refresh owned MCode, Pi, Aside,
Raycast, omo, OpenCode, and Kilo catalogs with the current model selection, context windows, and
reasoning-effort ladders. Proxy startup refreshes an owned Raycast catalog. Changes to
model visibility, provider selection, or presets also refresh connected Pi, Aside,
Raycast, omo, OpenCode, and Kilo catalogs.
Missing, foreign-edited, or unsafe blocks stay untouched, as do previously owned blocks
you removed manually.
An enabled Aside profile is an exception to the usual owned-only refresh: if its account
directory exists and it has never had an owned block, sync may create its first block when
that slot is empty. A prior Aside connection enables this behavior for all registered
profiles by default. Sync does not create missing account directories or replace manual blocks.
A refused or overlapping refresh is reported separately for each client. Start a new Pi,
OpenCode, or Kilo session or fully quit and reopen Aside to load the updated file.
Aside refresh requires a [compatible running proxy](#aside-profile-controls).

If Models reports **“Model selection saved”** together with a client-refresh warning, the
selection is already saved; one or more client files could not be updated. The warning names
the affected client and Aside profile, when applicable, and explains the refusal. Open
**Connect** to inspect that client or profile before starting a new session. Resolve the
reported issue, then retry `ocx sync`; an overlapping operation must finish first. If the
warning includes a backup path or says recovery did not finish, inspect that recovery state
before retrying. A successful selection save alone does not confirm client-file recovery.

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

## Aside profile controls

Aside profile controls and the Aside refresh performed by `ocx sync` require a running
ocx proxy that supports the Aside profile APIs. Updating the CLI alone does not update an
already-running proxy. If the proxy is unavailable or too old, the Aside operation cannot
complete; the CLI never falls back to writing Aside profile files locally.

Upgrade the ocx installation used by the proxy, then restart the proxy (or start it if it
is stopped). Retry `ocx sync` or the profile command. After the profile files update
successfully, fully quit and reopen Aside so it loads the new catalogs.

```bash
ocx integration client status --client aside --json
ocx integration client enable --client aside
ocx integration client disable --client aside --profile 1
ocx integration client history --client aside --profile 1
ocx integration client restore --client aside --profile 1 --op <opId>
```

The profile number is the account ID shown by the status command. Omitting `--profile` on an
Aside toggle applies the desired state to every registered profile. A per-profile change leaves
siblings unchanged. Desired sync settings are saved before file changes; actual state and any
refusal are reported for each profile. A partial bulk result is not an all-applied success and
the CLI exits nonzero. Undo restores the selected profile's synchronization intent as well as
its file, so a later sync does not silently reverse Undo.

The [profile API](/reference/management-api/#aside-profile-controls) returns HTTP 200 for a
successful bulk operation and HTTP 207 with `ok: false` if any profile refuses. Inspect every
entry in `results`: successful profiles are not rolled back when another fails. Desired
settings remain saved, so retry after addressing the affected profile rather than assuming
the entire change failed. If saving those settings fails, no profile files are changed.

For a targeted refresh of eligible Aside profiles, rather than broad catalog sync:

```bash
ocx integration client sync --client aside --json
ocx integration client status --client aside --json
```

This uses the existing attested Aside owner and has no profile selector or local
fallback. `{results:[]}` exits 0 and means no eligible profiles, not applied writes.
Any failed row returns exit 1 while successful profiles remain updated. Preserve
per-profile refusal, residual and separately labeled redacted backup information;
inspect the affected profile before retrying. This refresh is separate from each
profile's preview/bound mutation workflow.

Each profile has separate ownership and history. Existing user edits, unsafe paths and linked
catalogs are refused; the existing explicit overwrite and drift-confirmation controls remain
available. Fully quit and reopen Aside to load changed model files.


## ZCode 3.14 and later

ZCode 3.14 moved its custom providers to `~/.zcode/v2/provider_config.json` and left
`~/.zcode/v2/config.json` reachable only through a one-shot import that runs when the new file is
missing. ZCode creates the new file the first time it runs, so on any install that has ever been
launched the import is already spent and a write to `config.json` reaches nothing.

opencodex writes `provider_config.json` directly where it can. Enabling the integration adds the
`opencodex` provider rule to that file, a catalog refresh updates it, and disabling removes exactly
what opencodex put there. Every other rule in the file is left alone, including a rule another
provider keeps for a model id that also appears under ours. A rule carrying the `opencodex` id that
opencodex did not write is a conflict rather than something to take over; resolve it in ZCode, or
use the explicit overwrite.

An unreadable or non-file provider store also refuses writes; it is not treated as an absent store that permits the legacy import.

Two other situations still refuse rather than write. A block opencodex applied before ZCode moved its
store keeps the integration on `config.json`: disable it there first, then enable it again to write
the new store. And a `provider_config.json` whose `schemaVersion` is not one opencodex has observed
is reported rather than merged into, because that file holds every provider ZCode has and asserting
a shape into it would trade a silent no-op for a silent loss. Status names the file ZCode reads
whenever the integration is not writing it.

In that second case, add the provider in ZCode's own settings: base URL
`http://127.0.0.1:10100/v1` (adjust the port to your bind), any non-empty key, and the model ids
from `ocx export --client zcode`. Deleting `provider_config.json` to re-trigger ZCode's import is
not supported — it discards every provider ZCode keeps there.

## Cline CLI

This integration targets Cline's current CLI/shared SDK provider store, whose native schema has
`version: 1`. Legacy VS Code extension `globalState`/secret storage is not migrated or detected
as this integration. Run Cline once to initialize its settings directory.

**Stop Cline before enabling, syncing, disabling or restoring the integration.** OpenCodex writes
`providers.opencodex` into both `providers.json` and sibling `models.json`. The first file holds
the OpenAI Responses connection with a non-secret loopback placeholder; the second holds the
filtered routed model catalog, including available context and image metadata. Existing provider
entries and the default provider selection remain unchanged.

```bash
ocx integration client list --json
ocx integration client enable --client cline
ocx integration client history --client cline
ocx integration client restore --op <operation-id>
```

After enabling, restart Cline and select OpenCodex, or launch with
`cline --provider opencodex --model <provider/model>`. External catalog changes are read when
Cline restarts. Cline is excluded from unattended catalog refresh; after changing the routed
model selection, stop Cline and run `ocx sync` or enable the integration again to refresh it.
A selected model is preserved while still routed and cleared if removed from the exported catalog.

`CLINE_PROVIDER_SETTINGS_PATH` overrides the primary file. Otherwise `CLINE_DATA_DIR` selects the
data directory, then `CLINE_DIR` selects the root, then `~/.cline` is used. The model file is always
`models.json` beside the selected provider file. Overrides must be absolute or start with `~`.
Mirror command-local Cline `--config` paths with `CLINE_PROVIDER_SETTINGS_PATH` when starting
OpenCodex. A primary path named `models.json` is refused because the files must be distinct.

Each file replacement is atomic, but no filesystem operation replaces both simultaneously.
One journal operation snapshots both original files; a write or bookkeeping failure compensates
both. An interrupted operation retains a private recovery record. Status reports incomplete
recovery as unsafe, and the next explicit mutation recovers only if neither file nor its
ownership has an unrelated edit. If recovery refuses, preserve the files and the recovery path
reported by the operation; resolve the conflict before retrying.

Undo restores **both original byte strings**, including a file that originally did not exist.
Edits after the operation require the existing explicit `--confirm-drift`; the edited pair is
backed up first. An occupied OpenCodex entry requires the existing `--overwrite-conflict` opt-in.
Disable removes the two managed entries; it does not restore a prior foreign entry. Use Undo
for that. Snapshot retention and expiration follow the same rules as other integrations.

The download `cline-config-bundle.json` contains two native document members: `settings` for
`providers.json`, and `catalog` for `models.json`. It is not itself a Cline settings file. Prefer
the integration command for a journaled merge and rollback. Remote admission wiring is not
supported by this generated integration; it requires unauthenticated loopback access.

## GitHub Copilot App

The GitHub Copilot desktop app can use opencodex as an OpenAI-compatible model provider. This is a
manual client setup with no switch on **Connect**, and it is separate from the upstream
`github-copilot` provider, which uses a Copilot subscription as a backend for opencodex.

1. Start opencodex and confirm it answers:

   ```bash
   curl http://127.0.0.1:10100/healthz
   curl http://127.0.0.1:10100/v1/models
   ```

2. In the Copilot app, open **Settings → Model providers → Add provider** and enter:

   | Field | Value |
   |---|---|
   | Name | any label, for example `OpenCodex` |
   | Base URL | `http://127.0.0.1:10100/v1` (adjust the port to your bind) |
   | API key | leave blank on loopback |

3. Sync models from the endpoint, or add one by its `provider/model` id, and select it.

The app uses `GET /v1/models` for discovery and `POST /v1/chat/completions` for turns. Those turns
go through opencodex's normal model routing, so provider credentials, OAuth accounts and combos apply
as they do for any other client. The accepted request fields are listed in the
[proxy formats reference](/reference/proxy-formats/).

If the app reports no models, check that the base URL ends in `/v1` rather than
`/v1/chat/completions` and that `/v1/models` returns a non-empty `data` array. When opencodex
listens on a non-loopback address, put a data-admission key (the token described under
[remote access](/reference/configuration/server/#remote-access), or a dashboard-generated `ocx_…`
key) in the app's API key field. The app sends it as `Authorization: Bearer`, which
`/v1/chat/completions` accepts as proxy admission and never forwards upstream; see the
[authentication matrix](/reference/proxy-formats/#authentication-matrix).

## omo (Codex / LazyCodex) role models

When LazyCodex is installed, the omo tab shows an **omo (Codex / LazyCodex)** section below the Pi-based omo controls, listing
every Codex agent role found in `$CODEX_HOME/agents/*.toml`, with the model each one is pinned
to. Codex runs a role on that pin no matter which model the parent asks for, so this is where a
role's model is actually decided. LazyCodex counts as installed when the `omo@sisyphuslabs`
Codex plugin is enabled in `$CODEX_HOME/config.toml` and an installed copy under
`$CODEX_HOME/plugins/cache/sisyphuslabs/omo/` carries its `lazycodex-install.json`. A `~/.omo`
folder on its own does not count, because Pi-based omo creates it too. Without LazyCodex the
section is hidden and the command line reports it as not installed. Pick a model on a row and
press Save:

- opencodex rewrites only the root `model = "..."` line of that role's file. The role's
  instructions, comments, and other keys are left exactly as they were. A role with no pin gets
  one added near the top of the file.
- The same value is written to `[codex].agents.<role>.model` in `~/.omo/omo.jsonc`, which
  LazyCodex 5.1.1 and later reads. If that file does not exist it is not created. If it contains
  comments it is left untouched, because saving would remove them; the tab says so, and you can
  set the value there by hand. Symlinks and non-regular files are rejected; on macOS and Linux,
  a FIFO is rejected without waiting for a writer. A skipped mirror does not undo the role-file save.

Nothing happens until you press Save; syncing or restarting opencodex never changes a role file.
New Codex sessions pick up the change. The same controls exist on the command line:

```bash
ocx agent roles
ocx agent roles set explorer xai/grok-4.5
```

### Auto-assign

Auto-assign is part of omo (Codex / LazyCodex): it sits above the role table in that section and
exists only while LazyCodex is detected. Without it the dashboard shows neither, the API answers
409 `lazycodex_not_detected`, and `ocx agent roles suggest` is refused.

Auto-assign proposes a model for every role at once. opencodex asks your
default Codex model (the root `model` in Codex `config.toml`) one question: for each role, given its
description and the start of its instructions, which capability tier (fast, standard or frontier)
and how much reasoning (glance, measured, thorough or exhaustive) does it need? That model never
picks a model. opencodex then picks the cheapest model from your picker list that reaches the tier:

- Models listed under `codexRoleTiers` in the opencodex config (`{ "fast": [...], "standard": [...], "frontier": [...] }`)
  have that tier.
- Other models with a known price are ranked by price and split evenly across the three tiers. With only
  one or two priced models, the dearest is frontier and the other, if any, is standard.
- Models with no price and no listed tier are never proposed. List them to include them.

Each proposal shows the model, the tier, the reasoning effort, a one-line reason, and what would move
it up or down. A role the model could not size clearly is shown as not sized, with the reason, and
cannot be applied. Nothing is written until you press Apply on a row or Apply all. Applying uses the
same save as picking by hand, and also rewrites the role's `model_reasoning_effort` when the file already has
one. The effort is placed on the chosen model's own levels: its lowest, its default, one above the
default, or its highest.

```bash
ocx agent roles suggest
ocx agent roles suggest --model xai/grok-4.5 --apply
```

## Kilo

Kilo CLI, VS Code, and JetBrains share one global config. This integration writes
`provider.opencodex` into the first existing file among `kilo.jsonc`, `kilo.json`,
`opencode.jsonc`, `opencode.json`, and `config.json` under `~/.config/kilo`
(`XDG_CONFIG_HOME` relocates that directory). If none exist, the destination is
`kilo.jsonc`. Project configs are never written.
Kilo merges all of these global files. If another candidate also defines
`provider.opencodex`, status names every competing file and Apply and Replace refuse;
remove `provider.opencodex` from those files before enabling the integration. An unreadable or unsafe
candidate also blocks the write. Disable can still remove a block owned in the recorded file
while another candidate conflicts or cannot be parsed; the other candidate is left untouched.

The owned fragment is only `provider.opencodex` (OpenCode V1 shape: `npm`, `options`,
`models`). Kilo's published schema has no OpenCode V2 `providers` key, so that block is
not emitted; Kilo instead receives the per-model reasoning choices as a variant map inside
its provider block, built from the same effective canonical metadata as the OpenCode
export. `$schema`, `model`, `enabled_providers`, MCP, and other keys stay
user-owned. Select `opencodex/<provider/model>` in Kilo after applying.

Loopback uses `{env:OPENCODEX_KILO_API_KEY}` as `options.apiKey`. A non-loopback bind
moves admission to `options.headers["x-opencodex-api-key"]` and never serializes a real
key. Apply rewrites the whole global file as pretty JSON, so comments and trailing
commas in other keys are not preserved. Kilo is on the implicit catalog fan-out: `ocx
sync`, `POST /api/sync`, and visibility, provider, or preset changes refresh an owned Kilo
block under the same safe owned-only rules as every other client, and a new Kilo session
loads the updated file.

```bash
ocx integration client enable --client kilo
ocx export --client kilo --out ./kilo.jsonc
```

## Command Code

Command Code keeps its custom providers in `~/.commandcode/providers.json`. This
integration writes `provider.opencodex` into that file and is loopback-only.

**Which root it writes.** Command Code resolves its provider map as
`document.provider ?? document.providers`, so the singular root wins whenever it
exists. The integration therefore reads the target file first and writes into the
root that file already uses: a document that already carries a `providers` map keeps
it, and your other providers stay readable. A fresh file gets the singular `provider`
root. Both roots are declared as managed paths, so Disable removes the block from
whichever one it was written into.

**The credential form.** The provider is written with `apiKey: false`, the documented
form for an endpoint that needs no key. A raw string is refused by Command Code, and
no service-token file is read, referenced, or exported by this integration.

**Home resolution.** There is no `COMMANDCODE_HOME` override here. The published
client resolves `HOME ?? USERPROFILE` and then appends `/.commandcode/providers.json`;
it does not consult that variable. An override this integration honoured but the
client ignored would make Apply report success at a path Command Code never opens, so
the path is always `~/.commandcode/providers.json`.
On Windows with the default home, the integration uses `HOME ?? USERPROFILE`
only when the selected value is nonblank and Windows-absolute; otherwise it uses
`homedir()`. A separately supplied home is preserved. A `HOME` set by Git for
Windows or MSYS2 is therefore honoured only when it passes those checks.

Paste the key yourself if you later move the provider off loopback: Command Code
stores keys in `~/.commandcode/auth.json` (via `/connect`), not in `providers.json`.

```bash
ocx integration client enable --client commandcode
ocx export --client commandcode --out ./providers.json
```

`ocx commandcode restore --op <opId>` accepts only Command Code operations, including
`--preview` and `--plan-fingerprint` requests. It rejects client/profile overrides.
The running proxy must support client-scoped restore; older proxies return an error
without falling back to the generic restore endpoint.
Use `ocx integration client restore` for the generic journal and the explicit Aside
profile commands above for Aside operations.

## Factory Droid

Run Droid once to create `~/.factory`, then explicitly enable this integration with
`ocx integration client enable --client droid`. OpenCodex adds only documented
`customModels` entries to your personal `settings.json`, using a keyless local
Chat Completions endpoint. Choose a row from Droid's `/model` picker. Disable
removes the managed rows; Undo restores the exact saved file. Other settings and
custom models remain yours.
If Droid normalizes a `customModels` row by adding `id` or `index`, OpenCodex ignores those two
client fields when checking ownership so saved reasoning defaults remain available.

Open **Connect → Factory Droid** (`/#integrations/droid`) to set a reasoning
default for each connected model. Choose from the model's supported efforts,
review the changes, then confirm. **No default** clears that model's draft setting;
use **Save / review changes** and confirm to apply the removal.
Models without a declared effort list show that no default is available.

The CLI supports the same defaults in Droid apply/overwrite. For example, replace
the fictional model below with an exact connected ID and supported effort:

```bash
ocx integration client preview --client droid --operation apply --reasoning-default example/model-a=high --json > droid-preview.json
```

After reviewing the applicable plan and choosing the write:

```bash
DROID_FINGERPRINT="$(jq -er 'select(.canApply == true) | .fingerprint' droid-preview.json)"
ocx integration client enable --client droid --reasoning-default example/model-a=high --plan-fingerprint "$DROID_FINGERPRINT" --json
ocx integration client status --client droid --json
```

Repeat `--reasoning-default MODEL=EFFORT` to submit the complete replacement map.
The last equals sign separates model and effort; case and exact IDs are preserved.
Duplicate model keys refuse. Omitted flags preserve defaults;
`--clear-reasoning-defaults` explicitly sends an empty map. To clear, preview with
that flag and repeat it in the matching enable command. Clear and entries cannot
combine. These flags are Droid-only and do not apply to disable/restore. Repeat
the same map in preview and commit; the server validates model-specific efforts
and refuses stale binding rather than silently accepting a changed map.

For an intended complete clear, preview that separate action:

```bash
ocx integration client preview --client droid --operation apply --clear-reasoning-defaults --json > droid-clear-preview.json
```

After reviewing and choosing it:

```bash
DROID_CLEAR_FINGERPRINT="$(jq -er 'select(.canApply == true) | .fingerprint' droid-clear-preview.json)"
ocx integration client enable --client droid --clear-reasoning-defaults --plan-fingerprint "$DROID_CLEAR_FINGERPRINT" --json
```

The default applies only when Droid omits an effort from its request. An explicit
request effort takes precedence over this default; existing OpenCodex pins and
caps still apply. Droid may continue to display **Dynamic** even when OpenCodex
applies the configured default. Requests without the Droid default header are
unaffected; the header is a request preference, not proof of client identity.
For combos and routing policies, each concrete target checks the preference
against its own effort list, so an incompatible first target does not remove it
from a compatible fallback.

A saved default that the routed model no longer supports is ignored for requests.
If the connected model's declared effort list no longer includes the saved value,
it is omitted from the panel's defaults and removed from the managed row on refresh.
Reviewing without editing lets OpenCodex preserve the remaining supported defaults.

Refresh preserves defaults while the exact `provider/model` selector remains
connected and declares the saved effort. Renaming a provider, model, or combo alias replaces that managed row
and clears its default; choose a default for the renamed row again. Disable
removes the defaults with the managed model rows, and Undo restores the saved
rows and their defaults together.

Models whose IDs or display names contain `,` or `]` are skipped because the
managed selector cannot address them safely; export and managed settings show
the same rows. A nonempty catalog with no addressable models is refused.

Droid also reads legacy `config.json` and local `settings.local.json`. Resolve
legacy rows that use the OpenCodex endpoint, a generated model ID, or an
`OpenCodex:` display name, and any local `customModels` override, before enabling;
OpenCodex refuses those ambiguous settings. It also refuses an
unsafe target or a row edited since apply. The integration is loopback only and
never copies provider credentials. Factory documents the [BYOK schema](https://docs.factory.ai/model-independence/byok)
and [personal settings path](https://docs.factory.ai/droid-cli/settings).
