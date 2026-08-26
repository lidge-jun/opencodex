# 100 — Promotion and rollback documentation

## Files

### NEW: devlog/_plan/260814_bun14-preview-dev/PROMOTION.md
Document the stable-day promotion sequence:
1. preview-dev -> dev (fast-forward)
2. dev -> preview (reset --hard)
3. npm preview publish with stable bun
4. Cross-platform CI + service lifecycle verify
5. dev -> main
6. npm latest publish

Rollback procedure:
- OPENCODEX_BUN_PATH=1.3.14 binary
- streamMode=legacy-tee
- Revert package.json bun to 1.3.14
- Keep split fresh-process CI jobs

