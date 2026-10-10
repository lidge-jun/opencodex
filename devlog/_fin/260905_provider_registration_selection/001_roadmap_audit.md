# Roadmap lock

2026-09-05: independent audit reviewed 000, 010 and 020 against the actual source.
First verdict FAIL; accepted the pending-consumer, retained-recovery and stale
notice gaps. Refined the unconfirmed count assumption to the Models switch-row
inventory. Second verdict PASS, blocking_issues empty.

The first work phase is docs-only. No implementation or behavior-test pass is
claimed. Baseline direct TypeScript check and GUI build passed; GUI build emitted
the pre-existing large-chunk advisory. No local test suites were run.

Locked sequence: wp1 initial-selection state/policy/persistence and its regression
coverage, then wp2 localized GUI and CLI guidance plus rendered proof and final
delivery. Both implementation phases require independent review and remote CI.
No CI waiver is authorized for this unit.

Current source ownership and acceptance details are in 010/020. Later P phases
must recheck them against the tree before writing code.
