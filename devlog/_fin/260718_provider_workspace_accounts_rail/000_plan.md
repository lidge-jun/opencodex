# Providers workspace account and rail loop

## Loop specification

- Archetype: spec-satisfaction repair with two dependency-ordered product slices.
- Trigger: the workspace owns provider selection but hides existing account-management capability in Settings and its left rail degrades into raw fragments or collisions at constrained widths.
- Goal: expose safe multi-account selection as a first-class workspace tab and turn the provider rail into a compact, semantic, collision-free navigation surface.
- Non-goals: new authentication protocols, account deletion redesign, automatic quota-routing policy changes, provider catalog redesign, brand-asset replacement, new dependencies, deployment, or remote push.
- Verifier: focused OAuth/Codex API and workspace tests prove contracts; GUI typecheck/build/lint prove compilation and i18n; live local API and browser flows prove account switching, restoration, keyboard behavior, responsive layout, console, and network state.
- Stop condition: account and rail criteria in the bound goalplan carry fresh evidence; no credential or raw account identifier is exposed; independent review has no open High/Critical blocker.
- Memory artifact: this unit, its decade documents, `.codexclaw/goalplans/opencodex-providers-workspace-provider-workspace/`, local commits, and browser screenshots.
- Terminal outcomes: `DONE` on verified integration; `NOOP` only for a slice already satisfying every criterion; `BLOCKED` for a missing safe account contract; `UNSAFE` for credential exposure or destructive requirements; `NEEDS_HUMAN` for irreducible product intent; `BUDGET_EXHAUSTED` only after the bounds below are hit.
- Escalation: the main agent reclaims a packet after two distinct workers fail it; any new delegated write slice is first added as a P-phase amendment. Review findings are folded back through the same reviewer until pass/near-pass or three failed rounds.

## Classification and resource bounds

- Overall work: C3 cross-domain frontend integration.
- Account-selection slice: C4 verification depth because it mutates the active authentication identity, although it reuses existing local routes and stores.
- Rail slice: C2 frontend repair within the existing workspace module.
- Tool and credential scope: local repository, local OpenCodex management API on `127.0.0.1`, Browser/in-app browser and isolated agbrowse only. Never read browser storage, cookies, raw tokens, or credential files.
- Write scope: files named in `010_account_switcher.md`, `020_provider_rail.md`, `030_integration_qa.md`, this devlog unit, and the bound goalplan/ledger.
- External cost: zero paid web/provider calls and no new package installs.
- Delegation bound: at most four concurrent research/review agents; writes remain main-agent owned unless a later P amendment assigns disjoint files.
- Wall-clock bound: three hours of active loop work before reporting `BUDGET_EXHAUSTED`; ordinary compaction is not exhaustion.

## Necessity gate

- Do nothing: rejected because the workspace passes only `oauthEmail`; the existing auth panel receives neither account rows nor handlers and returns `null` for OAuth providers.
- Delete: accepted selectively for the duplicate rail `Providers / Add provider` header and redundant right-column fragments; deleting account management is contrary to the requested workflow.
- Configure: rejected because no CSS/config switch connects the existing account contract to the workspace.
- Reuse: selected. Reuse `GET/PUT /api/oauth/accounts`, `GET/PUT /api/codex-auth/*`, `ProviderAuthPanel`, `CodexAccountPool`, existing tabs, semantic tokens, provider brand assets, and current i18n system.

## Current architecture map

```text
gui/src/pages/Providers.tsx
  owns config, oauth status, generic account sets, key pools, mutations
  -> ProviderWorkspaceShell.tsx
       owns rail filtering/selection and detail slot
       -> ProviderRail.tsx
       -> ProviderDetails.tsx
            -> Overview / Models / Usage / Settings
            -> ProviderAuthPanel.tsx (implemented but not wired by workspace caller)
                 -> CodexAccountPool.tsx for canonical OpenAI forward provider

src/server/management-api.ts
  GET/PUT/DELETE /api/oauth/accounts*
src/codex/auth-api.ts
  GET/PUT /api/codex-auth/accounts|active
```

Source anchors: `gui/src/pages/Providers.tsx:46-64,113-139,446-482`; `gui/src/components/provider-workspace/ProviderDetails.tsx:24-68,131-188`; `gui/src/components/provider-workspace/ProviderAuthPanel.tsx:42-54,105-130`; `src/server/management-api.ts:1271-1300`; `gui/src/components/CodexAccountPool.tsx:44-82`.

## Design direction

- Existing design system is authoritative: `docs/design-system/*`, `gui/src/styles.css`, and existing `ui.tsx` primitives.
- Working-tool direction: quiet, dense, predictable, reversible. No concept images are generated because this is a utility dashboard with an established system, not a new expressive surface.
- The requested “account tab” is a new detail information-architecture tab. Individual variable-length accounts remain selectable rows inside that panel; they do not become a horizontal tab strip or segmented control.
- Provider rail rows become two-level: brand/name on the primary line; model count and rare disambiguation metadata on the secondary line. Readiness remains in the status-group heading, localized accessible name/title, and a reinforcing dot—never as raw text inside the fixed-size dot. Default/free/local remain exception badges or icons, not unstructured trailing text.
- Full Design Read and state grammar: `001_design_read.md`.

## Threat model for account selection

- Assets: active account identity, masked email labels, quota state, local account configuration, OAuth credential store.
- Entrypoints: workspace account list fetches, active-account PUTs, add/remove controls, 30-second Codex account refresh.
- Boundaries: browser UI -> localhost management API -> credential/config stores.
- Attacker/failure capability: stale response ordering, double activation, malformed/failed HTTP response, compromised local page trying to surface raw IDs, identity-less providers, reauth-required credentials.
- Controls: reuse server validation; never serialize tokens; display masked email or localized ordinal fallback; generation-bound list commits; non-2xx checks; pending locks; authoritative refresh; disable unusable rows; restore original account after live QA; privacy scan and API redaction tests.

## Dependency-ordered work phases

1. `roadmap-design` (this docs-only cycle): lock architecture, Design Read, threat model, exact diffs, activation scenarios, and verification commands.
2. `account-switcher` (`010_account_switcher.md`): fix account state consistency first, then wire the new tab and existing account surfaces.
3. `provider-rail-polish` (`020_provider_rail.md`): rebuild the rail row hierarchy and responsive composition after the detail/tab width contract is stable.
4. `workspace-integration-qa` (`030_integration_qa.md`): cross-slice regression, live switch/restore, multi-viewport/locale/theme/keyboard checks, independent adversarial review, and final evidence.

## Acceptance summary

- Canonical OpenAI exposes main plus pool accounts in `Accounts`; generic OAuth providers expose their account set; key providers expose `API keys`; local/no-auth providers do not show a dead tab.
- Multi-account selection is shown only when the provider/store actually contains multiple identities. Identity-less OAuth providers may remain one-slot and must not be described as a pool merely because the generic endpoint returns one row.
- Loading, loaded-empty, one, many, reauth, switching, success, HTTP failure, network failure, and stale-response branches have named activation evidence.
- Active state remains server-authoritative. Failed switches do not change the selected row. Live QA restores the original active account.
- No raw token, full email, or opaque account ID appears in the new workspace surface or evidence.
- Rail rows never stack characters vertically or collide; readiness is conveyed by group text plus the localized accessible name and reinforced by color. Long names truncate with a title and accessible full name.
- Existing provider SVG/image rendering remains untouched so original brand color behavior is preserved.

## SoT sync target

`docs/design-system/components.md` will gain the finalized workspace tab/account-row and provider-rail contracts during C after rendered behavior is proven. No new design-system folder or token is introduced.
