# 070 — Phase 7: docs, review, delivery

## Docs

- `docs-site/src/content/docs/guides/integrations.md` (#8742's Gemini section): Interactions endpoint
  (`POST /v1beta/interactions`, `/v1/interactions`), what is refused and why (agent, background,
  hosted tools, non-text output), `previous_interaction_id` retention (process memory, 24 h, owner-scoped,
  lost on restart), `GET`/`DELETE`, `countTokens` as a local estimate.
- `docs-site/src/content/docs/reference/adapters.md` google section (from line 467): usage composition
  (D5), fail-closed finish reasons, prompt blocks, structured 429 handling, tool-result images on
  Antigravity, audio input, Vertex `us`/`eu` hosts.
- `docs-site/src/content/docs/reference/cli/providers-accounts.md` and its `es` translation:
  `needs-reauth(tos)`.
- English is the source; per `docs-site/AGENTS.md`, translated pages must not contradict it (update or
  leave untouched, never leave a contradicting statement).
- `structure/`: every owned file touched by 010–060 has its doc updated in the same commit;
  `bun run structure:index` after manifest changes.
- Move this unit to `devlog/_fin/` only after the PR merges (owner decision); until then it stays in
  `_plan/` with a status line per phase.

## Verification

Once, at the end, under `/usr/bin/lockf -k /tmp/ocx-test.lock`: `bun run typecheck`, `bun run test`
(record the known container/systemd/mtime failures from AGENTS.md separately if they appear),
`bun run structure:check`, `bun run privacy:scan`, `cd docs-site && bun run build`, `bun run lint:gui`
only if `gui/` changed.

## Review

A fresh GOAT review task (`task.create`, `role: review`) on the final head with this unit, the matrix
and the diff; findings folded or rebutted in a second round that continues the same reviewer; the final
approval round uses a fresh reviewer. Security-relevant observations go to `.tmp/` only.

## Delivery

Push `feat/google-protocol-cpa-parity`; open one PR to `dev` using
`.github/PULL_REQUEST_TEMPLATE.md` (Summary, Verification, Checklist), stating the #8742 dependency and
which commits are #8742's; link it with `goat_pull_request_link`; report exact-head PR CI. No merge, no
force-push, no `ci.yml lane=all`.

