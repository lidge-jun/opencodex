## ADDED Requirements

### Requirement: Isolated alternate-account recovery canary

The repository SHALL provide a deterministic Bun test that uses only task-owned temporary state and a mocked outbound transport to exercise a Codex Pool Responses request whose first synthetic account receives a pre-stream quota failure and whose alternate synthetic account succeeds.

#### Scenario: Quota rejection recovers through one alternate account

- **WHEN** a synthetic Pool request receives a pre-stream 429 from its initially selected account
- **THEN** the canary SHALL verify exactly one retry using a different synthetic account and a successful client-facing response

#### Scenario: Canary does not require external credentials or traffic

- **WHEN** the canary executes
- **THEN** it SHALL not access real provider credentials, contact a non-localhost upstream, or modify a persistent OpenCodex or Codex home

#### Scenario: Canary cleanup contains process-global work

- **WHEN** the canary server exits
- **THEN** the test SHALL await lifecycle shutdown and reset only test-owned watchdog, sweeper, startup-prime, and retained-memory state before restoring its environment or deleting temporary homes; it SHALL also keep the request-path lazy quota prime dormant

### Requirement: Bounded Codex thread-affinity observation

The Codex routing module SHALL expose a test-only affinity entry count so the isolated canary can assert the documented bound without serializing account identities or adding a runtime management endpoint.

#### Scenario: Distinct synthetic threads remain bounded

- **WHEN** the canary resolves more distinct synthetic thread ids than the affinity capacity
- **THEN** the observed entry count SHALL equal `CODEX_THREAD_AFFINITY_MAX_ENTRIES`, a recent affinity SHALL remain sticky, and an evicted oldest thread SHALL be rebound after the active selection changes

#### Scenario: Test observation contains no account identifiers

- **WHEN** a test reads the affinity observation
- **THEN** it SHALL receive only a numeric count and no thread id, account id, credential, or quota value
