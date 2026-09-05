# Main-account quota protection and Reserve compatibility

## Loop specification

- Archetype: spec-satisfaction repair; HOTL, bound checkout 8841.
- Trigger: owner requests a 99% main-account hard-lock switch beside Ultra Fast and an investigation/patch for using other models alongside Luna reserve.
- Goal: stop new main-account admissions at observed 99% usage while keeping unrelated routes available, with explicit opt-in consequences and truthful Reserve compatibility.
- Non-goals: upstream entitlement bypass, invented ordinary-usage recovery, quota reset redemption, modifying live port 10100, releases, replacing Codex binaries, or editing the reference corpus.
- Verifier: exact-head GitHub CI, TypeScript check, existing GUI build/lint, isolated browser interaction and screenshots. No local test suites, including focused suites or test:changed. User explicitly authorizes no-verify pushes and admin merges after green CI/review.
- Stop: every registered criterion evidenced and stack merged bottom-up; otherwise report actual missing external authority, not completion.
- Memory: this unit plus the session-bound goalplan/ledger.
- Resources: existing local tools and GitHub credentials; no purchases; 4-hour reassessment checkpoint. Model and effort inherited for all lanes. Main reclaims a packet after two distinct worker failures; delegation changes are P amendments.
- Terminal outcomes: DONE, NOOP with evidence, BLOCKED/NEEDS_HUMAN for a real external prerequisite, UNSAFE for an entitlement bypass, BUDGET_EXHAUSTED only at the stated bound.

## Baseline and ownership

Base `d6b457462` matches fetched `origin/dev`. Checkout began clean/detached and was adopted in place as `codex/main-account-99-hard-lock`.
Installed locked root/GUI dependencies without changing manifests. Initial typecheck lacked bun-types; after frozen install, `bun run typecheck` exited 0. No tests executed.

```text
src/types/config.ts + src/config.ts       persisted opt-in
src/codex/quota.ts + auth-api.ts          observed quota and physical identity
src/codex/account-usability.ts            Pool exclusion
src/codex/auth-context.ts                 final native-main admission
src/server/management/config-routes.ts    settings transaction/DTO
gui/src/pages/codex-set-multiauth.tsx     existing advanced settings placement
gui/src/components/                      switch/dialog/main-card status
tests/codex-integration/ + tests/config/  CI-only behavioral regression
```

Reuse existing config mutation/rollback, quota parsing, account identity reconciliation, native dialogs and UI tokens. Do not add a framework, second settings API, or credential store.

## Dependency-ordered work phases

1. wp0: source-grounded docs-only roadmap and independent audit; lock before production edits.
2. wp1 / `010_policy.md`: main quota protection contracts, admission and management, with regression coverage. Bottom PR targets dev and works without the UI layer.
3. wp2 / `020_settings.md`: switch, confirmation, main-card state and supported Reserve compatibility documentation; depends on the policy contract. Upper PR targets the bottom branch.
4. wp-reserve / `030_reserve_compatibility.md`: source-grounded explicit Reserve metadata/availability and independent quota handling; depends on the preceding identity and settings contracts.
5. wp3 / `040_delivery.md`: exact-head review/CI and bottom-up authorized admin merge, followed by fetched ancestry and closure evidence. Pending macOS and other platform gates remain mandatory.

The Reserve client gate is a separate feasibility decision, not permission to misrepresent server state. If source establishes a safe OCX-only compatibility patch, concretize it as a P amendment before writing. If it requires modifying the installed Desktop client or publishing to an unspecified upstream repository, record the boundary and ask for that specific decision after completing in-scope work; do not claim same-picker coexistence.

## Acceptance

- Off/absent flag preserves current routing. Enabled flag uses the 5h/short window when present, otherwise weekly, otherwise monthly-only usage; it blocks at >=99 on that selected window. Other windows cannot trigger this local policy. Unknown data is not invented as 0 or 100. Owner steering is recorded in 013.
- Main exclusion cannot prevent usage refresh or profile recovery. Explicit main and Direct paths cannot evade a measured block; unrelated caller credentials cannot inherit main's quota.
- Observations are identity-bound; account changes and restart cannot attach another account's cached reading. Only a fresh valid lower observation releases this policy, not clock-only expiry, pause/cooldown/reauth. The existing minute sweep refreshes blocked main usage without inference or reset credits.
- UI distinguishes enabled from currently blocked. Cancel/Escape do not save; save errors preserve actual server state; success requires explicit acknowledgment. Main status remains visible outside Advanced.
- Do not claim 1% is reserved: parallel/in-flight/direct-to-upstream use can reach 100 before observation. Luna reserve cannot be used while this policy blocks the main account.
- Keep server Reserve grants and `ordinary_usage_allowed` unchanged.
- Every merge requires reviewed exact-head CI and an origin/dev ancestor check.

## Continuity

wp0 roadmap build: independent audit PASS after three accepted amendments (outbound guard reachability, six-hour durability, effective workspace matching). Baseline root typecheck, GUI build and GUI i18n lint passed. No production edits or local suites.

Next wp1 P: reread 010 against current tree, name exact worker API boundaries, include the discovered Direct sidecar header path in `src/providers/openai-sidecar.ts`, then independently audit before building. Reserve Desktop investigation remains read-only and may add a later bounded compatibility cycle if evidence supports it.
