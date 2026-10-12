# 060 Done (wp1)

## Conclusion

Claude fast mode is a native FastWire (`anthropic-speed`) on the Anthropic adapter for `claude-opus-5-5`, `claude-opus-5` and `claude-opus-4-8` on both the OAuth and API-key providers, with `usage.speed` confirmation, a budgeted one-shot standard-speed resend on a recognized fast refusal, a `fast_downgrade` metrics class and request-log label, and confirmation-gated 2x pricing. PR #5604 targets `dev`; the initial completion record described head `5e4cb7ea77`. The later repair and its validation are recorded in `050_build.md` and the PR Verification section.

## Evidence

- Live probe matrix (020) and live smoke through the new adapter code (050): refusal → standard resend → `downgraded/response-declined`; Opus 4.6 live standard echo downgrades.
- Isolated end-to-end through the real proxy pipeline with a fake upstream, rendered request-log label (050, `evidence/logs-fast-downgrade.png`).
- Original local gates and focused/directory tests were recorded for the initial implementation head. The repair's focused validation is in `050_build.md`; exact-head hosted CI is still required.

## What did not complete

- Hosted CI was not complete on the initial head: Cross-platform CI runs 35781678978 and 35783578147 attempt 2 were cancelled during the release window. The repair head needs its own successful exact-head checks; prior cancelled runs cannot certify it.
- No user account can currently serve a live `usage.speed: "fast"` 200 (four need usage credits, two orgs have fast disabled).
- The full local suite was not run for this repair. The scoped checkout ran only the focused regression file and typecheck; other gates remain for hosted CI.

## Next

Verify exact-head CI on the repair commit; merge is the maintainer's call.
