---
title: CLI Agents, Routing, and Integrations
description: Multi-agent, combo, observability, access, protocol path, integration, system, and config commands.
---

These commands control agent policy and routing, inspect the live proxy, and connect supported clients to opencodex.

## Agent policy

### `ocx agent <status|injection|effort|subagents|fallback|roles|sidecar|memory-models|compaction-routing> ...`

Manage the headless multi-agent roster, effort caps, prompt injection, fallback, and sidecar settings.
Use `status` for the current policy. See [Sub-agent surfaces](/guides/sub-agent-surface/) for how
surface modes, delegation, effort, and fallback behavior fit together.

```bash
ocx agent subagents set ark/model-a,openai/gpt-5.5
```

`ocx agent roles` is for omo (Codex / LazyCodex). It lists each Codex agent role in
`$CODEX_HOME/agents` with its model pin and whether `~/.omo/omo.jsonc` can be updated, or says
LazyCodex is not installed, in which case `set` is refused. `ocx agent roles set <role> <model> [--effort <level>]` rewrites only
that role's root `model` line, and its `model_reasoning_effort` line with `--effort`, and mirrors both into omo.jsonc at
`[codex].agents.<role>` as `model` and `reasoning`. An effort LazyCodex has no level for, such as `ultra`, is written to the role file only. A missing omo.jsonc, or one containing comments, is left unchanged
and the command says so. See [omo (Codex / LazyCodex) role models](/guides/integrations/#omo-codex--lazycodex-role-models).

```bash
ocx agent roles set explorer xai/grok-4.5 --effort medium
```

`ocx agent roles suggest` is omo (Codex / LazyCodex) only, refused like `set` when LazyCodex is not
installed. It sizes every role with one call to the default Codex model (or `--model`) and
prints a proposed model and effort per role without writing anything. `--apply` writes every proposal
through the same write as `set`, skipping and naming the roles whose model and effort already match.
See [Auto-assign](/guides/integrations/#auto-assign).

Human-readable suggestion output displays terminal control characters as visible escapes.
Use `--json` when you need the original suggestion values without presentation escaping.

`ocx agent injection suggest <work>` does the same for the delegation model: it sizes the described
work, proposes the cheapest sufficient model and an effort from the delegation picker's list, and writes
nothing unless `--apply` is given, which saves through the same write as `injection set`. See
[Delegation model and effort](/guides/sub-agent-surface/#delegation-model-and-effort).

`ocx agent sidecar web --list` and `ocx agent sidecar vision --list` print the models the
server currently offers for each sidecar — the exact filtered set the dashboard picker shows
(picker-visible rows plus the login-entitled Luna/Haiku auth slots, intersected with executor
availability for web search, minus provably text-only models for vision). Human-readable lists
show each model's backend in brackets. A web-search `--model` write resolves that server-offered
row and persists its backend and model together, so switching to an Anthropic option cannot keep
an OpenAI backend (or vice versa). Writes go to the same management route as the GUI and are
subject to the same per-sidecar gate: web search refuses a backend/model pair outside the listed
set (closed membership), while vision refuses only a model provably unable to see (unknown ids
stay writable).

```bash
ocx agent sidecar web --list
ocx agent sidecar web --model gpt-5.6-luna
ocx agent sidecar web --enabled off
```

`--enabled off` is the same switch as the Dashboard's Off row: OpenCodex stops running the
sidecar and the Codex integration writes `web_search = "disabled"` into `~/.codex/config.toml`,
which is what lets an MCP search server be the only search path. `--enabled on` removes that
marker-owned line again. When the save actually moves the switch, the command reports the
Codex-side write it triggered (`codexWebSearch` in `--json`, a trailing `Codex config:` line
otherwise) and points at `ocx sync` when it could not happen; a save that leaves the switch
where it was has nothing to report and prints no `Codex config:` line. The flag works for
`vision` too.

### Injection defaults and sidecar runtime settings

```bash
ocx agent injection status --json
ocx agent injection set --sync-codex-defaults off --json
ocx agent injection status --json
ocx agent sidecar web --stream-routed-output on --json
ocx agent sidecar vision --timeout-ms 30000 --json
ocx agent sidecar status --json
```

Run writes only for the requested change. Injection `--sync-codex-defaults on|off`
updates `syncCodexSubagentDefaults`; omitted model/effort/prompt/guidance stay intact,
and `-` clears model/effort/prompt. The receipt has actual normalized
`model`, `effort`, `prompt`, `multiAgentGuidanceEnabled` and
`syncCodexSubagentDefaults`, not a fabricated catalog result.

Web `--reasoning` remains supported. `--max-descriptions` and `--timeout-ms` are
vision-only; timeout accepts integers from 1 to 2147483647 milliseconds.
`--stream-routed-output` is web-only. Partial writes preserve sibling settings.
The new-option receipt exposes only the selected public `webSearch` or `vision`
state and `codexWebSearch` apply report. `{applied:false, reason, retryable}`
distinguishes native apply deferral/refusal from a saved setting; a missing or
mismatched new setting is unverified and nonzero. Read status for full observed
settings, including web reasoning. Do not retry blindly on ownership refusal.

### Memory and compaction routing overrides

```bash
ocx agent memory-models show --json
ocx agent memory-models set --extract-model <route> --extract-effort high --consolidation-model <route> --json
ocx agent memory-models show --json
ocx agent compaction-routing show --json
ocx agent compaction-routing set --model <route> --effort high --triggers manual,auto --sources '<exact-source>,<provider>/*' --json
ocx agent compaction-routing show --json
```

Each set replaces the entire block. Memory accepts extract/consolidation model
and optional effort pairs; an effort without that phase's model is refused.
Omitted phases use their existing/default route, not a stopped pipeline.
`--file memory.json` instead reads the block itself:

```json
{"extract":{"model":"example/model","reasoningEffort":"high"}}
```

An explicit memory file `{}` is valid and remains an empty override block;
`ocx agent memory-models clear --json` writes null. Both mean no custom override,
not disabled memory processing. File mode is exclusive with scalar options.
Regular UTF-8 files or piped `--file -` use the 4 MiB/30-second bounded-input
contract, including a 4 MiB serialized request limit.

Compaction files contain required `model`, optional `reasoningEffort`, `triggers`
and `sourceModels`. Triggers are unique `manual`/`auto`; source selectors must be
exact and unique, or provider/* patterns. Omitted triggers use server defaults;
omitted sources select all sources, not the previous custom scope.
`ocx agent compaction-routing clear --json` writes null and restores ordinary
compaction routing without disabling compaction. No synthetic model call verifies
these saves.

Reads return only `{memoryModels: blockOrNull}` or `{compactionRouting: blockOrNull}`.
Writes add `catalogRefreshPending`: false exits 0 without promising every client
applied, true exits 1 after saving. Missing/malformed pending evidence is null with
`verification:"unverified"` and exit 1. Read back before recovery.

### `ocx effort [status|set|clear]`

Inspect or change main and subagent reasoning-effort caps through the live proxy, or the local
configuration when no proxy is available. Cap values are `low`, `medium`, `high`, `xhigh`, `max`,
and `ultra`; `-` clears the selected cap. `none` and `minimal` are not cap levels and are rejected
before probing the proxy or submitting an update, including when another option in the same command is valid.
They remain valid for `--injection`, which sets the separate injection effort rather than a cap.

```bash
ocx effort status --json
ocx effort set --main high --subagent low
ocx effort set --subagent -
```

Status preserves existing stored/runtime cap values and reports unsupported values in `warnings`
(an empty array when none are unsupported). The same warnings appear in human output and name the
field that is ignored with a correction command. Status never repairs or rewrites those values.
An ignored subagent field does not remove a valid main cap. `ocx effort clear` clears both caps
while retaining the separate injection-effort setting. See [Sub-agent surfaces](/guides/sub-agent-surface/)
for the request surfaces where caps apply.

### `ocx v2 <status|on|off|mode <v1|default|v2>|keep-native-v1 <on|off>|threads <n>|mode-hint <text|--clear>>`

Manage the Codex `multi_agent_v2` feature flag and the three-state multi-agent surface mode.
These operate locally by default. `--live` uses the selected running proxy with no
local fallback; both targets support `--json`. Re-read status on the same target
after a change and distinguish stored settings from new-session behavior.

| Subcommand | Action |
| --- | --- |
| `status` (default) | Report the current v2 flag, multi-agent mode, and thread concurrency. |
| `on` | Enable the global `multi_agent_v2` feature; local changes resync the catalog. Rejected while the v2 hybrid pin is active because the global override would defeat it. |
| `off` | Disable the `multi_agent_v2` feature and resync the catalog. |
| `mode v1` | Force all models to v1, disable native v2, and preserve the active thread limit. |
| `mode default` | Respect upstream model surface pins. |
| `mode v2` | Force models to v2 and preserve the active thread limit. With `keep-native-v1` off, enable global native v2; with it on, disable the global override and use catalog pins. |
| `keep-native-v1 on\|off` | Under `mode v2`, keep ChatGPT-native models on v1 and routed models on v2. Enabling it disables the global V2 override before catalog sync. |
| `threads <n>` | Set the active v1/v2 thread limit to an integer of at least 1. |
| `mode-hint <text>` | Set the Proactive delegation hint (Ultra mode) for every model and effort. |
| `mode-hint --clear` | Remove the hint so the effort-derived policy (ultra = proactive) resumes. |

```bash
ocx v2 status
ocx v2 mode v1
ocx v2 mode default
ocx v2 on
ocx v2 threads 16
ocx v2 mode-hint "Proactive multi-agent delegation is active."
ocx v2 mode-hint --clear
```

The `mode` subcommand writes `multiAgentMode` to the opencodex config and resyncs the Codex catalog.
Mode and flag transitions move the current numeric thread limit between the valid v1/v2 Codex keys;
a failed transition restores the original `config.toml`. Changes apply to new Codex sessions, while
running sessions keep their pinned surface.

Codex resolves an enabled global `multi_agent_v2` override before the selected model's catalog
pin. The hybrid `keep-native-v1` contract therefore keeps that global override off; otherwise a
native row stamped `v1` would still start on V2 and produce backend-encrypted child tasks.

`mode-hint` writes `features.multi_agent_v2.multi_agent_mode_hint_text` in Codex's
`$CODEX_HOME/config.toml` even when `multi_agent_v2` is currently disabled. The
command only persists the override; it does not enable or disable the feature, so
the hint takes effect when a matching Codex surface is active. The hint overrides
codex-rs's effort-derived multi-agent policy, so any model and any reasoning effort
receives the Proactive delegation prompt. It does **not** change reasoning effort
itself. A missing argument or a whitespace-only value is rejected; only `--clear`
removes the hint. The Subagents dashboard's Ultra mode **on** toggle has a stricter
gate: it requires the native feature to be enabled with an explicit v2 surface
(`ocx v2 mode v2`); `ocx v2 on` alone does not satisfy that dashboard gate.

#### Explicit v2 target and outcome

```bash
ocx v2 status --json
ocx v2 status --live --json
ocx v2 mode v1 --live --json
ocx v2 status --live --json
```

The live write uses the existing management route. Only explicit live `mode`
accepts `--acknowledge-surface-advisory`; add it only when acknowledging that
advisory is requested. Local mode and status/on/off/keep-native/threads/hint reject
it. There is no automatic acknowledgment.

For literal reserved hint text, pass one quoted operand after `--`:

```bash
ocx v2 mode-hint --live --json -- '--clear'
```

This stores literal `--clear`; without `--`, `mode-hint --clear` removes the hint.
The suffix is not scanned for help, live, JSON or clear controls; controls belong
before `--`. Extra operands and duplicate flags refuse before mutation.

Local JSON is `{ok, target:"local", action, changed, state, sync}` using actual
post-write state. Mode/keep-native and changed on/off keep their real sync attempt
even without a discovered port; threads/hints and unchanged on/off add no sync.
An absent/malformed sync result becomes unverified with exit 1, not success.
`changed` or state can be unknown after failure; do not claim rollback.
Live status reports validated state/advisory/recommendation with `target:"live"`;
writes add `ok:true` and `catalogRefresh`. Only committed, nondegraded refresh exits
0. HTTP 502 may mean partially applied native state: inspect before retrying.
Local usage errors retain exit 1; new live usage errors use exit 2.

## Combo routing

### `ocx combo <list|show|set|remove|stats> ...` · `ocx route combo ...`

Manage combo failover and round-robin virtual models. `ocx route combo` is the hierarchical alias;
combos and routing profiles are distinct resources. Combo targets use
`provider/model[:weight],provider/model[:weight]`.

```bash
ocx combo list
ocx route combo set reliable --targets ark/model-a:2,openai/gpt-5.5
```

`set` accepts `--strategy`, `--sticky`, `--effort`, `--alias`, `--rename-from`, `--native-alias`, and
`--display-name <label|->` (`-` clears the label). A native alias captures only one currently supported,
unqualified bare OpenAI model id. Bare `gpt-5.6-*` native aliases use Codex Pool/Direct credentials.
Account-qualified OpenAI routes remain distinct, while provider-qualified routes such as
`openai-apikey/gpt-5.6-*` use their configured API key and never fall through to the native alias.
Read the safety and visibility contract in the guide before enabling the compatibility pair.
With `--strategy jev` only, the decision method is chosen by one of two mutually exclusive flags.
`--decision-provider <provider|->` names a configured `jev-decision` row (for example a self-hosted
Ollama `tev1`) as a System One-compatible server. `--decision-model <route|->` names an ordinary
opencodex route (for example `ollama/qwen3:4b`) that answers the same choice as JSON; it cannot be
this combo or any JEV combo. Omitting both uses TypeSafe. `--decision-timeout <ms|->` sets the
decision deadline (1000–120000, default 4000); `-` clears any of the three.

`ocx combo test [--combo <id>] [--decision-provider <provider|jev> | --decision-model <route>]
[--decision-timeout <ms>]` sends one synthetic decision probe through a saved combo's method or an
unsaved selection and reports the gate, backend, and latency; it may spend one decision call.
`ocx combo discover [--query <text>]` lists configured System One rows and catalog models that look
like decision models, with the derived endpoint.

For structured target metadata, inspect offline help and the current combo:

```bash
ocx combo set --help
ocx combo list --json
ocx combo show reliable --json
```

A `--targets-file` document is a nonempty ordered array, for example this shape
with provider/model values replaced by actual configured candidates:

```json
[{"provider":"example","model":"raw/model","weight":1,"reasoningEfforts":["high"],"modelProfile":"Reasoning tasks","lastResort":false}]
```

Optional fields are `weight`, `reasoningEfforts`, `modelProfile` and `lastResort`.
Efforts are a unique nonempty list of `low`, `medium`, `high`, `xhigh`, `max`, `ultra`;
empty/none/minimal custom-model semantics do not apply. Files or explicit piped
`-` have a 4 MiB limit and 30-second read deadline; the serialized management body
must also fit 4 MiB. Unknown fields refuse before the write.

```bash
ocx combo set reliable --targets-file targets.json --image-input auto --reasoning-effort-mode strict --json
ocx combo show reliable --json
```

`--targets-file` and `--targets` are mutually exclusive. Omitting both preserves
complete target metadata for partial edits; replacement files preserve order and
explicit `lastResort: false`. `--image-input auto|disabled` and
`--reasoning-effort-mode strict|adaptive` preserve omission, while explicit `auto`
and `strict` override saved disabled/adaptive values. Reasoning-effort mode is
separate from `--effort-mode fallback|force`, which governs the default effort.
`--allow-metered-targets on|off` grants or clears operator consent for marked combo targets on a loopback-only proxy; public and linked callers still need configured-key consent.
`--native-alias on|off` preserves explicit false; the legacy bare flag means true.
Turning it off may require the intended alias clear, `--native-alias off --alias -`,
to avoid retaining an incompatible native alias. Set/rename is an upsert without
CAS, so re-read after changes. The receipt is `{success, id, model, combo, catalogRefresh}`;
skipped, failed or degraded catalog refresh returns nonzero after saving.

### Observe combo decision statistics

```bash
ocx combo stats reliable --range 30d --json
```

Use the exact stored combo ID from list/show, not its public model or alias.
Ranges are `7d`, `30d` (default), and `all`. This reads recorded JEV observations
without running a paid decision probe. Inspect decisions, model attempts,
measured attempts, model tokens and decision tokens separately. Keep the
`measuredModelAttempts/modelAttempts` and `decisionUsageReported/decisions`
coverage ratios with the totals. Nullable averages are unavailable, not zero.
Preserve `usageIncomplete`, `historyTruncated`, `entriesTruncated`, dropped-entry
counts and snapshot-window boundaries. Zero observations do not prove success.
There is no monetary cost or comparative savings field in this report.

See [Combos](/guides/combos/) for routing behavior and configuration guidance.

## Routing profiles

Existing profiles support inspection and evaluation through the live API:

```bash
ocx route policy list --json
ocx route policy show reliable --json
ocx route policy dry-run reliable --model-context 128000 --tools --image --structured-output --json
```

Only run this evaluation with authority to activate Lab on the target. The management POST can activate Lab and start automation that is already enabled there, including upstream probes. Use list/show for observation without that activation effect.

Replace `reliable` with a listed ID. `evaluate` is an alias for `dry-run`; both
send requirements to the saved profile's evaluator without an inference request.
Creation, update and deletion use the explicit file/revision workflow below.
Combo writes edit a separate resource. Missing profiles return exit 4 and missing
operands return 2.

### Edit a routing profile with its observed revision

Create/update can activate Lab and already-enabled automation, including upstream
probes. Only run them with that authority. List/show are observational; first
read offline help and save the intended profile:

```bash
ocx route policy update --help
ocx route policy show reliable --json > profile.observed.json
jq 'del(.id, .model, .revision) | if .alias == null then del(.alias) else . end' profile.observed.json > profile.next.json
```

Edit and review the next file; keep the observed file unchanged. Input contains
only editable `alias`, `candidates`, `require`, `optimize`, `limits`,
`unknownEvidence`, and `compatibility` with supported nested fields. `id`, `model`,
`revision`, unknown keys and null alias are not editable input. The server still
validates provider, alias and policy semantics. `--file -` accepts piped stdin;
regular UTF-8 files/stdin have the 4 MiB and 30-second bounded read contract.

```bash
ocx route policy update reliable --file profile.next.json --expected-revision '<exact-revision-from-observed-show>' --json
ocx route policy show reliable --json
```

Use the original opaque revision explicitly. HTTP 409 / exit 5 means read show
again, review concurrent changes and rebuild the edit. Never silently fetch a
replacement revision, retry or convert update into create. For an authorized new
ID use `ocx route policy create <new-id> --file profile.next.json --json` without a
revision. Authorized removal is `ocx route policy remove <id> --yes --json` and
has no revision guard.

Create/update returns `{success, id, model, profile, catalogRefresh}` with the new
`profile.revision`; remove returns `{success, id, catalogRefresh}`. Only committed,
nondegraded refresh exits 0. A saved receipt with skipped/failed/degraded refresh
exits 1: inspect before recovery instead of repeating the configuration write.

## Compatibility Lab

Lab is local inspection **and** explicit evidence/automation management. Reads
use the local projection and do not require a running management API:

```bash
ocx lab status --json
ocx lab catalog --json
ocx lab subjects --limit 10 --json
ocx lab automation status --json
ocx lab automation runs --limit 10 --json
ocx lab public community --json
```

`subject`, `observations`, `event`, `artifact`, and `production-signals` follow
local evidence lineage. The public family offers preview/export by repeated
`--event <id>`, verification/import through `--file <bundle.json>`, and community
context. Export and import write local evidence. Verification can print its
result and still exit nonzero when the bundle is not cryptographically valid.

Automation enable/disable changes local policy; manual `lab run` selects a layer
and scenario and may spend upstream quota. Read `ocx help lab` and the relevant
leaf before these authorized operations. A saved local policy does not prove
that a separately running proxy's scheduler adopted it. Full automation policy
editing and run cancellation are not exposed by these CLI controls.

## Observability and debug

### `ocx observe <logs|usage|storage|memory|debug|claude-inbound|injection> ...`

Inspect proxy requests, usage, storage, memory, and debug data. The direct aliases are:

| Alias | Equivalent resource |
| --- | --- |
| `ocx logs [filters] [--follow] [--json|--jsonl|--events]` | `ocx observe logs` |
| `ocx usage compare [--range <today|1d|7d|30d>] [--json]` | `ocx observe usage compare` |
