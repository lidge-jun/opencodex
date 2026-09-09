# 071 — WP7 execution: the Bun 1.4 stack, retargeted rather than abandoned

Four PRs, four different outcomes. The instruction was to retarget rather than
abandon, and that is what happened — but not by merging the stack.

| PR | Outcome | Where |
|----|---------|-------|
| #2301 devlog roadmap | **LANDED**, rebuilt on `dev` | `e8b480a52` |
| #2302 runtime diagnostics | **CLOSED**, defect not shipped | rebase recipe on the PR |
| #2303 GC relief harness | **LANDED**, blockers closed | `1ab34dc49` |
| #2304 smol A/B harness | **LANDED**, blockers closed | `1ab34dc49` |

All landed work merged as PR #2376 → `89231146e`.

## Why the stack was not merged as a stack

Only #2301 targeted `dev`; the rest targeted stack-internal branches, so `dev` CI
never ran on the runtime diff. Merging any child would have carried #2302's runtime
into `dev` through a docs or harness PR.

Worse, a lane found a trap that a stacked merge would have sprung:

```
git diff origin/dev cac21afb -- src/cli/doctor.ts   ->   -94/+6
```

Coordinator remnant-recovery work landed on `doctor.ts` **after** the stack was cut.
Merging the stacked head would have silently **reverted** it. That is only visible if
someone actually diffs the stacked head against current `dev` rather than trusting
that a mergeable PR is a safe PR.

## Why #2302 alone was not landed

`src/server/management/system-routes.ts` fabricates a measurement:

```ts
extraMemorySize: typeof stats.extraMemorySize === "number" ? stats.extraMemorySize : 0,
```

The watchdog and doctor both type the field optional. `JSON.stringify` keeps `0` and
drops `undefined`, so a counter that was never read would surface as `jscExtra=0MB`
— inside a series whose only purpose is to show whether native memory grows.
**Unavailable is not the same measurement as zero.** `typeof === "number"` also admits
`NaN`.

Shipping an observability feature that invents a zero is worse than shipping nothing,
so it was closed with the exact rebase recipe and the optional-field contract instead.

## Blockers closed in what did land

**Whitespace (#2301).** `git diff --check` was red on all six added files. Reproduced,
then fixed.

**`010` contract.** The plan itself specified the unavailable case as `0` — the same
defect as #2302, one layer up. Fixed to omit the key, so the plan no longer instructs
the next implementer to fabricate.

**`040` step 3.** Described matched GC pairs driven by identical *concurrent* request
streams, contradicting `020`'s split into idle RSS cells and separate latency cells.
Running an RSS cell under load reintroduces exactly the allocator residual the split
exists to remove.

**Missing baseline (#2303).** The harness recorded `rssAfterLoad`, `rssPlus5s`,
`rssPlus60s` — and no pre-load sample. The controlling 260731 gate is *"at least 50% of
post-load RSS **growth** is gone"*, which that shape cannot express:
`rssAfterLoad - rssPlus60s` cannot separate recovery from ordinary drift, and the
recorded verdict divided recovered bytes by *total* post-load RSS, answering a
different question than the gate asks. Now records `rssBeforeLoad` and derives
`postLoadGrowth` and `recoveryFraction`, with `null` when growth was not measurable so
an inconclusive cell does not read as 0% recovery.

**Silent GC failure (#2303).** A child-side `gc-error` was ignored by the parent, so a
collection that threw became a 10-second `gc receipt timeout` that hid the cause. It
now rejects the cell.

**Ungated SIGUSR2.** The collector was gated by a *comment* saying the locked 7h
retention protocol never sends that signal. That is a claim about one sender, not a
property of the process — a stray signal would have collected inside the measurement
that protocol exists to take. Now gated on `OCX_GC_EVAL=1`.

**Unvalidated inputs (#2304).** Reproduced before fixing:

```
$ bun scripts/smol-worker-ab.ts <dir> 100 0
{"completionSuccess":true,"elapsedWithin25Pct":false,"peakRssReduced":false,"verdict":"fail"}
```

Zero runs, `completionSuccess: true`, median fields silently absent — a structurally
incomplete gate reporting success. Now bounded integers, `median([])` throws, and
medians are computed only after both arms complete.

**Overclaimed scope (#2304).** The header claimed to measure "the audited large-payload
shapes of the three production workers" while importing none of them. Corrected to what
it is: a synthetic screening of the array-plus-JSON burst shape those workers share.
This matters because it stops the FAIL being read as a per-call-site gate.

## What was deliberately not done

The GC harness needs a live upstream fixture to produce numbers. **The recorded RSS
cells were not regenerated**, so the `020` table still carries the old denominator.
Re-running the cells and rewriting that table around `recoveryFraction` is the next
measurement pass. It is stated in the commit message and the PR body rather than
quietly implied, because the alternative — shipping a harness that *can* prove the gate
next to a table that never did — is exactly the kind of gap that gets read as proof
later.

Both experiments' **FAIL verdicts stand**. No production `Bun.gc(true)` call and no
`smol: true` flag was landed. A negative result with evidence is the deliverable.

## Also closed in this phase

The work-phase-1 holdout **#2359** landed as `d179fa4f2`. The author had pushed
`e2424f33` dropping the `opencode-free/deepseek-v4-flash-free` exclusion that broke
`provider-live-models.test.ts:163`, and pruning the stale
`OPENCODE_GO_THINKING_TOGGLE_MODELS` entries — exactly the fix the review asked for.
Re-verified in an isolated worktree (`tsc` exit 0; 193 pass / 0 fail) before merging.
Issue **#2330** closed, recording why `grok-4.6` and `deepseek-v4-flash-free` were
deliberately *not* excluded: both are live, and hiding a served model is a worse bug
than the one being fixed.

