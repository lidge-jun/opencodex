# Phase 2 — Publish the stack, one pull request only

## Push

```sh
git push --no-verify origin codex/260908-d-group-l1-test-runner-output
git push --no-verify origin codex/260908-d-group-l2-cursor-watchdog
```

`--no-verify` is the owner's instruction for this unit. Neither push starts
Cross-platform CI: `ci.yml`'s `push:` trigger is limited to
`branches: [main, preview, dev]` (`ci.yml:26-27`).

## Open exactly one pull request

Tip only, targeting `dev`:

```sh
gh pr create --repo lidge-jun/opencodex --base dev \
  --head codex/260908-d-group-l2-cursor-watchdog \
  --title "fix(test): preserve lane output after timeouts and stabilize the Cursor stream-health watchdog" \
  --body-file <path>
```

The lower layer gets **no** pull request. `ci.yml` triggers on a bare
`pull_request:` with no base filter (`ci.yml:7`), so a second pull request would
start a second Cross-platform CI run; draft status does not suppress it either —
no job in `ci.yml` reads a draft condition.

A stacked child pull request based on the layer-1 branch is also unavailable here:
`enforce-target` grants the wrong-base exemption only when the parent branch has
its own **open** pull request (`enforce-pr-target.yml:536-537`), which is exactly
what this design avoids. The tip therefore targets `dev` directly.

## Description requirements

`.github/PULL_REQUEST_TEMPLATE.md` requires Summary, Verification, and Checklist;
`enforce-target` rejects thin or malformed descriptions. The description must also:

- name both source pull requests (#3924, #3930) and describe the stack layering;
- carry `Co-authored-by: luvs01 <27862058+luvs01@users.noreply.github.com>`. The
  hygiene checker reads that trailer from the description or a commit message
  (`pr-carry-attribution.cjs:190`), and the carry verbs in the description are what
  make it demand one at all. The description trailer satisfies the gate; it does
  **not** by itself put the trailer in the landed commit — see phase 3, where the
  squash body carries it explicitly;
- state honestly that local suite, typecheck and build were **NOT RUN** by owner
  instruction, and that hosted CI on this exact head is the verification gate,
  naming which job families are skipped by the workflow;
- be substantive: `pr-quality.cjs` strips template boilerplate and requires real
  content (two substantial sections, or 120+ characters across two blocks), so
  placeholder bullets fail the gate.

As a maintainer-authored pull request this needs no readiness checklist and no
`review-ready` label (`enforce-pr-target.yml:766-768`, `1096-1103`). Do not tick a
local-CI attestation box that was not earned — the owner forbade the local suite.

No GUI files change, so the screenshot rule does not apply.

## Other workflows that will fire

Expected and unavoidable for any pull request: `enforce-target`, `pr-hygiene`,
`pr-labeler`, `react-doctor`, plus CodeRabbit. `service-lifecycle` does **not**
fire — none of the four paths is in its allowlist. These are gate/lint signals, not
the product suite; only Cross-platform CI is the product gate.

## Outcome

Executed 2026-09-08 against base `942c02873`.

| Ref | SHA | Pull request |
|---|---|---|
| `codex/260908-d-group-l1-test-runner-output` | `ab06523e6` | none, by design |
| `codex/260908-d-group-l2-cursor-watchdog` (tip) | `8b81676ac` | [#3940](https://github.com/lidge-jun/opencodex/pull/3940), base `dev` |

Both pushes used `--no-verify`. Neither started Cross-platform CI, as predicted by
the `push` branch filter. Opening #3940 started exactly one run on `8b81676ac`; the
first check-runs to appear were `changes`, `select windows runner`, `hygiene`,
`label`, `resolve-pr` and `react-doctor`, which matches the expected set.

The layer-1 branch has zero pull requests in any state, which is the property that
keeps the stack to a single CI run.

## Acceptance

- Both branches exist on `origin` at the expected SHAs.
- `gh pr list --head codex/260908-d-group-l1-test-runner-output` returns empty.
- Exactly one open pull request has head `codex/260908-d-group-l2-cursor-watchdog`
  and base `dev`.
- Exactly one Cross-platform CI run exists for the tip head SHA. "Exactly one" is
  scoped to the pre-merge candidate: landing on `dev` starts a separate push run,
  and a base refresh replaces the candidate with a new head and a new run.
