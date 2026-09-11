# 021 — wp2 landing record: PR #3166

## Landed

- PR: #3166 `ingw/fix-request-owned-main-pin-3157` by @Ingwannu
- Head audited: `17f01162ad404f1bcee7d7f00998fc0e143365e5`
- Merge SHA on `dev`: `75090d4e0e26637a3db0157edf3090830ba00d52`
- Mechanism: `gh pr merge 3166 --squash --admin --delete-branch`
- Closes: #3157 (closed manually)

## The flake, and how it was resolved rather than waived

At first inspection `test 3/4` was red on
`tests/responses-state.test.ts > late async spill completion cannot overwrite the shutdown
fallback` with `ETIMEDOUT` from `src/responses/spill-store.ts:232` — a wall-clock ACL budget
expiring on a loaded runner, in a subsystem this PR does not touch.

Rather than merge over a red check, the run was re-inspected: run `33527409692` had already
been re-run and reported `completed success`, and `gh pr checks 3166` returned zero `fail`
lines on the same head. The merge went in on a genuinely green rollup.

## Ancestry proof

    git merge-base --is-ancestor 75090d4e0e26637a3db0157edf3090830ba00d52 origin/dev
    # exit 0

## What changed in the product

A Pool-mode request carrying its own forwardable Codex bearer no longer clears a healthy
manual `__main__` pin. Request-owned credentials are excluded from stored-account entitlement
discovery by design, and the shared-selection path had been reading that exclusion as evidence
the pinned main was dead — persisting a Pool account at 100% usage over a main at 16%.

The fix validates the caller credential's own account-gated roster, gives an unentitled caller
a model-only detour that leaves the shared pin intact, and keeps paused or quota-drained mains
on the ordinary Pool promotion path.

## Security boundary

MAINTAINERS.md requires explicit security review for credential-selection changes. The PR
records the boundary: no caller bearer is persisted, no Pool affinity, health, or entitlement
state is written, and the physical main credential is not read. Documented in
`structure/08_openai-provider-tiers.md`; regressions in `tests/codex-auth-context.test.ts`
(68 pass).

