---
title: Sub-agent Surface (v1 / base / v2)
description: Control how Codex spawns and manages sub-agents across all models.
---

## What sub-agents are

A sub-agent is a separate Codex worker that the main agent can create for a focused task. It has its
own context and tools, so several independent tasks can run in parallel. opencodex controls which
Codex collaboration surface exposes those workers, which models Codex offers for them, and how a
failed model can fall back. It does not decide when your main agent must delegate.

## Modes

Choose the mode for **new sessions**. Existing sessions keep the surface they started with.

| Mode | What Codex gets | Who should pick it |
| --- | --- | --- |
| **v1** | Classic namespaced `spawn_agent`, `send_input`, `resume_agent`, and `close_agent` tools. A spawn can select another model directly. | Beginners who need reliable delegation across different providers, especially native-to-routed children. |
| **base** (default) | Upstream model pins: GPT-5.6 Sol/Terra use v2, Luna uses v1, and unpinned models follow Codex's `multi_agent_v2` feature flag. | Most users. It follows Codex's intended surface for each model without forcing one globally. |
| **v2** | Flat `spawn_agent`, `send_message`, `followup_task`, `interrupt_agent`, and agent-list tools, with concurrent sessions. | Users who want the newer concurrent workflow and understand model inheritance and the encrypted-task limitation below. |

On **v2**, an optional **Keep ChatGPT on v1** switch (`keepNativeChatGptOnV1`) leaves Sol/Terra
on the v1 surface so they can still spawn Grok or Claude. ChatGPT-native parents encrypt v2
`NEW_TASK` bodies; routed models cannot read them. Routed parents stay on v2, where child tasks
are plaintext. OpenCodex disables the global `multi_agent_v2` override for this hybrid because
Codex applies that override before per-model catalog pins. This is a switch *inside* v2, not a
fourth catalog mode.

:::tip[Not sure?]
Start with **base**. Choose **v1** when cross-provider delegation must work predictably. Force **v2**
only when you specifically want its newer session model across every catalog entry.
:::

## How it works

The selected mode controls the `multi_agent_version` field in every catalog entry Codex reads:

- **v1** stamps `multi_agent_version = "v1"` on every model.
- **base** restores upstream pins. Unpinned entries follow the native `multi_agent_v2` feature flag.
- **v2** stamps `multi_agent_version = "v2"` on every model, except when **Keep ChatGPT on v1** is enabled: ChatGPT-native rows stay `"v1"` and routed or combo rows stay `"v2"`.

opencodex applies this as the final pass to both the live `/v1/models` catalog and the catalog synced
to disk. That is why a mode change affects newly created App, CLI, and TUI sessions consistently.

For a v2 roster, eligibility has three states: an entry stamped `"v2"`, explicitly set to `null`, or
with no `multi_agent_version` field is eligible. A genuine `"v1"` pin is excluded because it states
that the model belongs to the other collaboration surface.

## Delegation model and effort

The dashboard's **Sub-agent delegation** controls three related settings:

- `injectionModel` is the preferred worker model named in opencodex guidance.
- `injectionEffort` is the optional `reasoning_effort` to request for that model.
- `injectionPrompt` replaces the built-in v2 guidance text.

`multiAgentGuidanceEnabled` defaults to on and is the master switch for opencodex-authored guidance
on both surfaces. Turning it off suppresses both the v2 designation block and v1 proactive text.

For array-form stateless Responses requests, opencodex places generated guidance after leading
system and developer metadata, including developer `additional_tools`, and before conversational
input. Stateful `previous_response_id` continuations reuse tagged guidance only when it matches the latest
tagged item in their trusted replay prefix. Other generated guidance is reused when an exact generated
developer item exists in that prefix. When guidance changes, leading tool protocol stays first and
the replacement is inserted before current conversational input.

These are instructions to the main agent, not a proxy-side spawn router. On v2, a full-history fork
inherits the parent model and rejects model or effort overrides. Guidance therefore tells Codex to
use `fork_turns: "none"` (or a positive partial turn count such as `"3"`) when passing `model` or
`reasoning_effort`, and to make the task message self-contained.

Custom `injectionPrompt` text can use all four placeholders:

| Placeholder | Replaced with |
| --- | --- |
| `{{model}}` | The effective preferred model for this request. A bare native `injectionModel` is account-qualified only when the request itself targets an explicit account selector. An unresolved or ambiguous bare value becomes an empty string; an unresolved explicit account-qualified or routed id remains unchanged |
| `{{effort}}` | The configured `injectionEffort`, or an empty string |
| `{{roster}}` | The resolved picker-visible, surface-compatible roster |
| `{{fallback}}` | The configured global fallback guidance |

The built-in v2 guidance has a 700-character budget. If it would exceed the budget, opencodex drops
the roster first rather than truncating the core spawn instructions. Built-in guidance fires only
when a preferred model, eligible roster, or fallback chain resolves. A configured `injectionModel`
is sufficient to render a custom prompt; if a bare value cannot resolve uniquely, `{{model}}`
expands to an empty string.

On v1, opencodex injects only the upstream-style proactive delegation guidance at `max` or `ultra`
effort. It does not add a preferred model, roster, fallback list, or custom prompt on v1.

The default-off `syncCodexSubagentDefaults` option is separate from guidance. When opencodex owns
active Codex routing, sync or restart can write the selected values as marker-owned
`[agents] default_subagent_model` and `default_subagent_reasoning_effort` entries in Codex TOML.
opencodex updates or removes only fields bearing its markers. If either target field is user-owned,
the pair is left unchanged rather than partially written; ambiguous TOML is rejected without a
write. External provider managers and user-owned root routing also remain authoritative.

## Fallback chains

For a spawned worker, opencodex builds this priority order:

1. The requested primary model.
2. A per-model chain from `subagentModelFallbackByModel` in opencodex config, keyed by
   the requested primary model.
3. The global `subagentModelFallback` list in opencodex config.

Per-role fallback chains belong in opencodex config, not in
`$CODEX_HOME/agents/*.toml`. Codex 0.146+ strictly deserializes agent role files and
rejects `model_fallback` as an unknown field, which skips the entire role definition
(#1190). opencodex can still read a legacy `model_fallback` line from the TOML for
backwards compatibility, but `ocx doctor` warns about it and Codex itself will ignore
the affected role.

Duplicate model ids are removed while preserving the first occurrence. During selection, opencodex
skips candidates that are disabled, unroutable, backed by a disabled provider, marked unhealthy,
inside a cooldown, missing a usable pooled Codex account, or beyond the configured quota threshold.
Availability probes are cached for `subagentModelFallbackPollMs` (60 seconds by default).

Fallback does not make incompatible encrypted tasks readable. When the child task is encrypted for
ChatGPT, selection is restricted to canonical native ChatGPT targets even if an external model
appears earlier in the chain.

## Encrypted v2 task delivery

Codex may send a v2 native-to-routed child task only as backend-encrypted `encrypted_content`. That
payload can be read by the native ChatGPT backend, but not by an external provider. This is the
known [#92 limitation](https://github.com/lidge-jun/opencodex/issues/92).

opencodex fails safely instead of forwarding an empty or unreadable task:

- A direct non-native route returns HTTP 400 with
  `error.code = "unreadable_encrypted_agent_task"` and does not echo the ciphertext.
- A combo considers only canonical native ChatGPT targets for that task, including retries. If none
  is available, it returns the same 400 error.
- A readable plaintext task keeps the normal route and fallback behavior.

Recovery options are to select a native ChatGPT child, add a native ChatGPT target to the combo, use
v1 for heterogeneous-provider delegation, or resend the task as plaintext v2 `agent_message`
content when you control the caller.

An experimental, disabled-by-default `agentTaskRecovery` option can recover this specific native-
to-routed shape through a raw Responses passthrough to the fixed ChatGPT `/responses` endpoint using
the incoming credential shape used by the canonical `openai` provider with `authMode: "forward"`.
Recovery is available only while the proxy is bound to loopback. It never substitutes API-key
authentication, another provider credential, or another Codex account. Only `authorization`, matching
`chatgpt-account-id`, `originator`, and optional `openai-beta`/`user-agent` metadata are forwarded;
`content-type` and `accept` are generated locally, and no other caller headers cross the boundary.
It consumes quota, adds latency, briefly retains recovered plaintext in a bounded in-memory cache,
and depends on undocumented ChatGPT backend behavior. Because a model returns the recovered text,
byte-for-byte fidelity is not guaranteed. It rejects generic/API-key proxy callers and preserves
`unreadable_encrypted_agent_task` on any failure. See
[Agent configuration: Encrypted v2 task recovery](/reference/configuration/agents/#encrypted-v2-task-recovery)
for the full trust boundary and configuration.
Combo routing remains unchanged and continues to consider only canonical native ChatGPT targets for
encrypted tasks.

## Changing the mode

### GUI

- **Dashboard** → first stat cell: choose **v1**, **base**, or **v2**.
- **Models** → top-row segmented control: choose the same global mode.
- **Dashboard** → **Sub-agent delegation**: set guidance model/effort and the native-default opt-in.
- **Subagents**: choose and order the roster and configure the global fallback chain.

### CLI

Use `ocx v2` for the collaboration surface and native feature settings:

```bash
ocx v2 status
ocx v2 mode v1
ocx v2 mode default
ocx v2 mode v2
ocx v2 threads 8
```

Use `ocx agent` for delegation, roster, effort-cap, and fallback settings:

```bash
ocx agent status
ocx agent injection set --model anthropic/claude-sonnet-5 --effort xhigh
ocx agent subagents set gpt-5.6-sol,anthropic/claude-sonnet-5
ocx agent fallback set gpt-5.4-mini,xai/grok-4.5 --poll-ms 60000
ocx agent effort set --subagent max
```

Pass `-` to clear a nullable `ocx agent injection` value, or use the relevant `clear` action for a
roster or fallback list. See the [CLI reference](/reference/cli/) for all command families.

### API

The management API exposes matching `GET` and `PUT` endpoints:

| Endpoint | Manages |
| --- | --- |
| `/api/v2` | Surface mode, native feature flag, and thread settings |
| `/api/injection-model` | Preferred model, effort, custom prompt, guidance, and native-default sync |
| `/api/effort-caps` | Main-agent and sub-agent effort ceilings |
| `/api/subagent-models` | Ordered roster of up to five models |
| `/api/subagent-model-fallback` | Global fallback order and poll interval |

For example:

```bash
curl -X PUT http://localhost:10100/api/v2 \
  -H 'Content-Type: application/json' \
  -d '{"multiAgentMode":"v2"}'

curl -X PUT http://localhost:10100/api/injection-model \
  -H 'Content-Type: application/json' \
  -d '{"model":"anthropic/claude-sonnet-5","effort":"xhigh"}'
```

## FAQ

### Does choosing a delegation model force Codex to spawn it?

No. Guidance can recommend a model, and native-default sync can provide a Codex default, but the
main agent still decides whether to delegate.

### Why did my v2 child use the parent model?

A full-history v2 fork inherits the parent model. Use a spawn that sets `fork_turns` to `"none"` or
a positive partial count before passing a model or effort override.

### Why is a configured model missing from the v2 roster?

It may be picker-hidden, outside the five-model display limit, missing from the catalog, or pinned
to v1. A `"v2"`, `null`, or absent surface value is eligible; a real `"v1"` pin is not.

### Do mode changes affect running sessions?

No. Start a new Codex session after changing the mode. If a long-running App host still shows stale
catalog state, run `ocx sync` and restart that Codex surface.

### What happens when opencodex cannot trust the catalog?

opencodex compares the on-disk model catalog against the start time of every Codex app-server owned
by the current user, producing one of four states:

| State | Meaning | v2 guidance |
|---|---|---|
| `fresh` | Every app-server started after the catalog was written | Full guidance: preferred model, roster, fallbacks |
| `not_running` | No app-server detected | Full guidance |
| `stale` | At least one app-server predates the catalog | **No opencodex-authored model guidance** |
| `unknown` | The comparison could not be made | **No opencodex-authored model guidance** |

For `stale` and `unknown`, opencodex withholds its own disk-derived claims — preferred model, roster,
fallback and custom guidance — because the running Codex may not be able to spawn what the disk
catalog advertises.

It does **not** instruct the model to stop setting `model` or `reasoning_effort`. That observation is
global across every app-server for the user, while an inbound request carries no sender identity, so
a stale process cannot be attributed to the request in front of us. Prohibiting overrides on that
basis would block options the active `spawn_agent` tool legitimately advertises, for a session that
may well be fresh. The active tool schema stays authoritative.

`unknown` is not a synonym for `stale`. It means the comparison itself failed — an unreadable catalog
timestamp, an unreadable process start time, or a failed process enumeration — and it is reported
separately by `ocx doctor`. `stale` clears only after every detected Codex app-server starts after
the final catalog write; it does not necessarily clear `unknown`.

On Windows, this advisory check uses asynchronous PowerShell/CIM discovery on the v2 request path.
Concurrent cold checks share one in-flight discovery. Observed states are cached for five seconds;
an `unknown` failure is cached for only 250 milliseconds so a transient CIM error retries quickly. A
slow or failing CIM query can delay or suppress only OpenCodex-authored model guidance; it does not
block the Bun event loop, `/healthz`, or unrelated proxy traffic. Explicit CLI/service lifecycle
operations retain the synchronous, fail-closed process collector because they may signal processes.

Only a real change counts. A sync whose result is byte-identical to the catalog already on disk
leaves the file untouched, so restarting the proxy or re-syncing an unchanged model set does not
make a running Codex look stale.

### Reasoning effort

`injectionEffort` affects only delegated-worker guidance and, when explicitly enabled, native Codex
sub-agent defaults. It does not change the parent session's effort. `ultra` is a client-facing top
tier that Codex converts to `max`; opencodex then maps or clamps the value for the selected provider.

### Context cap

The model context cap is independent of sub-agent mode. Configure it on the Models page; native
OpenAI models retain their real context windows.
