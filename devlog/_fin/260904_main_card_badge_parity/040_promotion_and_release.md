# 040 — Phase 4: promotion to preview and main, release

Work phase: `wp4`. Depends on: `030`.

## Goal

Promote the merged `dev` state to `preview` and `main` and cut a release, as
the user explicitly authorized ("main preview 머지후 릴리즈까지 진행").

## Steps

1. Re-read `MAINTAINERS.md` and `scripts/release.ts` before acting; the release
   script is the release authority and is security-reviewed surface — do not edit
   it.
2. Confirm `dev` carries the merge commit and CI is green at that exact SHA.
3. Promote `dev` → `preview`, then `dev` → `main`, using the repository's
   established promotion path (pull request or maintainer promotion as
   `MAINTAINERS.md` prescribes; branch rulesets forbid direct pushes).
4. Cut the release through `scripts/release.ts`.
5. Verify: ancestry proof for both branches, the release run/tag, and the running
   proxy's `/healthz` version after upgrade.

## Escalation

If promotion or the release requires an approval the user has not delegated, or
the release script asks for a credential this session must not spend, stop and
report `NEEDS_HUMAN` with the exact blocking step rather than improvising.

## Bypass record

Tier: E8 (branch rulesets + release workflow). Executing surface: GitHub Actions
and branch protection. Known bypass: none available to this session. Residual
risk: a maintainer could promote manually. Final layer: branch ruleset on
`main`/`preview`.
