# 000 — Research: GPT-6-Astra shipped, and the adapter_eof report

Two questions, deliberately in one unit because the user hit them in the same breath
and the second one turned out NOT to be caused by the first.

## Q1: Astra shipped. What does upstream actually say?

Source of truth: `~/Developer/codex/121_openai-codex`, `origin/main`. Two commits landed
it on 2026-09-03:

- `ed391d4dd` — "Add GPT-6-Astra to the bundled model catalog (#42607)"
- `1f7b99922` — "Add GPT-6-Astra to Amazon Bedrock catalogs (#42619)"

Read with `git show origin/main:codex-rs/models-manager/models.json`. The real row:

| field | upstream value |
|---|---|
| `slug` | `gpt-6-astra` |
| `display_name` | `GPT-6-Astra` |
| `description` | `Our most capable model for complex, demanding work.` |
| `context_window` | `272000` |
| `max_context_window` | `872000` |
| `comp_hash` | `3000` |
| `visibility` | `hide` |
| `priority` | `1` |
| `minimal_client_version` | `0.153.0` |
| `shell_type` | `unified_exec` |
| `tool_mode` | `code_mode_only` |
| `default_reasoning_level` | `low` |
| `supported_reasoning_levels` | low, medium, high, xhigh, max, ultra |
| `multi_agent_version` | `v2` |
| `multi_agent_reasoning_effort` | `xhigh` |
| `prefer_websockets` | `true` |
| `use_responses_lite` | `true` |
| `support_verbosity` / `default_verbosity` | `true` / `low` |
| `supports_image_detail_original` | `true` |
| `node_repl_auto_review_required` | `true` |
| `available_in_plans` | 23 plans incl. `free`, `go`, `plus`, `pro`, `team`, `enterprise` |

It also carries its OWN `base_instructions` / `model_messages` — a GPT-6 agent prompt,
not Sol's.

Bedrock side (`#42619`): `openai.gpt-6-astra`, with `global.` and `us.` runtime prefixes.
Out of scope here; opencodex does not route Bedrock.

## Q1a: What does opencodex currently claim?

Earlier in this same session Astra was registered SPECULATIVELY from a leaked slug
(PR #3410, on `dev` as `db2e2eb47`). That guess is now measurably wrong. Live catalog
row read from `~/.codex/opencodex-catalog.json`:

| field | opencodex now | upstream | verdict |
|---|---|---|---|
| `display_name` | `GPT-6 Astra` | `GPT-6-Astra` | WRONG (space vs hyphen) |
| `description` | "…leaked API identifier; presentation provisional" | "Our most capable model for complex, demanding work." | WRONG |
| `context_window` (resolved) | `272000` | `272000` | OK — see correction below |
| long window / `max_context_window` | `922000` | `872000` | WRONG (over-advertises by 50k) |
| `priority` | `105` | `1` | WRONG |
| `visibility` | `list` | `hide` | deliberate divergence, argued in 010 |
| `comp_hash`, `shell_type`, `tool_mode`, ladder | match | match | OK (inherited from Sol, coincidentally right) — but the ladder is FRAGILE, see 015/C3 |

**Correction (audit round 1).** An earlier draft of this table listed `context_window: 922000`
as drift. Measured: `nativeOpenAiContextWindow("gpt-6-astra")` is already **272,000**,
because `NATIVE_GPT56_CONTEXT_WINDOW` is 272,000. The 922,000 that appears in
`~/.codex/opencodex-catalog.json` is the materialized **long window** (the 1M-opt-in
ceiling), so the drift is real but sits on `max_context_window`, not the default window.

`minimal_client_version` was also listed as MISSING. It is out of reach by design:
`upstreamNativeEntry` deletes that key from every result it returns, so no change inside
this unit's mechanism can populate it. Dropped from the drift list rather than left as a
criterion the plan cannot meet.

Root cause of the drift: `src/codex/data/upstream-models.json` has 8 rows and Astra is
not one of them (`gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`, `gpt-5.4`,
`gpt-5.4-mini`, `gpt-5.2`, `codex-auto-review`). So `NATIVE_OPENAI_CAPABILITY_SOURCES`
in [native-models.ts](../../../src/codex/catalog/native-models.ts) borrows Sol's pinned
snapshot, and `NATIVE_OPENAI_ALIAS_PRESENTATION` overlays a hand-written label. Both were
correct answers to "no upstream row exists"; neither is correct now that one does.

Note the local snapshot's Sol row reads `context_window: 372000`, while upstream main now
reads `272000` for Sol too — the pin is stale beyond Astra. Out of scope for this unit;
recorded so the next reader does not mistake it for a new defect.

## Q2: "Stream disconnected before completion … reason: adapter_eof"

The user reported this live, alongside a "Reconnecting… 5/5" indicator, in the same
message as the Astra request. The instinct is that ungating Astra caused it. The evidence
says otherwise.

### What adapter_eof means in this codebase

It is opencodex's OWN synthesized terminal, not an upstream error string. Three emitters:

- [bridge.ts](../../../src/bridge.ts) streaming path — when the adapter generator returns
  without a done/error event, the bridge closes open items and emits
  `response.incomplete` with `incomplete_details.reason = "adapter_eof"` so codex-rs never
  hits its parser's "stream closed before response.completed".
- [bridge.ts](../../../src/bridge.ts) buffered path — same reason string for the non-stream
  surface, so one condition produces one signal on both surfaces.
- [relay.ts](../../../src/server/relay.ts) — the relay surface's equivalent.

Consumed at [combo-stream-preflight.ts](../../../src/server/responses/combo-stream-preflight.ts).

So `adapter_eof` = "the upstream stream ended mid-turn without a terminal event". It is a
symptom label, and its cause is always upstream or transport, never the catalog.

### Evidence from the local request history

`~/.opencodex/routing-history.sqlite`, table `requests`:

- `close_reason = 'adapter_eof'`: **0 rows for all time** (not just 24h). Read this as a
  caution about the instrument rather than as exoneration — 25,493 rows carry a NULL
  `close_reason`, so the table may never record this condition. The positive evidence in
  021 is what actually settles the question. Query note: the time column is epoch-ms
  `timestamp`; there is no `created_at`.
- Astra requests exist and all failed BEFORE this unit's window, at 2026-09-03 20:26 on
  `openai-p3b640f`, as `502 / upstream_server_error` — the pre-release probes
  (`gpt-6-astra`, `astra`, `gpt-6`, `gpt-5.7-astra`, `mewfour`, `gpt-5.6-cyber`), each
  ~1s. That is the slug 404/502ing before launch, which is exactly what the prereg unit
  predicted. None of them is an `adapter_eof`.
- The session actually producing the user's error is `anthropic / claude-fable-5-1`, and
  its `total_tokens` climbs to **852,994** by 04:12:56 local. The long tail includes a
  45,900 ms turn with `first_output_ms = 45,877` — i.e. 46 seconds before the first byte.

That is the shape of a very large context on a long-lived stream, and it is the provider
the user's own turn was running on. The "Reconnecting… 5/5" indicator is the client
retrying that dropped stream, not the proxy rejecting a model.

### Working hypothesis (to be proved or refuted in wp3)

`adapter_eof` here is a genuine mid-stream disconnect, surfaced faithfully by the bridge.
If that holds, the correct outcome is NOT a bridge patch — the bridge is doing the one
right thing by refusing to call a truncated turn "completed".

**Resolved in [021](021_wp3_evidence.md):** the disconnect was a local `ocx service`
restart during this session's Astra work, which tore down in-flight streams. The
request table has a five-hour recording gap ending exactly at the current proxy's process
start time. Not an upstream fault, not a code defect, and not Astra.

Explicitly ruled out already: Astra's ungating (no Astra row in any adapter_eof), and the
catalog change from PR #3410 (catalog code emits no terminal events).
