# 090 Outcome — 2.72.0 TokenLab release

Closed 2026-09-30 (KST).

| Criterion | Result |
|---|---|
| #6240 merged after full-lane CI on its exact head | Merged `1cd9d25517` from head `2b9295fea6`; lane=all 36591083341 success on attempt 2 (windows 7/9 and 8/9 reran once; neither loads a changed module) |
| npm and GitHub releases | `latest` 2.72.0 (gitHead `5ab6d52b2a`, main via #6246), `preview` 2.72.0-preview.20260930 (gitHead `4f9e3f0afb`, preview via #6245); release.yml 36603799783 / 36602348988; v2.72.0 has 25 assets and a signed latest.json |
| Payment and sponsor email | TokenLab's 1,200 USDT payment confirmed on-chain (2026-09-29 13:53 UTC). Reply sent from the maintainer mailbox through Aside exec at 2026-09-30 02:59 KST, confirming receipt, the 2.72.0 release, the placements and the term start |

Release content since 2.71.0: #6221 (TokenLab preset, by @hedging8563), #6240 (sponsor placement,
CLI sponsor pinning, final sponsor copy and referral link). #6243 moved `dev` to 2.73.0 after the
candidate was pinned and is not part of 2.72.0.

Per the agreement, the three-month sponsorship term starts with the 2.72.0 npm release
(2026-09-29 17:45 UTC, 2026-09-30 KST).

Open items, outside this unit:
- DocuSign completion is not confirmed from the maintainer mailbox; TokenLab reports signing. Envelope
  status goes to the sender account.
- TokenLab's Responses-first preset proposal (`X-TokenLab-Delivery-Policy`) needs its own PR and evidence.
- TokenLab offered a USD 20 API credit for integration testing; redeeming it is the maintainer's choice.
- The installed proxy and desktop app on this machine were not updated.
