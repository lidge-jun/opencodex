# 090 — GO/NO-GO verdict

Head at close: 2b4ddf3b0 (docs-only merges above a012a460e; the last
code-bearing commit is the opus-fast catalog, PR #2346).

## Verdict: GO (promotion-ready dev)

## Evidence

- **CI**: Cross-platform CI completed success on a012a460e (last code head)
  and on 8f3ac5fe9 before it. Subsequent commits are devlog-only and skip CI
  by path filter; no code differs between a012a460e and this head
  (verify: git diff a012a460e..HEAD --stat -- ':!devlog').
- **Full suite**: 14264 pass / 10 skip / 0 fail (897 files) at 67b5fa019
  content (code-identical to head); bun x tsc --noEmit clean.
- **Regression audit**: 6 lanes over the 002 matrix (109 commits, all
  assigned) — ZERO P0/P1. Lane reports in 010.
- **Security review (GO gate)**: L3 file:line confirmation — deploy-key
  path env-only (release.ts:244), fixed-string rejection errors, all 16
  workflows SHA-pinned, release.yml permissions {} + OIDC scoped to publish
  job. Matrix + lane verdicts: pass.
- **privacy:scan**: green at every docs close in this loop.
- **Docs-sync**: catalog/vision/quota changes carry devlog units; locale
  parity for cost labels verified in L4 (9 locales typed-complete).

## Open items (not blockers, tracked)

- P2: ~1MiB per-message pre-flight guard (L1, fix sketch in 010).
- P2: routed-vision GET display drift on post-write noVision edits (L4).
- P2 ops: deploy-key least-scope is host-side config (outside repo).
- NEEDS_HUMAN: #2334 CursorCredentialRouter wiring (product decision);
  unwired module confirmed zero runtime reach (L1).
- Deferred probes: T02 rotation (unreproduced), maxMode propagation (NOOP
  by 310 A/B), client-version bump (NOOP by 240).

## What this loop landed since v2.29.0 relevant to release notes

Opus Fast families with verified tiers (#2346), #2305 text-marker fix
(#2341), bare-RE size prior (#2342), T04 stream-health watchdog (#2337),
OAuth fail-fast + H2 pool shutdown (#2338), plus the senpi round-2/3 and
readiness research units.

Promotion itself is a maintainer action (dev -> preview/main per
MAINTAINERS.md); this verdict only certifies dev's state.
