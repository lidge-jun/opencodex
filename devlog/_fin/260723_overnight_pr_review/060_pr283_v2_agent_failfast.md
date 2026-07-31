# 060 — PR #283: fix(v2): fail fast on unreadable routed agent tasks

- **Author:** MathiasHeinke
- **Branch:** codex/v2-encrypted-task-failfast → dev (draft)
- **CI:** All pass (8/8 checks)
- **Sol Review:** Einstein — VERDICT: FAIL (1 high, 4 medium)
- **Decision:** REBUILD_ON_DEV (fix mixed-slot bypass, improve Fernet validation)

## Sol Review Summary

### High — Mixed encrypted slots bypass the guard (H1)
When sanitizeEncryptedContentInPlace() splits a mixed slot into input_text
(control preamble) + encrypted_content (real task), readableAgentMessagePayload()
treats the preamble as actionable text. The guard returns false and the routed
provider is called without the task body — preserving the exact failure mode
the PR claims to stop.

### Medium issues
2. FERNET_TOKEN_EXACT regex too loose — accepts structurally impossible tokens
3. Envelope parsing has false-positive/negative cases
4. Request-wide scanning can reject readable turns due to encrypted history
5. Combo routing may stop before reaching a native-compatible target

## Rebuild Requirements
- Derive semantic classification from raw content BEFORE mutation
- Structural Fernet validation (base64url, version byte, minimum length)
- Pin canonical, mixed-hook, malformed-token, historical-message fixtures
- Scope guard to newly delivered task items (not expanded history)
- Filter combo candidates to decrypt-capable routes before 400
- Add machine-readable error code: unreadable_encrypted_agent_task
