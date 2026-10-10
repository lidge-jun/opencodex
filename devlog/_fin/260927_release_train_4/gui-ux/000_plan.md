# Release train 4 — GUI UX lane

The current dashboard exposes routed-model facts that still require editing `config.json`, and a combo with a text-only member still requires a manual Vision Sidecar declaration. This lane reviews those focused GUI changes on the live `dev` shape, verifies their actual browser flows, and lands only changes whose state transitions and CI are proven. `001_inventory.md` records the intake snapshot and PR age; each decade document below gives the file-level implementation or disposition contract.

## Loop specification

- **Archetype / trigger / goal:** satisfy the delegated release-train GUI acceptance contract by reviewing seven PRs and three issues, integrating safe lane-owned changes into `dev` with browser, test and CI evidence.
- **Non-goals:** main/preview, release/version changes, live user home/accounts/service, account-pool and picker lane code, a wholesale #5408 adoption, native GitHub stacks, and security findings in tracked files.
- **Tool and write scope:** GitHub reads/writes authorized in the delegation; source edits/Git operations in `/Users/jun/.codex/worktrees/t4-gui-ux/opencodex`; docs in this `gui-ux/` directory; focused tests there, with `test:changed`/full suites in a verification-only worktree at `/private/tmp/t4-gui-ux-verify` after the exact commit; isolated proxy homes and distinct local ports via the direct server entrypoint with client integrations OFF; subagents only `gpt-6-sol`; no other-thread messages. No user-imposed token or wall-clock limit.
- **Verifier:** focused Bun tests for changed behavior, `bun run test:changed`, `bun run typecheck`, `bun run lint:gui`, `bun run build:gui`, `cd gui && bun run lint:i18n` for JSX copy, `cd gui && bun test tests/locale-parity.test.ts` for ten-locale key parity, `bun run privacy:scan`, `bun run structure:check`, `bun run skill:surface:check` when capability maps change, and `bun test tests/ci-workflows/file-size-ratchet.test.ts` for capped files; browser click flows and screenshots for UI states; required PR CI at the exact head and post-merge `dev` CI. Script existence is grounded in root and GUI `package.json`; the locale parity test reads `src/i18n/<locale>.ts` directly (`gui/tests/locale-parity.test.ts:6,229`). `lint:i18n` does not itself inspect locale dictionaries, so translation meaning also needs manual review and browser proof. `bun run test:changed` follows imports but misses subprocess/source-oracle edges, so explicit regression files remain necessary. Seven concurrent worktrees justify the documented full-local-suite contention exception; CI supplies the broad suite.
- **Stop / outcomes:** DONE when selected PRs are merged with exact-head/post-merge CI and every assigned PR/issue has a linked disposition; NOOP only if current `dev` already satisfies the whole lane; NEEDS_HUMAN for a genuine product/security decision that cannot be inferred; BLOCKED only on a repeated external blocker; UNSAFE when a change fails the security boundary; BUDGET_EXHAUSTED only on an actual user/host bound.
- **Memory artifact:** this numbered unit, PR Verification bodies, exact-head CI links, and local `.tmp/gui-ux/` screenshots/receipts.
- **Escalation:** a changed PR head, another lane changing a shared owner, auth/security objections, irreconcilable CI or browser environment, or an unowned external contract changes the disposition before publication.

## Design Read

```yaml
name: opencodex-dashboard
colors:
  primary: "var(--accent)"
  accent: "var(--amber)"
  background: "var(--bg)"
typography:
  heading: { fontFamily: "var(--font-ui)", fontSize: "var(--text-subtitle)" }
  body: { fontFamily: "var(--font-ui)", fontSize: "var(--text-body)" }
iconography:
  system: "existing OpenCodex controls"
  weight: "regular"
  domain: "existing components"
```

This is an operator dashboard for repeated model and provider work. Preserve compact rows, stable navigation, semantic status color and the existing dialog shell from `gui/design-system/`; add actions where a user is already inspecting the affected model. Never apply an editorial or floating-glass kit. **DESIGN_VARIANCE 3 / MOTION_INTENSITY 1 / density D6.** A save needs a clear committed/no-op/unknown outcome, visible loading state, recovery after timeout, focus restoration, keyboard activation, and readable 400px plus long-locale layout. A restore is a separate explicit action because it discards declarations.

## Ordered work phases and decisions

| Phase | Decision | Why / acceptance |
|---|---|---|
| `010` | Carry and repair #6058 on current `dev` | Capability editor is a cohesive lane-owned slice with no merge-tree conflict. Fix remaining fractional-window and persistence-failure concerns, prove model settings save/restore in an isolated proxy and browser, and land after exact-head CI. |
| `020` | Reimplement #4932 on current `dev` after `010` | Its model modality declaration shares the new editor's provider map. Resolve `combo-routes.ts` against current code, add Vietnamese copy, and prove a mixed combo's sidecar enrollment plus sibling-axis preservation. |
| `030` | Assess/reimplement #5617 on current `dev` after model changes | Large stale visibility semantic change intersects `model-routes.ts`, `Models.tsx`, catalog, and provider UI. Reimplement only after the account-pool lane finishes the shared provider UI owner, and if global-vs-provider semantics survive current catalog convergence and security review; otherwise leave open with concrete deferral comment. |
| `040` | Defer auth/config/account PRs and resolve issues | Defer #4649/#4644 pending explicit security review and iOS proof; #5932 overlaps account-pool ownership; #2355 is 2,971 commits old with eight conflicts; #5408 is 7,790 added lines and shares the account-pool domain. Keep #3379 open because selector rename is missing, and clarify #4189's intended provider contract. No auth implementation is in this train. |
| `050` | Integration and disposition | Build selected branches sequentially from the preceding accepted `dev` merge SHA, rebase to the current `dev` tip, validate file caps/union/ten locales, attach screenshots by `pr-assets` SHA, merge only after required exact-head checks and review findings, verify `dev`, then close solved issues/original PRs with links and credit. |

Each phase is its own PABCD cycle. A later P rechecks this plan against the latest `origin/dev` and may narrow or append a slice with a written reason. `structure/INDEX.md` owns the source-document map; relevant SoT targets are `structure/gui-and-management-api.md`, `structure/dashboard-and-usage.md`, `structure/catalog.md`, and `structure/config.md` when their contracts actually change. User-facing changes update the matching `docs-site/` guide or reference. All new tests are registered in both test-layout inventories. PR screenshots live on `pr-assets`, never in the code PR branch.

## Consultation

Architect handle `01a0e33b-a8a7-7ab3-8682-461189c7d1c8` proposed GUI-01→GUI-02→GUI-03, conditional auth/config work, account-pool handoff for #5932, and wholesale #5408 deferral. I accept its dependency order, but reject its suggestion that the current OAuth account alias editor resolves #3379's Codex selector rename. `CodexAccountPickerSetting.tsx` still only toggles picker visibility; `codexAccountNamespaces` keys still lack a rename API. The issue remains open. Same-architect reflections first found a #3379 wording gap, #5617 owner/rollback gaps, and then #4932/#5617 decision wording and conditional-path gaps. Those were folded into this revision, `020_combo_sidecar.md` and `030_visibility.md`. The same handle's final response was **ALIGNED**, with no material gap in those amended passages. The independent A reviewer remains separate.
