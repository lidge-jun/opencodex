# 090 — Audit round 3: close-out

Unit: `260814_lab_core_decoupling`. Amends `030`, `040`, `080`.
Reviewer: same independent reviewer, round 3, 2026-08-14.
Verdict: **GO-WITH-FIXES (blockers=2)** — one Medium, one Low. No High remains.

Rounds 1 and 2 are fully closed: B1-B5 and R2-1..R2-4 all verified shut. The reviewer
confirmed the corrected design empirically rather than by reading it — with the phase-1/2
cuts simulated, `router.ts`, `lifecycle.ts`, and `responses/core.ts` each reach **zero**
`src/lab/` modules, and none of them transitively reaches `server/index.ts`. The
composition root really is a leaf with respect to the protected set.

Two independent confirmations of the `080` correction:

- **Startup ordering.** Between `Bun.serve` (`index.ts:1638`) and `return server` (`:1752`)
  the only `await`s are at `:1679`, `:1690`, `:1691` — all inside the `server.stop`
  override closure. `startServer` is non-async (`:492`) and cannot yield. The synchronous
  subagent-fallback path therefore cannot observe an unregistered slot.
- **Loaded vs executed.** Lab modules do no import-time work: `lab/paths.ts:64`,
  `lab/digest.ts:13`, `lab/constants.ts:3` export only functions and constants;
  `ensureLabDirs` is called from inside function bodies (`automation/persistence.ts:212`),
  never at top level; the single module-level allocation is an empty `Map`
  (`subject/installation-salt.ts:8`). A static import in the composition root loads the
  graph but creates no directory, opens no SQLite handle, and starts no timer.

So the owner's guarantee holds exactly as stated: **a profile-less user executes no Lab
code.** What remains is the evaluation cost of ~69 modules for profile-less users, stated
plainly in `080` rather than hidden.

## R3-1 (Medium) — dry-run evaluates policies outside the activation gate

This is the concrete "guard passes while Lab executes" path.

`POST /api/routing-profiles/dry-run` calls `assembleCandidateEvidence`
(`routing-profile-routes.ts:362` → `:103`), with a static import of the assembler at
`:19`, entirely independent of `labActivationRequired`.

After phase 3 the assembler consults the provider slot. On an install started without
profiles the slot is null, so dry-run returns candidates with **no compatibility
evidence** — the operator's preview disagrees with what production does once Lab
activates. And the `080` behavioral assertion ("slots null, no scheduler timer") stays
true throughout, so the guard passes while the property it stands for is violated.

Narrow but reachable: dry-run requires a resolvable profile (`:350`), so it needs a
profile created at runtime on a process started profile-less — exactly the Q3 case.

**Amendment.** Two calls, both synchronous:

1. The profile-mutation handler calls `activateLab` on the create path when
   `labActivationRequired` becomes true (already proposed in `080:101-104`).
2. The dry-run branch calls `activateLab` before assembling evidence when
   `labActivationRequired(config, configDir)` is true.

Phase 4's behavioral assertion is extended: on a genuinely profile-less config, a dry-run
request must register no slot. That closes the loophole where an untested endpoint
satisfies the guard.

## R3-2 (Low) — runtime activation must resolve `configDir` like startup does

Startup reads `getConfigDir()` (`index.ts:1738`); the automation handler reads it again
(`lab-automation-routes.ts:79`); the profile handler reads none. `080` removed the
per-config reconcile machinery that had made the intent explicit, while the orchestrator
remains genuinely per-`configDir` (`orchestrator.ts:80`).

Not a live defect in a single-server process, but unspecified.

**Amendment.** State it: runtime activation resolves `configDir` exactly as the startup
block does, and `activateLab` stays idempotent per `configDir` key.

The reviewer confirms Q3's other two cases are already correct — automation-enabled with
zero profiles works because `labActivationRequired` is a disjunction, and it is now
evaluated only at startup and on profile creation, so R2-4 cannot resurface.

## Reviewer conduct note (recorded, not buried)

To disprove `070` A1 the reviewer started a real server against the live config, which ran
the model-rename startup migration and rewrote `~/.opencodex/config.json`. The reviewer
disclosed this unprompted and precisely.

Assessed, not just accepted: the migration is the ordinary `#1610` path that any `ocx start`
applies, retiring `gemini-3.6-flash*` ids in favour of `gemini-3.7-flash`
(`providers/model-rename-migration.ts:70-75`, `providers/antigravity-models.ts:15`). It is
idempotent, takes no backup by design because it only rewrites ids the file still names
(`model-rename-startup.ts:10-18`), and the legacy keys survive in
`contextWindowOverrides`. The file is user data outside the repository; the working tree is
unaffected. **Left as-is** — reverting would re-introduce retired model ids, and the change
is one the user's own next `ocx start` would make.

The correct instruction was missing from my dispatch packet, so this is a packet defect on
my side. Future read-only probes that start a server must set an isolated `configDir`. That
is now stated in phase 4's test guidance, since the same trap applies to the boundary tests.

## Status

| Criterion | State |
|---|---|
| 1 — no static/transitive Lab import in the three protected files | provable |
| 2 — profile-less request executes no Lab code | provable |
| 3 — routing-profile installs keep evidence + passive signals | satisfied; window gone |
| 7 — Lab registered before the first request | well-formed, asserted by the startup invariant |

Round-1 B9 (research/roadmap document split) remains deferred by agreement — documentation
hygiene, not a correctness item.

**A-gate exit:** near-pass. Both remaining findings are folded into phases 3 and 4 above as
concrete amendments; no High-severity blocker survives.
