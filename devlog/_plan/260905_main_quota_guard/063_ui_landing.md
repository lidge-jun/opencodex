# UI landing and final Reserve base

PR3560 was admin-squashed into dev at `a53775103e764e6644d41ec47d2e3e753e9f4613` on 2026-09-05T06:04:13Z. Its final source head was `fe9ed3b1b5c122cc0258fa85b077d6776aea0ab2`; fresh fetch plus `git merge-base --is-ancestor` verified integration ancestry.

Exact-head Cross-platform CI33947155910 attempt1 passed before merge, including four Linux shards, both macOS shards, all selected package/keyring jobs and aggregate ci. The only suite/control skips were event-unselected Windows shards and macOS control. Every governing PR check passed, including target run33947154134. Duplicate target job101256171050 was cancelled by the documented PR-comment concurrency rule for a higher-priority waiting request; its cancelled result was not counted as success. The resolved focus finding and prior reviewed UI behavior remain unchanged. Parent repair/landing, dev retarget and fresh-CI conditions from the maintainer review were satisfied; the owner-authorized admin path was used without dismissing reviews.

Reserve PR3578 now targets dev. Its ten own commits were rebased from the exact merged UI head onto `a53775103`, producing `c09e73760b7bf80fcb3d78ff46e3e5bf5e273505` before this documentation commit. All ten range-diff entries are unchanged. The forthcoming published head requires fresh exact-head CI and review closure before landing.

Eleven synthetic UI screenshots remain in022_ui_evidence. No local suites, deployment or live account modifications occurred. The mixed-plan pool request remains the next audited work unit after the original delivery closes, not part of this Reserve rebase.
