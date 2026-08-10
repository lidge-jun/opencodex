# 050 — adopt-as-is replacements: #1159 and #1171

Two contributor PRs survived a skeptical read with no required changes. Per the
stack principle, we still do not merge them in place: the change is rebuilt as
our commit on the stack branch, and the original is closed with a pointer.

## #1159 — Cursor Grok wire model prefix

Claude-family and Grok models need a `cursor-` prefix with an effort-tier suffix
on the request wire, while parameterized Grok Fast keeps its base id. The PR
adds a request-only helper and leaves discovery normalization alone — the right
seam, since mixing the two would corrupt the model list.

- `src/adapters/cursor/effort-map.ts:118-128` — the prefix helper
- `src/adapters/cursor/request-builder.ts:130-154` — the call site
- `tests/cursor-effort-suffix.test.ts:86-118`
- `docs-site/src/content/docs/reference/adapters.md`, Cursor model-ID section

Test: `regular grok-4.5 request ids match the recorded discovery fixture` —
low/medium/high and default/xhigh serialize as `cursor-grok-4.5-{tier}`; Fast
stays on the base id plus parameters.

Known limitation, worth stating in the PR body rather than discovering later:
the fixture proves the mapping against recorded discovery output, not live
Cursor state. A Cursor rename requires refreshing it.

This does not fix #1162 (Cursor Claude-family `resource_exhausted`). That issue
has no code-level cause identified and needs a capture.

## #1171 — A6API unlimited quota keys

An unlimited A6API key reports zero finite credit totals, and finite-total
validation then hides it, so a working key looks dead in the dashboard. The PR
puts the unlimited branch ahead of that validation and keeps expiry.

- `src/providers/quota.ts:61-75,201-206,318-367`
- `tests/provider-quota.test.ts:260-316`

Test: `A6API unlimited keys remain visible even when all finite credit totals
are zero` — unlimited flag, zero totals, expiry propagation, exactly one report,
and an "Unlimited API credits" row.

Two observations that are not blockers: `creditsUsd` is currently ignored by the
GUI and duplicates the display window, and the string handling recognizes
`"true"` but not `"1"`. Neither breaks an existing consumer. Note them in the
PR body.

## Stacking

Neither touches files used by any other phase in this unit. They can be one PR
or two; two is preferable because they close two different originals and a
reviewer should be able to reject one without the other.
