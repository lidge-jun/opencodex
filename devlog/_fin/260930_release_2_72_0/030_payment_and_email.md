# 030 — Payment check and sponsor email (wp4)

1. Aside exec, read-only, WORKS inbox: TokenLab messages since 2026-09-29 18:00 KST (payment
   confirmation, transaction hash, amount), DocuSign completion status. Where a transaction hash is
   given, confirm it read-only on the public chain explorer against the recipient addresses in the
   agreement (1,200 USDT, TRC-20 or ERC-20).
2. Only after npm `latest` reads 2.72.0 (the term starts at that release), Aside exec replies in the TokenLab thread from   the maintainer mailbox, politely: payment received (only if confirmed), #6221/#6240 merged, released in
   opencodex 2.72.0 (npm `@bitkyc08/opencodex`, release link), the 3-month term starts on that
   release date per the agreement, README/picker placement live, the Responses-first proposal will be
   evaluated separately. No attachments, no other recipients.
3. Record 090_outcome.md; move this unit and `260929_tokenlab_sponsor` to `devlog/_fin/` through a
   docs PR to dev.

Wallet addresses and transaction hashes stay out of the repository; the outcome records only that
payment was confirmed and when.

## Findings (2026-09-30, before release)

- WORKS inbox (Aside exec, read-only): Vincent wrote on 2026-09-29 23:08 KST that he signed the
  agreement and paid 1,200 USDT on TRC-20, with a transaction hash, and sent final sponsor copy: a
  longer English blurb, a Chinese blurb, and `https://tokenlab.sh/r/OPENCODEX` as the README and
  picker link. A 23:13 message offers a USD 20 API-credit code for integration testing.
- On-chain (Tronscan, read-only): the hash is a confirmed, successful transfer on the official
  USDT contract of exactly 1,200.000000 USDT to the agreement's TRC-20 address, at 2026-09-29
  13:53 UTC; not flagged as risky.
- DocuSign: the only DocuSign mail in WORKS is the 21:08 sender-verification notice. No completion  notice reached the maintainer mailbox; status notices go to the envelope sender's address, which this
  check did not cover. Signature completion stays unverified here.
- Consequence for 010: #6240 takes the final copy and referral link (`2b9295fea6`) before the
  regression gate; the earlier `lane=all` run on `21cddd35c9` was cancelled.
