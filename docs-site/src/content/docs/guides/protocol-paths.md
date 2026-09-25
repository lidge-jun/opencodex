---
title: Protocol paths
description: How a request on the Responses, Chat Completions, or Messages API reaches a provider, how to preview and trace that path, and the staged switches that change it.
---

opencodex serves three client APIs: **Responses** (`/v1/responses`), **Chat Completions**
(`/v1/chat/completions`), and **Messages** (`/v1/messages`). Each provider receives one upstream
wire, decided by its adapter. When the client API and the upstream wire differ, the request is
converted on the way in and the answer is converted on the way back. This page explains how that
path is named, how to see it before and after a request, and which settings change it.

Every setting on this page is off by default. With the defaults, requests travel exactly as they
did before these settings existed.

## Delivery modes

A path is a list of hops from the client API to the upstream wire. The hops are the three API
names, `ir` (opencodex's adapter-neutral request and event form), and `responses-internal`
(Responses JSON or SSE produced only as an internal bridge, never seen by a client).

| Mode | Meaning | Example request path |
| --- | --- | --- |
| `native` | Same API at both ends; the client's body is what the provider receives | `chat > chat` |
| `translated` | Converted once, through the target wire's codec or the IR | `chat > responses`, `responses > ir > messages` |
| `legacy-bridge` | Converted through the internal Responses form first | `chat > responses-internal > ir > messages` |
| `blocked` | Refused before anything was sent | none |

`native` describes how a request travels. It is not a compatibility verdict: a native path can
still meet a provider that rejects a field, and the Compatibility Lab's verified results are a
separate thing.

With every switch off, an eligible single-provider route takes these paths:

| Client API → upstream | Path |
| --- | --- |
| Responses → Responses | native |
| Responses → Chat or Messages | translated through the IR |
| Chat → Chat | native (JSON when the client sends `stream: false`) |
| Chat → Responses, Messages → Responses | translated through the Responses codec |
| Chat → Messages, Messages → Chat | legacy bridge |
| Messages → Messages | native only when the caller forwards its own Anthropic credential; legacy bridge for a key opencodex manages |

Combos, routing policies, and synthetic effort or fast model rows take the legacy bridge from Chat
and Messages unless a switch below says otherwise.

## Feature effects

Some request features cannot survive every conversion. For example, the Chat fields `n`,
`logprobs`, `logit_bias`, `seed`, `audio`, and `prediction` have no place in a Responses body, and
the Messages `top_k` field is dropped on the way to Responses. opencodex records each such effect as
`passthrough`, `translated`, `degraded`, or `unsupported` (shown as *Dropped* in the dashboard).
These are declared from the converters' code; they are not measured results.

## Preview a path

A preview is computed from your configuration alone. It sends nothing to any provider, does not
advance combo rotation, and is not logged.

- Dashboard: **API** page, **Request path preview**.
- CLI:

  ```bash
  ocx api explain --model combo/main --inbound chat --feature request.seed
  ocx api explain --model claude-sonnet-4-5 --inbound messages --json
  ```

The preview lists every route candidate with its request path, delivery mode, feature effects, and
whether the `reject` policy (below) would refuse it. `ocx api protocols --json` lists the feature
names it accepts. A Messages request that forwards the caller's own Anthropic credential is shown
with `caller-credential-required` rather than assumed, because a preview has no caller.

## Trace a request

Each request that reached a provider, or was refused before sending, records the path it actually
took on its log row: the final mode and paths, the reasons, the
feature effects, and one path per physical attempt. In the dashboard, **Logs** shows a path badge,
a **Protocol path** filter, and a **Protocol path** section in the request detail. Older rows have
no path data and say so; nothing is guessed.

## Unrepresentable features

`protocols.unrepresentable` decides what happens when a request carries a feature its path would
drop:

- `legacy` (default): the request is sent as before, and the loss appears only in the trace's
  feature effects.
- `reject`: the request is refused with HTTP 400 before anything is sent, naming only the feature
  keys. Chat answers `invalid_request_error` with code `unsupported_feature`; Messages answers
  `invalid_request_error`. The trace is `blocked`.

Under `reject`, a direct route is judged at the ingress once its provider and wire are settled.
Combos and policies are not judged at the ingress; with `nativeChatCombos` on, a Chat combo judges
each candidate and skips one that cannot carry the request.

## Rollout switches

These switches stage the new paths. Each defaults to off, and a switch that is off changes nothing.

| Switch | When on |
| --- | --- |
| `nativeChatCombos` | An eligible Chat candidate inside a combo is sent natively from its own copy of the client body; the other candidates keep the bridge. |
| `managedMessagesNative` | A Messages request whose route is a direct, key-authenticated Anthropic provider is sent as Messages instead of through the bridge. Routes that need bridge-only behaviour (a pinned effort, blocked-skill elision, the web-search sidecar, vision preprocessing, synthetic rows) stay on the bridge. |
| `managedMessagesNativeOAuth` | Native Messages for the unpooled `anthropic` OAuth provider on `api.anthropic.com`. Effective only together with `managedMessagesNative`; a pooled Anthropic OAuth account set stays on the bridge. |
| `directEncoders` | For a non-Responses upstream, the answer to a Chat or Messages client is encoded directly from the adapter's events instead of through the internal Responses stream. The request side is unchanged. |
| `shadowPlan` | At the end of each Chat or Messages request, the plan a preview would have predicted is compared with the path the request took; a disagreement adds `planMismatch: true` to the log row's path record. No second request is sent. |

Change them with the CLI or by editing `protocols` in `config.json`
([reference](/reference/configuration/server/#protocol-paths-protocols)):

```bash
ocx api policy                                   # show the current policy; changes nothing
ocx api policy --rollout shadowPlan=on           # change one switch
ocx api policy --unrepresentable reject
```

`ocx api policy` writes only when you pass a setting flag, and only when you run it.

### Shadow plan

`shadowPlan` is the safe first step: it changes no request. It checks whether the preview agrees
with reality for the traffic you actually send. The comparison uses the route the request settled
on (for a combo, the target that answered), and compares the delivery mode, the upstream wire, and
the request path. The response path is not compared, because `directEncoders` changes it and the
preview does not model that switch. A caller-forwarded Messages request and a Claude compatibility
reject are not compared. Responses requests are not compared.

`planMismatch` appears in the `protocolTrace` of a row returned by `GET /api/logs`. The dashboard
does not display it yet.

## What has not moved yet

These paths still use the internal Responses bridge or are not covered:

- Chat and Messages requests are still decoded into a Responses-shaped body before the IR, including
  on a translated path.
- Routing-policy candidates, combos reached through an effort row, combo candidates while
  `nativeChatCombos` is off, and Messages combos.
- Direct encoding (`directEncoders`) covers only a concrete, non-Responses route in streaming
  delivery. Combo and policy children, routed compaction, run-turn adapters (Cursor, Devin,
  coding-agent CLIs, CodeBuddy), and sidecar turns keep the bridge.
- A native Chat combo candidate that fails in-band before any output does not move on to the next
  candidate; a bridged one would.
- Web search, vision, and image-generation sidecars run only on the Responses pipeline.
- `previous_response_id`, `store`, `background`, and compaction stay Responses features.
- Adapters whose wire is none of the three APIs (Gemini, Kiro, Cursor, and others) are translated
  through the IR with no feature claims.
- Native Chat over OAuth is not planned. Native Messages over Anthropic OAuth covers only an
  unpooled account; a pooled account set stays on the bridge.
- The managed native Messages path forwards a caller's `anthropic-beta` values only from a short
  allowlist and only to `api.anthropic.com`, drops
  top-level fields outside its allowlist without a feature effect, and does not apply
  `claudeCode.stabilizePromptCache`.
