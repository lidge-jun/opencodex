---
title: Cursor ACP -> OpenCodex feasibility
unit: 260910_cursor_acp_bridge
class: C3 (docs-first investigation)
date: 2026-09-10
status: plan
---

# 000 -- Plan

## Loop spec

- **Question (as asked):** can the Cursor ACP integration implemented in `cli-jaw`
  be attached to OpenCodex?
- **Work class:** C3. Docs-first investigation; no `src/` change in this unit.
- **Deliverable:** a feasibility verdict with source-proven evidence, plus a
  written *recommendation* to correct an existing OpenCodex planning document
  that mis-identifies ACP. The recommendation is the deliverable; the edit to
  `800_agent-fabric/` belongs to that unit and is deliberately not performed
  here, which is why the scope boundary below excludes it.
- **Previous D conclusion (LOOP-CONTINUITY-01):** the closest prior unit is
  `devlog/_fin/260716_grok_build_connect/`, which answered the *reverse*
  direction (an ACP-capable agent harness consuming OpenCodex models over
  `/v1/responses`). Its verdict was "PARTIAL -- possible with config". That unit
  explicitly did **not** examine OpenCodex consuming an ACP agent, so this unit
  is new work rather than a re-open.

## Scope

**IN**

- Identify which protocol `cursor-agent acp` actually speaks, from primary sources.
- Inventory the `cli-jaw` ACP subsystem and separate portable protocol code from
  host-coupled code.
- Map the OpenCodex adapter contract and every registration touchpoint a
  process-spawning provider must satisfy.
- Decide feasibility per integration direction and record the blocking constraint.

**OUT**

- Any change under `src/`, `gui/`, or `docs-site/`.
- Vendoring or copying `cli-jaw` source into this repository.
- Live `cursor-agent acp` handshake proof (the macOS login keychain is locked on
  this host; see 040 residuals).
- Building the adapter. If the verdict is GO, implementation is a separate unit.

## Phase map (dependency order, PHASE-SPLIT-01)

Each phase consumes the verified output of the previous one.

1. **Protocol identity.** Which spec is "ACP" here. Everything downstream is void
   if this is wrong, and there is prior evidence in this repository that it *was*
   wrong -- so this phase is first, not a footnote.
2. **Source inventory.** What `cli-jaw` actually has, classified by portability.
   Depends on 1 to know which methods matter.
3. **Host seam.** What OpenCodex requires of a non-HTTP provider. Independent of
   2 in principle, but read after it so the two contracts can be diffed.
4. **Verdict.** Fit analysis per direction, blocking constraint, options.
   Consumes 1-3.

## File change map

| File | Change | Source |
|---|---|---|
| `000_plan.md` | this plan | -- |
| `010_protocol_identity.md` | which ACP, with opened primary sources and dates | L3 lane |
| `020_cli_jaw_inventory.md` | per-file portable/host-coupled split with import evidence | L1 lane |
| `030_opencodex_seams.md` | `ProviderAdapter` contract, `coding-agent` precedent, touchpoint table | L2 lane |
| `040_feasibility_verdict.md` | verdict, blocking constraint, options, residuals | main |
| `050_audit.md` | independent reviewer verdict and main disposition | A phase |
| `060_done.md` | cycle summary, what did not improve, falsification hooks | D phase |

No file outside `devlog/_plan/260910_cursor_acp_bridge/` is touched.

## Accept criteria

1. **Protocol identity is proven, not asserted.** 010 names the exact vendor page
   that links `cursor-agent acp` to a specific spec, quotes it, and gives the
   date it was opened. A search snippet is not sufficient (SEARCH-PROOF-01).
2. **The name collision is resolved with dated evidence on both sides.** 010
   shows the two same-acronym protocols are different specs, each with its own
   primary source and date.
3. **Every PORTABLE claim carries an import-line quote.** The portable/host split
   is what the analysis rests on, and a false "portable" is the costly error, so
   020 quotes the actual imports (or their absence) for **every** file it calls
   portable. For host-coupled files it quotes a representative sample naming the
   coupling, not all fourteen. This asymmetry is deliberate and is stated here so
   the criterion matches what the unit actually delivers -- an earlier revision
   demanded quotes for every file and did not meet its own bar.
4. **Every OpenCodex touchpoint carries `path:line`.** 030's table has no row
   whose proof column is empty or generic.
5. **The verdict states a blocking constraint or explicitly states there is none.**
   A verdict of "possible with work" that does not name what specifically breaks
   is rejected.
6. **Residuals are separated from findings.** Anything not proven on this host --
   notably the live handshake -- appears under residuals, never in the verdict body.

## Verifiers (PLAN-VERIFIER-REAL-01)

Run before being written here.

| Command | Exit | Reads this unit's target? |
|---|---|---|
| `bun run privacy:scan` | `0` ("Privacy scan passed", re-run 2026-09-10 after staging) | **Yes, but only once the files are tracked.** `scripts/privacy-scan.ts:60` takes its inputs from `git ls-files`. The first run of this gate passed while reading **none** of this unit's files, because they were untracked. The files were then `git add`-ed and the gate re-run; `git ls-files -- devlog/_plan/260910_cursor_acp_bridge` now lists all six, including `050_audit.md`, which was itself missed on the first staging pass. |
| `bun test tests/ci-workflows/repo-hygiene.test.ts` | `0` (14 pass / 0 fail, 2026-09-10) | **Yes, partially, and also only when tracked.** It asserts no `160000` gitlink and no excised material is in the index, and includes an unresolved-security-verdict tripwire over open devlog plans. It checks hygiene, not correctness. |

**This table is itself an instance of the trap PLAN-VERIFIER-REAL-01 warns about**
-- "a command that silently checks nothing when its config file is absent". An
earlier revision of this plan asserted the first row's "Yes" without checking how
the script sources its file list, and the A-phase reviewer disproved it. Recorded
rather than quietly fixed, because the failure mode is the point.

There is **no** gate that checks the correctness of prose in `devlog/`. Criteria
1-6 are human/reviewer review, not machine-enforced. This is recorded rather than
papered over: do not claim a gate protects the verdict.

## Bypass record (PLAN-BYPASS-NAMED-01)

- **Tier:** E7 (agent-followed instruction).
- **Executing surface:** the A-phase reviewer plus maintainer reading.
- **Known bypass path:** an agent can write a confident verdict with fabricated or
  snippet-only citations; `privacy:scan` and `repo-hygiene` both still pass.
- **Residual risk:** a wrong architectural verdict lands in a public directory and
  is later cited as settled. This has already happened once in this repository --
  see 010 on `devlog/_plan/800_agent-fabric/110_protocol_boundaries.md`.
- **Final layer:** none. Mitigation is the verbatim-anchor requirement in criteria
  1-4, which makes a fabricated citation cheap to spot-check, not impossible to write.

## Delegation record

Three read-only `xai/grok-4.6` explorer lanes, dispatched with `$cxc-search`
attached per SEARCH-ATTACH-01, with disjoint read bounds (DISPATCH-ISOLATION-01):

| Lane | Read bound | Output |
|---|---|---|
| L1 | `cli-jaw` only | 020 |
| L2 | `opencodex` only | 030 |
| L3 | public web only | 010 |

**Architect consultation gap -- explicit waiver.** `references/delegation.md`
requires `agent_type: "architect"` in the live dispatch schema. This session's
`spawn_agent` schema exposes only `model`, `reasoning_effort`, `fork_context`,
`message`, and `items`; there is no role field, so native architect routing
cannot be selected or verified here. Registering the role requires a separate
authorized installation plus a fresh session, which is out of scope for a
read-only investigation.

A design consult was run for its content on `xai/grok-4.6` with a
`CXC-ROLE: architect` marker and `cxc-dev` attached. Its routing is
**unverified**; it is treated as an unverified-routing consult, not as satisfied
architect consultation.

The A-phase reviewer correctly noted that recording a gap does not close it. This
unit therefore takes the other branch the rule allows and records an **explicit
process waiver**: the formal architect gate is waived for a docs-only unit that
writes no `src/` code and ships no runtime behavior, on the grounds that the
dependent completion it would block is a devlog record rather than an
implementation. A GO decision on any of ACP-D2/D3/D4 must **not** inherit this
waiver.
