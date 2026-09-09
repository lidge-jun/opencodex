# 030 — Phase 3: verification and pull request

Work phase: `wp3`. Depends on: `010`, `020`.

## Goal

Prove both fixes on the running dashboard, pass the repository gates, and open a
PR against `dev` that satisfies the repository's own CI gates.

## Steps

1. `bun run typecheck` — expect exit 0.
2. `bun test tests/codex-auth-api.test.ts` — expect exit 0, new case passing.
3. `bun run lint:gui` — expect exit 0.
3b. `bun run privacy:scan` — expect exit 0 (AGENTS.md CI gate; added after audit
    blocker 3 noted it was missing from this list).
3c. Docs-site evaluation: this change restores badge parity that the dashboard
    documentation already describes generically; record "no docs-site change
    needed" in the PR unless a page names the missing badges explicitly.
4. `bun run build:gui`, restart the local proxy from this checkout, load the
   dashboard, and capture a screenshot of the main card showing BOTH badges.
   The proxy on port 10100 is the user's live service: restart it only through
   the normal `ocx` service path already used for source dogfooding, and verify
   `/healthz` afterwards.
5. `bun run test` — full suite, required before marking the PR review-ready
   (AGENTS.md PR-ready gate).
6. Branch `codex/260904-main-card-badge-parity`, commit per phase, push, open a
   PR targeting `dev` with all three template sections and the screenshot
   (`enforce-target` rejects a gui PR without one).
7. `gh pr checks` at the exact head SHA; merge only on a green rollup.

## Accept criteria

- Screenshot shows `pro` badge and ticket badge on the main card.
- Full suite and typecheck exit 0 at the PR head SHA.
- `git merge-base --is-ancestor <merge-sha> origin/dev` succeeds after merge.

## Bypass record

CI gates here are repository-owned (E8, GitHub Actions). Known bypass:
`--no-verify` on local hooks does not bypass branch protection on `dev`.
Residual risk: none beyond maintainer merge authority. Final layer: branch
ruleset on `dev`.
