# Lane D release-train roadmap

Satisfy-spec HOTL for delegated recommendations #16 → #17 → #15 → #21 → #25.
Goal: independently audited manual dependent PRs ready for main-session integration.
Scope: Claude outbound, display-name dialog, usage costs/overlays/summary, usage GUI,
plus directly required CLI/API/tests/docs. i18n files are append-only shared per main's
2026-09-07 correction. No other lane-owned files; no merge/release/main/preview.
No local test/typecheck/build/install. Remote ci.yml lane=all at final top SHA is
sole product verifier. Local source and diff checks are not execution evidence.
No user token or wall-clock bound supplied. Use existing repo/GitHub authorization.
Stop: top-head green with reviewer verdicts and layer PR/SHA evidence; otherwise
record exact DEFER/BLOCKED reasons without claiming implementation passes.
Memory/evidence: this unit plus .tmp/lane-d for review drafts. Unpublished security
material stays in scratch. Reclaim failed delegated work after two distinct agents;
other-lane file collision requires main coordination.

## Dependency and publication map

| Phase | Item | Outcome | Branch |
|---|---|---|---|
| 0 | Roadmap | Lock all diff plans before code | first layer docs |
| 1 | #3719 slice | Legacy redacted-before-signed SSE/JSON parity | codex/260907-d1-thinking |
| 2 | receipt guard | Prevent new intent while recovery is pending | codex/260907-d2-receipt |
| 3 | #3817 | Exact account identity resolves provider overlays | codex/260907-d3-account-prices |
| 4 | #3667 | Price editor + CLI + authoritative explicit zero | codex/260907-d4-price-editor |
| 5 | #3379 slice / #2956 | Inclusive custom usage bounds + GUI | codex/260907-d5-usage-ranges |
| 6 | readiness | Fresh top CI, screenshots and implementation audits | top branch |

All lower subjects include [skip ci]; every push uses --no-verify. Native stack null.
Only phase 6 dispatches ci.yml lane=all; failures get Astra-high exact-log diagnosis,
fixes on their owning layer and rebase --update-refs cascade. Main alone merges.
#3719 and #3379 stay open. #2956 credit uses verified GitHub author identity.
