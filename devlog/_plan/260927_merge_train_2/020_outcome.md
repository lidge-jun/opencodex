# Merge train round 2 — outcome and what stays open

Re-queried after 9E landed (`dev` `5744e7a19f`, 2026-09-27).

## Landed

| PR | What | `dev` |
|---|---|---|
| #5987 (9C) | #5968 #5966 #5933 #5952 #5942 #5943 plus fixes | `81aea0f043` |
| #5985 (9B) | #5969 #5944 #5938 #5935 #5939 #5951 (#5977 dropped) | `bf04176b67` |
| #5993 | kiro-pool-rank test reads its clock after recording the verdict | `177c647d9c` |
| #5984 (9A) | #5965 #5963 #5962 #5961 #5959 #5958 plus two test fixes | `8a26a79a99` |
| #5986 (9D) | owner #5926 #5928, #5911 (#5915 credited), #5978, plus sibling and pairing fixes | `6b2b66d194` |
| #5988 (10A) | #5949 (#5834 credited) #5884 #5934 #5829 #4663 #5431 (#5893 reverted) | `1972cdb99d` |
| #5997 | Windows cleanup in the sibling recycle test | `7d503b897f` |
| #5992 (10B) | #5954 (#5708 credited) #5919 #5896 #5147 #4740 plus lease, ACL and redirect fixes | `35f267d409` |
| #6012 | macOS plugin ACL trust accepts harmless ancestor ACEs | `2a3cfa5abe` |
| #5998 (9E) | owner #5970 #5973 #5972 #5971 #5974, #5990, plus link, routing and reaper fixes | `5744e7a19f` |

Closed as landed: every carried PR above. Closed as superseded: #5733 (#5947), #5976 (#5943), #5834 (#5949), #5915
(#5911). Issues closed after checking the fix on `dev`: #5880, #5940, #5096, #5948, #5913, #5501, #5833, #5881, #5877,
#5702, #5146.

## Still open, with reason

| PR | Reason |
|---|---|
| #5831 | Owner decision: may a two-window WHAM response release the 5h lock? |
| #5964 | Owner decision: accept losing genuine mid-prose MiMo tool calls? |
| #5956 | Owner decision: is a pause-only slice of #5649 acceptable? |
| #5995 (the reworked, closed #5980) | Owner decision: keyless access through the anonymous OpenCode identity. |
| #5800 | Owner decision: the Agent SDK harness policy and its new dependency. |
| #5912 | Owner decision: adopting a new provider with a native-app OAuth callback. |
| #5879 | Needs an ownership and retry redesign before carry. |
| #5977 | The status reader trusts an unauthenticated HTTP response; needs a server proof bound to the response. |
| #5893 | Bun fetch does not honor `*.local` or CIDR `NO_PROXY` entries; needs pattern translation and CIDR routing. |
| #5927 | Security blocker on the images pool path; the details are in scratch. |
| #5925 | Its CodeBuddy half landed in #5945; the direct-MCP half needs splitting and review. |
| #5953 | Overbroad summary-budget override. |
| #5539 | Folds `minimal` for OpenAI API-key providers. |
| #5497 | Conflicts plus config-surface work. |
| #5947 | 43-file client interception feature. |
| #5782 | Two feature lines, 11 conflicts. |
| #4222 | Experimental feature. |
| #4732, #4228, #4177, #3742, #3741, #3738, #3463, #5099, #5374, #4056 | Stale, feature-sized, inert or security-bound (triage lane report). |
| #6030, #6027, #6026, #6025, #6022, #6020, #6019, #6007, #6006, #6003 | Opened after this round's inventory, so no review, CI or security gate was run on them here; next round. #6019 (Ingwannu) tightens the ACL display-name check that #6012 introduced. |
| Contributor enhancement PRs that change `gui/` | Out of scope for this round. |

Also opened after the inventory: #6015, #6011 and #6010 (Ingwannu, test chores). They fall outside the bug and non-GUI
enhancement filters.

#5708 was closed by its author as superseded by #5954. Its backend is on `dev` with his credit; the provider-workspace
GUI controls it also carried are not, and remain possible follow-up scope.

Open issues whose fix is not on `dev` stay open; the issue lane's table lists each one with its evidence. #3376, #3377,
#4878 and #5853 are referenced by landed PRs but have no complete fix on `dev`.
