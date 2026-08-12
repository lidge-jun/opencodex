---
title: FAB-00 Task Domain Model
programme_id: OCAF
phase: FAB-00
date: 2026-08-03
---

# 040 -- Task Domain Model

Canonical abstraction: the **OpenCodex Task** (not a request, not a transcript). A transcript is one projection.

## 1. Task Core

```
Task
+ identity: task_id (ULID), schema_version (semver), created_at, created_by (operator|adapter), parent_task_id|fork_point
+ objective: title, goal, acceptance_criteria[] (each content-hashed), constraints[], unresolved_questions[]
+ repository: canonical_remote, repository_id, base_commit, target_branch, workspace_policy
+ policy_snapshot: sandbox, network, command_approval, file_approval, secrets_policy, allowed_runtimes[], allowed_providers[]
+ execution: current_owner (runtime_session_id|null), active_run, runtime_sessions[], workspaces[], handoffs[]
+ evidence: artifacts[], verification_runs[], decisions[], claims[]
+ provenance: events[], capability_manifests[], semantic_loss_ledgers[], security_observations[]
```

**Decisions:** `task_id` = ULID (sortable, unique). `acceptance_criteria` are content-hashed (sha256) so target acknowledgement can hash-compare. `policy_snapshot` is immutable per task; a policy change forks a new task version (`parent_task_id`).

## 2. RuntimeSession (required fields)

`runtime_session_id` (ULID), `task_id`, `adapter` + `adapter_version`, `harness` + `harness_version`, `native_session_id` (opaque, adapter-resolved), `native_state_ref` (opaque blob path, never inlined), `workspace_id`, `role` (primary|reviewer|verifier|observer), `capabilities_at_start` (manifest id), `policy_at_start` (snapshot id), `status`, `terminal_reason`.

**Decision (honesty invariant, sec.3.2):** `native_session_id` and `native_state_ref` are **opaque** to the Fabric -- adapters resolve them; the Fabric never fabricates native state. A runtime session records native references it can verify, nothing more.

## 3. Artifact (types + metadata)

Types: `patch`, `diff`, `commit`, `test_report`, `build_report`, `review_report`, `security_finding`, `decision_record`, `plan`, `screenshot`, `generated_file`, `bounded_log_excerpt`, `handoff_package`, `semantic_loss_ledger`.

Required metadata per artifact: `content_hash` (sha256, content-addressed), `producer` (runtime_session_id), `workspace_id`, `git_state` (commit + dirty flag), `mime_type`, `size`, `trust_label` (untrusted|sandbox|reviewed|trusted), `redaction_state`, `creation_event_id`.

**Storage:** content-addressed `artifacts/sha256/<prefix>/<hash>`; never inlined in events -- events reference the hash.

## 4. Claim

`claim_id`, `statement`, `producer`, `required_evidence_class`, `supporting_artifact_hashes[]`, `validation_status` (unvalidated|validated|refuted|superseded), `validator` (runtime_session_id|null), `superseding_claim_id`.

**Decision (evidence-based completion gate):** task completion requires at least one `validated` claim per `acceptance_criterion` (claims bound to criteria by hash).

## 5. Deviation from plan sec.8

None material. Concretized: `task_id`=ULID; content-addressed artifacts; binding claims->acceptance criteria; opaque native refs. Added `trust_label` and `redaction_state` to artifacts (security/privacy, `100`).
