# wp3 — #6774 config write lock carry

## Scope

Carry #6774 (luvs01, which carries c7ac1a03 by Devin AI) onto current `dev`. The PR serializes the cooperating OpenCodex writers of the Codex config and profile through one config lock with explicit held handles, and binds journal recovery to that locked section. Its base e6c6e13a22 is two commits behind `dev`; only the layout registration files overlap.

Detailed review findings and the hardening acceptance list stay in gitignored lane scratch (`.tmp/L2-scratch/`) until the fix ships, per the AGENTS.md security-notes rule. This document covers only what the PR description already states publicly.

## Plan

1. Rebase `refs/lane-l2/pr6774` onto `origin/dev` in `.tmp/lanes/L2-service-journal-2` (branch `codex/codex-config-write-lock-carry`), preserving the #6772 and #6778 layout registrations.
2. Apply the scratch acceptance list. The fixes and their tests land together in the carry PR.
3. Keep `inject.ts` (cap 987) and `codex-auth-api.test.ts` (cap 6549) under cap by moving code into new sibling modules. Register any new test file in both layout files, and keep `structure/codex-home.md` at 600 lines or fewer.
4. Regression files: `codex-config-write-lock`, `codex-prompt-lock`, `codex-inject-write-lock`, `codex-inject-v1-reconcile`, `codex-inject-missing-config`, `codex-journal`, `codex-journal-recovery`, `codex-prompt-layers-write`, `codex-features-cache`, `codex-v2-gate`, `tests/config/config-mutation-lock`, `tests/cli/cli-agent-runtime-settings`, and `codex-auth-api`. After those: typecheck, the layout and ratchet tests, `structure:check`, and `privacy:scan`.
5. Before ready: an independent sol code review and a security review, with the security-review notes kept in scratch.

Co-authors: `Co-authored-by: 김상훈 <luvs01@hanmail.net>` and `Co-authored-by: Devin AI <158243242+devin-ai-integration[bot]@users.noreply.github.com>`.

