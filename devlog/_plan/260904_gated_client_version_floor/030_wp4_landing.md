# 030 — wp4: landing

1. `bun run typecheck`
2. `bun run privacy:scan`
3. `bun run test` (full suite; this is the PR-ready gate)
4. Branch `codex/260904-gated-client-version-floor` off current `dev`, targeting `dev`.
5. PR using `.github/PULL_REQUEST_TEMPLATE.md` with Summary, Verification and Checklist filled.
6. Push is owner-approved for this unit, including `--no-verify`.
7. Merge once CI is green, also owner-approved.

Known container-only failures listed in `AGENTS.md` are not regressions; on this Windows host
the service/systemd cases may behave differently again. Any failure is compared against a
baseline run on the unmodified tree before it is called a regression.
