# 000 — dev release readiness (main..dev regression audit)

origin/main is v2.29.0 (231e622be); origin/dev is 146 commits ahead
(1af7a1e26 at planning time). Goal: a dev head a maintainer can promote —
every subsystem delta audited for regressions, P0/P1s fixed with tests, full
gates green, honest GO/NO-GO.

## Scope of the delta (inventory in 001)

Major landings since main: SelectedImage native vision (#1742), Bun 1.4
stable bump + canary retirement, model-catalog refresh (Ox Alpha, DeepSeek
vision preview), release deploy-key push path (#2290), Windows restart
helper (#2293), senpi T01/T03/T05 (#2320/#2321/#2322), clean Connect
terminal (#2307), Auto [Tool Result] echo fix (#2318), H2 discovery pool
(#2332), credential router module (#2334, unwired), Z.AI quota (#2028), Pi
route sep fix (#2272), xai web-search normalize (#2312), merge-train units
(#2281 prompt_cache_key, #2270 custom-tool passthrough, #2289 docs locales,
#2296 subagent quota scope, #2294 release host hardening), T04 watchdog
(#2337), T07+shutdown (#2338), #2305 text-marker fix (#2341), bare-RE size
prior (#2342), round-2/3 devlog units.

Audit-round additions (first plan audit caught these missing): xAI Fast /
Priority Processing enablement + pricing (f87698c0d, 1d7d8177a, 057f93ea5,
#2072 train), Claude Code thought-signature call_id replay (6c748663e,
b31f3dbed), zero-byte coordinator remnant recovery (6d5f0cf2c, #2295),
desktop pool affinity / reconnect binding (0e5a43459, 72df5e0de), vision
routed-backend sidecar incl. loopback describe executor (21aec549d..
3ff19c33e, #2306/#2188), Windows service fail-closed installation state
(948fb5db1, 2df92a270). 001 must inventory from the ACTUAL log, not this
summary.

## Audit lanes (WP4, read-only subagents; ox-alpha preferred)

- L1 cursor adapter stack: vision, watchdog, terminal paths, error
  classification interplay (esp. #2342 size prior vs #2320 mapping vs T04
  watchdog error paths), request-builder text channel rebuild.
- L2 providers/registry + quota: catalog refresh, noVision curation, Z.AI
  windows, subagent quota scope, Ox Alpha entries.
- L3 release surface: deploy-key push path, scp-host rejection, release.ts
  vs workflows, version/tag consistency.
- L4 GUI/dashboard + management API: sidebar/star routes, models API
  parity with registry changes.
- L5 runtime/CI: Bun 1.4 bump fallout, workflow hardening test shape,
  Windows shard skips, test-queue behavior.
- L6 responses-core + client adapters: prompt_cache_key normalization
  (#2281), custom-tool passthrough (#2270), compaction body ordering /
  apply_patch lowering, Claude Code thought-signature replay, vision routed
  describe executor (server half of #2306), desktop pool affinity +
  zero-byte coordinator recovery.

Lane ownership rule: every commit in the 001 inventory is assigned to
exactly one lane in 002; unassigned commits fail the matrix (the first
audit found L1-L5 left responses-core uncovered).

## Write-scope contract (WP boundaries)

- WP1 (this cycle): docs-only. Probe TRANSCRIPT capture for the 210/290
  re-probe is allowed (read-only wire calls, redacted); no src/ edits.
- WP4: audit lanes are READ-ONLY subagents; ALL production fixes are
  main-agent edits, each with a regression test, each its own commit.
- Promotion itself is out of scope (maintainer decision).

## 210/290 correction contract (re-probe, not prose edit)

The "fast is callable" correction REPLACES the 210 entitlement
interpretation, so it must carry its own probe transcript (already captured
live this session: opus-4-8-high-fast succeeded both maxMode arms;
4-7-low-fast RE persists; bare 4-7-fast not_found) AND must reopen the 290
parity verdict: maxMode becomes provable, so 290's "unprovable on this plan
tier" row is amended to point at 310 (big-ctx A/B, billing approved) as the
deciding probe. 260's size-prior evidence stands, but its "entitlement
rejections share the shape" framing is softened to "non-overflow rejections
share the shape" since the tier-specific RE cause is now unknown.

Each lane returns: findings ranked P0(release blocker)/P1(fix before
promote)/P2(note), each with file:line, repro or verifying command, and a
confidence tag. Main agent falsifies P0/P1 before fixing (no snippet-only
fixes).

## Gates for GO

- bun run typecheck + full bun run test green (local or ssh lidge).
- bun run privacy:scan green; lint:gui if gui touched.
- Cross-platform CI green on final head.
- No open P0/P1 from any lane.
- Security-review sign-off recorded for release-surface changes (#2290,
  #2294, workflow edits) per MAINTAINERS.md — L3 lane must produce an
  explicit security-review section, and its findings gate GO.
- Docs-sync check: user-facing behavior changes (catalog refresh, quota,
  vision) verified against docs-site; locale parity spot-check beyond #2289.
- GO/NO-GO recorded in 090_go_verdict.md with evidence pointers.
