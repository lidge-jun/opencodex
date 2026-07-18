# A-gate audit synthesis — roadmap-design

## Independent inputs

Three read-only Sol explorers completed before the formal A gate:

- Account contract explorer: `VERDICT: READY`; confirmed existing generic OAuth and Codex account APIs/stores, missing workspace prop wiring, stale generic account loads, generic network-error gap, reauth selection gap, canonical OpenAI boundary, and Codex false-success risk.
- Provider rail explorer: `VERDICT: READY`; confirmed the historical raw readiness leak is already fixed on current HEAD, but found the six-peer flex collision budget, empty fixed slots, config-id wrap, 769px/container overflow, and original-color SVG path.
- Design-system/QA explorer: `VERDICT: BLOCKED` against the pre-plan implementation state; found missing workspace props, unsuitable account-as-tabs/segmented treatment, incomplete detail-tab/listbox keyboard semantics, missing remove labels/live regions, undefined `--fg` tokens, missing DOM harness, and unrelated baseline lint debt.

The formal A reviewer was dispatched to a different model family as required. Two different-family reviewers and one fresh Sol replacement each produced no result after three bounded waits and were retired. The prior design explorer was resumed for blocker closure and also produced no follow-up result after three bounded waits. Under the plan's escalation rule, the main agent reclaimed synthesis rather than waiting indefinitely or pretending a reviewer passed.

## Blocker synthesis and disposition

1. **Workspace auth panel is unreachable for generic OAuth/key providers.**
   - Root: `Providers.tsx:464-480` omits props already accepted by `ProviderDetails.tsx:24-68`.
   - Disposition: accepted in `010_account_switcher.md` exact `Providers.tsx`/`ProviderDetails.tsx` wiring.

2. **Account selection must not become variable email tabs or segmented buttons.**
   - Root: detail tabs are information architecture; account identities are variable data.
   - Disposition: the user-requested `Accounts` tab owns a panel; accounts remain vertical single-select rows with separate management actions (`001_design_read.md`).

3. **Generic list/switch state is not concurrency- or failure-honest.**
   - Root: map replacement, no generation, no network catch, and reauth rows remain switchable (`Providers.tsx:113-139`).
   - Disposition: generation-bound per-provider merges, explicit load state, pending lock, reauth guard, and failure activation are required by `010_account_switcher.md`.

4. **Canonical Codex switch can report false success.**
   - Root: `CodexAccountPool.tsx:71-82` ignores `res.ok` and updates local state unconditionally.
   - Disposition: non-2xx check, preserved old active id, returned-id consumption, authoritative refresh, and stale-load generation are required.

5. **Custom forward providers can incorrectly receive the Codex pool.**
   - Root: `ProviderAuthPanel.tsx:42-50` branches on every `forward`; catalog canonicality is stricter.
   - Disposition: new pure `providerAuthSurface` must reuse `isAccountProvider`; custom forward activation is in the test matrix.

6. **Detail tabs and rail listbox have incomplete keyboard ownership.**
   - Root: tabs lack controls/panels/roving focus; listbox and option buttons are duplicate Tab stops.
   - Disposition: explicit WAI-ARIA tab behavior in 010 and single option-owned focus model in 020; Browser is the behavior oracle because the repo has no DOM test dependency and new dependencies are forbidden.

7. **Historical raw readiness leak must not be reintroduced.**
   - Root: earlier text inside an 8px dot had no actual `.sr-only` definition.
   - Disposition: current empty `aria-hidden` dot is preserved; status text stays in group heading and localized accessible name/title (`001`, `020`).

8. **Rail layout has no semantic shrink priority and fails by container width.**
   - Root: six unwrapped peers, five fixed gaps, fixed metadata, and viewport-only breakpoint.
   - Disposition: icon/identity/trail structure, conditional metadata, child-owned ellipsis, shell-local container query around 640px, and measured width matrix (`020`).

9. **Workspace style tokens drift from the design-system SoT.**
   - Root: undefined `--fg`/`--fg-muted` and touched raw values.
   - Disposition: replace with existing semantic tokens in 020; sync `docs/design-system/components.md` only after C proves the behavior.

10. **Baseline lint debt could be hidden by a broad completion claim.**
    - Root: existing `ProviderOverview.tsx` `react-hooks/set-state-in-effect` error.
    - Disposition: 030 runs lint and reports the unchanged baseline separately; every new lint/i18n error remains a blocker.

11. **Live account switching can leave user state changed.**
    - Root: account activation is a real local mutation.
    - Disposition: 030 captures original ids in process memory without printing, switches only reversible identities, restores both generic/Codex ids, and verifies restoration. No add/remove/redeem/auto-switch action is allowed.

12. **Identity-less OAuth providers are not true pools.**
    - Root: Kimi/Kiro credentials lack stable account identity and replace the active slot.
    - Disposition: plan amended so one-row identity-less providers are not described as multi-account pools; actual returned rows remain authoritative.

## Coverage ledger

- `000_plan.md`: objective, exclusions, class, HOTL bounds, threat model, dependency order, SoT and terminal outcomes — covered.
- `001_design_read.md`: existing-system Design Read, dials, concept skip, Accounts-tab distinction, states, a11y, rail grammar, responsive contract — covered.
- `002_baseline_evidence.md`: user screenshots, live count-only inventory, route/store anchors, reachable branch inventory, browser baseline and lint debt — covered.
- `010_account_switcher.md`: exact NEW/MODIFY paths, state ownership, canonical gating, activation matrix, tests and browser restore — covered.
- `020_provider_rail.md`: exact NEW/MODIFY paths, semantic row hierarchy, status-dot rule, container query, keyboard/locale/theme matrix — covered.
- `030_integration_qa.md`: stale check, ordered gates, live reversible QA, multi-width matrix, independent final review, repair policy and completion evidence — covered.

## Main audit judgment

All High/Critical implementation-state blockers found by independent explorers are represented as concrete plan amendments with reachable activation evidence. The only residual is process-level: formal A reviewer follow-up delivery failed repeatedly, so the audit relies on three completed independent reports plus main synthesis under the declared reclaim rule. This does not weaken C: final implementation review still requires a fresh independent reviewer before goal completion.

VERDICT: GO-WITH-FIXES (blockers=0)
