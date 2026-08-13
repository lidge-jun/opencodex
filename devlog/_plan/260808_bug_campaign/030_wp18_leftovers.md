# WP18 — the leftovers, and a retraction on #1302

Three concrete items remained after WP17: two devlog units unpublished, my own
#1301 held indefinitely, and #1244 having gone `DIRTY`.

## devlog 028 and 029 published

They existed only in local history. Published as **#1314**, merged to `dev` as
`6a7e5f05e`. The campaign record is now on the branch rather than on my disk,
which is the point of keeping it.

## #1301 — rebased, and deliberately left red

It had been held since both its CI runs came back `cancelled` under #1302, and
had drifted 5 commits behind. Rebased onto `b5d44a534`, force-pushed with a
lease against the previous head, both commits preserved with their separation
(luvs01's assertion trailered, the unconditional-step assertion mine).

Re-verified on the rebased head rather than reusing old numbers: full suite
**10055 pass / 7 skip / 0 fail** across 627 files, `ci-workflows` 125 pass,
typecheck and privacy scan clean, and the `if: false` ablation still fails
against current `dev` — so the coverage gap it closes is still open on the base.

The new run hung again, `test 3/4`, 19:32:43Z → 19:47:59Z. **Not rerunning it.**
A retry *might* come back green — that is unknowable, and I stated it as a
certainty in the first draft of this page. What matters is that one green retry
would not erase **two cancellations at consecutive exact PR heads**:
`31263738953` at `f09ef1557` before the rebase, and `31274685166` at
`454b1d3b5` after it. Held pending a root cause or a reproducible base-branch
comparison, not pending a luckier roll.

## The #1302 "narrowing" — retracted

I claimed this run's stall landed at the same file as run `31152916419`,
`cli-native-profile → cli-restart-health` with `killed 1 dangling process` as
the last line, and called it a repeated signature.

**It is not true, and the audit caught it before it went further than one issue
comment.** Re-reading the logs:

Those are two different questions and I had collapsed them into one column:

| Run | First logged `EEXIST` under | Last output before silence | Outcome |
|-----|------------------------------|----------------------------|---------|
| `31152916419` | `tests/autostart-health.test.ts` | — (no silence) | **kept running**, finished 1 fail / 2 errors in 85s; never cancelled, no dangling-process line |
| `31263738953` | `tests/baseten-provider.test.ts` | `tests/claude-messages-endpoint.test.ts` | hung, cancelled at 15m |
| `31274685166` | `tests/api-storage.test.ts` | `tests/cli-restart-health.test.ts` | hung, cancelled at 15m |

Three runs, and no column repeats. The pair I pointed at is **one observation**.
I compared two logs by memory of what one of them said, cited a completed
failure as corroboration for a hang, and then in the first draft of this
retraction still named the wrong file for `31263738953` — `claude-messages` is
where the output *stops*, not where the error first appears.

What the evidence supports, at its real strength: Bun `EEXIST` on `epoll_ctl` —
a descriptor registered with the event loop twice — appears in all three runs
under different files, and **co-occurs** with one completed failure and two
15-minute cancellations that leave an orphan `bun`. Whether the `EEXIST` causes
the hang, shares a cause with it, or is incidental is **not established**. No
file-level culprit identified.

My earlier "the shard varies, so it is not one bad test" was also imprecise for
a different reason: sharding distributes files differently per run, so a varying
shard number never argued against a single file either way.

Local reproduction of the pair failed (`--isolate`, three runs, 18 pass / 0 fail
in ~2.8s on macOS), which I had presented as "needs the Linux runner" — with the
hypothesis retracted, it is simply a null result. Retraction posted to #1302.

### Why this one stings

The whole reason #1301 is being held is that I stopped calling this flake and
started gathering evidence. Then I produced a false piece of evidence, in the
issue I opened to keep the record honest, by asserting a comparison instead of
running it.

## #1244 — conflicted by my own merge

It went `DIRTY` because **I merged #1305**. The overlap is
`src/codex/catalog/provider-fetch.ts` and `tests/codex-catalog.test.ts`:

```
<<<<<<< dev (from #1305 / #1163)
    const members = combo.targets.map(target => resolveComboCatalogMember(...))
=======  #1244
    const discoveredMembers = combo.targets.map(target => memberByKey.get(targetKey(target)))
>>>>>>>
```

`dev` now synthesizes a combo member whose provider row is incomplete instead of
dropping it; #1244 renames the same binding as part of the picker work.
Resolving it means deciding how a synthesized member behaves in the new flow —
the author's design call.

Told them so, with the conflict quoted, and did not rebase it. Worth noting the
asymmetry honestly: I rebased #1163 (366 behind) because its conflicts were two
import lines, and I am declining #1244 (25 behind) because one conflict is a
semantic decision. Age was never the criterion.
