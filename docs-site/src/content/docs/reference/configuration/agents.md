---
title: Agent Configuration
description: Multi-agent surfaces, delegation guidance, preferred models, fallback chains, native-default sync, and effort caps.
---

Agent settings control which Codex collaboration surface is advertised and how opencodex guides,
routes, and limits delegated work.

## Agent fields

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `multiAgentMode?` | `"v1" \| "default" \| "v2"` | `"default"` | `v1` stamps every catalog model as v1; `v2` stamps every model as v2. `default` restores upstream pins (Sol/Terra v2, Luna v1) and otherwise follows the native `multi_agent_v2` flag. Applies to new sessions. |
| `keepNativeChatGptOnV1?` | `boolean` | `false` | When `multiAgentMode` is `"v2"`, disable the global V2 override, stamp ChatGPT-native rows as v1, and keep routed rows on v2. Codex resolves the global override before catalog pins, so both parts are required for a ChatGPT parent to spawn routed children without backend-encrypted tasks ([#92](https://github.com/lidge-jun/opencodex/issues/92)). Ignored in `v1` and `default`. |
| `subagentModels?` | `string[]` | `gpt-5.5`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.4-mini` | Up to five bare native, account-qualified `<selector>/<native-openai-model>`, or routed `provider/model` ids featured first in the sub-agent picker. The dashboard offers only bare native and routed ids and omits exact account-qualified choices when it saves; use `ocx agent subagents set` or edit the configuration for exact choices. An explicit empty list is preserved. |
| `injectionModel?` | `string` | — | Preferred native or routed sub-agent model used in proxy-authored v2 delegation guidance. |
| `injectionEffort?` | `string` | — | Preferred effort (`low` through `ultra`), meaningful only with `injectionModel`. |
| `injectionPrompt?` | `string` | — | Replaces the built-in v2 guidance body. Supports `{{model}}`, `{{effort}}`, `{{roster}}`, and `{{fallback}}`. A configured `injectionModel` is sufficient to render the custom prompt. |
| `multiAgentGuidanceEnabled?` | `boolean` | `true` | Controls only opencodex-authored v1/v2 developer guidance; it does not change native agent defaults, tools, routing, rosters, or effort caps. |
| `syncCodexSubagentDefaults?` | `boolean` | `false` | Opt into writing `injectionModel` and optional `injectionEffort` as Codex's native defaults during sync/restart. Requires `injectionModel`. |
| `subagentModelFallback?` | `string[]` | `[]` | Priority-ordered global fallback models for spawned child turns. |
| `subagentModelFallbackByModel?` | `Record<string, string[]>` | `{}` | Per-primary-model fallback chains, keyed by the requested primary model id. This is the supported home for per-role fallback metadata; `model_fallback` inside Codex agent TOML makes Codex 0.146+ skip the role (#1190). |
| `subagentModelFallbackPollMs?` | `number` | `60000` | Availability-probe cache interval. Values below 1000 ms fall back to the default. |
| `effortCap?` | `string` | — | Hard ceiling for qualifying v2 main turns and marked spawned-child turns. Accepts `low` through `ultra`. |
| `subagentEffortCap?` | `string` | — | Additional ceiling for spawned-child turns only. When both caps apply, the lower wins. |
| `agentTaskRecovery?` | `object` | — | Experimental opt-in recovery for backend-encrypted v2 tasks sent to routed providers. Disabled unless `enabled: true`; see [Encrypted v2 task recovery](#encrypted-v2-task-recovery). |

Manage the surface with the dashboard or
`ocx v2 status|on|off|mode <v1|default|v2>|keep-native-v1 <on|off>|threads <n>|mode-hint <text|--clear>`.
Mode changes apply to new sessions. `maxConcurrentThreadsPerSession` is a `PUT /api/v2` field, not a
`config.json` key; `ocx v2 threads <n>` writes `max_concurrent_threads_per_session` under
`[features.multi_agent_v2]` in Codex's `$CODEX_HOME/config.toml` after v2 is enabled.

**Ultra mode** (the Subagents dashboard toggle, `PUT /api/v2` field
`multiAgentModeHintText`, and `ocx v2 mode-hint`) writes
`features.multi_agent_v2.multi_agent_mode_hint_text` in Codex's
`$CODEX_HOME/config.toml`. The CLI `ocx v2 mode-hint` command persists this key even
when `multi_agent_v2` is disabled; it does not toggle the feature. The hint overrides
codex-rs's effort-derived multi-agent policy, so any model and any reasoning effort
receives the Proactive delegation prompt; it does **not** change reasoning effort.
A `null` value removes the key so the effort-derived policy (ultra = proactive,
otherwise explicit) resumes; empty or whitespace-only values are rejected because a
present empty override would suppress even the ultra-derived Proactive message. The
Subagents dashboard's Ultra mode **on** toggle requires both the native feature and
an explicit v2 surface (`multiAgentMode: "v2"`, equivalent to `ocx v2 mode v2`);
`ocx v2 on` alone does not satisfy that dashboard gate.

The management API exposes `GET`/`PUT /api/v2`, `/api/injection-model`, `/api/effort-caps`,
`/api/subagent-models`, and `/api/subagent-model-fallback`. Injection-model updates are partial;
the custom prompt is the `prompt` field on that API.

The Codex Auth page can also toggle Codex's own `default_mode_request_user_input`
feature flag (`GET`/`PUT /api/codex-auth/features/default-mode-request-user-input`). Enabling it
adds `[features] default_mode_request_user_input = true` to Codex's
`$CODEX_HOME/config.toml` through the official `codex features enable|disable` CLI
(format-preserving edit, removed again when disabled), which lets Codex pause a
Default-mode session and ask you questions with the `request_user_input` tool. The
flag is under development upstream and only applies to new sessions; the toggle fails
loudly when the installed Codex build does not know the flag yet.

## Roster and guidance

The effective v2 roster is the configured, picker-visible, priority-sorted first five models that
are compatible with v2 and present in the injected catalog. V2 eligibility treats an explicit `"v2"`,
`null`, or absent upstream pin as eligible; a real `"v1"` pin is excluded. Excluded entries remain in
configuration so they can become eligible later.

Surface detection uses tool shape. A namespaced `spawn_agent` with `send_input`, `resume_agent`, or
`close_agent` is v1. A flat `spawn_agent` with `send_message`, `followup_task`, `interrupt_agent`, or
`list_agents` is v2.

V1 guidance is proactive text only at `max` or `ultra`. V2 receives a proxy-authored developer
message only when a preferred model, eligible roster, or fallback chain exists. Built-in v2 guidance
has a 700-character budget and drops the roster first if necessary. Guidance is deduplicated across
replay prefixes and inserted before a trailing `compaction_trigger`.

`injectionModel` and `injectionEffort` are advisory unless native-default sync is enabled. The built-in
v2 text asks Codex to pass supported model/effort overrides to `spawn_agent` with
`fork_turns: "none"`. A custom `injectionPrompt` substitutes missing values with an empty string.

## Native Codex default sync

When enabled, `syncCodexSubagentDefaults` writes marker-owned
`[agents] default_subagent_model` and `default_subagent_reasoning_effort` fields. Existing unmarked
user-owned target fields are treated as conflicts and remain authoritative; partial or ambiguous TOML
writes fail closed. Clearing `injectionModel` also clears the opt-in. These defaults affect newly
created Codex tasks and do not cause delegation by themselves.

## Fallback chain

Spawned-child fallback order is:

1. the requested primary model;
2. per-model chains from `subagentModelFallbackByModel` (keyed by the primary model); then
3. global `subagentModelFallback` entries.

Per-role fallback chains must live in opencodex config. Writing `model_fallback` into
`$CODEX_HOME/agents/*.toml` makes Codex 0.146+ reject the whole role file as an unknown
field and skip the role (#1190). A legacy `model_fallback` line in the TOML is still
read for backwards compatibility, but `ocx doctor` flags it.

opencodex skips disabled, unroutable, unhealthy, cooling-down, or quota-threshold candidates. The
availability snapshot is cached for `subagentModelFallbackPollMs`. Encrypted child tasks can restrict
the chain to canonical native ChatGPT targets; if none can read the encrypted payload, the request
fails instead of routing unreadable ciphertext elsewhere.

```json
{
  "multiAgentMode": "v2",
  "subagentModels": ["gpt-5.5", "anthropic/claude-sonnet-5"],
  "injectionModel": "gpt-5.5",
  "injectionEffort": "high",
  "syncCodexSubagentDefaults": true,
  "subagentModelFallback": ["gpt-5.4-mini"],
  "subagentModelFallbackByModel": {
    "gpt-5.5": ["gpt-5.4-mini"]
  },
  "subagentModelFallbackPollMs": 60000,
  "subagentEffortCap": "high"
}
```

## Encrypted v2 task recovery

`agentTaskRecovery` is an experimental compatibility path for a native ChatGPT parent spawning a
routed v2 child. It is disabled by default. When explicitly enabled and the final routed child task
contains an otherwise unreadable Fernet payload, opencodex uses a raw Responses passthrough request
to the fixed `https://chatgpt.com/backend-api/codex/responses` endpoint with forward-mode
authentication. ChatGPT returns the plaintext assignment through a forced function call; opencodex
then converts only that task item to a standard user message before routed-provider dispatch.

This is not local decryption and does not fix the Codex wire protocol. It depends on undocumented
ChatGPT backend behavior and may stop working after a backend change. The recovered assignment is
model output, not a cryptographically verified plaintext, so byte-for-byte fidelity is not
guaranteed. A scoped cache miss may add an authenticated ChatGPT request, consume account quota, and
add latency before the routed request. Concurrent requests for the same scoped task share one
recovery request. Startup prints a warning whenever the feature is enabled.

Admission and retention are deliberately narrow:

- recovery is available only while the proxy is bound to loopback;
- only a native Codex caller with a matching ChatGPT bearer/account pair is eligible. This is the
  credential shape used by the canonical `openai` provider with `authMode: "forward"`; recovery uses
  only the pair on the incoming request and never substitutes API-key authentication, another
  provider credential, or another Codex account;
- callers using `x-opencodex-api-key`, `x-api-key`, generic API credentials, or a proxy admission
  secret keep the existing `unreadable_encrypted_agent_task` failure;
- raw ChatGPT credentials are sent only to the hard-coded ChatGPT endpoint and are never placed in
  the request body, logs, cache keys, or provider request; the in-memory cache scope uses only a
  process-random keyed digest of the caller credential and account;
- the recovery request forwards only `authorization`, the matching `chatgpt-account-id`,
  `originator`, and optional `openai-beta` and `user-agent` metadata; opencodex sets `content-type`
  and `accept` itself, and no other caller headers cross this boundary;
- recovered plaintext is never logged or persisted; the process-local cache is credential-, parent-
  thread-, and ciphertext-scoped, expires after 15 minutes, and is bounded by both configured entry
  count (200 by default, 512 maximum) and 8 MiB total;
- any malformed envelope, failed recovery, timeout, or validation failure preserves the existing
  fail-closed error; client cancellation returns 499. Neither path forwards ciphertext to the
  routed provider.

### Threat model

This path assumes the local native Codex caller already holds a valid ChatGPT credential and that
the fixed ChatGPT endpoint is trusted to authenticate it. It protects against generic proxy/API-key
callers using the feature as a plaintext oracle, redirecting credentials to another destination,
cross-account or cross-thread cache reuse, and sensitive-data logging or persistence. Admission
checks token issuer, audience, Codex client, expiry/not-before bounds, and exact account match before
every cache lookup; the endpoint remains the signature authority.

It does not protect against another process running as the same OS user, a compromised ChatGPT
backend or recovery model, prompt injection inside the encrypted task, model transcription errors,
or memory inspection of the running proxy. Recovery output must therefore be treated as untrusted
model output rather than authenticated plaintext.

```json
{
  "agentTaskRecovery": {
    "enabled": true,
    "model": "gpt-5.6-sol",
    "timeoutMs": 45000,
    "cacheEntries": 200
  }
}
```

Enable this only when the additional authenticated request, quota use, plaintext-in-process boundary,
and private-backend dependency are acceptable. Prefer a native ChatGPT child or v1 heterogeneous
delegation when they are not.

This recovery path applies to direct-routed children. At most 32 recovery requests can be active at
once; additional misses fail closed. Combo routing keeps its existing native-only filter for
encrypted tasks and does not invoke recovery.

## Effort caps

Caps apply only to the v2 collaboration feature: a main turn qualifies when its tools expose v2,
while a child qualifies when it carries exact codex-rs `x-openai-subagent: collab_spawn` or
`"subagent_kind": "thread_spawn"` markers in `x-codex-turn-metadata`, even
if leaf tools no longer expose collaboration. V1 main turns, `multiAgentMode: "v1"`, compaction,
review, and memory-consolidation turns bypass caps.

Caps only lower effort. They snap to the highest advertised rung at or below the cap. If a model has
no effort control or no supported rung fits, opencodex removes the effort and lets the provider default
apply. `max` and `ultra` are accepted, while the dashboard offers `low` through `xhigh`.

For a beginner-oriented explanation of v1, default, and v2 behavior, see
[Sub-agent surfaces](/guides/sub-agent-surface/).
