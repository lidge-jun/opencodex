# T2: [Bug]: Settle SOCKS5 streaming uploads on cancellation and early final responses

### Client or integration

Direct HTTP/API client

### Area

Proxy and routing

### Summary

The upload loop awaits the caller body reader before parsing any response head. Aborting destroys the socket but does not settle a pending `bodyReader.read()`. A stalled upload can therefore keep the fetch promise pending, including when the peer has already returned a final response.

### Reproduction

Static source trace at `7864869c31c41cca9830d93540238f17df8faafb`; the following fake-upstream regression is the proposed executable reproduction, not a claimed local test result.

1. Use a fake SOCKS peer and a Request body stream that produces one chunk and then leaves its next read pending.
2. Abort after the headers/chunk arrive, or have the upstream send a final response without waiting for the upload to finish.
3. Assert bounded settlement, request-body cancellation, no further upload writes and no orphaned socket/listeners. Do not use a production endpoint.

### Version

7864869c31c41cca9830d93540238f17df8faafb

### Operating system

Source review on macOS 27.0; the transport logic is cross-platform. Runtime reproduction has not been executed in this analysis.

### Provider and model

Not provider- or model-specific. Use a local fake upstream and no real credentials.

### Logs or error output

No live traffic or runtime logs collected. Evidence is the exact source path below.

### Screenshots and supporting files

[src/lib/socks5-fetch.ts:559](https://github.com/lidge-jun/opencodex/blob/7864869c31c41cca9830d93540238f17df8faafb/src/lib/socks5-fetch.ts#L559); [src/lib/socks5-fetch.ts:573](https://github.com/lidge-jun/opencodex/blob/7864869c31c41cca9830d93540238f17df8faafb/src/lib/socks5-fetch.ts#L573); [src/lib/socks5-fetch.ts:589](https://github.com/lidge-jun/opencodex/blob/7864869c31c41cca9830d93540238f17df8faafb/src/lib/socks5-fetch.ts#L589). Existing handshake/response abort support is retained; this is a request-body lifecycle gap, not a claim that cancellation is absent. Related #2894.

### Redacted configuration

Use a test-owned loopback upstream and SOCKS tunnel or the pinned direct helper as specified above. No user home, provider credentials or running proxy is needed.

### Implementation path

1. MODIFY `src/lib/socks5-fetch.ts`: observe the final response head concurrently with upload, skipping informational responses.
2. Race body reads/drain waits with caller abort and early final response. On termination, cancel/release the body reader without allowing a hanging cancel callback to block settlement.
3. Preserve the first terminal cause and caller abort reason; do not send a terminating chunk after an early final response. Avoid concurrent consumers of the same socket reader.
4. ADD focused `tests/lib/socks5-upload-lifecycle.test.ts` regressions.

### Acceptance criteria and verification

- Pending body read + caller abort rejects with the original reason and releases resources.
- Early final response resolves and stops upload.
- Socket error/timeout during a stalled body read settles rather than hanging.
- Backpressure, normal POST completion and informational response handling remain correct.

New test files must be registered in `scripts/test-layout/layout.json` and `tests/fixtures/test-layout-expected.json`; split tests rather than raise file-size caps. Update `structure/transports/inventory.md` and any other owner declared by the manifest. Run focused regressions and exact-head hosted CI in the implementation PR; no passing runtime result is claimed here.

### Checks

- [x] I searched existing issues and documentation.
- [x] I removed secrets, tokens, account details, request credentials, and personal data.
