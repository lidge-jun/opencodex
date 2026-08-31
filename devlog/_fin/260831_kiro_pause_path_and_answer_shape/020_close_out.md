# Close-out: the blocked-on-user state

Merged. `afc1cc59c` (#3031) carries the contract change, the tests, and the
public documentation.

## What shipped

The injected Kiro contract now describes three states instead of two. Alongside
"still working" and "fully complete" there is "cannot continue until the user
supplies a decision, information, or a clarification that only they can give" —
and that question is delivered as the final answer, through the channel that
already terminates the turn correctly.

Four surfaces carry it, because a model that reads one of them and not the
others gets a contradiction:

- `KIRO_COMPLETION_INSTRUCTIONS` — the prose contract.
- `KIRO_COMPLETION_RETRY_MESSAGE` — the one instruction the model sees at the
  exact moment it failed to complete. Its old tail, *"Do not ask the user for
  another task"*, was scoped to soliciting new work but read as a ban on asking
  anything.
- The completion tool's schema description — what the model reads while
  *choosing* a tool.
- The `answer` property description — what may go in the field.

Round one changed the terminality half of that schema description and left the
eligibility half saying only "fully complete". That asymmetry is part of why
prose alone did not move the outcome.

## Review changed the shape twice

The review record is worth keeping, because both corrections were substantive.

An independent design audit ran six rounds before the commit. It killed
ask-tool isolation as unreachable (measured: 8 `request_user_input` calls
across 644 rollouts, ask-then-another-tool **0** times), caught a test
precondition that could not fail — `not.toContain("omitted")` against a notice
that says capitalized `Omitted` — and caught the schema description still
admitting only a completed answer.

PR review then found the trigger was too narrow. "Blocked on a decision" does
not cover "what is the account id" or "which of these paths did you mean", and a
model stuck on a missing value is stuck exactly as hard as one stuck on a
choice. The wording now names a decision, information, and clarification, and
the doc comments say why, so a future reader does not narrow it back.

Review also asked for ordering assertions on the non-regression test. Counts and
payloads alone would have passed on a reordered stream, or on an early `done`
followed by a second one.

## What was deliberately not built

No adapter gate. Across 644 rollouts the same-inference prose-plus-tool shape
occurs 26 times: 4 question-tailed (1329-1938 chars) and 22 ordinary progress
narration (608-3141). The ranges overlap completely, and at `flushOpen` the
adapter knows only that a non-completion tool was emitted, its restored
identity, and its arguments. `stopReason` cannot help, because Kiro sends
`END_TURN` for progress prose too. Every gate is a coin flip on whether a user
sees their agent's work.

No reservation guard for the injection budget. Both charged inputs are
structurally capped and the predecessor unit already proved that guard's test
passes with the guard removed. Two hostile-catalog tests pin the property
instead, each asserting its own precondition so neither can pass while charging
less than it claims.

## The limit, stated plainly

This is influence, not enforcement, and it cannot promise non-recurrence. Kiro
accepts only automatic or no tool choice, so no typed progress/pause/complete
protocol can be forced upstream, and the good and bad event streams are
observationally identical at the adapter. The tests prove the contract is
delivered, not that the model obeys it.

The goalplan criterion demanding a code-level mechanism was amended by recorded
steering (`260831-c1-amend-prose-only-mechanism`) rather than reinterpreted to
fit the diff.

## Landed-state verification

Read out of `origin/dev` after the merge, not the working tree:

- `src/adapters/kiro-constants.ts` carries the widened trigger on both
  constants.
- `src/adapters/kiro.ts` carries it on the schema description and the `answer`
  property.
- `tests/kiro-adapter.test.ts` carries the two contract tests and the two
  hostile-catalog tests.
- `tests/kiro-stream.test.ts` carries the parameterized non-regression test.
- `docs-site/src/content/docs/reference/adapters.md` documents the pause
  semantics; seven translated locales carry the same statement.

CI on the merged head: 23 checks green, the only non-pass being the
intentionally skipped Windows matrix placeholder. One `macos` failure was
investigated and is unrelated —
`tests/shutdown-launcher.test.ts` spawns a real launcher and waits on POSIX
signal delivery under a 20s bound, contains no Kiro reference, and passed on
rerun of the identical commit.

Focused evidence at the merged tree: `bun run typecheck` exit 0; 206 pass / 0
fail / 797 expect() calls across `kiro-adapter`, `kiro-stream`, and
`tool-catalog-nudge`; `bun run privacy:scan` passed. The local full suite was
excluded by instruction; CI covered it.

## Merge trail

- `f5a625cf3` (#3012) — round one, terminal completion contract.
- `6f75616f0` (#3014) — round one close-out.
- `1031b6fff` (#3016) — round one landed-state record.
- `afc1cc59c` (#3031) — this unit.

