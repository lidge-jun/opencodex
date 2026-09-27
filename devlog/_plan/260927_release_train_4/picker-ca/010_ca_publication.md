# 010 — Serialized CA publication and public recovery record

Depends on: `000_plan.md`. Work phase `wp1`, class C4. Source owner: `src/claude/intercept/picker-ca.ts`; consumer: `src/claude/intercept/runtime.ts` in phase 020. No production keychain, service, or home operation.

## File changes (diff-level)

| Path | Change | Before → after |
| --- | --- | --- |
| `src/claude/intercept/picker-ca.ts` | MODIFY | `underPickerCaLock` returns `T | undefined`, and void callbacks are repeated outside the lock → tagged `{ ok: true, value: T } | { ok: false, error }`, with a caller-visible failure and no unlocked publication. The cached and fresh paths both decide and publish only under the lock. A live foreign owner blocks a fresh publication **and makes a cached mismatched authority throw**; returning the cached CA after merely deferring publication would let callers arm it against a different on-disk owner. `processAuthorities` is set only after a successful locked path. |
| `src/claude/intercept/picker-ca.ts` | MODIFY | A replacement overwrites the last public PEM with no durable predecessor → under the same lock, parse the current public PEM, write one `{ sha1, sha256, certPem }` record to `pending-untrust.json` by private temporary file/rename **before** `ca.pem` changes, then publish `ca.pem` and `ca-owner.json`. Refuse another replacement while that record exists. Reject malformed or oversized pending data rather than dropping it. Expose a bounded read, a check of whether the pending PEM is still the published certificate with a matching **live** owner, and exact-entry acknowledgement under the lock. A missing record means no pending item. No `keyPem`, signing key, private path, or request data enters the record. |
| `src/claude/intercept/picker-ca.ts` | MODIFY | `ensurePickerCa(configDir)` returns a CA to controller/CLI/runtime even when predecessor cleanup is unresolved → keep its return type, but make its default call refuse any pending record or replacement requiring untrust. Add a narrow startup-only option that permits a fresh replacement **only when no prior pending record exists** and returns the CA with its newly queued predecessor for immediate cleanup in phase 020. The ordinary controller `enable` and picker-runtime material paths use the default and cannot trust or rearm a new CA before cleanup. |
| `tests/claude-integration/claude-picker-ca.test.ts` | MODIFY | Existing process-restart and foreign-owner tests check only the final certificate → test a successful void callback executes exactly once, an actual second process holding the SQLite lock causes zero publication outside it, and competing processes leave `ca.pem` and `ca-owner.json` with matching SHA-256 after serialization. Check the pending record contains only public PEM/fingerprints and is written before replacement; malformed record blocks publication; cached republish obeys the same lock. |

## Conditional activation and field chain

- Normal void callback: call the tagged lock helper with a side-effect counter, assert one increment and `ok: true` even though `value` is `undefined`.
- Busy lock: hold the actual picker SQLite lock in a child process, call `ensurePickerCa` in another process, assert no publication and an explicit deferred outcome; release then retry. No in-process stub substitutes for this contention check.
- Live foreign owner: publish from a live second process, call the cached `ensurePickerCa` in the first, and assert it refuses instead of returning an authority whose public PEM is no longer published.
- Prior certificate: start with a valid published public PEM, rotate, assert the record exists with its SHA-1/SHA-256 before the new `ca.pem` is visible. If the write fails, the old PEM remains published.
- Interrupted publication: fault-inject failure after recording pending but before replacing `ca.pem`; while the matching owner process is alive, a second process sees the pending PEM still actively published and **does not** untrust it. It defers picker construction/cleanup; after the owner exits, a later process retries removal.
- Bad record: stage malformed JSON and attempt rotation, assert no replacement and no private material. No parsing fallback silently erases recovery data.
- Sequential predecessors: an unresolved A blocks another publication; after exact A acknowledgement, a later B-to-C rotation may create B as the next single pending item. A mismatched acknowledgement leaves the original record intact.
- Later controller enable: leave a pending entry after a failed removal, invoke the real controller enable path, and assert no trust add or picker rearm. The default `ensurePickerCa` refusal is the gate, not a changed controller implementation.

New field chain: the startup-only `ensurePickerCa` path creates the single pending entry; the JSON writer serializes it; the bounded reader validates its fingerprints against the PEM; phase 020 consumes it for `untrustPickerCa`, then the locked acknowledgement removes it. Ordinary `ensurePickerCa` callers consume only the no-pending state. The option is created only by `startClaudeIntercept`, is not serialized, and has no other consumer. A test-visible lock helper, if needed to observe the void callback, is a narrow code contract and not user configuration.

## Proof before closing this phase

Run isolated `bun test tests/claude-integration/claude-picker-ca.test.ts`, `bun run typecheck`, and the relevant source-as-data/process tests explicitly. Inspect the final CA/owner pair and journal bytes, and verify no `ca.key` or signing key appears anywhere under the fixture state root. Record exact commands and outcomes in the phase D note.
