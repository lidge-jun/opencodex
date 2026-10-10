# wp2 — Remove the retired slugs from the Codex-login native catalog

Membership only. No default moves here; that is wp3.

## MODIFY src/codex/catalog/native-models.ts

`NATIVE_OPENAI_MODELS` line 156. Before:

```ts
  "gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex-spark",
```

After:

```ts
  "gpt-5.5", "gpt-5.3-codex-spark",
```

Two comments name the removed slugs as examples and must stop doing so, because after
this change they would describe a list that no longer holds them:

- line 75, in the `SELF_DESCRIBED_NATIVE_OPENAI_MODELS` doc comment: the sentence "the
  pin also holds `gpt-5.5`, `gpt-5.4` and `gpt-5.4-mini`" stays true of the snapshot, but
  the retired slugs are no longer admission candidates at all. Rewrite it around the pins
  that remain reachable — `gpt-5.5`, `gpt-5.2`, `codex-auto-review` — so the reason the
  allowlist is explicit rather than structural survives the retirement.
- line 175, in `NATIVE_MAIN_DRAIN_SENTINEL_MODELS`: drop `gpt-5.4` and
  `gpt-5.4-mini` from the "would have widened the sentinel to" enumeration, leaving
  `gpt-5.5` and `gpt-5.3-codex-spark`. The set itself is unchanged — neither slug
  was ever a member.

## MODIFY src/codex/catalog/metadata.ts

Line 165, `NATIVE_OPENAI_CONTEXT_OVERRIDES`: DELETE
`"gpt-5.4": { contextWindow: 1_000_000, maxContextWindow: 1_000_000 },`. This was the
only 1M native; `gpt-5.4-mini` has no entry and took its window from the pin.

Line 123, the operating-cap comment: the sentence "and gpt-5.4 runs 272,000 against
1,000,000" describes a row that is going away. Rewrite it to cite only the GPT-5.6
slugs it already discusses.

Line 540, the `upstreamNativeEntryForSlug` allowlist comment: "would also admit
gpt-5.5/gpt-5.4/gpt-5.4-mini" becomes "would also admit gpt-5.5/gpt-5.2/codex-auto-review".
The behaviour is unchanged; the example set follows the pins that can still be reached.

## KEEP src/codex/data/upstream-models.json (audit reversal)

The plan originally called for deleting the two pinned objects (`"slug": "gpt-5.4"` at
line 460, `"slug": "gpt-5.4-mini"` at line 565). The A phase reversed that.

This file is a snapshot of upstream's bundled catalog, and `metadata.ts:580` states the
contract: "The pinned JSON is left byte-identical to upstream; only the projection fills
in." The snapshot already carries `gpt-5.2` and `codex-auto-review`, neither of which is
in `NATIVE_OPENAI_MODELS`, so a pinned row has never been an exposure decision.

Nothing re-exposes a retired slug from the snapshot alone. `PINNED_NATIVE_CAPABILITY_ENTRIES`
and `UPSTREAM_NATIVE_ENTRIES` are both built by iterating `NATIVE_OPENAI_MODELS`, so once
the slugs leave that list their pinned rows are never looked up. The one consumer that
reads raw snapshot rows, `GATED_MODEL_CLIENT_VERSION_FLOOR` in
`src/codex/model-entitlements.ts:135`, filters on `ACCOUNT_GATED_NATIVE_OPENAI_MODELS`
(Daybreak only) and never sees them.

Deleting ~205 lines of upstream-owned JSON would change no behaviour while breaking the
file's fidelity to its source and churning `reserve-catalog-lifecycle.test.ts` and
`codex-model-entitlements.test.ts`, which read it directly. Membership is the lever.

## MODIFY src/codex/catalog/parsing.ts, src/codex/catalog/effort.ts, src/codex/catalog/sync.ts

Comment-only. Each names `gpt-5.4` or `gpt-5.4-mini` as the illustrative "older native"
(`parsing.ts:521` preserved-row cap, `effort.ts:62` xhigh clamp, `sync.ts:263` mock
max/ultra). Replace the examples with `gpt-5.5` / `gpt-5.3-codex-spark`. No predicate
changes: the clamp keys on "is not a gpt-5.6 native", so a request that still names a
retired slug is still clamped correctly.

## Tests

Membership assertions that must drop the slugs:

- `tests/codex-integration/codex-catalog.test.ts` — `filterSupportedNativeSlugs`
  expectation at 6954 and the visibility inputs at 6943-6944; delete the "native gpt-5.4
  uses its 1M context window override" test at 3459-3466 with the override itself.
  The "preserved gpt-5.4-mini rows get the openai cap" test at 3640-3678 cannot simply be
  kept: it feeds a preserved row through `mergeCatalogEntriesForSync`, and after membership
  removal that row is a droppable unsupported native. Run it first — if it drops, repoint
  the fixture onto a surviving non-overridden native so the #1430 cap regression keeps its
  coverage. Line 3686 (`nativeOpenAiContextWindow("gpt-5.4", 272_000)`) names a retired
  slug in a test about the generic cap, so repoint it too.
  KEEP 3817 (negative: the slugs must not leak into `UPSTREAM_NATIVE_ENTRIES` — still true
  and now trivially so), KEEP the Nova1 routed alias fixtures at 1175-1205 and the cursor
  rows at 4340-4893.
- `codex-catalog-sync-hardening.test.ts` 118-140, 275-281, 373-376 — repoint the native
  fixtures onto `gpt-5.5` / `gpt-5.6-luna`; 729-765 likewise.
- `codex-catalog-golden.test.ts` 41 and the `"gpt-5.4@9"` golden projection at 76.
- `codex-catalog-model-picker-order.test.ts` 153-167.
- `codex-catalog-restore.test.ts` — the hide/priority/window fixtures listed in the
  audit; the 1M expectation at 398 goes with the override.
- `native-model-toggle.test.ts` 71-72 and 299. KEEP 79 (`cursor/gpt-5.4` proves vendor
  slugs are ignored by native visibility) and 234-243 (preserved compact-limit map).
- `model-visibility-management-api.test.ts` 376-436 — a removed slug is no longer a
  valid native visibility target, so these move to a surviving native.
- `codex-convergence-account-selectors.test.ts`, `codex-auth-context.test.ts`,
  `codex-metadata-integrity.test.ts`, `codex-v2-gate.test.ts`, `effort-policy.test.ts`
  281-315 — these use the slug as a live native request id; repoint to `gpt-5.5`.
  `effort-policy.test.ts` 435-439 keeps testing the clamp, on a surviving old native.
- `tests/claude-integration/` — `claude-models-discovery.test.ts` expected roster,
  `claude-model-info.test.ts` (its "only authoritative 1M native" claim dies with the
  override), `claude-context-windows.test.ts` 24-29, `claude-inbound.test.ts`.
- `tests/clients/desktop-3p.test.ts` 215-221 — same 1M native subject.

Do not touch: `tests/usage/**`, `tests/providers/**` vendor suites,
`tests/fixtures/commandcode-models.json`, `tests/responses/responses-shadow-intercept.test.ts`,
`tests/routing/subagent-*` (operator rosters and a negative sentinel assertion).

Four more in-scope files the first sweep left unclassified:
`tests/codex-integration/codex-app-server-processes.test.ts:491-500` KEEP (the
`codex --config model=...` fixture exercises a command-line detector; any token works),
`tests/codex-integration/slug-codec.test.ts:106` KEEP (codec round-trip pair, not
membership), `tests/responses/empty-completion-guard.test.ts:467` KEEP (string formatting),
`tests/vision/vision-eligibility.test.ts:225` REPOINT to `gpt-5.6-luna` — unlike the
OpenRouter rows at 22-26 this one is the native eligibility subject and belongs to wp3.

## Proof for this phase

`bun test tests/codex-integration tests/claude-integration tests/clients` green, plus
`bun run typecheck`.
