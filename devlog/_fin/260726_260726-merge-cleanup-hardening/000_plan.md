# 000 — 260726-merge-cleanup-hardening: Plan

## Objective

Publish the local `dev` integration (Grok Build production hardening + Claude
Desktop), retire the three remote branches the user approved for deletion, and
then harden the surfaces that this session's two merges actually touched.

Evidence base (measured this session, not remembered):

- `git rev-parse dev` = `3ec8f532bab2b3fb663ca5d8c711b452cf4d806d`
- `git ls-remote origin refs/heads/dev` = `6d8f05fdce63cb1a9b10491a49a601efba68b03e`
  (origin is 38 commits behind; local is a strict fast-forward descendant)
- `gh api repos/lidge-jun/opencodex/branches/dev/protection` → 404 "Branch not
  protected" (a plain push is allowed; no bypass needed)
- `gh pr view 403` → `state=OPEN head=092dd749102ae568b11c89b9c8e3a57bfb2b877d`
- `git merge-base --is-ancestor 092dd749 dev` → exit 0 (the PR head is already
  contained in local `dev`, so closing #403 loses no work)

The merge landed via two commits, `f6520fcd` (Grok) and `0a78672f` (Desktop),
plus the follow-up test fix `3ec8f532`. Eight conflicts were resolved by hand,
which is exactly the material that needs an adversarial second look.

## Loop-spec

- Loop archetype: WP1 is verifier-defined (SHA equality, branch absence are
  pass/fail). WP2–WP3 are judged: "is this merge resolution actually correct"
  has no single oracle, so the verifier is source-grounded adversarial review
  plus the existing test gates.
- Write scope: `src/`, `gui/src/`, `tests/`, `gui/tests/`, `docs-site/` when a
  user-facing behavior changes, `devlog/_plan/` for plan and receipt docs.
- Out of scope: `dev2-go`, `feat/macos-app`, other repositories, npm publish /
  GitHub Release, version bumps, unrelated refactors, and the code of every
  other open PR (#355 #408 #424 #426 #429 #447 #455 #461 #464 #478 #479 #481 #482).
- Remote mutations authorized by the user this turn: push `dev`, close PR #403,
  delete the three named remote branches. Nothing else touches the remote.
- Bounds: local test gates only; no unattended credential use beyond the already
  authenticated `gh`/`git` remote.

## Work-phase map (one phase = one full PABCD cycle)

| WP | Doc | Slice | Depends on |
|----|-----|-------|------------|
| WP1 | `010_push_and_remote_cleanup.md` | Push `dev`, close #403 with an ancestry proof, delete 3 remote branches, verify preserved refs | — |
| WP2 | `020_server_surface_hardening.md` | Adversarial review of the server-side conflict resolutions | WP1 |
| WP3 | `030_gui_surface_hardening.md` | Adversarial review of the GUI/i18n conflict resolutions | WP1 |
| WP4 | `040_final_gates.md` | Full gate run and close-out commit | WP2, WP3 |

## Accept criteria

Mirrored into the goalplan `criteria[]` as c1–c6:

- c1 — local `dev` and `origin/dev` report the same SHA.
- c2 — PR #403 is `CLOSED` with the containment proof posted as a comment.
- c3 — the three approved remote branches are absent from
  `git ls-remote --heads origin`, and `dev`/`main`/`preview`/`dev2-go`/
  `feat/macos-app`/`tmp/dev2-go-source-export` all survive.
- c4 — every server-side defect found is fixed and pinned by a regression test,
  or the surface is recorded NOOP with the paths inspected and the reasoning.
- c5 — same standard for the GUI/i18n surface.
- c6 — `bun run typecheck`, `bun run test`, `gui bun run test`, `bun run
  lint:gui`, `bun run privacy:scan` all pass with zero new failures.
