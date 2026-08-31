# 011 — Five rejected designs, and what each one got wrong

The shipped fix is the sixth design. The five before it were each plausible, each
partially validated, and each wrong in a way worth recording — four of them were
rejected only because an adversarial reviewer or a stress case went looking.

## Draft 1 — four declarations, three of them inert

Proposed: `white-space: nowrap` + `flex-shrink: 0` on the shared `.models-chip`,
`flex-wrap: wrap` on `.models-provider-toggle`, and an ellipsis on the name
replacing an `overflow-wrap: anywhere` that was already dead.

**Rejected by measurement.** Injecting the candidate changed nothing: the name box
stayed 0.0px and header height stayed 115.1px, byte-identical to baseline. Adding
`flex-wrap: wrap` to a flex container whose used width has *already been decided*
cannot recover width — inner line construction redistributes the 31px it was given,
it does not ask for more.

The chip declarations did work in isolation (6 lines to 1), which is what made the
draft dangerous: a partial fix that looks like success while the overlap survives
untouched.

**Rejected independently by audit**, which named the same flexbox error from first
principles and added three findings measurement would not have produced:

- The shared-chip claim was false. "All nine call sites are short status chips" — they
  are not. Aliases reach 64 characters (`src/config/provider-name.ts:13`), and the
  model-row chips at `Models.tsx:1447-1455` sit in a non-wrapping row with long
  German/Russian translations, so a non-shrinking chip could push the model id or edit
  button out of the row.
- The ellipsis was self-defeating: it needs positive used width, and on a box that can
  still reach 0px it truncates to nothing. The draft called this "a real minimum" while
  adding no minimum.
- A false consolation: the draft claimed a truncated name stays readable via the
  adjacent alias chip. That chip is optional and holds the *alias*, not the slug.

## Draft 2 — `min-width: max-content`, unbounded

Proposed one declaration: raise the toggle's floor to its intrinsic width. It fixed
all 20 ordinary cells and the removal test showed the other four declarations were
inert once it was in place. It looked finished, and the devlog said so.

**Rejected by audit.** A min/max conflict in CSS resolves in favour of the *minimum*,
so `max-width: 100%` cannot cap a `max-content` floor. Stress-measured after the
objection: a 64-character provider name overflowed the card by **216px** at 1100.

Two things made that miss possible. First, `.models-provider-card` sets
`overflow: hidden`, so the overflow never reached the page and the
"no page overflow" gate passed it — the gate was blind, not the fix correct. Second,
the 20 measured cells were all *ordinary* data; nothing exercised a legal maximum.

## Draft 3 — caps per child, one child at a time

Proposed the floor plus `max-width: 16rem` on the name, then `max-width: 12rem` on
the toggle-scoped chip after a stress test found a 64-character **alias** overflowing
by 103px.

**Rejected by audit again**, on the case neither cap covered: a name and an alias can
*both* legally be 64 characters, and `max-content` sums its children. Measured: the
combined case still overflowed by **64px** at 1100.

That was the signal to stop patching. Drafts 2 and 3 were the same mistake twice —
bound the floor by enumerating children, then discover another child. The child audit
had seven entries; two were user-controlled, and each cap only closed the one it named.

The same round also caught a wrong *reason* in the draft: it claimed
`min(max-content, 100%)` failed because `100%` resolves against a collapsed basis.
Measured in the live browser, `CSS.supports('min-width', 'min(max-content, 100%)')` is
**false** on Chromium 151 — the declaration is invalid and dropped entirely. Right
conclusion, wrong mechanism, and the doc had to say which.

## Draft 4 — `flex-basis: auto`, but only two children bounded

Proposed the change of approach that survives today: fix **visibility** with
`flex-basis: auto` instead of a raised minimum, and get **boundedness** from
shrinkability plus an ellipsis on the name and the toggle-scoped chip. It passed the
20-cell gate, the 64-character name case, the alias case, and the combined case that
killed draft 3.

**Rejected by audit** on the difference between bounding a container and bounding its
children: `min-width: 0` on the toggle removes *its* floor, but each child keeps its
own `min-width: auto` — its min-content width — and the sum of those floors can still
exceed the container. Two children had no rule at all: the active count
(`Models.tsx:1244`) and the discovery-failure badge (`Models.tsx:1235`, which also
carries fixed padding). Measured with every child forced to 64 characters: **484px**
of silently clipped overflow, unchanged from baseline.

The audit also corrected a claim the draft made in passing: the count is not a fixed
string, it interpolates live array counts.

Draft 4 was closer than its predecessors and still had the same shape of bug, which is
what finally made the pattern legible: **three consecutive designs had failed by
enumerating children.** The fix was not a better list.

## Draft 5 — the universal rule, applied to a child that had nothing to truncate

Proposed `flex: 1 1 auto` on the toggle plus one rule over
`.models-provider-toggle > *`: `min-width: 0`, `overflow: hidden`,
`text-overflow: ellipsis`, `white-space: nowrap`. It fixed the everyday defect, passed
all 20 locale x width cells, and — unlike draft 4 — survived the adversarial case with
every child forced to 64 characters at `cardScrollOver: -2`.

**Rejected by audit**, on a cost the containment gate could not see. The rule also
matched the chevron `<svg>`, whose inline `width: 14` is not a flex floor: it keeps
the initial `flex-shrink: 1`, and the new `min-width: 0` removed the only thing
stopping it. Measured on the adversarial row: the chevron rendered **2.5px** wide while
the gate reported success. The fix had bought containment partly by destroying the
collapse affordance, and no assertion in the plan would ever have noticed.

That is a different failure from drafts 2-4. Those were too narrow — they bounded named
children and missed the next one. Draft 5 was too broad: it applied a text-truncation
treatment to a child with no text to truncate. Both directions produce the same lesson
from opposite sides, which is that the right unit is not "how many children" but "which
property is being quantified over".

Draft 6 keeps the universal rule and adds `.models-provider-toggle > svg { flex: none }`
— an exemption by element **type**, not by identity, so a future icon inherits it
without being enumerated. Re-measured: chevron 14px, containment unchanged at -2, gate
still 20/20.

The same round corrected two further overstatements in the draft: `> *` was described
as covering children "present and future" when it cannot select an anonymous flex item
created by a bare interpolated string, and the plan named an
`effectiveDeclaration` reader as its verifier that is file-local and unexported, so it
cannot be imported as written.

## What the sixth design does differently

It separates the two properties that were being conflated, and it stops naming children
by identity:

- **Visibility** — the toggle's content must enter the header's wrap decision. Draft 2
  bought this with a raised *minimum*; draft 4 buys it with `flex-basis: auto`, which
  raises nothing.
- **Boundedness** — the row must never exceed the card. A raised minimum is the enemy
  of this, which is why drafts 2 and 3 kept leaking. Draft 4 showed that per-child
  ellipses are not enough either, because an unlisted child keeps its own min-content
  floor. The shipped rule applies `min-width: 0` and an ellipsis to
  `.models-provider-toggle > *` — every **element** child, so there is no number to
  choose and no list to maintain. Its cost is that no child of this header may wrap,
  which is correct for a single-line identity row and is stated in `010`.
- **Affordance** — a bound must not be paid for out of a control's legibility. Draft 5
  proved that containment and correctness are different measurements: it fit the row
  while reducing the collapse chevron to 2.5px. `> svg { flex: none }` exempts the one
  child kind whose size is intrinsic rather than textual.

All three shipped declarations are load-bearing and none substitutes for another —
compared with four of five inert in draft 1 and two of three in draft 3.

## Lessons

**Reading a stylesheet tells you what is declared; only measuring tells you what is
allocated.** Draft 1 reasoned about which declarations were missing from the elements
that looked wrong. The defect was in how much width an ancestor was willing to claim,
two levels up.

**A candidate that improves one symptom is not evidence it addressed the cause.** The
chip going from 6 lines to 1 was real, and it was still the wrong fix.

**A gate that cannot see the failure mode will certify it.** `overflow: hidden` on the
card made three separate overflows invisible to a page-overflow check. The stress
cases had to be added deliberately; no amount of re-running the ordinary sweep would
have found them.

**When a fix needs a third exception, the shape is wrong.** Draft 3's second cap was
the warning and draft 4's two-child ellipsis was the same warning again. Three
successive designs failed by enumerating children; the answer was to quantify over
them instead.

**A gate that only asks "does it fit" will certify a fix that fits by breaking
something.** Draft 5's containment number was genuinely -2 and the row genuinely fit —
it fit partly because a 14px control had been squeezed to 2.5px. The measurement was
true and the conclusion drawn from it was wrong, which is the hardest kind of error to
catch by re-running the same gate. Every measurement needs a matching question about
what it does *not* observe.

**Over-generalizing is the same defect as under-generalizing, mirrored.** Drafts 2-4
were too narrow, draft 5 too broad. The correct question was never how many children to
name; it was which property to quantify over — text children abbreviate, icons do not.
