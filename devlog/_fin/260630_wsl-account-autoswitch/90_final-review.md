# 90 - Final review

Purpose: close the WSL account auto-switch plan with independent review and
concrete typecheck/test/privacy evidence. This is a skeleton to fill once
phases 10-50 land; do not pre-fill results.

## Independent-review stance

- Reviewer is a read-only sub-agent that did NOT write the phase code.
- Stance is code-review first: bugs, behavioral regressions, missing tests, and
  blast radius lead the writeup; summaries come after findings.
- Each finding is grounded in `file:line`. PASS/FAIL is per phase, with a
  re-verification pass recorded after any FAIL is addressed.
- Reviewer confirms the change actually fixes the mapped root cause, not just
  that tests are green.

## Full verification gate (run at the very end)

- [ ] `bun x tsc --noEmit` -> exit 0, no diagnostics.
- [ ] `bun test` -> record pass/fail/expect counts; 0 fail required.
- [ ] `bun run privacy:scan` -> clean (no secret/PII leakage introduced by
      diagnostics added in phases 20/30/50).
- [ ] Focused regression bundle for the touched files re-run together (list the
      exact `tests/*.test.ts` once phases land).

## Regression matrix (root cause -> phase -> proving test)

Fill the test column with the concrete test name(s) as each phase lands.

| RC | Root cause (00_plan.md) | Phase | Proving test (fill in) |
| --- | --- | --- | --- |
| 1 | Quota-state deadlock: all-unknown `100 < 100` never fires; quota never primed | 10 | [ ] all-unknown pool still rotates / tie-break |
| 2 | WSL networking/DNS/VPN/proxy blocks WHAM fetch | 30 | [ ] doctor reports reachability + proxy/env hints |
| 3 | Thread affinity returns before `applyQuotaAutoSwitch`; mid-session threshold cross does not switch | 40 | [ ] bound thread re-evaluates and switches on threshold cross |
| 4 | drvfs raw IO error misclassified as needs-reauth, evicts account | 50 | [ ] fs throw during refresh keeps account in pool; revoked still evicts |
| 5 | Clock skew (sleep/resume) affecting cooldown/reset/lock-stale math | none (see out-of-scope) | n/a |

Note: RC2 also depends on phase 10/20 priming actually being reachable; the
doctor output is diagnostic, not a behavioral switch test.

## Out of scope (explicit)

- RC5 clock skew: WSL time-sync drift after resume is historical and fixed by
  default in current WSL (Tier-2 source-backed). Expected no-op; do not add
  speculative clock-skew handling to cooldown/reset/lock-stale math unless a
  phase surfaces a real reproduction.
- Deep VPN / Hyper-V / mirrored-networking host configuration. Phase 30 reports
  reachability and proxy/env state; it does not reconfigure the user's network,
  WSL `.wslconfig`, or Windows proxy.
- drvfs lock-mechanism redesign. Phase 50 reclassifies errors and warns; it does
  not replace `openSync(wx)` locking (the O_EXCL unreliability is UNCONFIRMED).
- Persisting the needs-reauth set or adding TTL expiry.
- Kiro adapter / Kiro OAuth parity (owned separately, as in prior plans).

## Release note stub (fill when phases land)

- Fixed: ChatGPT multi-account auto-switch could stall on WSL2 when all pool
  accounts had unknown quota (RC1) ...
- Added: quota priming so candidates are not stuck unknown (RC1/phase 20) ...
- Added: `ocx doctor`-style WHAM reachability + proxy/env diagnostics for WSL
  networking (RC2) ...
- Fixed: mid-session threshold crossings now re-evaluate thread-affinity bound
  accounts (RC3) ...
- Fixed: transient filesystem errors during token refresh no longer drop a pool
  account from rotation; warn when the state dir is on a `/mnt/...` Windows mount
  (RC4) ...

## Completion decision

(to be filled: confirm phases 10-50 implemented, committed, independently
reviewed, and covered by the regression bundle; state any residual risk and any
intentionally deferred item.)
