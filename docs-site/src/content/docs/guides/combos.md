---
title: "Combos: failover and load balancing"
description: Route one virtual model to several providers for failover or weighted load balancing.
---

A **combo** is one virtual model that fronts an ordered list of real provider/model targets. Your
client requests `combo/<id>`; opencodex chooses a target, rewrites the request to that concrete
`provider/model`, and can try another target when the first one has a retryable failure.

This is useful when you want either:

- **Failover:** prefer one model, but keep backups ready.
- **Load balancing:** spread successful requests across models or providers in weighted batches.

Combos sit in front of normal provider routing. Read [Model Routing](/guides/model-routing/) first
if `provider/model` selectors are new to you.

## 60-second quickstart

This example creates `combo/main` with Anthropic first and OpenAI second. Both providers must
already exist and be enabled.

```bash
ocx combo set main --targets anthropic/claude-opus-4-8,openai/gpt-5.6-sol
```

The default strategy is failover, so a normal request goes to
`anthropic/claude-opus-4-8`. If that attempt has a retryable failure, opencodex can hop to
`openai/gpt-5.6-sol`.

Use the virtual model anywhere you would normally provide a model id:

```json
{
  "model": "combo/main",
  "input": "Explain why the sky looks blue."
}
```

Confirm the saved definition:

```bash
ocx combo show main
```

:::tip
Start with failover and equal weights. Switch to round-robin only when you intentionally want to
distribute traffic, and add weights only when equal distribution is not appropriate.
:::

## How combo names work

The combo id in `ocx combo set <id>` must start with a letter or number. It may then contain
letters, numbers, `.`, `_`, or `-`, up to 64 characters total. Its canonical model id is always
`combo/<id>`; for example, id `main` becomes `combo/main`.

The `combo/` namespace is reserved while combos are configured. A provider named `combo` cannot
occupy it, and a combo id cannot duplicate a configured provider name.

An optional alias gives the combo a different public model name. An alias:

- uses the same characters as an id;
- may be bare, such as `daily-fast`, or contain one `/`, such as `team/daily-fast`;
- cannot be `combo` or start with `combo/`;
- cannot duplicate another combo alias; and
- cannot be a bare native OpenAI-family name beginning with `gpt-`, `o1-`, `o3-`, `o4-`, or
  `codex-`.

Even when an alias is set, the canonical `combo/<id>` form still resolves. Canonical lookup runs
before alias matching, so an alias cannot take over another combo's canonical id.

:::note
Aliases change the public name clients request; they do not change the combo's stored id or the
concrete provider/model selectors behind it.
:::

## Choose a strategy

### Failover: ordered primary and backups

`failover` selects the first eligible target in configuration order. A target is eligible when its
provider exists, is enabled, is not cooling down, and can handle any special request constraint.
Weights and `stickyLimit` do not affect this strategy.

Given this order:

1. `anthropic/claude-opus-4-8`
2. `openai/gpt-5.6-sol`
3. `google/gemini-3-pro`

each request starts with Anthropic. A retryable Anthropic failure moves that request to OpenAI; a
retryable OpenAI failure can move it to Google. A terminal error stops immediately instead of
trying the remaining targets.

### Round-robin: smooth weighted batches

`round-robin` uses smooth weighted round-robin. A larger target weight gives that target a larger
share over time without sending all of its share as one long block. `stickyLimit` controls how many
successful requests stay on the selected target before the next weighted selection.

Create a 2:1 combo with batches of two successful requests:

```bash
ocx combo set balanced \
  --targets anthropic/claude-opus-4-8:2,openai/gpt-5.6-sol:1 \
  --strategy round-robin \
  --sticky 2
```

Calling the targets **A** (weight 2) and **B** (weight 1), the first six weighted selections are
`A, B, A, A, B, A`. Because `stickyLimit` is 2, each selection stays active for two successful
requests:

| Successful request | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Target | A | A | B | B | A | A | A | A | B | B | A | A |

The long-run share is still 2:1. A retryable failure ends the current sticky batch, cools that
target, and selects another eligible target for the same request.

:::caution
Weights are relative, not percentages. Weights `2,1` and `200,100` express the same ratio. Prefer
small values that communicate intent.
:::

## What happens when a target fails

Combo failures are divided into **hop** failures and **terminal** failures.

| Result | Behavior |
| --- | --- |
| HTTP 401, 403, 404, 408, 429, or any 5xx | Cool the target and hop to the next eligible target. |
| Classified authentication, subscription, quota, rate-limit, overload, or upstream-server error | Cool the target and hop, even when the status alone is not sufficient. |
| Client cancellation (499), `origin_rejected`, cyber-policy refusal, context overflow, or invalid request | Stop and return the error; another target would not make the request valid. |
| Any other unclassified error | Stop and return the error. |

A hopped target enters cooldown for 60 seconds by default. If the upstream response includes a
valid `Retry-After` value, opencodex uses it instead. Numeric seconds and HTTP-date values are
accepted, and every cooldown is capped at 10 minutes.

The current request never retries the same attempted target. Later requests skip it until its
cooldown expires. If no eligible target remains, the proxy returns HTTP 503 with
`error.code = "combo_unavailable"`.

:::note
Failover is intentionally bounded. It helps with target-specific availability, authentication,
quota, and overload failures; it does not hide caller errors or policy refusals.
:::

## Default reasoning effort

`defaultEffort` supplies `reasoning.effort` only when all of these are true:

1. the combo has a non-null default;
2. the caller did not set an effort; and
3. the selected target's catalog advertises that exact effort.

If the request has no `reasoning` object, opencodex creates one. If `reasoning` exists without an
`effort` property, it preserves the other fields and adds the default. A caller-provided effort is
never overwritten.

When target capability is unknown or does not include the configured effort, opencodex omits the
default and leaves the target's own behavior unchanged. Supported values are `low`, `medium`,
`high`, `xhigh`, `max`, and `ultra`; omit the field or set it to `null` to leave effort entirely to
the caller and target.

## Encrypted v2 sub-agent tasks

There is one important limitation for Codex v2 sub-agents ([issue #92](https://github.com/lidge-jun/opencodex/issues/92)).
A native parent can send a newly spawned worker's task only as ciphertext minted for the native
ChatGPT backend. An external provider cannot read that payload.

For such a request, a combo filters its eligible targets to canonical native ChatGPT routes,
including after a retryable failure. If the combo has no decrypt-capable target, opencodex stops
before dispatch and returns HTTP 400:

```json
{
  "error": {
    "type": "invalid_request_error",
    "code": "unreadable_encrypted_agent_task"
  }
}
```

This protects the task from being sent to a provider that would receive no readable instructions.
Readable plaintext tasks use the normal combo strategy.

You have four recovery options:

1. Select a native ChatGPT model for the child.
2. Add a canonical native ChatGPT target to the combo.
3. Use the v1 surface for delegation across different providers.
4. If you control the caller, resend the task as plaintext v2 `agent_message` content.

See [Sub-agent Surface](/guides/sub-agent-surface/) for the v1/base/v2 modes and the full encrypted
task workflow.

## Manage combos

### Dashboard

Open the local dashboard and choose **Combos**. The workspace creates, edits, renames, and removes
combos, and its target picker excludes disabled models and nested combos.

### CLI

The primary commands are:

```bash
ocx combo list
ocx combo show <id>
ocx combo set <id> --targets provider/model[:weight],...
ocx combo remove <id> --yes
```

`set` also accepts `--strategy`, `--sticky`, `--effort`, `--alias`, and `--rename-from`. Use `-`
as the value of `--effort` or `--alias` to clear that field. `create` and `update` are aliases for
`set`; `delete` is an alias for `remove`; and the same subcommands are available under
`ocx route combo`.

### Management API

Headless clients use `GET`, `PUT`, and `DELETE` on `/api/combos`. `GET` lists normalized combo
definitions, `PUT` creates or replaces one (and can rename one), and `DELETE` takes the id query
parameter. Authentication and request/response details are in the
[Management API reference](/reference/management-api/).

For the complete persisted configuration, see [Configuration](/reference/configuration/).

## Configuration reference

Combos are stored in the top-level `combos` object, keyed by combo id:

```json
{
  "combos": {
    "balanced": {
      "targets": [
        { "provider": "anthropic", "model": "claude-opus-4-8", "weight": 2 },
        { "provider": "openai", "model": "gpt-5.6-sol", "weight": 1 }
      ],
      "strategy": "round-robin",
      "stickyLimit": 2,
      "defaultEffort": "high",
      "alias": "team/balanced"
    }
  }
}
```

| Field | Required | Default | Rules |
| --- | --- | --- | --- |
| `targets` | Yes | — | Non-empty ordered array of configured `{ provider, model, weight? }` targets. Duplicate provider/model pairs are rejected. |
| `targets[].weight` | No | `1` | Integer from 1 to 10,000. Used by round-robin; ignored by failover. |
| `strategy` | No | `"failover"` | `"failover"` or `"round-robin"`. |
| `stickyLimit` | No | `1` | Integer from 1 to 100 successful requests per round-robin selection. |
| `defaultEffort` | No | `null` | `low`, `medium`, `high`, `xhigh`, `max`, or `ultra`; applied only when the caller omits effort and the target advertises support. |
| `alias` | No | none | Optional trimmed public model id; use the alias rules above. An empty value is stored as no alias. |

## Troubleshooting

### Why does `combo/<id>` return 404?

The combo id is unknown. The response is HTTP 404 with type `invalid_request_error`. Run
`ocx combo list`, check spelling and case, and confirm your management command wrote to the same
running opencodex instance that receives model requests.

### Why do I get `combo_unavailable`?

Every target is currently ineligible: for example, its provider is disabled, it is cooling down,
it has already been attempted for this request, or an encrypted v2 task excludes it. Check target
provider state and recent upstream errors. For cooldowns, wait for the 60-second default or the
upstream `Retry-After` period (never more than 10 minutes), then retry.

### Why was my alias rejected?

Check the alias grammar and reserved names first. A duplicate alias or invalid shape is rejected as
HTTP 400. A slashed alias whose first segment is a configured Codex account namespace is rejected
as HTTP 409; choose a different alias namespace. The CLI and dashboard display the server's exact
validation message.

### Why did failover stop after the first error?

The error was terminal rather than target-specific. Fix invalid input, reduce an oversized context,
handle a policy refusal, or correct the rejected request origin. Combos do not hop for those cases.
