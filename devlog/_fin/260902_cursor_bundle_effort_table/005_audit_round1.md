# 005 — Audit round 1 (roadmap, wp0)

Two dispatched reviewers (gpt-5.6-sol high, agents 01a06204… and 01a06210…) produced no output
within 6 and 6 wait cycles and were retired (DISPATCH-RETIRE-01). The main agent audited
directly against the tree on 2026-09-02; evidence below is from commands run in this session.

## Checks

1. 010 parser vs the real bundle: `bun /tmp/ocx-effort-probe.js` applying the 010 regexes to
   `main.js` → 4 effort constants (w/T/k/S), **16 families**, every `effort:` ref resolves,
   outputCaps 128000/64000/32768 read, bare rule `^gpt-5(?:\.\d+)?$` → w. PASS.
2. Before-snippets: `cursor-integration-routes.ts:64-72` matches 010; `context.ts:60`
   `readRuntimePort` seam exists for the injected loader; `responses/core.ts:2753`
   `parsed = parseRequest(body)`; `chat-completions.ts:136` `isNativeChatRouteEligible`;
   `claude-messages.ts:646` `wantsNativePassthrough` — all match 030. PASS.
3. Grammar collision (030): `rg -- '--(low|medium|high|xhigh|max|minimal|none|ultra)\b'` over
   registry.ts, effort-map.ts, generated/model-metadata.ts → 0 hits. PASS.
4. Lab boundary: `models-capabilities.ts` has no imports; the planned
   `cursor-effort-table.ts` imports node:fs/path + a type. Nothing reaches src/lab. PASS.
5. 050 vs `tests/cursor-catalog.test.ts:101-103` (exact ids `gpt-5.1-codex-max`,
   `gpt-5.5-extra`): the normalizer only accepts `claude-*` stems, so ordering it first cannot
   mis-parse those. REAL_1M ordering is stated in 050. PASS.
6. 040 i18n: `gui/src/i18n/provider.tsx:25` falls back to `en` per key. Residual resolved.
7. 020 vs 001 contradiction (top-level long_context_threshold_tokens): resolved in 020 by
   dropping the field; bundle check `void 0!==i?{long_context_threshold_tokens:i}:{}` confirms
   Cursor derives it. PASS.
8. Field chains: effortTable/family (010) create in the route → JSON → cursor-api.ts type →
   rendered in 040; tableLess/effortRows (030) same; cursorEffortRows (030) config type + zod
   + effort-row.ts + three ingress handlers + status route; maxOutputTokens (020) metadata →
   CatalogModel → provider-fetch → aggregation → index.ts row. Complete.

## Blockers

1. Medium — 030 §6: `claude-messages.ts:648-654` already applies an `effortOverride`
   (`extractOcxEffortDirective`) via `output_config.effort` before translation. wp3's P must
   reconcile the row effort with that path (reuse it, or justify injecting the internal
   Responses `reasoning.effort` as the lane proposed because of the `none` rung). Folded as a
   P-phase task of wp3; not a wp0 blocker.

VERDICT: GO-WITH-FIXES (blockers=1)

