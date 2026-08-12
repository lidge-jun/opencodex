# 002 — Audit round 1: synthesis and plan amendments

Reviewer: independent `gpt-5.6-sol` (medium) explorer, read-only, anchored at
`HEAD == origin/dev == cbbfdd877`. Verdict: **FAIL**, 12 numbered blockers.

Every blocker below was re-checked against the tree by the main agent before
being accepted or rebutted. The reviewer was right about more than it was wrong
about, and two of its findings invalidate deliverables the plan had promised.

## Accepted — and what changes

### B5, B6, B7 (High) — phase 050 proposed work that already exists

**Verified.** `src/lib/crash-guard.ts:332` `installCrashGuards()` already
registers both `process.on("unhandledRejection")` and
`process.on("uncaughtException")`, records redacted diagnostics, and is called
from `src/cli/index.ts:265`. It even contains a dedicated
`isBenignAbortTeardown` branch for the exact Bun teardown rejection
(`crash-guard.ts:156,185`).

`cancelBodyOnAbort` is already applied at 8 sites including the OpenAI Responses
path (`src/server/responses/core.ts:3436,3671`), the Anthropic and generic web
search executors, both vision describers, and `codex/auth-api.ts:1748`.

Service supervision already exists (launchd `KeepAlive`, systemd
`Restart=on-failure`, Windows restart-on-failure).

So three of the five work items in `050` were **re-proposals of shipped code**.
That is a planning failure: the phase was written from the issue text and the
`abort.ts` comment without auditing what already consumed that helper. Worse,
the reviewer's point about activation is decisive — a test that re-proves
`cancelBodyOnAbort` on an already-guarded path cannot go red before the fix, so
it would have been ceremonial coverage, not a regression test.

**Amendment:** `050` is rewritten as a disposition-first phase. See `051`.

### B1 (High) — PR #1508 sets `emittedContentEvent` for thought-only parts

**Verified in the real diff** (`pr1508@219e7f365a`):

```ts
const textEvent = googlePartTextEvent(part);
if (textEvent) {
  emittedContentEvent = true;
  yield textEvent;
}
```

`emittedContentEvent` feeds `return emittedContentEvent ? "content" : "continue"`
(`google.ts:645`), which drives heartbeat suppression
(`if (sawLiveness && !sawContentEvent) yield { type: "heartbeat" }`).

**Partial rebuttal, and the plan was also wrong.** The main agent initially
wrote in `020` that a thought-only part must not set the flag. Reading the
consumer shows that flag is **liveness classification**, not user-visible-content
accounting: a candidate carrying model thinking *is* upstream activity, and
suppressing the synthetic heartbeat for it is arguably correct.

But the reviewer's underlying complaint stands on a stronger footing than the
one it stated: the PR **changes heartbeat behavior for thought-bearing streams
and has no test asserting which behavior is intended**. Whichever way it goes,
it must be a decided, covered contract rather than an accident of refactoring.

**Amendment:** `020` drops its incorrect assertion that the flag must not be
set, and instead requires (a) an explicit decision recorded in the PR, and
(b) a test that pins heartbeat/content classification for a thought-only frame.
The main agent's position, to be confirmed with the contributor: keep
`emittedContentEvent = true` for thought parts (they are real upstream
activity), and add the missing test. Also required: an explicit
thought-signature replay regression, not reliance on unchanged fixtures.

### B2, B3 (High) — `rangeFullyCovered` is not derivable, and 030 does not close #1497

**Verified and decisive.** `usage.jsonl` is append-ordered by *completion*,
while the persisted timestamp is the request *start* time. A long-running
request started before a short one can be appended after it. Therefore the
oldest timestamp among retained rows does **not** bound the timestamps in the
dropped prefix, and `rangeFullyCovered: true` could assert completeness that is
false. Shipping a field whose whole value is trustworthiness, in a state where
it can lie, would repeat the exact class of defect #1497 reports.

The reviewer is also right that the issue's acceptance bar ("`30d` must
aggregate every valid persisted request") is not met by better labeling.

**Amendment:** `030` is rewritten (see `031`) to drop `rangeFullyCovered`
entirely and report only what is provable: that truncation occurred and what
the retained window is, explicitly framed as a lower bound. The PR is a
**partial mitigation without `Closes #1497`**; the issue stays open for the
rollup work tracked in #1008.

### B4 (High) — #1409 attribution is not proven

**Verified.** `gui/src/pages/use-providers-crud.ts` uses `PATCH` at lines 82,
99, 125 for provider edits, and `gui/src/pages/Models.tsx:476` sends
`modelContextWindows` over `PATCH`. Only the Add Provider modal POSTs, and only
a duplicate name reaches the overwrite branch.

So the plan proved a **real bug** — `buildProviderPayload`
(`gui/src/provider-payload.ts:71-108`) constructs a payload that structurally
cannot carry `modelContextWindows`, and the POST path fills the absent field
from the registry seed — but it did **not** prove that this is the sequence the
reporter hit. Their timeline is upgrade → restart → later unrelated full-config
write, and the maintainer's comment names #1273's stale whole-document writer as
the leading hypothesis.

**Amendment:** `040` fixes the POST data-loss defect on its own merits and
**does not carry `Closes #1409`**. The issue receives a comment describing the
confirmed POST path, the fix, and what evidence would still be needed to
attribute the reporter's specific loss. This is the honest disposition: fix what
is proven, do not claim the report is resolved.

### B8, B10 (Medium) — scope statements to tighten

**B8 verified:** `openai-chat.ts:1157` checks only `typeof name === "string"`,
so a buffered `""` name is emitted. The narrowed issue #1514 is about the
streaming path, but `010`'s claim that the buffered path "is not part of the
defect" is too strong. **Amendment:** `010` extends the nonblank-name check to
the buffered validator, with its own focused test — the same one-line class of
fix, and it removes an obvious follow-up report.

**B10 verified:** `contextWindow` is also omitted by `buildProviderPayload`,
also user-editable from Models (`Models.tsx:475`), and also registry-seeded
(`derive.ts:404`). **Amendment:** `040` locks the field-ownership matrix at plan
time rather than deferring it to B, and covers `contextWindow` alongside
`modelContextWindows`.

### B11, B12 (Medium) — gates and evidence hygiene

**B11 accepted:** `gui/AGENTS.md` requires locale updates plus
`bun test tests`, `lint`, `build`, and `lint:i18n` inside `gui/` for functional
GUI changes. `030`'s command list was root-only. Since `031` now scopes the GUI
work down to copy on an existing surface, the full gate list is recorded and
run; if the GUI change proves to need new visible strings, every locale module
is updated in the same PR.

**B12 partially accepted.** The security-review point is accepted: `040` touches
a management write boundary, so the PR explicitly flags it for the security
review `src/AGENTS.md` requires. The evidence-URL point is accepted for `001`,
which now carries source URLs and retrieval dates.

## Rebutted

### B9 (Medium) — post-loop termination branch "lacks grounded activation"

**Rebutted with rationale.** The reviewer is right that the post-loop flush is
hard to reach with an unnamed call: raw EOF with pending calls exits through the
truncation branch first (`openai-chat.ts:1071-1080`). But the branch is not
being *added* — `yield* flushToolCalls()` already runs there, and the change is
that its result is now honored. Leaving that one site unhandled would mean an
unnamed call still escapes on whatever path reaches it, which is precisely the
defect. Handling all three sites uniformly is cheaper to reason about than a
two-of-three exception that a future reader must re-derive.

Concession: `010` no longer claims a distinct activation scenario for site 3.
It states plainly that sites 1 and 2 are the reachable activations and that
site 3 is defensive uniformity on an existing call.

## Net effect on the goalplan

| Phase | Before | After |
|---|---|---|
| 010 #1514 | streaming only, `Closes #1514` | streaming + buffered, `Closes #1514` |
| 020 #1503 | land #1508 as-is | land #1508 **with** heartbeat decision + 2 added tests |
| 030 #1497 | `rangeFullyCovered`, `Closes #1497` | provable reporting only, **no** `Closes` |
| 040 #1409 | `Closes #1409` | fix POST loss, **no** `Closes`, issue comment |
| 050 #1419 | 3 work items | disposition-first; shipped code audited, not duplicated |

Two issues therefore move from "will be closed" to "will be advanced with an
evidence-backed comment". That is a real reduction in what this unit delivers,
and it is the correct call: the alternative was closing #1497 with an aggregate
that still omits rows, and closing #1409 against a path the reporter may never
have taken.
