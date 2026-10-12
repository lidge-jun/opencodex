# R3: [Bug]: Request full replay when a task-scoped continuation cannot be used

### Client or integration

Direct HTTP/API client

### Area

Proxy and routing

### Summary

A task-scope mismatch correctly avoids replaying another task’s state, but removes previous_response_id and continues with the current input. If that input is only a delta, the proxy silently turns it into a fresh conversation. Missing or corrupt state instead asks the client to replay the full conversation. The proposed policy rejects every scope mismatch, including requests that appear to contain full input, because the proxy cannot prove the supplied input is complete. This deliberately changes the historical fresh-start behavior; a caller can retry explicitly without previous_response_id.

### Reproduction

Static source trace at `7864869c31c41cca9830d93540238f17df8faafb`; the following fake-upstream regression is the proposed executable reproduction, not a claimed local test result.

1. In an isolated state fixture, store a response under task scope A.
2. Submit its previous_response_id with task scope B and a delta-only input.
3. Trace expandPreviousResponseInput into the ordinary/combo request paths. Current code strips the ID and continues fresh. Expected: the generic continuation-unavailable response before upstream I/O, allowing explicit full client replay.

### Version

7864869c31c41cca9830d93540238f17df8faafb

### Operating system

Source review on macOS 27.0; the transport logic is cross-platform. Runtime reproduction has not been executed in this analysis.

### Provider and model

Not provider- or model-specific. Use a local fake upstream and no real credentials.

### Logs or error output

No live traffic or runtime logs collected. Evidence is the exact source path below.

### Screenshots and supporting files

[src/responses/state.ts:1066](https://github.com/lidge-jun/opencodex/blob/7864869c31c41cca9830d93540238f17df8faafb/src/responses/state.ts#L1066); [src/server/responses/request-prepare.ts:245](https://github.com/lidge-jun/opencodex/blob/7864869c31c41cca9830d93540238f17df8faafb/src/server/responses/request-prepare.ts#L245); [src/server/responses/core-combo.ts:203](https://github.com/lidge-jun/opencodex/blob/7864869c31c41cca9830d93540238f17df8faafb/src/server/responses/core-combo.ts#L203). Related closed #702 covers expired-state context loss. The mismatch fresh-start behavior was intentional historically; this residual applies the current fail-closed replay principle without replaying foreign state.

### Redacted configuration

Use a test-owned continuation store and fake upstream. Set different client-task scopes in the stored entry and request. Do not use a live user home, credentials, SOCKS tunnel or running proxy.

### Implementation path

1. MODIFY `src/responses/state.ts`: represent scope mismatch as unavailable replay provenance rather than silently turning the body into a fresh request. Keep foreign state inaccessible.
2. MODIFY ordinary `request-prepare.ts` and `core-combo.ts` consumers to reuse the generic 400 previous_response_not_found shape, preserving the internal reason only for bounded diagnostics.
3. Update current tests that intentionally expect fresh-start behavior; preserve same-scope and valid unscoped compatibility.
4. Cover HTTP/WS/combo entrypoints through the existing replay tests or new sibling files. Update Responses transport and client replay guidance.
5. Record this as an intentional change to the historical fresh-start policy; validate affected client behavior before merge.

### Acceptance criteria and verification

- Mismatched continuation + delta returns generic previous_response_not_found with zero upstream sends.
- Response reveals neither stored scope nor foreign-state existence/details.
- A mismatched request carrying apparently full input also gets the same generic refusal; retrying that full input without previous_response_id succeeds. Update the deliberate fresh-start cases in `tests/responses/responses-state.test.ts` and `tests/server/server-combo-failover-e2e.test.ts`.
- Explicit full replay without previous_response_id succeeds normally.
- Same-scope continuation and documented legacy unscoped behavior remain valid.
- HTTP, WS and combo paths produce consistent semantics.

New test files must be registered in `scripts/test-layout/layout.json` and `tests/fixtures/test-layout-expected.json`; split tests rather than raise file-size caps. Update `structure/transports/inventory.md` and any other owner declared by the manifest. Run focused regressions and exact-head hosted CI in the implementation PR; no passing runtime result is claimed here.

### Checks

- [x] I searched existing issues and documentation.
- [x] I removed secrets, tokens, account details, request credentials, and personal data.
