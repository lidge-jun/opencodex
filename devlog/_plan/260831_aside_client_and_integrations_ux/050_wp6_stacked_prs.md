# wp6 — Stacked pull requests

## Shape

The dependency graph is two independent chains, not one line:

```
dev ── wp2 (aside backend) ── wp3 (aside GUI)
 └──── wp4 (history redesign)
 └──── wp5 (brand marks)
```

wp3 is the only child that must target another PR's head. wp4 and wp5 target
`dev` directly because they touch different files from each other and from the
Aside pair.

One overlap exists and is deliberate: wp3 adds `CLIENT_MARKS.aside` while wp5
adds six other entries to the same map. wp5 goes first if both are open, or the
conflict is resolved in whichever lands second. Recorded so review is not
surprised.

## Branches

`codex/aside-export-client` (wp2), `codex/aside-gui-surface` (wp3, based on
wp2), `codex/integrations-rollback-history` (wp4), `codex/client-brand-marks`
(wp5).

## Per-PR requirements

`.github/PULL_REQUEST_TEMPLATE.md` in full: Summary, Verification, Checklist.
`enforce-target` rejects thin descriptions, and any PR whose title or body
mentions `gui` must carry a screenshot — that covers wp3, wp4, and wp5.

`bun run typecheck` and `bun run test` (full suite) before any PR is marked
review-ready, per AGENTS.md. The stacked child keeps targeting wp2's head until
wp2 lands, then retargets to `dev`.

## Push

Requires explicit user approval per LOOP-GIT-01. The user asked for stacked PRs
in the original request, which authorizes the push for this scope.
