# 061 — wp7 outcome: the flake is fixed, and the work-phase numbering is not

`c8c8dc338` — `test(auth): close the startup-prime window that rotates the credential
mid-fixture (#3139)`. Merged with the roadmap unit in the same PR.

## Result

```
gh pr checks 3139
  macos   pass  11m40s
  ci      pass  4s
```

That is the verifier that matters. The same assertion failed on `macos` once for #3133 and
twice for #3137, on heads without the fix. It passed on the **first** run of the fixed head.

Local: `bun test tests/server-auth.test.ts` -> 91 pass / 0 fail / 618 expect().

## Where wp7's work actually happened

In wp6, not wp7. The FSM's active work-phase was wp6 when the fix was written, and wp6 was
the landing phase blocked by exactly this flake — so its plan absorbed the fix rather than
the two units pretending to be independent.

Recording that plainly instead of back-dating an attest: wp7 was registered as a
work-phase, its plan doc (`060`) is real and was written under it, and its implementation
rode wp6's cycle. The ledger shows one cycle, which is what happened.

## What this phase is really a record of

Three explanations, two wrong, one measured — the table is in `060`. Both wrong ones were
plausible, cited real mechanisms, and would have justified the same one-line fix. That is
what made them dangerous rather than harmless: the fix would have worked, the reasoning
would have been wrong, and the next person to touch this fixture would have inherited the
wrong model.

What broke the tie was the runtime's own counter:

```
$ OPENCODEX_DEBUG_QUOTA=1 bun test ... -t "websocket passthrough refreshes pool auth"
[codex-quota] prime done (reason=startup, pool=1, refreshed=1)
```

`refreshed=1` on five runs of the unfixed tree **and** five of the fixed one. Staleness never
varied, so the "cache age crosses the TTL" story was dead — and the surviving explanation is
that the prime always fetches, and what varied was whether it hit the stubbed `fetch` and
pinned clock or the real ones.

`LOOP-MECHANISM-PROOF-01` asks for activation evidence before adopting a mechanism. Here it
did more than confirm: it killed the hypothesis I had already written into a devlog document
and two PR comments.

## Residual

The comments on #3109 and #3112 quote the first wrong explanation. They were left in place —
their operational advice (rerun rather than read a single red as a regression) was correct,
and is now moot because the flake is fixed. `051` carries the pointer to the correction.
