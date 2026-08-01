# 003 — PR #73 dev cherry-pick + hardening (DONE)

- 07afa28 cherry-pick (author Wibias preserved), conflict: discovery.ts tail only — kept 260709
  refresh (glm-5.2 1M, kimi-k2.7-code), took PR effort tiers (glm-5.2 high/max).
- 949e08d follow-ups: httpStatusFromTerminalError re-export (suite caught import-time failure —
  same bug class Kuhn flagged on #74); NGHTTP2_CANCEL benign only when expectedClose (3 sites);
  live filter activation restricted to effort suffixes (+3 regression assertions).
- Gates: tsc 0; bun test 1673/0. dev pushed to 949e08d. PR #73 closed with credit comment;
  issue #72 follow-up posted.
- cxc-search (Mendel, Tier-2 verified): 9+ rival cursor bridges catalogued (opencode-cursor 236★,
  composer-api 251★, pi-cursor-sdk 217★, cursor-api-proxy 131★...); resource_exhausted occurs in
  the OFFICIAL IDE with credits remaining (Cursor forum 2025-12~2026-03, staff: server-side);
  bridge-vs-IDE throttle hypothesis weakly supported, unproven; peer mitigations: IDE/CLI header
  mimicry, x-cursor-checksum (ccs#517 "Jyh cipher"), CLI/SDK path, model pinning, pacing.
- Follow-up ideas: compare our fingerprint headers vs eisbaw/cursor_api_demo profile
  (x-cursor-checksum absent in ours? check request-builder), consider 5-tier effort advertising.
