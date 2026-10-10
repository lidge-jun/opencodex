# Architect reflection — remaining gaps and final dispositions

Verdict: **ALIGNED**, with six residual gaps. All six are folded below; the plan's
file-change map and accept criteria in `000_plan.md` are amended accordingly.

1. **Abort path for redemption (surviving edge of D3a).** After the 30 s bound
   aborts, the outcome is unknown and the old code left a live "Use coupon"
   button. Folded: an aborted redemption puts the dialog into an explicit unknown
   state, re-reads the coupon list, and does not offer a same-id retry. The user
   sees the refreshed count and decides from it.
2. **`byExpiry` NaN ordering.** Folded: an unparsable `validityEnd` sorts last
   instead of collapsing the comparator to `0`, so a malformed timestamp cannot
   make a confidently wrong coupon the "nearest expiry".
3. **Conditional `tokenId`.** Folded: the dialog refuses to redeem when it holds
   no coupon id rather than posting without one and letting the server's
   upstream-order default apply. This makes the D6a rebuttal an enforced invariant.
4. **C-activation coverage for the folded defects.** Folded into the verifier
   contract: the GUI test must cover a replayed *failure* (200 with
   `code: "redeem_failed"`, `replayed: true`), a 409 identity mismatch clearing the
   held id, a 503 `capacity`, and a two-account roster where one row's retry must
   not strand the other row's read.
5. **Accept criteria did not fail on regression.** Folded: criteria 7-10 below.
6. **Bookkeeping.** The key set is 31, not 29. No read cache or TTL is specified:
   a panel remount re-reads, bounded by three concurrent reads and by the fact
   that only the open provider's accounts are in the read set. That is accepted
   cost, recorded rather than hidden.

## Amended accept criteria (extends 000_plan.md)

7. A replayed redemption whose `code` is not `redeemed` is reported as a failure,
   never as a completed reset.
8. A 409 identity mismatch clears the held operation id so the next attempt is not
   guaranteed to repeat it.
9. A 503 `capacity` reports its own retryable message, and no failure message
   claims a coupon was not consumed unless that is known.
10. One row's retry or redemption never cancels another row's in-flight read.

