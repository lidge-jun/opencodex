# Verification and delivery record

The fix uses a common committed selection for manual and automatic OAuth/API-key allocation.
A healthy manual selection has priority; reactive429 recovery remains enabled with poolOFF.
The physical request carries the binding of the adapter that built it. A stale binding is rebuilt,
and the new adapter and request cache remain authoritative for later retries and continuations.
Image/search loops share the request-specific executor. Codex routing/controller semantics are unchanged.

## Focused evidence

| Surface | Evidence |
| --- | --- |
| Generic OAuth | Parameterized xAI, Cursor, Kimi, Copilot, Antigravity, Nous, Kiro, Meta-Muse manual priority;36 focused checks passed |
| Store |13 failing regression cases before repair;36 store checks passed, including ABA/removal/recreation and refresh-only preservation |
| Actual dispatch | Copilot build/pacing races,413 follow-up, image/search pacing, and runTurn first-send coverage;31 checks passed with3 final boundary cases demonstrated RED→GREEN |
| API keys | Literal/env/keychain identity and newer manual selection; native Chat pacing revalidation; focused12+59 checks passed |
| Anthropic | Manual selection, guarded promotion, restart bootstrap, and always-on429; focused96-test group passed |
| Antigravity |20 OAuth401/project tests passed; a project-less account is refused before dispatch; every admitted request uses its account's project |
| Image/search | Image loops31, search61, timeout contract7 passed in separate processes |
| Management/relay |40 focused checks passed; authenticated invalidation stream, client cancellation, byte/subscriber bounds, expiration/revocation, and established SSE lifetime |
| Dashboard | Probe/passive quota hydration, stale selection guards and immediate event/reconnect behavior;38 roster+8 page checks passed |
| CI fixes | Upsert fixtures now persist like the real login flow and verify disk; GUI source binding check updated; React Doctor0.9.11 changed-file scan has0 errors/0 warnings |
| Static/privacy | Typecheck, privacy scan and diff check passed at integration checkpoints |

Counts identify each recorded check group; they overlap and must not be added into a unique-test total.
The user prohibited repository-wide local tests. An earlier full run was interrupted with exit130;
it is not completion evidence and was not repeated. CI runs asynchronously on PR3768.
At dd5aec571, all23 applicable CI checks passed, with2 intentional skips.

## Current browser proof

Aside opened a local synthetic fixture rendering the real Providers component and styles at1440×900.
The current GUI moved ChoiceA→ChoiceB from a selection event without advancing the poll clock;
upstream quota-read count stayed2→2. Both screenshots were inspected by main; no Korean clipping or
incorrect active indicator was observed. The fixture and owned browser tabs were stopped afterward.
The screenshots contain only synthetic account names and masked IDs.

- [Before](evidence/011_selection-before.png)
- [After](evidence/012_selection-after.png)

Independent C reviews identified and drove repairs for cached adapter reuse, sidecar dispatch,
credential refresh priority, account/project pairing, restart priority, stream lifetime and quota
hydration. All identified findings were implemented and the repaired cases were exercised.

## Delivery scope

One PR: https://github.com/lidge-jun/opencodex/pull/3768 . Every push uses`git push --no-verify` as
explicitly requested. The maintainer explicitly authorized an administrator merge. Remote merge
state and its final SHA are verified separately from local implementation proof; no runtime service
restart or real-account configuration mutation is part of this change.
