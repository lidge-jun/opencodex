# Bug-PR merge train after batch 6 — roadmap

Batch 6 landed as #5918 (`76b26a0881`). Open bug-labelled PRs re-queried at that head:
#5921, #5920, #5916, #5915, #5914, #5911, #5831, #5800, #5782, #5539, #5497, #4222.

## Decisions

| PR | Decision | Reason |
|---|---|---|
| #5914, #5882, #5849 | Close as landed | Carried in #5918. Close each with the same thank-you note earlier batches used (author credit, merge SHA, what changed on top). |
| #5916 (OAuth 429 send budget, #5880) | **Carry in batch 7 with a fix** | Real starvation bug and meaningful tests (4 cases red on `dev`, 86 focused pass). The independent security review failed on one point: the allowance scales with roster size with no fixed ceiling, so one request can fan out to 3 × N sends. Batch 7 adds a hard per-request ceiling that roster size cannot raise, then re-runs the security review. |
| #5497 (FastWire tier authority for relays) | Evaluate in batch 7 P | Bug-labelled, 357 lines, but it adds a provider config field and fails hygiene. Carry only if the failure is mechanical and the field is opt-in with no default change; otherwise leave it. |
| #5831 (main-lock recovery from two-window WHAM) | NEEDS_HUMAN | @Ingwannu holds approval for an owner decision on whether an omitted short window counts as proof no window exists. That is a policy call for the owner. |
| #5911, #5915 (Meta Muse OAuth continuations) | Leave | Two overlapping drafts on the same OAuth surface; #5911 is the maintainer's own active draft with an ADR. Consolidation is theirs to decide. |
| #5539 (effort wire mapper on unpinned routes) | Evaluate a narrowed carry in batch 7 P | The failure is real: strict upstreams answer `400 Invalid option` for `minimal`/`ultra` sent to a provider with no configured ladder. The native Chat half reverses tests that deliberately preserve the caller's spelling on unpinned routes, so it stays out. The Responses half (`mapRoutedResponsesReasoningEffort` for unconfigured providers) touches no existing assertion; carry it alone if focused tests show no other behavior change. |
| #5800 (Claude Agent SDK harness) | Leave | Adds a runtime dependency (`package.json`, `bun.lock`) and replaces a provider; needs dependency and maintainer security review beyond a bug train. |
| #5782 (Windows manual stops + bridge) | Leave | 9.3k lines, two feature lines, conflicting with `dev`. |
| #4222 (side-chat cache) | Leave | Experimental feature behind a setting, not a bug fix. |
| #5920, #5921 (desktop quota rows, widget reload) | Leave | Opened by the owner account minutes ago with their own devlog plan; another task owns them. |

## Next cycles

- wp3 — batch 7: `codex/bug-train-7` from `dev`; carry #5916 plus the ceiling fix; decide #5497 and the narrowed #5539 at P. Security review of the
  final diff by an independent reviewer before merge. Exact-head CI, then `--admin --match-head-commit`.
- Closing the loop: re-query open bug PRs and confirm every one left open has a row above.
