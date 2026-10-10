# 002 — Architect consultation record (wp1-P)

Architects (read-only, gpt-6.1-sol, high): **Kant** `01a11e36-a671-74f2-885b-18c7fc28e510` (runtime authority),
**Pascal** `01a11e36-a72b-7663-af14-35535b24c80e` (launcher + PATH decision). Proposals returned 2026-10-09.

## Kant (runtime authority) — main dispositions

| ID | Proposal | Disposition |
|---|---|---|
| D1 | Process-parentage evidence reusing desktop-startup probes, plain ESM so the Node launcher can use it; double read; Windows needs pid+ppid+exe+creation time | **Accept**, amended: Windows returns `unsupported` in this unit (no CIM query on every status; documented follow-up). Unknown evidence never blocks (see D5 amendment). |
| D2 | Three distinct authorities: liveness, durable ownership, live supervision; never record ownership from parentage | **Accept** verbatim. |
| D3 | Unowned supervision + verified login for the same app ⇒ protection desktop, rebootSafe, recommendedCommand null; add `recommendedAction`; fix status.ts:262 and doctor.ts:1687 | **Accept.** `recommendedAction` is a plain sentence, not a shell command. Human "Runtime source" label kept (a test pins it); a new "Runtime supervisor" line is added instead. |
| D4 | Additive `supervisor` field in `ocx-resolve/1`; Rust serde ignores unknown fields | **Accept** (verified: `desktop/src-tauri/src/resolve.rs` has no `deny_unknown_fields`). No Rust change. |
| D5 | Guard service install/repair/start/restart and all updater decision points; unknown supervision blocks destructive handling | **Accept with amendment:** `kind:"desktop"` blocks, and (r2) `unknown` with `desktopSeen: true` blocks too. Plain `unknown`/`unsupported` keep today's behavior so a failed `ps` cannot strand npm updates. The guard is an early warning (E3, CLI-executed); no env bypass is added; the supported path is "quit Desktop first", which removes the evidence; known bypass: an older CLI on PATH never runs the guard. |
| D6 | Keep `ocx stop` working (Desktop's own runtime_stop.rs calls `stop --json`), add stderr notice; start/restart wording | **Accept.** Notice suppressed under `--json`. |
| D7 | File map and tests | **Accept**, split into wp2 (evidence+projection) and wp5 (guards). |

## Pascal (launcher, PATH) — main dispositions

| ID | Proposal | Disposition |
|---|---|---|
| D1 | Order: OPENCODEX_BUN_PATH → bundled → bundled installer recovery → validated PATH Bun → failure | **Accept.** |
| D2 | Absolute PATH entries only, `bun`/`bun.exe` only, realpath + regular executable + isRealBunBinary + bounded `--version` probe; minimum = pinned 1.4.2 | **Amend minimum:** same major as the pinned dependency and minor ≥ pinned minor (≥ 1.4.0, < 2.0.0), because the reporting machine's Bun is 1.4.0; record as policy, not proof. (r2) Identity probe and POSIX writable-location rejection accepted. |
| D3 | Stamp provenance `source:"process"`, keep systemd launcher-mode exception | **Accept.** |
| D4 | No silent delegation to Desktop CLI; document paths | **Accept with amendment:** the failure text names an installed Desktop CLI when one is found (macOS `/Applications` and `~/Applications`), so the user has a working command. |
| D5 | Version-skew notice: preflight helper, 200 ms, skip JSON/help/internal | **Amend:** neutral advice (no `ocx service restart` hint); run only for lifecycle commands (`start`, `stop`, `restart`, `update`, `service`) where the wrong CLI does damage; status/doctor/resolve already report skew. |
| D6 | Desktop PATH installer is a separate opt-in feature | **Accept** → wp4 records the decision and the follow-up design. |

Reflection (same architects) on the written plan revision: recorded below after the check.



## Reflection (plan revision r1 → r2)

- Kant `01a11e36-a671…`: **MISALIGNED** on r1 — gaps: old live runtime verdict, pid binding, unknown ownership, GUI
  consumers, stale guidance, fail-open on changed evidence, anchors. All folded in 010/020 "r2 amendments".
- Pascal `01a11e36-a72b…`: **MISALIGNED** on r1 — gaps: version wording, Bun identity/writable checks, durable consumer
  proof, neutral skew advice, timeout claim, 000 contract text, 040 wording. All folded (000, 002, 030 r2, 040).
- r2 re-sent to both for confirmation; result recorded in 003 if anything remains.
- r2 re-check: Pascal **ALIGNED**; Kant **MISALIGNED** (consumers doctor/status summary, runtime-port correlation, guard
  continuity) → folded as r3 in 010/020. r3 re-check: Kant **ALIGNED**. Plan revision r3 goes to independent A audit.

## Independent audit

- Round 1 reviewer `01a11e4b-1a4a-7211-9a96-dcf9f1b5a29e` (gpt-6.1-sol): **FAIL** (blockers: Node-incompatible latch,
  missing pre-stop gate; mediums: launcher source assertion, predicate, field chain, verifier coverage; low: bypass
  ledger). Synthesis: all seven accepted, none rebutted; folded as r4 in 010/020/030. Decision change (latch module
  location, new pre-stop inspection point) is an execution-flow amendment within Kant D5 — no new design decision.
- Round 2 (same reviewer): **GO-WITH-FIXES (blockers=2)** — doctor verifier placeholder, unexecutable Node activation test;
  low: CliStatusJson name. All three folded as r5 (010/020). Main judgment: near-pass, both blockers folded with
  concrete amendments; no residual High.
