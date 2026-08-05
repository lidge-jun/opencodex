# Allocator residual refresh — live Bun evidence

**Checked:** 2026-08-01 Asia/Seoul (`2026-07-31T19:03:55Z`)

**Scope:** upstream research and Phase-4 recommendation only. No local benchmark
or runtime experiment was run for this refresh.

## Bottom line

There is still **no stable Bun release newer than v1.3.14**. GitHub's live
latest-release record remains
[`bun-v1.3.14`, published 2026-05-13](https://github.com/oven-sh/bun/releases/tag/bun-v1.3.14).
Consequently, merged PR [#32120](https://github.com/oven-sh/bun/pull/32120)
and the newer allocator work described below are not in a published stable Bun
that OpenCodex can adopt today.

The upstream outlook is materially better than the 2026-07-31 snapshot,
however. Bun main now:

1. makes JavaScriptCore and Bun share mimalloc instead of retaining separate
   libpas and mimalloc heaps ([#34009](https://github.com/oven-sh/bun/pull/34009));
2. hands idle thread heaps to a background scavenger
   ([#34181](https://github.com/oven-sh/bun/pull/34181));
3. explicitly starts that scavenger ([#34502](https://github.com/oven-sh/bun/pull/34502)); and
4. has since updated its mimalloc fork to upstream dev3/v3.4.3+
   ([#36431](https://github.com/oven-sh/bun/pull/36431)).

Those changes are a plausible upstream solution to much of the 1.3.14 allocator
residual, and maintainer measurements on a Next.js server show a large reduction.
They are **main/canary evidence, not a stable-release upgrade path yet**. The
honest Phase-4 decision for the bundled stable remains
**NOOP-with-documentation for allocator reclamation**. Do not add periodic
`Bun.gc(true)`, allocator environment variables as product defaults, or a Darwin
FFI purge hook. Re-evaluate by upgrading and rerunning the A–F matrix when a
stable release containing the allocator train is actually published.

## 1. Dated live-evidence ledger

| Upstream item | Live state at check time | Relevant activity and Phase-4 meaning |
|---|---|---|
| [Bun releases](https://github.com/oven-sh/bun/releases) | **Latest stable: v1.3.14**, published 2026-05-13. No v1.3.15 or v1.4 stable release is listed. | There is no newer stable changelog to inspect. In particular, neither #32120 nor the July allocator train can be claimed as shipped stable. Some upstream comments call a main build “1.4.0”; treat those measurements as pre-release/main evidence until a release record exists. |
| [Issue #21560](https://github.com/oven-sh/bun/issues/21560) | **Open**; last updated 2026-07-12. | The latest comment asks whether #30590 has a current-tree successor; no maintainer answer or direct `Bun.gc(true)` successor is linked there. Its macOS/Linux report with flat JS counters and rising RSS remains allocator-compatible evidence, not proof of OpenCodex-owned live objects. |
| [PR #30590](https://github.com/oven-sh/bun/pull/30590) | **Closed unmerged** 2026-06-26. | It demonstrated the missing operation: after JSC finalizers, synchronously scavenge libpas and force mimalloc collection. It was closed because the Rust rewrite removed/reorganized its target files. No equivalent post-finalizer forced path is merged: [v1.3.14 calls `mimalloc_cleanup(false)` before `runGC(true)`](https://github.com/oven-sh/bun/blob/bun-v1.3.14/src/jsc/VirtualMachine.zig#L753-L760), and [current main retains the same ordering](https://github.com/oven-sh/bun/blob/f68e504ae48a5a54eb3017f29baa99dd31660a5e/src/jsc/VirtualMachine.rs#L1097-L1104). |
| [PR #28743](https://github.com/oven-sh/bun/pull/28743) | **Closed unmerged** 2026-05-13. | Still useful historical ownership evidence: HTTP-thread allocations freed on another thread can wait in mimalloc delayed/free structures. It was superseded diagnostically by #30590 and is not an active fix. Main's unified allocator/scavenger work may reduce this class, but #28743 itself did not ship. |
| [Issue #32111](https://github.com/oven-sh/bun/issues/32111) / [PR #32120](https://github.com/oven-sh/bun/pull/32120) | Issue **closed**; PR **merged** 2026-06-21 at `8dd1b617e49e...`. | Fixes the async `ReadableStream` client-abort teardown crash. It is not an RSS-retention fix, but remains relevant to the abort load cell. Because latest stable predates the merge, v1.3.14 does not contain it. |
| [PR #34009](https://github.com/oven-sh/bun/pull/34009) | **Merged** 2026-07-14; main only. | Replaces the 1.3.14 two-allocator arrangement by routing JSC allocation through Bun's mimalloc. Upstream reports lower RSS across server workloads and removal of libpas's continuously polling scavenger. This changes the allocator model substantially, so 1.3.14 knob conclusions must not be copied unchanged to the future release. |
| [PR #34181](https://github.com/oven-sh/bun/pull/34181) | **Merged** 2026-07-16; main only. | Adds event-loop idle handoff to mimalloc's background scavenger so a busy/chattery server can return free pages off the JS thread. Upstream reports material RSS reductions, with a measured worst-case synthetic static-route throughput cost around 4–6%; ordinary JS-handler servers were within about ±2%. |
| [PR #34502](https://github.com/oven-sh/bun/pull/34502) | **Merged** 2026-07-18; main only. | Explicitly starts the allocator scavenger after the mimalloc fork stopped starting it from a process constructor. The author states that without this call purge falls back to allocation-driven behavior. A maintainer later reported sequential `Bun.build()` RSS plateauing on main rather than climbing. |
| [PR #36431](https://github.com/oven-sh/bun/pull/36431) | **Merged** 2026-07-30; main only. | Updates the fork to upstream dev3/v3.4.3+ while preserving scavenger, idle-handoff, hole-purging, and Darwin behavior. Its macOS arm64 A/B says a 256 MiB free workload fell from about 252.5 MiB footprint to 2.5 MiB after a scavenger cycle on both the old and new pins. This validates the new scavenger path, not v1.3.14. |
| [Issue #34389](https://github.com/oven-sh/bun/issues/34389) | **Closed** 2026-07-24 as fixed on main. | Maintainer reproduction measured a Next.js standalone server at 1.3.14: 720 MiB startup / 827 MiB after idle, versus the main build labelled 1.4.0: 179 MiB / 318 MiB. The maintainer attributes the change to #34009, #34181, #34502 and allocator updates. Strong evidence to retest the next stable; not evidence that a stable 1.4 release exists. |
| [PR #30725](https://github.com/oven-sh/bun/pull/30725) | **Open**; last updated 2026-07-10. | Proposes up to two asynchronous full JSC collections at an active→idle transition. It targets promoted JS objects/JIT code, not forced native page purging, and therefore does not replace the allocator fix. |

### Stable-release conclusion

Question 1's conditional does not fire: there is no newer stable release, hence
no newer stable changelog containing an RSS/allocator/fetch-stream change or
#32120. The next stable should be accepted only after its published release notes
and commit ancestry show which of #32120, #34009, #34181, #34502, and #36431 it
actually contains.

## 2. Bun 1.3.x macOS knob inventory

The key applicability boundary is visible in Bun v1.3.14's build definition:
mimalloc is linked for Bun's explicit allocator use, but
[global malloc override is deliberately disabled on macOS](https://github.com/oven-sh/bun/blob/bun-v1.3.14/scripts/build/deps/mimalloc.ts#L16-L35)
because zone/interpose breaks native addons and system frameworks. JSC/libpas,
Bun/mimalloc, and Apple malloc zones therefore remain separate control surfaces
in this stable release.

| Candidate | Applies to Bun 1.3.14/macOS? | Expected effect | Verdict / risk |
|---|---|---|---|
| `MIMALLOC_PURGE_DELAY=0` | **Yes, but only to Bun's mimalloc-managed allocations.** The bundled fork reads `mimalloc_*` environment options and has a 1000 ms default ([pinned source](https://github.com/oven-sh/mimalloc/blob/f15aecb94fc8096008bf87b90c53ed682026914a/src/options.c#L122-L142)). It does not control JSC/libpas or ordinary Apple malloc zones. | Purge an eligible unused mimalloc page immediately instead of waiting for its deadline. On this pinned macOS path, decommit prefers `MADV_FREE_REUSABLE`, falling back to `MADV_DONTNEED` ([source](https://github.com/oven-sh/mimalloc/blob/f15aecb94fc8096008bf87b90c53ed682026914a/src/prim/unix/prim.c#L493-L502)). A #21560 user reported lower/oscillating macOS RSS with this variable plus a canary, but the two changes were not isolated. | **Diagnostic-only candidate**, never a default. It can increase `madvise`/fault churn and hurt throughput or tail latency; it cannot purge libpas. If retained in the Phase-4 matrix, require fresh-process control/variant runs and performance gates. |
| `MIMALLOC_PURGE_DECOMMITS=1` | **Yes, and already the bundled default.** | Decommit on purge, which is the path most likely to reduce reported RSS; setting `0` selects reset/`MADV_FREE`, which can leave RSS looking high despite reusable pages. | **NOOP when set to `1`; reject `0` for this objective.** This does not make a page become purge-eligible or trigger a purge. |
| `MIMALLOC_ARENA_EAGER_COMMIT=1` | The variable is parsed, but it controls arena commit policy, not reclamation. The documented/default value `2` enables eager commit only on overcommit systems such as Linux; `1` opts macOS in. | Commits a large arena eagerly to improve some allocation paths. It does not force freed pages back to the OS. | **Reject as an RSS remedy.** It can increase commitment and front-load work; it addresses the opposite side of the lifecycle. |
| `MIMALLOC_SCAVENGER` | **Not a v1.3.14 facility.** The explicit background-scavenger integration is the July main-only #34181/#34502 train. | On current main, Bun starts and uses the scavenger itself; an operator should not need to turn it on. Disabling it would restore allocation-driven cleanup. | **Unavailable in bundled stable; no product setting.** Revisit only through a future stable upgrade. |
| `BUN_JSC_libpasScavengeContinuously=1` | **Mechanically relevant but unsupported.** Bun's pinned WebKit exposes `libpasScavengeContinuously` (default false) and, when set, prevents the libpas scavenger from shutting down ([option](https://github.com/oven-sh/WebKit/blob/5488984d20e0dbfe4be2c3ba8fb18eb81a5e0e8b/Source/JavaScriptCore/runtime/OptionsList.h#L635-L642), [effect](https://github.com/oven-sh/WebKit/blob/5488984d20e0dbfe4be2c3ba8fb18eb81a5e0e8b/Source/JavaScriptCore/runtime/InitializeThreading.cpp#L111-L118)). Bun maintainers have used the `BUN_JSC_` prefix since at least v1.0.x ([example](https://github.com/oven-sh/bun/issues/7232#issuecomment-1818616994)); current source explicitly warns that these options are unstable debugging controls ([source](https://github.com/oven-sh/bun/blob/f68e504ae48a5a54eb3017f29baa99dd31660a5e/src/jsc/lib.rs#L578-L587)). | Keeps the libpas background scavenger alive, so it may make cached JSC pages eligible for earlier OS return. It is not a synchronous “purge now” call and does nothing for mimalloc. | **Diagnostic-only, higher-risk candidate.** Expect background CPU/power and `madvise` activity; #34009 measured the old libpas scavenger polling around 10 Hz. Never expose as an OpenCodex setting or default. Future unified-allocator builds remove the reason to use it. |
| `bun --smol` / `smol = true` | **Supported Bun option.** Bun says it selects the smaller JSC heap and runs GC more frequently ([runtime docs](https://bun.com/docs/runtime), [worker detail](https://bun.com/docs/runtime/workers)). | Can reduce live/peak JSC heap and allocation pressure. It does not command libpas or mimalloc to return already-free native pages. | **Supported pressure reducer, not an allocator-residual fix.** It can slow execution. EXP-3's small tracked counters and pinned post-GC RSS make it unlikely to reclaim the 1.65–2.04 GiB residual by itself. |
| `Bun.gc(true)` | **Supported API**, but the documented claim that it asks mimalloc to clean fragmented memory is weaker than its 1.3.14 implementation ([docs](https://bun.com/reference/bun/gc)). The stable source performs non-forced mimalloc cleanup **before** JSC finalizers, then runs synchronous JSC GC; #30590's rejected diff existed to correct exactly that ordering/force gap. | Reclaims unreachable JS objects synchronously and may clean some mimalloc state that was already free before the call. It does not guarantee macOS RSS reduction. | **Harness probe only. Do not schedule in production.** It stops the JS thread, adds CPU/latency, and EXP-3 already observed external accounting fall without RSS falling. |
| `malloc_zone_pressure_relief(NULL, 0)` via Bun FFI | Apple defines this as a best-effort request for maximal relief across registered malloc zones when zone is null and goal is zero ([Apple libmalloc header](https://github.com/apple-oss-distributions/libmalloc/blob/c49dafa25f1efe8607701ae6014a663ad2ee437f/include/malloc/malloc.h#L516-L522)). Bun itself only wires it into Darwin GC/stat paths when malloc debugging is compiled in ([v1.3.14 source](https://github.com/oven-sh/bun/blob/bun-v1.3.14/src/jsc/bindings/bindings.cpp#L4829-L4851)). | May release pages held by Apple malloc zones. It does not provide a supported way to force v1.3.14's explicit mimalloc heap or libpas caches, because macOS malloc interposition is disabled and those allocators have their own scavengers. | **Reject.** It is an unsupported process-wide FFI intervention with incomplete allocator coverage and possible long stalls; WebKit previously reduced duplicate calls because of main-thread stall cost ([WebKit bug 164375](https://bugs.webkit.org/show_bug.cgi?id=164375)). |

### Knob conclusion

There is no supported Bun 1.3.x/macOS switch that synchronously purges the full
allocator mix. Only `MIMALLOC_PURGE_DELAY=0` and
`BUN_JSC_libpasScavengeContinuously=1` reach one relevant allocator each, and
both are diagnostic launch variants with incomplete coverage. Combining them
would also make attribution worse; test each separately before any combined
cell. `--smol` is supported but answers a different question. `Bun.gc(true)`
and Apple-zone pressure relief do not close the proven residual.

## 3. Community and operator workarounds

| Workaround seen upstream | Evidence and applicability | Classification |
|---|---|---|
| Set `MIMALLOC_PURGE_DELAY=0` | A #21560 reporter saw macOS RSS periodically return on a Bun 1.2.20 canary with this variable. Because runtime and variable changed together, it is a lead rather than isolated proof; it also misses libpas in 1.3.14. | Experimental launch-time mitigation only. |
| Reduce repeated native allocator churn and reuse long-lived objects | In [#34053](https://github.com/oven-sh/bun/issues/34053), reusing one `Bun.Transpiler` reduced per-call growth about 25×. For an HTTP proxy the analogue is to stream and bound queues instead of repeatedly materializing whole bodies; Phases 2–3 already pursue that. | Valid workload-shape reduction, but it cannot guarantee OS page return after the high-water mark. |
| Use the next Bun allocator train | Maintainers verified major RSS improvement on main after #34009/#34181/#34502 and closed #34389 as fixed. | Preferred future remedy **after a stable release exists**. A canary can be used only for an isolated staging comparison, never as OpenCodex's default runtime. |
| Move the memory-heavy role to Node/Go | #21560 users report stable RSS after moving workers to Go, and #34389/#30415 compare favorably with Node. OpenCodex is intentionally Bun-native, so this is not an in-scope implementation. | Architecture escape hatch for other applications; not an OpenCodex fix. |
| Recycle workers or restart the process | Frees every allocator and is the common final operator workaround for native high-water processes. | **Operator escape hatch only. Rejected as the Phase-4 solution.** The existing manual drain/restart action must remain explicitly labelled this way; never automate or present it as a fix. |

No upstream source establishes a reliable long-lived-server workaround that
both preserves the Bun 1.3.14 process and returns pages from libpas, mimalloc,
and Apple malloc zones. Claims stronger than that would outrun the evidence.

## 4. Phase-4 recommendation

### Decision now: NOOP-with-documentation for allocator reclamation

Do not add an OpenCodex production code path for forced GC, FFI pressure relief,
allocator environment defaults, or automatic restart. The residual exists in a
single-reader standalone HTTP topology, the supported runtime has no complete
purge API, and upstream is already replacing the allocator architecture rather
than endorsing a 1.3.x knob.

Phase 4 may still make an independently justified **observability** change (for
example, distinguishing sustained RSS growth from a stable safety-ceiling
plateau), but that must be reported as observability and not as an RSS fix.

The terminal documentation should say:

- Bun v1.3.14/macOS can retain a high RSS plateau after transient HTTP
  allocation even when JSC/external counters fall;
- stable RSS plus stable JSC/external/request/queue state is
  allocator-compatible, not proof that request data is still live;
- `--smol` can reduce JS-heap pressure but is not guaranteed to lower a native
  post-load plateau;
- no allocator environment variable or FFI purge hook is an OpenCodex-supported
  setting; and
- manual drain/restart is only an operator escape hatch.

### Reopen gate: next published stable

When GitHub publishes a stable later than 1.3.14:

1. verify release notes and ancestry for #32120, #34009, #34181, #34502, and
   #36431 rather than trusting the version string alone;
2. upgrade the bundled runtime in the normal dependency workflow;
3. rerun fresh-process A–F macOS arm64 cells, including the single-reader HTTP
   topology, for the full 60-second idle window with `vmmap`/`footprint`;
4. compare plateau, sustained slope, throughput, and tail latency against the
   v1.3.14 baseline; and
5. only call the unit locally fixed if the supported stable materially reduces
   the residual without an OpenCodex restart or unsupported knob.

If Phase 4 needs one last pre-upgrade attribution pass, test
`MIMALLOC_PURGE_DELAY=0` and
`BUN_JSC_libpasScavengeContinuously=1` as separate launch-time harness variants.
They are evidence probes, not product candidates. The current recommendation
does not depend on them passing.
