# Verification and review

No local test suite or typecheck was run. Dependencies and an isolated Vite/runtime preview were used for manual UI/CLI checks. Production port 10100 was not restarted or reconfigured by this task.

## Remote checks

On macmini-cf, clean temporary clone at `601725c87`, project Bun 1.4.0:

- GUI build: exit 0 (existing large-chunk warning).
- GUI focused tests: 9 pass, 0 fail.
- Typecheck: exit 0.
- Runtime focused tests: 803 pass, 0 fail across adapter resolution, configuration migration, management validation, startup, xAI transport, Fast policy, headless CLI and Responses passthrough.
- Privacy scan: passed.

Subsequent `64e3e079a` adds OAuth re-login retention and corrects multimodal test parameterization; these require fresh verification. Latest-head PR CI is the final gate, not the earlier remote run.

## Live first-result experiment

The new adapter generated the upstream synthetic request without changing live user config. Initial example quoting caused one model response to overescape JavaScript string delimiters; switching the shared example to a single-quoted JavaScript literal fixed that observed output.

Successful first generated source, executed unchanged with the host code-mode tool:

```js
text(JSON.stringify(await tools.exec_command({cmd: 'printf OCX_FIRST_RESULT_7391'})))
```

The helper returned exit 0 and stdout `OCX_FIRST_RESULT_7391`. Replaying that actual result produced HTTP 200, one final message containing exactly the marker, and zero additional function calls. This verifies one synthetic live roundtrip, not a guarantee that a probabilistic model can never omit output again. The fallback explains an empty result; it does not fabricate discarded output or rewrite JavaScript.

## UI and CLI

Isolated home with no credentials, backend port 10239 and Vite port 15239; production user settings are not the fixture. Seeded old Chat overrides were removed at startup and version 1 was persisted. `provider edit xai --xai-chat on --json` returned success and effective Responses state false. The real Accounts screen then showed Chat checked. Clicking it off returned unchecked; the same persisted setting is shared by both surfaces.

Screenshot: `assets/001_chat_optin.png`, inspected after capture. The app-level screenshot path clipped the right side; direct tab compositor capture produced the complete 1600x900 page, including the switch. No page content or styles were modified for capture.

## Independent reviews

- A: PASS after clarifying name-pinned xAI OAuth scope, preserving latest POST choices and future migration versions.
- B/C: fixed reconciliation ordering so transient persistence failure cannot undo the projected default.
- C: fixed OAuth re-login retention and array-row test parameterization. Fresh interdiff review and latest-head CI pending.

## Remaining delivery gate

Templated PR, current-head CI, admin-bypass disclosure, fetched dev merge ancestry, and temporary resource teardown must be recorded before completion.

## First full-CI finding

PR #3670 at `4f827844b`: Linux shard 1 failed in `anthropic-thinking-signature.test.ts` because its hand-built `as never` request omitted the required `OcxParsedRequest.context` and used obsolete provider `passthrough` metadata. The new guidance path exposed this malformed fixture. Fix the fixture with the real `parseRequest(body)` and `authMode: forward`, keeping both original envelope-stripping assertions unchanged. Do not add a production fallback for a state the parser cannot produce.

Remote current-head follow-up before this fixture change: typecheck passed and 178 tests across OAuth upsert/native Responses passed. Independent review resolved all findings at `64e3e079a`; latest-head full CI remains required.

Linux shard 4 found a real native-wire parity gap: HTTP 429 bypassed generic OAuth account rotation. Remote red proof at `4f827844b` with expanded attribution tests: 14 pass / 3 fail (both buffered/streaming rotation returned 429; five-account bound sent once rather than four times). The fix reuses the existing account/quorum/cooldown budget in the native pre-stream loop and keeps selected-account refresh/replay identity synchronized. Green proof and new exact-head CI are required.

At `3ebc3abba`, remote typecheck and 67 tests across attribution, generic/event failover and the signature fixture passed. This includes failed alternate-snapshot preservation and `429 -> 401` refreshing the newly selected account. Independent review: PASS, zero blockers. CI then flagged a long synthetic bearer literal in the new test; use a short unmistakable fixture value instead, with identical authentication assertions and no scanner exception.

Temporary UI tab closed; preview processes stopped and ports 10239/15239 verified unbound. The screenshot and private synthetic probe receipts remain as evidence. The pending gate is latest-head full CI and authorized admin landing of PR #3670.

The Chat reasoning-stream regression also relied on the previous default. Its fixture now explicitly chooses Chat with the completed migration marker and static model discovery; unexpected native-wire calls fail locally instead of escaping its mock. Original reasoning ordering, tier stripping and header assertions are unchanged.
