# wp3 — #2901 compaction provider selection

Issue #2901 (score 58), no implementation PR. Reported on 2.31.0/macOS by a user
running GitHub Copilot as their only provider.

## What actually happens

Ordinary turns route to GHCP. Compaction alone returns:

```
404 Model gpt-5.6-sol requires the canonical openai provider.
Run: ocx provider add openai && ocx sync && ocx restart
```

The path is short and every step is in the current tree:

1. `handleResponsesCompact` calls the ordinary router —
   `route = routeModel(config, raw.model, evidenceFromBody(raw))`
   (`src/server/responses/compact.ts:512`).
2. `routeModel` reserves every bare `gpt-*`/`o1-`/`o3-`/`o4-` id for the canonical
   provider: `isBareOpenAiFamilyModel` (`src/router.ts:510-513`) is checked at
   `:701`, **before** configured model lists and `defaultProvider` at `:749-752`.
   With no enabled `openai` row it throws `NoEnabledOpenAiProviderError`
   (`:706`, class at `:468-475`).
3. `compact.ts:513-519` turns any router throw into the 404 the user sees.

`compactProvider` is only ever `route.provider` (`compact.ts:595`). There is no
`compactModel`/`compactProvider` config key anywhere in the tree.

## Why the existing mitigations do not reach it

**#2858 compact handoff.** `compactHandoffRoutes` (`compact.ts:164`) remembers a
model that *demonstrably compacted this thread*, and it is only written by
`rememberCompactHandoffRoute` after a successful compaction
(`compact.ts:1095,1106`). A GHCP-only user never records an entry, because their
first compaction dies at step 3. The map is a quota-failover aid, not a
bootstrap.

**#636 catalog suppression.** `src/codex/catalog/sync.ts:1674-1676` already stops
advertising bare `gpt-*` rows when only non-OpenAI providers are configured,
precisely so they cannot hard-404. That fix covers the model *picker*. It cannot
cover compaction, because the Codex client chooses the compaction model itself
rather than taking it from the served catalog.

So the established project position is already: **a bare native id that cannot
route should not become a hard failure for a user who never configured OpenAI.**
This issue is the same rule applied to the one surface #636 could not reach.

## The machinery for the fix already exists

`core.ts:3587-3588` computes
`routedCompaction = parsed._compactionRequest === true && !isCanonicalOpenAiForwardProvider(route.provider)`,
and when true it strips tools, web-search, tool choice and structured output, runs
the routed model as a plain summarizer, and lets the bridge append the synthetic
compaction item (`src/responses/compaction.ts`). Compacting on a non-OpenAI
provider is a supported, exercised path.

The only thing missing is that a *bare native id* never reaches it: the router
refuses before any of that runs.

## Design: fall back rather than add a setting

The issue title asks for a setting. A setting is the worse answer here.

A config key requires the user to discover that compaction is a separate routing
decision, learn a new key name, and edit JSON — after hitting an error whose text
tells them to install a provider they deliberately do not want. The failure is
total (the conversation cannot continue), so the remedy should not be homework.

Instead: when a compaction request carries a bare native model and no canonical
`openai` provider is enabled, route it the way the user's ordinary turns already
route, and let the existing routed-compaction path summarize.

**This cannot change behavior for any working configuration.** The fallback is
reachable only where `routeModel` throws `NoEnabledOpenAiProviderError` today —
i.e. only where the current outcome is a hard 404. A user with an enabled
`openai` provider takes the identical branch they take now. That is why this
needs no opt-in flag: there is no behavior to preserve, only an error to replace.

## Audit amendment (A1)

The first plan was too narrow. A source audit found that the v1 compact handler is
not the only entry point: v2 `compaction_trigger` requests enter
`handleResponsesInner`, whose initial `routeModel` call fails before the existing
`routedCompaction` bridge can run. The implementation must therefore use one
compaction-only routing helper from both entry points.

The helper may fall back only for an unqualified bare OpenAI-family model when
the canonical `openai` provider is absent or disabled and the configured default
provider is active. It must rethrow for account-qualified selectors such as
`side/gpt-5.5`, policy/combo routes, disabled or missing defaults, and every
other router error. This preserves exact account routing and keeps ordinary
turns on today's path.

## File change map

| File | Action | Change |
|------|--------|--------|
| `src/router.ts` | MODIFY | add a compaction-only route helper that preserves the native reservation for ordinary requests and permits the narrowly gated default-provider fallback described above; retain route-decision metadata with a distinct reason |
| `src/server/responses/compact.ts` | MODIFY | call the shared helper for v1 compact routing and log one sanitized substitution line when the helper selects the configured default |
| `src/server/responses/core.ts` | MODIFY | call the same helper for the initial v2 `compaction_trigger` route, while leaving ordinary and recovery/model-change routes on ordinary routing |
| `docs-site/.../guides/` (compaction reference) | MODIFY | document that a bare native compaction model falls back to the configured default when no canonical OpenAI provider is enabled |
| `tests/router.test.ts` | MODIFY | prove helper-only fallback, account namespace fail-closed behavior, and unchanged ordinary `routeModel` behavior |
| `tests/responses-compaction-routing.test.ts` | MODIFY | regressions for v1 and v2 entry points, canonical OpenAI preservation, non-native errors, and one-time logging |

## Scope boundary

IN: the compaction fallback for the v1 `/v1/responses/compact` handler and v2
`compaction_trigger` turn, its log line, docs, and tests.

OUT: a `compactProvider`/`compactModel` config key. If an operator later wants to
*pin* compaction to a specific model while having a working `openai` provider,
that is a genuine feature and a separate cycle; it is not what unblocks #2901.
OUT: changing `isBareOpenAiFamilyModel` or the router's native reservation, which
is load-bearing for ordinary turns.

## Accept criteria

1. **GHCP-only config, bare native compaction model: both entry points succeed**
   and are summarized by the configured provider. Activation: a config with no
   `openai` row, a v1 compact request and a v2 `compaction_trigger` request for
   `gpt-5.6-sol`, asserting non-404 status and that the routed provider received
   the turn.
2. **A working openai config is untouched.** Activation: the same request with an
   enabled canonical provider still routes to it; assert the provider chosen is
   the canonical one and no fallback log fires.
3. **Other router failures still 404.** Activation: an unroutable non-native model
   id still returns the original error, proving the catch is narrow.
4. **Exact account selectors remain fail-closed.** Activation: with a configured
   `side` account namespace but no canonical `openai`, `side/gpt-5.5` still
   returns `NoEnabledOpenAiProviderError` and never reaches the default provider.
5. The substitution is logged once with both model ids, without persisting
   credentials or raw request bodies.

## Verifier

`bun x tsc --noEmit` plus the focused router and compaction tests. Full suite
forbidden.
