# Track 2 protocol delivery

- Archetype: satisfy-spec repair with an evidence-backed defer outcome.
- Trigger: maintainer assigns track 2 and authorizes ordinary PR chains, no-verify pushes, final remote CI first, and admin integration.
- Goal: preserve Chat JSON/SSE semantics (#3770/#3779), refusal (#3767), supported custom efforts (#3775), hosted-search execution (#3761), and opt-in Claude compatibility (#3730), or document a concrete unresolved blocker.
- Non-goals: native GitHub stacks, local tests/typechecks/builds/install, other tracks, service/config changes outside repository, releases/deployments. Do not weaken CI definitions or treat skipped tests as passing.
- Baseline: dev 7d8523eed75a67f7a4a15b533744fcd0e6059aa8, including #3771.
- Verifier: existing workflow_dispatch ci.yml lane=all at the final integration head; lower diagnostic CI only if final fails. Commands are NOT RUN locally by explicit instruction. Read workflow definitions to establish target coverage. Independent source review precedes remote execution.
- Stop: feasible reviewed changes land through dev PRs with verification evidence; other items receive explicit evidence-backed dispositions. No completion claims for deferred issues.
- Artifact: this numbered unit; private security analysis and raw tool results only in /tmp/cf54-*.
- Expected outcomes: landed, already implemented, deferred with concrete blocker, or blocked by external CI/service state.
- Escalation: parent reclaims failed worker slices; never widen auth/routing trust or retry provider work to make a test pass. No user budget was set.

## Roadmap

1. Docs-only roadmap and independent audit.
2. 010: JSON Responses to streaming Chat semantics; carry #3779 with attribution.
3. 020: refusal across live SSE, final snapshots, JSON, collection, and JSON-to-SSE.
4. 030: custom effort provenance/capability repair after independent Codex source check.
5. 040: hosted-search path feasibility, then scoped execution/continuation repair or defer.
6. 050: opt-in Claude compatibility gate after independent official-contract/security audit or defer.
7. 060: final source audit, remote CI, ordinary PR-chain integration and exact dev ancestry proof.

The semantic stack is JSON fallback -> refusal. Catalog and Claude slices have disjoint implementation owners and join the integration tip. Source refs are ordinary branches, not registered native stacks. Do not run a separate lower-level CI before the final integration failure.

## Process availability

Installed cxc skills resolved to 0.2.20 because the named 0.2.19 directory is absent. No SessionStart binding was injected into this task; SESSION-IDENTITY-01 forbids borrowing a prior/transcript id. Therefore no FSM activation is claimed. Durable P/A/B/C/D artifacts and the native active goal still track authorized work; tests remain pending until remote evidence exists.
