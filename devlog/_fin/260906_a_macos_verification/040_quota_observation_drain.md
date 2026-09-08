# Join asynchronous quota observations in fixtures

The final top's Windows1 verification (run33990109175, job101372136435) found a concrete fixture ordering defect. The first two quota-reset seam assertions saw no event after six microtasks and five milliseconds. A later test that used the existing explicit drain received those earlier scheduled and surprise events instead. The fixed sleep did not join cold lazy imports or the serialized observation chain, and fixture reset replaced the capture sink while old work was still pending.

This C1 test-only follow-up uses the existing flushQuotaObservationsForTests seam. Join observations before assertions; join before resetting a fixture or replacing its sink; and join asynchronous baseline forgetting after clearAccountQuota. Keep all event counts, reset kinds, account separation and no-notification assertions unchanged. Production quota logic and timing remain untouched.

Verify on the remote pinned runtime with the full focused file and typecheck. Delay the existing observation/forget chain in scratch to prove the new drain still passes and the old five-millisecond fixture fails. Restore every temporary mutation. Require independent review and final exact-head CI before integration. No local tests, builds or typechecks.
