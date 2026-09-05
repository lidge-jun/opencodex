# 812 — Completed local verification cycle and evidence

 > Current sequencing is governed by830: deliver this verified aggregate into dev first, then execute two complete post-merge regression PABCD cycles. The local cycle recorded here does not replace those two cycles.

## Scope and result boundary

Pinned main48f8186647d9ffb108d226dcfa91a64225aae2a7, pinned
devbf58ef1824e7b827b2a6bc1a5effb5d36ce80180, candidate
e052a874085d9dde864086146330348c3cba150a. This cycle does not publish
or merge. It does not resolve all68 initial debt rows. A second full PABCD
cycle and final hosted/merged-dev gates remain required.

The repaired verification candidate is
ef7914d4a51899f49baa141990f79750b4c75cf9. Its product/dashboard/package
content is identical to e052;813 adds only the test-fixture correction and
its records. The earlier failed attempts remain attributed to e052.

## Per-stack preservation and remaining size debt

| Original facade | Dev lines | Candidate lines |
|---|---:|---:|
| `src/lib/redact.ts` | 526 | 353 |
| `src/providers/openai-tiers.ts` | 416 | 319 |
| `src/adapters/anthropic-image-normalize.ts` | 518 | 228 |
| `src/adapters/cursor/native-exec-desktop.ts` | 207 | 194 |
| `src/adapters/cursor/tool-definitions.ts` | 777 | 112 |
| `src/adapters/xai-tool-schema.ts` | 436 | 351 |
| `src/vision/index.ts` | 673 | 380 |
| `src/responses/parser.ts` | 889 | 560 |
| `src/claude/inbound.ts` | 583 | 386 |
| `src/server/system-env.ts` | 537 | 310 |
| `src/codex/prompt-layers.ts` | 1652 | 1146 |
| `src/combos/types.ts` | 440 | 350 |
| `src/codex/log-guard/inspect.ts` | 524 | 392 |
| `src/clients/config-export.ts` | 1990 | 1298 |

These are14 facade counts, not a fresh whole-repository debt census. The
desktop contract precursor was already under400. Parser, prompt layers and
config export remain above400; function-size debt is not eliminated by pure
moves. All31 new leaves are below400. No later debt layer was implemented.

Main independently checked every staged tip's ancestry and scoped source/test
blob equality in the aggregate, plus original/checkpoint identities. Fresh
independent review inspected46source/14test deltas, preserved declarations and
value/type exports, and147runtime edges; no introduced cycle or state-owner
duplication found. Vision Reserve policy/admission and file-ID caption
alignment, parser URL/file-ID/detail behavior, Claude rejection/error identity,
Combo cooldown defaults and newer provider fields survived rebase. See811
for every staged SHA and non-identical replay disposition.

## Whole main-to-dev regression matrix

The interval includes1837changed paths:1109test paths,185source paths,
96dashboard paths plus tooling/docs/assets.1026test renames mix relocation
with behavior-specific additions; rename similarity alone is not proof of
assertion equivalence. Root package version2.42→2.43 and native catalog5→8
in the isolated fixture are intended changes, not invariance claims.

| Surface | Evidence and interpretation |
|---|---|
| Responses/chat/Claude and images | Existing conformance, opaque recovery, native passthrough, inbound, tool-result image and vision cache cases retained; each original layer's focused checks passed at its own staged tip. File-backed translated Claude rejection is intentional; native preservation remains separately covered. |
| Streaming/cancellation/WS | Existing relay-eager, passthrough-abort and ws-upstream cases are in the full suite. WS metadata and task-recovery opt-in are intentional additions; finite cases do not prove every possible continuation chain. |
| Config/CLI/native | Client export bytes/fragments, TOML/EOL/ownership, shell env boundaries, CLI help/service and original assertion bodies retained. No live configuration or service changed. |
| Catalog/routing/state | Initial-selection fencing, combo wait/default/cancellation, reactive429 rotation and Reserve dispatch revocation remain in the full suite. Explicit opt-ins are distinct from default compatibility. Fast limitation below remains open. |
| Privacy/optional subsystem | Privacy scan passed at candidate; existing core-Lab boundary and destination/redaction coverage retained. Independent security review found no broadened authority in the extraction delta. |
| Dashboard/package | Main1310/0 and dev1443/0 component tests plus build/lint succeeded. Candidate1443/0 also passed. Isolated loopback rendered Dashboard/Providers/Models/Logs/Integrations; both showed one configured fixture, logs-empty and client-state surfaces; consoleerrors[]. Fixture upstream at127.0.0.1:1 intentionally refuses discovery, and configured-model fallback remained visible. Browser snapshots retained in ignored evidence. |
| Public value exports | Pinned-main14modules244names independently verified in actual main runtime15/0, then candidate15/0. Names-only check does not establish signature or semantic compatibility; declaration review and behavioral cases are separate evidence. |

## Execution record — do not flatten failures into green

The rendered baseline comparison above was pinned main versus pinned dev,
not initial-candidate UI proof. The repaired candidateef7914 was then served
separately on loopback18173 in its own fake home: Dashboard online,
Providers fixture ready, Models9/9 (8native plus1fixture), empty Logs and
unchanged Integrations cards were observed, with no console errors. Candidate
screenshots are retained; its exact test-owned server was stopped afterwards.

Main baseline:17717pass/16skip/0fail; dev baseline:19220pass/16skip/0fail.
Both exact final SHAs clean; frozen installs/build/type/privacy succeeded.

First candidate ordinary full run was interrupted after466s in
claude-models-discovery.test.ts. One worker was CPU-bound; suite143 and no
receipt. All14stage checks, export15/0, dashboard1443/0, type/lint/privacy0
before that interruption remain valid same-head partial evidence.

Unchanged discovery file alone passed12/12 in1.3s; diagnostic five repeats
passed60/60 in5.1s. A diagnostic full run withCPU-prof flags passed
19235/16/0, but produced no profiler artifact and its workerargv lacked those
flags. Profiling activation was not proved and no hotspot was obtained.
No test, timeout, runner partition or product source was weakened or changed.

Third whole-suite attempt (second ordinary attempt) completed with one
server-auth WebSocket terminal watchdog failure at1026ms; no receipt was
written. Matched traces reproduced that same failure on pinned dev1/20;
candidate20/20 passed. Those measurements did not themselves fix anything.

The fixture redirected fetch but missed the native WebSocket constructor.
A no-egress sentinel found2 unmocked canonical connection attempts while
the original old/new credential assertion passed.813 replanned the failed
cycle and repaired only that fixture, restoring WebSocket after every test
and covering exact path/scheme/host/argument delegation. The same sentinel
then passed with0 unmocked attempts at ef7914d4a, including unchanged
credential and status-log assertions. No timeout or product behavior changed.
Fresh repaired ordinary full suite passed19236/16skip/0fail (19059parallel
plus177serial), focused server-auth/native-WS/provider fixture161/1skip/0fail,
typecheck/privacy0. Source-bound receipt for ef7914d4a is clean, exit0,
owner01a06e97-b9d8-7250-8204-bb788338c288, epochc-20260905140213-d1684e.
Archived receipt: closeout-first-receipt-ef7914.json. Earlier failures remain
recorded; the separate discovery stall did not recur in this run, but is not
claimed fixed. Main accepts carrying that observation into820 as a
nonterminal risk, not as publication clearance or a defect-closure claim.
The first stall remains unexplained, not fixed or proven environmental.
A later passing run cannot erase it. It must carry into cycle2 and final
hosted evidence; recurrence triggers renewed RCA rather than blind retries.

## Fast opt-in limitation

A focused characterization on pinned dev confirmed a live-only literal
`fixture/foo--fast` remains literal while in the discovery cache, but after
explicit eviction can be read as Fast for`fixture/foo` when`fastRows=true`.
Default-off and explicitly configured literal controls keep the original
identity.1case/6assertions passed. The relevant source is unchanged in this
aggregate. Main has no Fast flag/parser, so the reviewer retracted an
existing-main-default-regression classification.

This is an unresolved new-feature contract ambiguity/defect candidate against
an overstrong source comment, not an implemented fix or a blanket reserved-name
policy. Retaining literal history or narrowing synthetic routing needs its own
design decision; neither is silently introduced by a pure-move closeout.
No universal “zero regressions anywhere” claim follows from this report.

## Next cycle

The first local work-phase closed through an evidence-backed D at ef7914.
The user's latest correction makes830 delivery the next phase: publish this
aggregate, pass its exact-head hosted checks and admin-land into dev. Then
840/850 perform two complete post-merge regression cycles, consuming820's
independent contract-guard design and the limits recorded above. No claim of
post-merge regression completion is made here.
