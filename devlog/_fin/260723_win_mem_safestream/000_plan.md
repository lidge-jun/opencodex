# 000 — 260723_win_mem_safestream: Plan

Session: 019f8f1c-3f9e-7b20-9467-6ab9fee1a831 · Branch: codex/260723-win-mem-safestream (from e3a059c6, dev lineage)
Goalplan: production-level-mitigation-of-windows-ram-leak · Loop: HOTL docs-first (LOOP-DOCS-FIRST-01)

## Objective

Mitigate the Windows RAM blow-up in #314 (one Bun process → ~23 GB RSS) at the app
level while the real fixes ride upstream Bun. Upstream state (live-verified
2026-07-23, see 001 for links):

- fetch-backpressure #28035: CLOSED as fixed by PR #29831 ("couple fetch()
  receive backpressure to JS body consumption"); which release carries it is
  UNVERIFIED — treat bundled 1.3.14 as not carrying it until proven.
- async-pull cancel segfault #32111: fix PR #32120 merged 2026-06-21; NOT
  assumed in 1.3.14. Note: the crash reproduced on macOS/Linux ARM64 too — it
  is NOT a win32-only bug; our code merely routes around it on win32 today.
- node:net handle leak: PR #31654 is still OPEN (it is a PR, not an issue;
  reviewer's "fixed in 1.2.23" suspicion was checked and rejected).

Safe-first design locked by 3 interview contradiction-scan rounds
(`.codexclaw/plan/interview-win-bun-leak.md`, findings H1-H5 / P1-P6 / F1-F5):

- tee()+background inspection stays DEFAULT on win32 + Bun 1.3.14 (known-crash
  runtime). No-tee and client-paced inline relays were REJECTED: they break the
  multi-turn passthrough context cache (core.ts:899), account-health recording
  (terminalBodyWillRecord → recordCodexUpstreamOutcome), #44 post-cancel
  late-terminal semantics, and turn lifecycle (registerTurn/unregisterTurn).
- NEW eager bounded single-reader relay (bounded client queue + post-cancel
  bounded discard-drain, full inspection side-effect parity) becomes win32
  default ONLY on runtimes carrying the #32111 fix — dormant on bundled 1.3.14,
  reachable via OPENCODEX_BUN_PATH or file-backed opt-in.
- Ops relief that works TODAY on 1.3.14: RSS watchdog (warn-only) + authed
  management memory endpoint + `ocx doctor` memory/runtime section (service
  process identity, RSS-first, heapStats discriminator) + docs-site
  troubleshooting page with honest labels.

## Loop-spec

- Loop archetype: verifier-defined (spec-satisfaction). No divergence.
- Write scope: src/, tests/, docs-site/, devlog/ in this worktree; local commits
  only. Out-of-scope: Bun bundle bump (package.json:59), gui/, release, push/PR/
  issue writes, dev branch, other worktrees.
- Verifier: bun run typecheck · bun run test · bun run privacy:scan · focused
  regressions per phase · Sol reviewer VERDICT at each A.
- Stop: all 7 goalplan criteria met with capturedEvidence. Escalation:
  NEEDS_HUMAN if a phase forces bundle bump or security-boundary change.
- Budget/bounds: this worktree only, no external state changes, session-bounded.
- Honesty bound: real Windows RSS improvement is labeled "awaiting Windows user
  verification" — never claimed from macOS.

## Work-phase map (one phase = one full PABCD cycle)

| WP | Doc | Slice | Depends on |
|----|-----|-------|------------|
| WP1 | 010 | Runtime gate module src/lib/bun-stream-caps.ts (known-bad/min-fixed #32111 semantics, version-injectable) + stream-mode setting persisted in config.json (debug-settings.ts is in-memory+env ONLY — cited just for override-precedence shape; audit blocker 1) | — |
| WP2 | 020 | Eager bounded single-reader relay src/server/relay-eager.ts + core.ts wiring behind gate + passthrough-abort invariant/mirror-comment lockstep | WP1 |
| WP3 | 030 | RSS watchdog (warn-only sampler; threshold-restart explicitly DEFERRED per F4) + authed management endpoint /api/system/memory | WP1 (reports gate/runtime state; no core.ts dependency — audit downgraded the WP2 edge to soft serialization) |
| WP4 | 040 | ocx doctor memory/runtime section querying service endpoint with service token; OPENCODEX_BUN_PATH guidance | WP3 |
| WP5 | 050 | docs-site troubleshooting page + final invariant sweep + full gates | WP1-WP4 |

## Accept criteria

Audit round 1 (Sol reviewer, GO-WITH-FIXES blockers=3) dispositions:
1. FOLDED — WP1 flag persistence moved to config.json (phantom file-backed
   debug-settings pattern corrected).
2. FOLDED — #28035 wording corrected to "fixed by #29831, release inclusion
   unverified"; gate semantics anchor on #32111 only.
3. REBUTTED with evidence — #31654 is an open PR (robobun, main target); the
   1.2.23 blog entry is a different fix. "Still open" stands.
Low residuals: 020 doc must state why NEW relay-eager.ts vs extending
relaySseWithHeartbeat (P3); 050 doc must state threshold-restart deferral (F4).

- 001 research doc captures: passthrough branch map (core.ts:1020-1075),
  inspection side-effect inventory (core.ts:1030-1058), service env baking
  (service.ts:231/369/645, winsw.ts:94), doctor introspection gaps (doctor.ts:235,
  /healthz index.ts:239), crash-guard benign shapes, upstream Bun issue matrix.
- 010-050 written to diff-level (exact paths, NEW/MODIFY, before/after diffs,
  activation scenario per gated branch — C-ACTIVATION-GROUNDING-01).
- Goalplan workPhases refined 1:1 onto decade docs at D (roadmap lock).
- Unit committed with git add -f (devlog gitignored).
