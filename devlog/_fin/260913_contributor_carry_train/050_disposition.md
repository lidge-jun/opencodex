# wp6 — Disposition and outcome

## What closes, and on what evidence

A merged pull request does not prove its linked issue is resolved. The rule from
the previous batch holds: Refs #N is not Closes #N, and a description stating the
issue stays open outranks any topical similarity.

GitHub auto-closes linked issues only on merge into the default branch. These
merge into dev, so every closure here is manual.

### Source pull requests carried by this train

Each source is closed only after its carry is verified on dev by
git merge-base --is-ancestor, with a comment naming the carry, its merge commit,
and the trailer that preserved the author credit.

| Source | Author | Carried by lane |
| --- | --- | --- |
| #4455, #4086, #4409, #4387 | jeongjin0, Eleven-is-cool, yxr1995-maker, luvs01 | R |
| #4438, #4389, #4457 | Yongzhaooo, olddonkey, jeongjin0 | C |
| #4382, #4413, #4170 | luvs01, rrmlima, yeongjunyoo | L |
| #4381, #4388, #4460 | luvs01, luvs01, AgenticLab-SH | B |
| #4447 | Veritas-7 | S |
| #4077 | laerad777 | X |
| #3663 | y2ambition-ai | H — no carry needed; already on dev as a33b51eb via #4360 |

#4171 (rrmlima) closes against lane R #4455 carry as a duplicate, with both
authors named in that landing.

### Issues expected to close, and three that are conditional

#4412 with lane R, #4439 and #4456 with lane C, #3729 with lane L, #4425 and
#4442 with lane I1, #4430 and #4435 with lane I2, and #4429 with lane I3.

#3775 and #4436 in lane I3, and #4454 in lane I4, are conditional rather than
expected, for the reasons below.

Each closure is re-verified against landed dev before it is executed, because the
map above is written while the lanes are still in flight.

Three of those closures are conditional rather than expected. #3775 may already be
covered by the effort ceilings #4349 landed, #4436 may reduce to a capability
declaration on the contract #4374 and #4376 established, and #4454 may be the same
envelope defect as #3661 seen from the other side. If a lane finds no defect to
fix, the issue gets a comment naming what was found and stays open. A closure is
never claimed against a fix that was not written.

### Issues that stay open

#4191, #4311, #3661, #3781, #4312 and #3506 are partially landed. They receive a
comment naming what landed and what remains, and they stay open. The previous
batch checked 24 closure candidates and every one came back KEEP for exactly this
reason: related work had shipped, but the actual ask had not been met.

## Credit repair

#4431 landed the xAI OAuth Fast classification without a trailer for the author of
#4077, who had proposed the registry change first. The landing was independently
derived from a live probe, so this is not a silent carry, but CREDITS.md is the
place that distinction gets recorded rather than left to memory. wp6 adds the
entry.

## Outcome document

060_outcome.md records, for a reader who was not in the loop: what landed and how,
the run ids that prove it, what the tips caught that per-link CI would have caught
earlier, what did not land and why, and the honest limits of the proof —
specifically that non-tip pull requests merged without their own ci check under a
recorded owner authorization.

LOOP-PESSIMIST-01 applies to that document: it also records which hypothesis died
and what evidence would show the tip-only CI economy is the wrong trade.
