---
title: FAB-00 Event and Artifact Contracts
programme_id: OCAF
phase: FAB-00
date: 2026-08-03
---

# 060 -- Event and Artifact Contracts

## 1. Event envelope (protobuf -- repo already depends on `@bufbuild/protobuf`)

```proto
message EventEnvelope {
  string task_id = 1;
  uint64 sequence = 2;            // expected-sequence append
  string event_id = 3;            // ULID, unique
  string event_type = 4;
  string schema_version = 5;      // semver of payload schema
  int64  occurred_at = 6;         // unix ms
  string actor_type = 7;          // operator|adapter|harness|supervisor
  string actor_id = 8;
  string runtime_session_id = 9;
  bytes  payload = 10;            // type-specific protobuf message
  string previous_event_hash = 11;// sha256 hex of prior event canonical bytes
  string event_hash = 12;         // sha256 hex of THIS event (excl. event_hash)
  string raw_event_ref = 13;       // optional opaque native-event ref (never inlined)
}
```

**Decisions:**
- **Hash chain:** `event_hash = sha256(canonical_encoding(envelope minus event_hash))`; `previous_event_hash` links events -> tamper-evident. Append order enforced by expected `sequence` (reject if `sequence != max+1`).
- **Unknown `event_type`:** becomes `RawRuntimeEvent` -- adapters **must not guess** (sec.11 / `070`).
- **Schema evolution:** `schema_version` per event; readers tolerate unknown fields (protobuf default). Breaking changes bump major; new optional fields bump minor. Snapshots optimize projection without replacing event authority (sec.9.3).

## 2. Normalised event types

`SessionStarted`, `SessionResumed`, `RunStarted`, `RunProgress`, `UserMessage`, `AgentMessage`, `PlanUpdated`, `ReasoningSummary`, `ToolCallStarted`, `ToolCallCompleted`, `CommandProposed`, `CommandOutput`, `FileChangeProposed`, `FileChangeCompleted`, `ApprovalRequested`, `ApprovalResolved`, `ArtifactProduced`, `UsageUpdated`, `RunInterrupted`, `RunCompleted`, `RunFailed`, `SessionClosed`, `RawRuntimeEvent`.

Each carries `native_type`, `native_id`, `adapter_version`, `task`, `workspace`, `runtime_session`, optional `raw_event_ref`.

## 3. Artifact hashing / trust / retention / redaction

- `content_hash` = sha256, content-addressed storage (`040`).
- `trust_label` progression: `untrusted` (model/harness output) -> `sandbox` (ran in sandbox) -> `reviewed` (reviewer claim validated) -> `trusted`.
- **Redaction:** secret-pattern files excluded by default (sec.9.4); `redaction_state` recorded per artifact.
- **Retention:** bounded log excerpts auto-trimmed; never persisted by default: hidden reasoning, full terminal streams, provider secrets, OAuth tokens, env vars, raw prompts unrelated to continuity (sec.9.4).
- Missing artifact -> projection **fault**, not silent zero (mirrors opencodex `usage` invariant, `structure/05`).
