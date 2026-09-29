# 050 Release (wp4)

1. Isolated verification in a /private/tmp checkout of the exact head with fresh OPENCODEX_HOME / CODEX_HOME: typecheck, focused tests, test:changed, structure:check, privacy:scan, skill:surface:check, file-size ratchet.
2. One PR to dev from codex/gpt-6-1-sol-rollout with the template; wait for exact-head required CI; maintainer merge under MAINTAINERS.md dev policy.
3. Release train per scripts/release.ts and the 2.70.0 precedent: dev version pre-move PR, preview promotion PR, main promotion PR; push-event Cross-platform CI + Service lifecycle green on each promotion SHA; release.yml dispatched with expected-sha for preview then stable.
4. Verify GitHub release assets, npm `latest` / `preview` dist-tags, latest.json.
5. Close the unit: move to devlog/_fin with an outcome doc.

