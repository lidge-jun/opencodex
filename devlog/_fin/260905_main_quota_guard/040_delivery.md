# Reviewable stack delivery

Depends on the completed runtime, settings and Reserve compatibility outputs. No production code in this cycle unless a verified defect requires a new scoped repair plan. All remaining platform checks, including macOS, are mandatory before each merge; runtime checkpoints are not merge approval.

## Branch and PR operations

Bottom `codex/main-account-99-hard-lock` -> dev: policy/config/API/status/regression contracts.
Upper `codex/main-account-99-settings` -> bottom: consumer UI, translations, screenshots and usage docs.
Use `.github/PULL_REQUEST_TEMPLATE.md` sections unchanged. Each body carries the stack order and exact verification evidence. GUI body embeds a durable screenshot. Explicitly disclose no local suites by owner instruction; never tick an assertion that a local suite passed.

PUSH: `git push --no-verify -u origin <branch>`; rewritten stack tips use explicit `--force-with-lease=<ref>:<observed-sha>` and only after preserving peer changes. Never force dev/main/preview.

## Verification and merge

Refresh `gh pr view` head/base, full statusCheckRollup, reviews and review threads. Independently audit security-sensitive policy/identity and UI contracts in English. Correct findings, cascade any bottom edits into upper, push and verify new heads.
CI is the test authority: inspect real workflows/logs for test/typecheck coverage at exact head, not just an empty required-check list. Diagnose failures before retrying.
On green/no unresolved blockers, user authorizes admin squash merge bottom. Record bypass authorization on PR. Immediately fetch dev; require `git merge-base --is-ancestor <merge-sha> origin/dev` exit 0.
Retarget/cascade upper after squash so it contains only its own changes over dev; reverify exact head CI before the upper admin merge. Repeat ancestry proof.

## Durable closeout

MODIFY this unit's numbered evidence doc with PRs, exact heads, checks, screenshots, review conclusions and merge SHAs. Move unit to devlog/_fin only when terminal outcome is recorded and all intended implementation is visible in public history. Goalplan completion follows actual D close and evidenced criteria; do not hand-mark a missing FSM phase as done.
