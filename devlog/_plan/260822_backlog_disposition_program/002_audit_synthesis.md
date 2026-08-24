# 002 — A-phase audit synthesis (REVIEW-SYNTHESIS-01)

Round 1 auditor verdict: **FAIL, blockers=7**. Every blocker was independently
re-verified by the main agent against the real tree before disposition. **All seven are
ACCEPTED**; none is rebutted. This document records the root cause of each and the
amendment it forces, per REVIEW-SYNTHESIS-01.

## B1 (High) — WP3's bare-name alias is unreachable. ACCEPTED, and it removes a change.

Auditor anchor: `src/bridge.ts:1041` and `src/bridge.ts:1788`. Re-verified verbatim:

```ts
if (options?.declaredToolNames && !options.declaredToolNames.has(event.name)) {
  const failure = responseError(502, "upstream_error",
    `routed provider emitted undeclared client tool "${event.name}"; only request-declared tools may be called`);
```

The authorization guard runs **before** `closeCurrentToolCall()` reaches
`coerceIntegerToolArguments`. Registering a schema under a bare key while leaving
`declaredToolNames` untouched therefore repairs arguments for a call that was already
rejected with a 502. The proposed wiring test injected `toolParameterSchemas` by hand and
bypassed the guard entirely — false confidence, exactly as the auditor said.

**Independent finding that settles it.** The issue body for #2316 reports the failing
call as `multi_agent_v1__wait_agent` — the **namespaced** name:

> On current `dev` (`a228ed741`), Grok-routed Codex App still rejects
> `multi_agent_v1__wait_agent` before the tool runs:
> `failed to parse function arguments: invalid type: floating point \`120000.0\`, expected u64`

Two things follow. First, the error is raised by **Codex's own deserializer**, which
proves the call *passed* our bridge and reached Codex — so the schema lookup **hit**.
Second, the name is namespaced, so no bare-name miss ever occurred in the report.

**Defect B does not exist in the reported bug.** WP3 is amended to a single-file change:
`src/lib/tool-argument-integers.ts` only. The `src/server/responses/collaboration.ts`
edit is **struck** from the plan. This makes WP3 smaller and removes the security-adjacent
surface entirely.

## B2 (High) — alias collision. ACCEPTED, dissolved by B1.

Auditor anchor: `src/server/responses/collaboration.ts:154`, which requires
`bareNameCounts.get(t.name) !== 1` before admitting a bare alias. The proposal's
"first declaration wins" bypassed that uniqueness policy. Since B1 strikes the alias
change entirely, the collision cannot occur. Recorded because the reasoning must survive:
**if a future unit wants bare-name repair, it must go through `declaredToolNames`,
`toolNsMap`, and `toolParameterSchemas` atomically under the existing uniqueness rule** —
never through the schema map alone.

## B3 (High) — 16 changes-requested PRs had no disposition. ACCEPTED.

The inventory counted 19 in that class; WP2 named 2 and WP7 named 1. The remaining 16
appeared only as inventory rows. A generic acceptance criterion is not a disposition.
Amendment: the table below enters `020` as its dispositioned roster.

| PR | State | Head | Size | Author | Title |
|----|-------|------|------|--------|-------|
| #2299 | draft | 48326fc5 | 860+/3- (9f) | abhisheksharma2411 | feat(catalog): operator display labels for live-discovered m |
| #2298 | draft | 38888e3d | 74+/0- (3f) | ppvia | fix(claude): warm empty Desktop-3P alias registry on first / |
| #2257 | draft | 510f1044 | 1289+/29- (20f) | yansigit | feat(agent): named subagent role catalog |
| #2244 | draft | 67acb331 | 913+/0- (9f) | ZSN12 | feat(workbuddy): add experimental desktop OAuth provider |
| #2215 | draft | d85cf057 | 126+/41- (8f) | parkjs101 | docs(sub-agents): describe v2 fork override rule as a prompt |
| #2123 | draft | 701b51f9 | 495+/32- (3f) | chilung-cgu | feat(quota): add per-account Gem/Cla quota probing for Googl |
| #2122 | draft | fd6e53de | 607+/41- (15f) | chilung-cgu | feat(catalog): config-level retainModels allowlist for autho |
| #2113 | ready | 3e17fe58 | 2184+/112- (63f) | cb8010d6 | feat(providers): allow trusted encrypted V2 task passthrough |
| #2071 | draft | e365907b | 2789+/124- (25f) | yansigit | feat(antigravity): CCA host failover and non-retryable image |
| #2070 | draft | f276d325 | 1608+/76- (14f) | yansigit | feat(antigravity): Claude CCA wire fidelity |
| #2068 | ready | 9dceb40f | 954+/31- (7f) | yansigit | feat(antigravity): live quota RPC and geoblock classificatio |
| #2050 | draft | 52324cef | 528+/72- (46f) | x3M3x | feat(combos): add random, least-used, and reset-window routi |
| #1905 | ready | 0be75f29 | 781+/80- (27f) | luvs01 | feat(codex): add per-model ChatGPT compaction budgets |
| #1829 | ready | bf5e67f9 | 2878+/2- (4f) | luvs01 | feat(codex): add durable reset-credit operation ledger |
| #1769 | draft | f87c4acb | 963+/36- (19f) | dbc-hbin | feat(gui): add manual paste fallback for OAuth add-account |
| #1756 | ready | e9a04d1e | 850+/116- (17f) | takltc | feat(grok): inject per-model reasoning effort into Grok Buil |

## B4 (High) — WP5 knowingly permits an external-writer credential clobber. ACCEPTED.

The research lane wrote: *"A true multi-writer CAS ... was demanded by the owner review;
the lock covers same-machine ocx processes but not Codex CLI writers that ignore our
lock. Flag this residual risk in the PR description."* A PR-description note is not a
mitigation for a credential-clobber race on a file another product writes.

Amendment: external-writer CAS moves **into WP5 acceptance criteria** — capture file
identity (dev/ino/mtime/size) plus content hash at read, re-compare immediately before
publication, and retry/adopt/refuse on change; with a regression that mutates
`auth.json` between refresh and publish and proves the newer writer survives. WP5 also
remains gated on exact-head maintainer security review per AGENTS.md.

## B5 (High) — the verifier commands are false-green. ACCEPTED; my `001` claim was wrong.

Re-verified directly:

```
$ ls tests/dispatch-sync.test.ts
ls: tests/dispatch-sync.test.ts: No such file or directory

$ bun test tests/codex-main-account-refresh.test.ts tests/codex-account-store.test.ts
 26 pass / 0 fail    RC=0
```

The second command names a file that does not exist and **still exits 0**, because Bun
silently ignores missing paths when at least one listed file exists. A verifier that
passes while its mandatory regression is absent is worse than no verifier.

Amendments: (a) WP4's placeholder resolves to the real file — `tests/cli-dispatch.test.ts`
exists, `tests/dispatch-sync.test.ts` does not; (b) every phase's C step prepends an
existence gate `test -f <path>` for each required new suite, and runs each mandatory
regression as its own invocation so a missing target fails the phase; (c) the
PLAN-VERIFIER-REAL-01 table in `000` is corrected — it currently overclaims.

## B6 (Medium) — WP4's `execFile` seam cannot carry its own timeout. ACCEPTED.

`execFile?: (file: string, args: readonly string[]) => Promise<{ stdout: string }>` has
no options parameter, yet the same document mandates `timeout: 10_000` and
`windowsHide: true`. A hung `Get-AppxPackage` probe would wedge `ocx sync` or
`ocx doctor`. Amendment: the seam gains a typed options parameter (`timeout`,
`windowsHide`, abort), with a test proving timeout rejection and process cleanup.

## B7 (Medium) — my auto-close hazard claim was factually wrong. ACCEPTED.

`001` claimed the merged #2320 "would close #2316 spuriously at the next dev→main
promotion". Re-verified: the squash commit message is

```
fix(cursor): classify bare 0-token resource_exhausted as context overflow (#2320)
```

— it contains **no** closing keyword. GitHub ignores closing keywords in a PR body when
the PR targets a non-default branch; no link is ever created, and promoting the existing
commit cannot resurrect an ignored keyword. The state facts stay (#2320 MERGED, body
still says `Closes #2316`, #2316 OPEN); the hazard claim is **withdrawn**.

## Correction carried from the auditor's additional findings

`000` justified ordering WP1 before WP3 as a shared-file dependency. Verified false:
#2335 touches `src/adapters/anthropic.ts`, `command-code.ts`, `google.ts`,
`src/responses/parser.ts`, `src/types.ts`, `src/types/tools.ts` — **not**
`collaboration.ts`; and post-B1 WP3 touches only
`src/lib/tool-argument-integers.ts`. There is **no file overlap**. WP1 still runs first
because merging verified-green work before opening new work keeps the baseline clean, but
the stated rationale is corrected to that, rather than a dependency that does not exist.

## Disposition summary

| Blocker | Severity | Disposition | Effect on plan |
|---------|----------|-------------|----------------|
| B1 | High | ACCEPTED | WP3 loses the `collaboration.ts` change entirely |
| B2 | High | ACCEPTED | Dissolved by B1; policy recorded for future units |
| B3 | High | ACCEPTED | 16 PRs dispositioned in `020` |
| B4 | High | ACCEPTED | External-writer CAS becomes WP5 acceptance, not a note |
| B5 | High | ACCEPTED | Existence-gated, one-file-per-invocation verifiers |
| B6 | Medium | ACCEPTED | `execFile` seam gains options |
| B7 | Medium | ACCEPTED | False hazard claim withdrawn from `001` |

Zero rebuttals. Round 2 audit follows on the amended documents.

