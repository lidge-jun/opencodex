# 010 — audit round 9: the partition holds, the transitions did not

Second resumed round. Confirmed this time: **A/B/C/D are mutually disjoint**, the
version-aware optional-field fallback preserves v1 behaviour, the hand-built v1 test is
constructible and red against a version-blind read, the exec bridge stays covered, and
`hadFirstUserMessage` is available where `rememberOriginal` runs.

So the shape partition — five revisions in the making — is finally sound. Both remaining
blockers were about **transitions between shapes**, which is a different question and one
the earlier rounds never reached because the partition was still wrong.

## Blocker 1 — pending accepted only two of the four shapes

Round 8's pending resolution read shape A or shape B and refused everything else. But
user activity does not wait for a crash to finish: a crash on either side of the routing
write, followed by an ordinary first message, produces pending+C or pending+D. Both were
refused, so restore stayed wedged — the same failure the tri-state was introduced to
prevent, surviving in the corner the round-8 table did not enumerate.

C and D are exactly as decidable under pending as without it, because the tuple still
says whether the routing write landed. Refusing them was never necessary; the table
simply stopped at two rows because two rows were all I had in mind when I wrote it.

## Blocker 2 — D can be pulled back into C, and the verdict did not notice

The sequence: `openai/vscode/0` with `hadFirstUserMessage = false` routes to
`opencodex/vscode/0`; the user's first message makes it `opencodex/vscode/1` (shape D);
legacy recovery then rewrites it to `openai/vscode/1` (`src/codex/history-provider.ts:991`),
which is shape C.

Provenance reads `relabel-committed`, and C's unconditional verdict for that value was
"restore to `0`" — erasing activity that could not have been OpenCodex's, since the
routing write for this entry produced a `0`.

The fix uses the field already added for blocker 1 of round 8: when
`hadFirstUserMessage` is false the route's expected event was `0`, so any later `1` is
the user's, whichever tuple the row now wears. `hadFirstUserMessage` is load-bearing in
two places, which is a decent sign it is the right field rather than a patch.

**The pattern across both:** shape classification answers "what is this row?" and the
verdict tables answer "how did it get here?". I had been treating the second as a
corollary of the first for six rounds. It is not — a row's current shape does not
determine its history, and both blockers are cases where two different histories produce
the same shape.

## Blocker 3 — a drift-prevention mechanism I claimed but did not build

`009` said the round count would be "written once at close-out". It still appears in
both `000` and `070`. Round 9 correctly called that a false claim rather than a stale
number: the count was right, the mechanism was fiction. Replaced with the honest version
— it is a two-place fact, check both every round.

Small, and exactly the category this gate exists for. A document asserting a safeguard it
does not have is worse than one that admits the manual step.
