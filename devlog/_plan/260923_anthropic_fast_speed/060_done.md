# 060 Done (wp1)

## Conclusion

Claude fast mode is a native FastWire (`anthropic-speed`) on the Anthropic adapter for `claude-opus-5-5`, `claude-opus-5` and `claude-opus-4-8` on both the OAuth and API-key providers, with `usage.speed` confirmation, a budgeted one-shot standard-speed resend on a recognized fast refusal, a `fast_downgrade` metrics class and request-log label, and confirmation-gated 2x pricing. PR #5604 to `dev`, head `5e4cb7ea77`.

## Evidence

- Live probe matrix (020) and live smoke through the new adapter code (050): refusal → standard resend → `downgraded/response-declined`; Opus 4.6 live standard echo downgrades.
- Isolated end-to-end through the real proxy pipeline with a fake upstream, rendered request-log label (050, `evidence/logs-fast-downgrade.png`).
- Local gates and focused/directory tests as listed in the PR Verification section.

## What did not complete

- Hosted CI on the exact head has no terminal result: both Cross-platform CI runs (35781678978, 35783578147 attempt 2) were cancelled by the user's `opencodex-ci` release-coordinator heartbeat, which cancels every non-main/preview/Release run during the 2.62.0 / 2.63.0-preview release. Rerun `gh run rerun 35783578147` (full, not failed-only) after that heartbeat stops.
- No user account can currently serve a live `usage.speed: "fast"` 200 (four need usage credits, two orgs have fast disabled).
- Local full suite not run in this `~/.codex/worktrees` checkout: the test-home guard breaks fixture cleanup and leaves cross-file hangs that reproduce on clean `origin/dev`.

## Next

Rerun CI after the release window; merge is the maintainer's call.
