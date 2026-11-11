# Startup safety and account labels

Desktop users need a quiet, truthful startup verdict when login registration cannot
be checked, and OAuth pool users need recognizable, privacy-preserving account
names. Preserve conservative restart-protection credit while distinguishing an
unknown observation from a verified disabled setting. Render user aliases first,
then a server-projected masked identity, then a localized ordinal.

- Loop: satisfy-spec, triggered by the owner request; goal is both changes merged to `dev`.
- Scope: Desktop login evidence and dashboard presentation; OAuth roster and account
  label surfaces; their tests, all GUI locales, public and ownership documentation.
- Out: shared inline-label background style; real user installation, services and
  login items; root full suite; new dependencies; native stack registration.
- Evidence: failing-first regressions, focused suites, typecheck, GUI checks,
  file-size ratchet, i18n, React Doctor, privacy and structure checks, isolated
  browser screenshots and exact-head CI plus a fresh independent review.
- Stop: after the authorized PR is merged and the squash SHA reported; blocked
  execution and unmet gates are reported without declaring completion.
- Memory: this unit and its numbered phase documents; session goalplan and receipts.
- Escalate only for a necessary unavailable capability or an unauthorized action.
  No token or time bounds stated; host limits apply. Keep host load moderate.

## Dependency order

1. Docs-only roadmap and independent audit (this cycle).
2. [010 implementation](010_implementation.md): evidence contract and safe
   account projection, then their presentation and tests in one coherent change.
3. [020 integration](020_integration.md): exact-head review, CI and integration.
   Use one ordinary PR unless the actual diff proves too large to review safely;
   phase ordering by itself is not a reason to stack.

## Source evidence and architect consultation

Baseline `41f316f40e` matched freshly fetched `origin/dev`. The service diagnostic
collapses failed and disabled probes in `src/service/desktop-startup.ts`, while
`gui/src/pages/startup-sections.tsx` repeats one recovery key three times. The
OAuth roster returns config-dependent `email` from `src/oauth/index.ts` and
`src/server/management/oauth-account-routes.ts`; the GUI requests ordinal-only for
Anthropic in `gui/src/components/provider-workspace/ProviderAuthPanel.tsx`.
The macOS tray and service share enabled-credit fixtures as documented in
`structure/desktop-start-at-login.md`.

Architect handle `node:delegated-task:command%3Amcp%3A2f716394-9556-49bf-a7d0-57ef9242bf2e%3Adelegate-task%3Astartup-architect-proposal-1`:
ARCH-01 additive tri-state accepted, with disabled only on stable evidence for
the actual app; absence without independently established ownership stays unknown.
ARCH-02 conservative backend credit and neutral GUI presentation accepted for
both live supervised and owned proxy; independently known risks remain visible.
ARCH-03 one explanation accepted. ARCH-04 masked email projection accepted;
no opaque ID fallback, malformed identities use ordinal. Aliases remain first.
Reflection round 1 was MISALIGNED: stable negative checks, stale/cached presentation,
system-disabled guidance and all OAuth fallback consumers needed detail. These four
findings were accepted and incorporated in `010_implementation.md`. The same
architect's reflection round 2 returned ALIGNED for ARCH-01 through ARCH-04,
with no remaining material gaps. Independent audit round 1 returned FAIL: omitted
Classic/page-level presentation, an explicit fixture-backed browser harness, security
review, and `ci:full` were accepted and added to 010/020. The same independent
reviewer's round 2 returned PASS: all four findings closed, no new high or critical
findings, and all 35 named paths resolved. This is plan-level evidence only.

## Baseline checks

After `bun install --frozen-lockfile` in root and `gui/` (both exit 0),
`bun test tests/gui/startup-health-ui.test.ts tests/gui/provider-workspace-auth.test.ts tests/service/service-desktop-login-registration.test.ts`
exited 0, 100 pass; it directly reads the named tests and their imports.
`bun run structure:check` exited 0 and reads `structure/` through
`scripts/structure-ssot.ts`. `cd gui && bun run lint:i18n` exited 0 and
reads its configured `gui/src/pages`, `gui/src/components` and other named GUI files;
it is not proof of translation completeness by itself.

## Roadmap cycle conclusion

The independent re-audit passed after four findings were folded in. A fresh bound
document check found three non-empty documents, required contract/integration gates,
and clean whitespace. Next: revalidate 010 against current source and begin its
failing-first implementation cycle. No product code was changed in the roadmap cycle.
The initial assumption that an existing roster label was always safe did not hold:
the email field follows a configurable masking policy, so the plan now requires a
dedicated masked projection. A test with masking disabled would refute that direction
if the projected label exposed the original identity.
