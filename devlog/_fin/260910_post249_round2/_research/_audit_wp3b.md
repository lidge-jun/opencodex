Read-only plan audit against `origin/dev` `95a3f6a59`. Heads: [#4165](https://github.com/lidge-jun/opencodex/pull/4165) `593360f28`, [#4166](https://github.com/lidge-jun/opencodex/pull/4166) `a3578aae5`. Local product tests were not run.

Neither diff touches Lane A (`src/server/responses/core.ts`, `src/claude/inbound.ts`, `src/service.ts`).

## #4165 — Closes #1711

The first-head CI failure was the new exact field assertion, not an old catalog `toEqual` being relaxed. At `04c4a8041`, `test 3/4` and `macos 1/2` failed with:

```
tests/codex-integration/catalog-zero-credit-picker.test.ts:131
Expected: "no_credit"
Received: undefined
```

`deriveEntry(null, …)` took the no-template fallback, and that path did not stamp `opencodex_inactive_reason`. `593360f28` copied the existing stamp onto that fallback and looped the same assertions over both `template: null` and a cached template. The equalities stayed `visibility === "list"` and `entry[CATALOG_INACTIVE_REASON_FIELD] === "no_credit"`.

```440:447:src/codex/catalog/sync.ts
  if (model?.catalogKind) entry.opencodex_catalog_kind = model.catalogKind;
  // Same additive stamp as the templated path above.
  if (model?.quotaInactiveReason) entry[CATALOG_INACTIVE_REASON_FIELD] = model.quotaInactiveReason;
```

**NOTE** — CI-fix did not weaken an existing catalog-row equality. It extended the new test and filled the missing stamp. Before: one `deriveEntry(null, …)` path. After: both derivation paths, same `toBe("no_credit")` / `toBe("list")`.

The inactive marker uses the combo runtime predicate. `quotaInactiveReason` filters disabled/unknown providers out of the vote, exempts canonical ChatGPT forward, treats a null/stale cache as not-exhausted, and returns `"no_credit"` only when every remaining usable target fails `cachedProviderQuotaIsExhausted` (`percent >= 100` and `remaining <= 0`, not Dashboard `quotaStateFromReport`). Tests pin stale cache, `percent: 40` at zero remaining, unlimited, ChatGPT exemption, and “every usable target.”

`visibility` is still hardcoded `"list"` on both derive paths. The stamp is additive in `gatherRoutedModelsUncached` and `deriveEntry`; `filterCatalogVisibleModels` is unchanged. `ManagementModelRow.disabled` is not reused.

The PR body states the native-picker limit in “The limitation, stated plainly”: Codex only understands `list`/`hide`, so this greys OpenCodex-aware consumers and does nothing in the native picker. It also records the catalog-plus-dashboard choice.

**SHOULD-FIX** `src/server/management/model-rows.ts:129-147` — Custom dashboard rows are rebuilt from `config.customModels` and drop `quotaInactiveReason`. Routed/combo rows spread `CatalogModel` and keep it. Custom Models-tab chips will not show even when gather stamped the catalog row.

**SHOULD-FIX** `tests/codex-integration/catalog-zero-credit-picker.test.ts:48-145` — Plan asked to seed quota and build through `buildCatalogEntriesFromObservedState`. Coverage is helper + `deriveEntry` only; gather→served-entry is not exercised end-to-end.

**NOTE** `gui/src/pages/Models.tsx:1678-1686` — Dashboard chip is present for rows that carry the field. Exact-head `ci` is green; `enforce-target` still fails `missing UI screenshot`.

Lane A files: no.

## #4166 — Closes #4038

The #4040 failure mode is actually guarded. `MIN_DECODE_WINDOW_MS = 1_000`; a positive window under that floor returns `{ kind: "unavailable", reason: "decode_window_too_short" }`, not a rate. The test uses 240 tokens / 50 ms remainder and asserts no `4800`.

```157:160:src/server/management/shared.ts
  if (windowMs <= 0) return { kind: "unavailable", reason: "invalid_duration" };
  if (windowMs < MIN_DECODE_WINDOW_MS) return { kind: "unavailable", reason: "decode_window_too_short" };
```

Existing e2e metric is unchanged: `tokensPerSecond` still divides by full duration, `tokPerSecondResult` still calls it, `filterLogs` still sorts on `tokPerSecond`, `RequestLogEntry` / `usage.jsonl` are untouched. New sibling: 240 tokens, 10s, TTFT 2s → decode 30, e2e 24.

Parent uses the request’s `firstOutputMs`; each attempt uses its own. The combo test has TTFT only on the child: parent is `ttft_missing`, attempt is 30.

`ttft_missing` and `decode_window_too_short` are on the server union, in `METRIC_REASON_KEYS` (`satisfies Record<MetricUnavailableReason, string>`), and in all nine locale files with real copy.

The PR body states the contested choice: #4040 closed as an unreliable estimate, and this retry is the floor plus `estimated: true` because proxy TTFT is not the provider generation start.

**SHOULD-FIX** `gui/src/pages/Logs.tsx:1151` — Plan said label the rate in the detail **and attempt** tables. Parent detail/list stack it; the attempt table still renders only `tokPerSecond`. The DTO already has `attempt.displayMetrics.decodeTokPerSecond`.

**SHOULD-FIX** `src/server/management/request-history-routes.ts:109,187` — Plan said keep this out of `/api/request-history` even though it shares the DTO. `decodeTokPerSecond` is computed inside `requestLogDto`, so history responses now carry it. Additive, not persisted, but it is not logs-only.

**NOTE** — `enforce-target` also fails `missing UI screenshot` on this GUI change. Exact-head `ci` is green.

Lane A files: no.

#4165 PASS
#4166 PASS
