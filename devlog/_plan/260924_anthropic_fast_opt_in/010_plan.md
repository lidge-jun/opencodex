# Anthropic Fast opt-in (default off) — plan (wp1)

## Loop spec (HOTL wp1)

- Request (2026-09-24): Anthropic fast mode spends usage credits, so keep it off by default; give the
  Anthropic provider card on the dashboard Models page one row that turns it on and off; open a PR and
  merge it. Push, PR, and merge are authorized for this change.
- Previous unit: devlog/_plan/260923_anthropic_fast_speed (#5604) made `claude-opus-5-5`, `claude-opus-5`,
  `claude-opus-4-8` Fast-eligible on `anthropic` and `anthropic-apikey` with no switch other than the
  global `fastMode`. Its residual already named the cost: every turn on an account without credits pays a
  refused round trip, and an account with credits is billed 2x without a per-provider choice.
- Branch `codex/anthropic-fast-default-off` from `origin/dev` 6b7a91f575.

## Design

- D1 Registry: `ProviderRegistryEntry.fastOptIn?: boolean`. `true` means the provider's Fast lane is billed
  beyond the plan and stays off until the operator enables it. Set on `anthropic` and `anthropic-apikey`.
  The FastWire, model map, and tier description stay as they are, so enabling restores #5604 exactly.
- D2 Config: `OcxProviderConfig.fastEnabled?: boolean`. `false` turns Fast off for any provider;
  `true` satisfies an opt-in registry entry; absent means "registry default" (off for opt-in entries,
  unchanged elsewhere). Zod provider schema accepts a boolean; auth-cors field policy classifies it `editor`.
- D3 Policy: `buildFastPolicyAuthority` (src/providers/service-tier.ts) resolves the switch from the configured
  provider, then the enriched provider, then `getProviderRegistryEntry(name)?.fastOptIn` (looked up by name
  regardless of transport match, because it can only turn Fast off). An off switch sets the provider
  capability to `false`, which `resolveFastPolicy` already treats as a global denial: eligibility becomes
  `capability-unsupported`, catalog Fast toggles and `--fast` rows disappear, `decideTier` drops, and the
  adapter never emits `speed`. No new policy branch in fastwire.ts.
- D4 Management API: PATCH /api/providers accepts `fastEnabled` (boolean, or null to clear). GET /api/providers
  adds `fastOptIn: { enabled }` only for opt-in registry entries so the dashboard knows where to draw the row.
- D5 Dashboard: a small `ProviderFastRow` component (own file, Models.tsx is 8 lines under its ratchet cap)
  with the same Off/On segmented control as the new-model policy row, label "Fast mode" and a hint that it
  uses usage credits at 2x price. Rendered in the provider body for providers whose summary carries
  `fastOptIn`. PATCH then reload. i18n keys in all ten locales.
- D6 Docs/SoT: docs-site providers reference (Anthropic Fast section + field table row), structure
  providers-and-adapters note.

## Tests

- New `tests/providers/anthropic-fast-opt-in.test.ts`: registry default ineligible for both entries;
  `fastEnabled: true` restores eligible; `fastEnabled: false` denies an ordinary service-tier provider;
  `catalogFastRowEligible` false by default; PATCH round-trip sets/clears the field and GET exposes
  `fastOptIn`.
- Rewrite fixtures that assumed default-on (responses-anthropic-fast-downgrade, fast pricing, fastwire roster
  if affected) to set `fastEnabled: true` deliberately.

## Acceptance

- C1 default ineligible / opt-in eligible (c-1). C2 Models row renders and PATCHes (c-2, screenshot).
- C3 typecheck, focused tests, test:changed, ratchet/layout, structure:check, privacy:scan, lint:gui, build:gui.
- C4 PR to dev with template, exact-head CI green, merged (c-3).

## Residuals

- Claude Messages native passthrough forwards a caller's own `speed` field (Claude Code /fast); that is the
  caller's explicit choice and stays outside this switch.
## Audit fold (A, reviewer NEAR-PASS)

- B1 folded: one helper `providerFastSwitchOff(name, provider)` (src/providers/fast-opt-in.ts) is applied in
  three places: the FastPolicy authority (service-tier.ts), `resolveModelPolicy` (static supportsServiceTier
  and fastTierDescription), and router registry enrichment, which writes `supportsServiceTier: false` on the
  resolved runtime provider so nameless `fastPolicyForModel` callers also see the denial.
- B2 folded by the same enrichment write.
- B3: PATCH already clears the provider model cache and runs `convergeCodexCatalog` for any non-pacing
  field; the policy test covers the PATCH round trip. Claude listings compute per request.
- B4: flipped fixtures set `fastEnabled: true` deliberately; load-degrade's inherited-fastWire warning skips
  providers whose switch is off.
- Residual accepted: native Claude Messages passthrough forwards the caller's own `speed`; documented.
- Scope confirmed by user: Cursor unchanged; only anthropic and anthropic-apikey default off.
