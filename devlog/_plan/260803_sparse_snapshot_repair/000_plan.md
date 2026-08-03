# 000 — Sparse Responses snapshot repair (#893)

Reserved unit. Deferred out of `260803_pr_issue_sweep` on blast radius.

## The defect

Responses-compatible gateways can emit lifecycle snapshots that are valid but
sparse — missing fields Codex clients need before they will commit the turn.
`src/server/responses/core.ts:1819-1827` composes only image-generation and
item-ID rewrites; there is no snapshot repair. `responses-snapshot-repair.ts`,
its config flag, its types, and its tests do not exist on `dev`.

## History

PR #894 addressed this and was closed unmerged. None of its four commits is an
ancestor of `dev`, and the #892 stack did not absorb the feature — verified
rather than assumed.

It was 1,168 additions across 23 files, and it carried a rewrite of the Darwin
relay design unit along with the fix. That breadth is why it did not land, not
the idea.

## Shape of the narrowed resubmission

- Provider-local and default-off. A repair that rewrites payloads for every
  gateway is a compatibility hazard; one that arms per provider is a fix.
- Preserve upstream values. Repair fills absences; it never overwrites what the
  gateway actually sent.
- Bound the reconstructed output and charge/release the translator budget, so a
  hostile or broken gateway cannot turn repair into unbounded work.
- Cover both SSE and JSON response modes.
- Leave the relay design unit alone.

## Status

Not started. Sequenced after `260803_pr_issue_sweep` closes. Credit to
@0xWinner98 for the original report and to PR #894's author for the first
implementation attempt, which the narrowed version should draw from.
