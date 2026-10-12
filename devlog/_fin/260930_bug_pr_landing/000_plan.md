# 260930 bug PR landing and backlog hygiene

## Objective

Land the ten open bug-fix pull requests that were green, mergeable and out of draft on
2026-09-30, then close backlog items that are already fixed, duplicated or superseded.

| PR | Subject | Author | Security review |
|---|---|---|---|
| #6316 | Claude models get their real 128K output maximum | vadymhimself | no |
| #6281 | Devin: Cognition blocklist rewrites for system prompt and message text | lonefisher | no |
| #6295 | Record why a native Claude passthrough failed in its request-log row | sh940701 | privacy (request log) |
| #6326 | Pool quota policy requires live credential evidence | luvs01 | yes (account pool) |
| #6325 | Bound XML identifying-attribute scans in redaction | luvs01 | yes (redaction) |
| #6324 | Devin family-axis scoring, sparse with own-key targets | luvs01 | no |
| #6319 | Bound Cursor local installer manifests | luvs01 | yes (install surface) |
| #6315 | Bound Devin held signature-type payloads | luvs01 | no |
| #6308 | Preserve Codex TOML values and routing marker ownership | luvs01 | yes (config write) |
| #6260 | Apply new-model policy before discovery, sync and export publication | colthreepv | no |

## Constraints

- Merge authority: the user authorized merge, cherry-pick, squash or reimplementation.
  Merges use the `dev` maintainer-integration exception in `MAINTAINERS.md` (actor
  `lidge-jun`, admin). Each merge records the decision and exact-head CI in a PR comment.
- Outstanding maintainer change requests block a merge until resolved.
- Reimplementation of another author's work carries a `Co-authored-by` trailer.
- Security findings for unfixed defects stay in `.tmp/`, never in this directory.
- Out of scope: releases, promotion to `main`/`preview`, npm publish, new features.

## Work-phase map

| Work-phase | Doc | Output |
|---|---|---|
| wp1 | this directory | locked roadmap |
| wp2 | 010_phase1_pr_landing.md | reviewed PRs merged or left open with a posted reason |
| wp3 | 020_phase2_backlog_hygiene.md | resolved, duplicate and superseded items closed |
| wp4 | 030_phase3_dev_tip_ci.md | final `dev` CI observed; dispositions recorded |

Order is dependency order: hygiene needs the landed set to know which issues are now
fixed, and the final CI needs every merge in place.

## Roadmap audit

A read-only `gpt-6.1-sol` auditor returned near-pass with three blockers against
`010_phase1_pr_landing.md`: live actor and base revalidation before `--admin`, a recorded
security verdict before merging the security-review PRs, and union checks against the moving
tip. All three are folded into that doc. The roadmap is locked for wp2 through wp4.
