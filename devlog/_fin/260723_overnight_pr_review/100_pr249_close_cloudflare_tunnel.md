# 100 — PR #249: feat: Named Cloudflare Tunnel default public API path

- **Author:** Aiweline
- **Branch:** feature/cloudflare-tunnel → dev
- **CI:** FAIL (6/7 checks fail: ubuntu, windows, macos, npm-global x3)
- **Decision:** CLOSE with comment

## Why Close

1. CI fails on all 3 platforms — not just flaky, structurally broken.
2. Massive scope: 2268 lines added across 20 files (new server module, GUI, i18n x5, 4 test files).
3. Introduces `cloudflared` as a runtime dependency managed by opencodex.
4. Security surface: spawns external process, manages tunnel tokens.

## What It Does

- Adds Cloudflare Tunnel integration: Quick Tunnel (trycloudflare.com) and Named Tunnel.
- GUI: tunnel status/toggle in API Access page.
- Server: `src/server/cloudflare-tunnel.ts` (582 lines) — process management, health checks.
- i18n: all 5 languages updated.
- Data-plane-only ingress: /v1/* with API key, blocks /api/*.

## Recommendation

- Close with a detailed comment acknowledging the feature value.
- The concept is interesting for remote access use cases.
- Suggest author: fix CI, reduce scope (server module only first), retarget as smaller PRs.
- No rebuild-on-dev at this time — too large to cherry-pick.
