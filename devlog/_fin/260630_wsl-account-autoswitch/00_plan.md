# 260630 — WSL Account Auto-Switch Failure (MOC)

> Goal: fix "ChatGPT 멀티 계정 자동 전환이 WSL에서 안 됨" report. Investigation
> (2026-06-30) found this is **not purely a WSL bug** — it is a quota-state
> design gap made visible by WSL networking/filesystem differences, plus a
> thread-affinity gap and a drvfs error-misclassification risk.
>
> Branch base: `dev` (HEAD 937828f). orchestrate session: `wsl-autoswitch` (phase P).

## Symptom

WSL2 user reports automatic account switching never happens. Manual switch path
is fine; the *automatic* quota-driven rotation does not move off the active
account.

## Investigation surface (how we know)

Four parallel investigators, all read-only:

- GPT Pro (via `agbrowse web-ai`, web search on) — ranked WSL/Windows hypotheses.
- Explorer A (quota priming) — when/how quota is populated.
- Explorer B (config + thread affinity) — in-memory vs disk, affinity pinning.
- Explorer C (drvfs file ops) — lock/rename/chmod behavior and error routing.
- Tier-2 source-proof — Microsoft WSL docs, Bun proxy docs, Ubuntu time-sync,
  confirming which WSL claims are PROVEN vs UNCONFIRMED.

## Root-cause model (ranked)

| # | Root cause | Confidence | WSL-specific? |
| --- | --- | --- | --- |
| 1 | Quota-state deadlock: all pool accounts stay `unknown=100`, and auto-switch only moves to a **strictly lower** score, so `100 < 100` never fires. Quota is never primed at startup; WHAM usage fetch only runs from the dashboard. | High (0.82) | No — exposed by WSL |
| 2 | WSL2 networking/DNS/VPN/proxy blocks Bun `fetch` to `chatgpt.com`, so WHAM quota never populates even if the dashboard is opened. Bun honors `HTTP(S)_PROXY` only if present in the WSL process env. | Med (0.68) | Yes |
| 3 | Thread affinity pins a live thread to its first-bound account for a 24h sliding window; the affinity reuse branch returns **before** `applyQuotaAutoSwitch`, so crossing the threshold mid-session does not switch. | Med | No |
| 4 | drvfs `/mnt/c` error misclassification: a raw IO error from `openSync(...,"wx")` or `renameSync` during refresh is not a lock-timeout, so it falls through to `markAccountNeedsReauth`, permanently evicting the account from rotation until restart. | Low-Med (0.42) | Yes |
| 5 | Clock skew (sleep/resume) affecting cooldown/reset-at/lock-stale math. Documented historically; fixed by default in current WSL. | Low (0.25) | Yes |

## Ground-truth code anchors

- Strict `<` selection: src/codex-routing.ts `pickLowerUsageAccount` / `applyQuotaAutoSwitch`.
- Unknown sentinel `CODEX_UNKNOWN_USAGE_SCORE = 100`: src/codex-quota.ts.
- Quota write sites (headers hot path + WHAM dashboard only): src/server.ts, src/codex-auth-api.ts.
- Thread affinity reuse before auto-switch: src/codex-routing.ts `resolveCodexAccountForThreadDetailed`.
- Refresh lock + error class: src/codex-account-store.ts `withCodexRefreshFileLock`.
- Reauth classification fork: src/codex-auth-context.ts `shouldMarkAccountNeedsReauthForCodexAuthFailure`.
- Atomic write: src/config.ts `atomicWriteFile`.

## Tier-2 proven facts (source-backed)

- WSL defaults to NAT networking; mirrored mode targets IPv6/VPN compatibility. (MS WSL networking)
- `autoProxy=true` is needed for WSL to use Windows' HTTP proxy. (MS WSL networking)
- Bun `fetch` honors `$HTTP_PROXY`/`$HTTPS_PROXY` **if set in the WSL process env**, and supports per-call `proxy`. (Bun docs)
- `/mnt/c` is explicitly not recommended for Linux-side files; permissions are calculated/metadata-based, and `chmod` largely maps only to a read-only attribute by default. (MS WSL filesystems / file-permissions)
- The `O_EXCL`/unlink-lock unreliability on `/mnt/c` is **UNCONFIRMED** by MS docs — treat as engineering risk, gate behind local diagnostics, not as the top cause.
- WSL time-sync drift after resume is historical and fixed by default in current WSL. (Ubuntu time-sync)

## Work-phase map (each = one PABCD cycle, focused tests, atomic commit)

| Phase | Priority | Surface | Outcome |
| --- | --- | --- | --- |
| 00 | P0 | This plan + root-cause model | Scope frozen; phase stubs created |
| 10 | P0 | Quota-deadlock fix (routing) | All-unknown set can still rotate (round-robin / tie-break); regression tests |
| 20 | P0 | Quota priming | Startup/pre-route WHAM prime so candidates aren't stuck unknown; failure is diagnosable |
| 30 | P1 | WSL networking diagnostics | `ocx doctor`-style WHAM reachability + proxy/env report; actionable hints |
| 40 | P1 | Thread-affinity re-eval | Re-run auto-switch when the bound account crosses threshold, not only on error |
| 50 | P2 | drvfs hardening | Classify IO errors as transient (not reauth); warn when state dir is on `/mnt/c` |
| 90 | P0 | Final review | Independent review + full typecheck/test/privacy-scan evidence |

## Decisions still open (for jun)

- D1: When all candidates are unknown and active is over threshold, prefer (a) round-robin rotation, (b) least-recently-used, or (c) stay put but surface a loud "quota unknown" log. (Phase 10)
- D2: Should quota prime at startup for all pool accounts (cost: N WHAM calls on boot), or lazily on first route when the active is unknown? (Phase 20)
- D3: drvfs `/mnt/c` state dir — hard warn only, or refuse unless `OPENCODEX_ALLOW_DRVFS=1`? (Phase 50)

## Status

- 2026-06-30: P phase. Plan + root-cause model frozen. Phase stubs to be drafted (subagent fan-out). No code changed yet.

## Artifacts (this folder)

- `10_phase1_quota-deadlock-routing.md`
- `20_phase2_quota-priming.md`
- `30_phase3_wsl-network-diagnostics.md`
- `40_phase4_thread-affinity-reeval.md`
- `50_phase5_drvfs-hardening.md`
- `90_final-review.md`
