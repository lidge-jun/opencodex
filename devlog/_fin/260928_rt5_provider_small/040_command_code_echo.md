# wp4 — Command Code post-prose tool_call echo

Carries #5964 by luvs01 (Epinephrine) as one squashed commit of its three PR files.

## Changes

1. `git checkout refs/rt5/pr-5964 -- src/adapters/command-code-tool-text.ts structure/providers-and-adapters.md tests/providers/command-code-tool-text-prose-split.test.ts`,
   committed with `Co-authored-by: Epinephrine <luvs01@hanmail.net>` and
   `Co-authored-by: luvs01 <27862058+luvs01@users.noreply.github.com>`. The branch's merge
   commit and unrelated desktop/workflow history are not carried.
2. MODIFY `docs-site/src/content/docs/reference/adapters.md` Command Code paragraph: replace
   "a marker split across chunks is still shown as text" with the new behavior: markup after
   prose, including a marker split across later deltas, is held and removed only when a
   same-content native call arrives; otherwise it is released as text and never becomes a
   call.
3. NEW regression in `tests/providers/command-code-tool-text-prose-split.test.ts`
   (architect D5): a post-prose envelope is held while an unrelated native input is already
   open; the matching native call's `tool-input-start` then arrives. The held tail snapshots
   open input ids (`command-code-tool-text.ts:422-427` in #5964) and `matchNative` skips a
   later id when another input was open (`:479-486`), so the echo may stay visible. If the
   test fails, fix `matchNative`/candidate capture so a later-starting same-content call
   still strips the echo, without letting a quoted example become a call.

## Acceptance

- Post-prose envelope with a matching native call: envelope stripped, prose kept.
- Post-prose envelope with no native call: released as text, no call minted.
- Marker prefix split across deltas: held, then resolved as above; flushed on finish or error.
- Late-starting matching native call after an unrelated open input: echo stripped.
- Documented compatibility change: a text-only call after prose stays text (never restored).

## Build record (2026-09-28)

The D5 regression was red on the #5964 carry: the unrelated call's end released the tail as
text. A first fix (subagent) kept every post-prose tail held past any unrelated call; the
reviewer rejected it because the tail, and the calls queued behind it, could then wait until
the turn ended. The landed fix keeps the #5964 matching logic and changes only
`toolInputStart`: a complete post-prose tail admits at most one later input, and only one of
its own tool, as a candidate. The wait is therefore bounded by the inputs open when the tail
started plus that one input; three tests pin the late match, the immediate release, and the
single admission. Local tests were frozen by maintainer order before this fix, so PR CI is its
only test evidence.

## Verify

`bun test tests/providers/command-code-tool-text-prose-split.test.ts tests/providers/command-code-tool-text.test.ts`
plus the other Command Code provider tests, typecheck, test:changed, structure:check,
privacy:scan, docs-site build.
