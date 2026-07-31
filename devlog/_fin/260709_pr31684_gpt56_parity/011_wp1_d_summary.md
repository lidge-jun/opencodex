# 011 — WP1 D summary (terminal outcome: DONE)

## What shipped
- `src/codex/data/upstream-models.json`: verbatim PR #31684 snapshot (8 entries, 292K).
- `src/codex/catalog.ts`: `UPSTREAM_NATIVE_ENTRIES` (gpt-5.6-only), `upstreamNativeEntry`
  (strips `minimal_client_version`), `finishUpstreamNativeEntry`,
  `shouldUpgradeToUpstreamEntry` (display_name === slug discriminator), deriveEntry
  substitution before template clone, merge-sync fallback-quality upgrade, central
  `prefer_websockets` gating in both ws override loops, `nativeOpenAiContextWindow` export
  (B2 fold-back, consumed by WP2).
- `src/reasoning-effort.ts`: canonical upstream effort descriptions.
- `tsconfig.json`: `resolveJsonModule`.
- Tests: +3 cases (snapshot spec parity incl. luna-no-ultra + sol-default-low;
  ws-enabled prefer_websockets; sync upgrade-vs-preserve); 2 existing assertions updated
  (ultra description; none removed).
- Docs: codex-app-model-catalog.md (snapshot mechanism + refresh procedure),
  docs-site codex-app-models.md (per-slug ladder), README en/ko/zh 5.6 lines.

## Evidence
- `bun x tsc --noEmit` exit 0; full `bun test` 1676 pass / 0 fail (171 files, 22.14s).
- Activation: luna ladder asserted `[low..max]` (no ultra) — snapshot branch fired;
  upgrade/preserve test drives BOTH discriminator directions.
- Commit: "catalog: pin upstream models.json snapshot (PR #31684)..." (11 files, +1057/-20).

## Deviation record (LOOP-PESSIMIST-01)
- Plan said snapshot restricted to SUPPORTED set; B discovered the bundled gpt-5.5 entry
  is STALER than installed live catalogs (`tool_mode: null`, `use_responses_lite: false`,
  comp_hash 2911) — blanket substitution would downgrade 5.5/5.4. Scope narrowed to
  gpt-5.6-only (installed catalogs have no real 5.6 entry to downgrade). Golden oracle
  unchanged as a result. Wrong-direction signal for the future: if a snapshot refresh
  ever carries richer entries than live catalogs, revisit this restriction.
- `ensureGpt56ReasoningLevels` kept (not deleted as planned) as the fallback for future
  5.6 slugs the snapshot predates.

## Next
WP2 (020): native GPT on/off toggles. Consumes `nativeOpenAiContextWindow` and the
snapshot-backed entry sources.
