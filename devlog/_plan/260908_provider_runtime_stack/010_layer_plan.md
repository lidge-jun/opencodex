# 010 — Layer plan

Stack shape (merge bottom-up, ordinary dependent bases):

| # | Branch | Base | Thesis | Source commits |
|---|--------|------|--------|----------------|
| 1 | `codex/prs-l1-codebuddy` | `dev` | CodeBuddy Global/CN headless CLI providers + shared `coding-agent` runtime | #3340: `7e56b6399`, `f651611f1`, `18530f8e8`, `4b705e92d` (cherry-pick -x) + layout fix commit |
| 2 | `codex/prs-l2-qoder-global` | L1 | Qoder Global PAT provider, account-scoped live model discovery | #3349: `4ac98bd4d` (cherry-pick -x, import-path conflict resolved) + layout fix commit |
| 3 | `codex/prs-l3-qoder-cn` | L2 | Qoder CN PAT profile | #3350: `a4e805084` (cherry-pick -x) |
| 4 | `codex/prs-l4-marks-docs` | L3 | Provider marks, display names, docs-site Qoder section, CREDITS | new maintainer commits |
| 5+ | `codex/prs-l5-*` | L4 | Secondary PRs accepted by 013 triage, one layer each | cherry-pick -x |

Layer rules:

- Each layer builds at its own tip. The layout-guard fix for a layer's tests lives in
  that layer, not deferred upward.
- Original author preserved by `cherry-pick -x` (author field + `(cherry picked from
  commit …)` line). Maintainer-authored repair commits carry no trailer because they
  are not the contributor's work; the PR body names the source PR.
- PR bodies use the repository template and carry the stack map (DEV-STACK-03).
- Only the top layer's head gets CI. Lower PRs are opened for review navigation and
  merge order; their own PR CI may run (`pull_request` trigger) but is not the gate.

Verification plan (hosted only):

1. Push all layers with `--no-verify`.
2. If the top PR's `pull_request` CI skips platform lanes, dispatch
   `gh workflow run ci.yml -R lidge-jun/opencodex --ref <top-branch> -f lane=all`.
3. Record run id, every job conclusion; skipped/cancelled are not passing.
4. Merge bottom-up with `--admin`, retarget the next child to `dev` after each parent
   lands, keep parent branches until no open child targets them.
5. After the top merge: `git fetch origin dev`; every merge SHA must satisfy
   `git merge-base --is-ancestor <sha> origin/dev`; `git rev-parse origin/dev^{tree}`
   must equal the certified head's tree (or a diff limited to merge-commit metadata).
