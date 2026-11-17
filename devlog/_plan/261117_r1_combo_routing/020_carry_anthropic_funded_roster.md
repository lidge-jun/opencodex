# 020 — carry #8857 (Closes #8759)

## Commands

```bash
git fetch origin pull/8857/head:refs/pr/8857   # head d1545947dfa072038d9a159f6ec40550f95574bd
git merge --squash refs/pr/8857
git commit -F <msg>   # "fix(anthropic): scale pool failover within the funded send budget (#8857)"
                      # trailer: Co-authored-by naming Vadym O (@vadymhimself) at his commit address
```

## Files (verbatim from the PR head)

- MODIFY `src/server/responses/request-transport.ts`: snapshot the eligible Anthropic roster before the first
  send, `anthropicFailoverLimit = max(ANTHROPIC_POOL_MAX_FAILOVERS_PER_REQUEST, min(roster, 6) - 1)`,
  fund the send budget with `expandInferenceOAuthSendBudget(max(generic, anthropic))`.
- MODIFY `src/server/responses/adapter-dispatch.ts`, `adapter-continuation.ts`, `sidecar-execution.ts`: replace
  the fixed cap with `transportState.anthropicFailoverLimit`; continuation rotation now reserves a
  `reserveCredentialHop` and restores the refused account's attribution when the replacement never sends;
  Anthropic initial sends count through the existing reporters.
- MODIFY `src/server/messages-native.ts`: same snapshot and limit on the native Messages lane, plus
  `oauthPhysicalSendAvailable()` intersecting with the physical send budget.
- MODIFY `src/server/responses/request-send-budget.ts` (comment), structure docs
  `structure/providers/anthropic-account-pool.md`, `structure/transports/responses-failover.md`,
  `structure/transports/responses-spend.md`, public doc
  `docs-site/src/content/docs/reference/configuration/providers.md`.
- NEW `tests/adapters/anthropic/anthropic-funded-roster.test.ts` (registered on an existing line of
  `scripts/test-layout/layout.json` and `tests/fixtures/test-layout-expected.json`), MODIFY four existing test files.

## Security review (required: credential and account-pool path)

A fresh reviewer subagent checks the carried diff for: unbounded or doubled sends (the hop must stay inside
the request send budget and the 6-account clamp), credential mix-ups across accounts during rotation and
attribution restore, permit leaks (`pendingHopPermit` released on every failure path), replay after
committed output, token or account identifiers reaching logs, and whether a final upstream refusal can
become an invented quota result. The maintainer's acceptance conditions on #8759 are the checklist.
High/Critical findings are fixed in this phase or the carry is downgraded to DEFER.

## Verification

```bash
bun test tests/adapters/anthropic/anthropic-funded-roster.test.ts tests/adapters/anthropic/anthropic-instance-recovery.test.ts \
  tests/adapters/anthropic/anthropic-quota-dispatch.test.ts tests/adapters/anthropic/anthropic-sidecar-account-failover.test.ts \
  tests/claude-integration/messages-native-oauth.test.ts
bun run typecheck
```

Regression proof: `anthropic-funded-roster.test.ts` fails against `origin/dev` source (four refusals then a
healthy fifth account returns the 429 under the fixed cap of 3).

