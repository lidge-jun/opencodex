# 100 — Stabilization round 2 (research + implementation loop)

Continuation of the 090 verdict. T01/T03/T05 landed (#2320/#2321/#2322). This
round re-inventories what REMAINS transferable from senpi and
yelixir-dev/cursor-ai-proxy-bridge (and any other public Cursor bridge found
during the swarm), locks a new decade-doc roadmap (110+), then implements the
top candidates as separate cycles, each pushed to dev.

## Inputs

- origin/dev head at research time: `525568652` (weighted credential router, unwired).
- Selected remaining 090 verdict candidates: T02 (conversation rotation), T04
  (heartbeat stall), T06 (maxMode), T07 (OAuth poll fail-fast), T09 (cacheRead
  clamp), T24 (EOF-without-turnEnded fold into T03). Unlanded ADAPT rows T08
  (per-exec heartbeat — conditional on long native-exec staying enabled;
  default off, so deferred unless research contradicts) and T10 (dedicated
  proto unit prerequisite) are dispositioned in 190, not silently dropped.
- New-in-dev artifacts needing follow-up regardless of senpi: #2334
  CursorCredentialRouter is dead code (only tests import it); cursorH2Pool has
  no shutdown hook wiring.

## Security / ToS boundary (binding, per AGENTS.md)

- No pre-disclosure security material in this public devlog: if research
  surfaces an unfixed weakness (in Cursor, senpi, or OpenCodex), the analysis
  goes to `.tmp/` scratch and the devlog records only a neutral
  "handled out-of-band" pointer once resolved.
- Excluded transfer classes regardless of source value: leaked/private
  artifacts, credential extraction, auth bypass, Safe Storage / native-app
  patching (090 T20 stays UNSAFE), live account mutation.
- ToS/product-policy questions (e.g. new endpoints whose use may be
  policy-sensitive) are NEEDS_HUMAN, not merely "needs live probe".
- Reference clones live in gitignored scratch (`.tmp/chase/`), matching the
  `devlog/_chase/` license rule: third-party source never enters this
  repository's history.

## Research lanes (Luna swarm, candidates only — main agent proves)

1. senpi delta since a5eed44536f3 (commits/releases): new Cursor mechanisms.
2. senpi issues/PRs: open stability reports naming Cursor adapter defects.
3. yelixir-dev/cursor-ai-proxy-bridge full file inventory beyond
   h2-session-pool.ts / credentials.ts.
4. Other public Cursor-protocol bridges/proxies (GitHub sweep).
5. Cursor upstream changes (client version strings, api2 endpoints, protocol
   deprecations) that could break the adapter soon.
6. Local-clone deep read (main agent, .tmp/chase/senpi +
   .tmp/chase/cursor-ai-proxy-bridge): git history, issues-referenced diffs,
   and rationale not visible in file inventories.
7. OpenCodex's own Cursor issue/PR/test delta on GitHub since 090 lock, so
   locally-reported regressions rank alongside external candidates.

## Verification lane (sol-medium, read-only)

Audit backlog items (a)-(f) from the goal objective against origin/dev head
with file/line evidence: wired-or-dead status of #2334, shutdown hook absence,
T04/T06/T07/T24 current state in live-transport.ts / oauth/cursor.ts /
live-models.ts. Every NEW candidate from lanes 1-7 gets the same falsification
pass against the current tree before it may enter a decade doc — no candidate
is roadmapped on snippet evidence alone.

## Output contract

- Decade docs 110, 120, ... — one per implementation cycle, diff-level
  (target files, function names, test names, expected diff shape).
- 190_roadmap_lock.md — ranked order, rejected/deferred candidates with
  reasons, NEEDS_HUMAN items (live-probe-only) explicitly marked.
- No production code in this cycle.
- Gate: implementation cycles may not start until 190 is locked (the D of
  this docs-only cycle). "Pushed to dev" in the header describes those later
  cycles, each separately gated by typecheck + full tests; the docs-only
  cycle pushes documentation only.
