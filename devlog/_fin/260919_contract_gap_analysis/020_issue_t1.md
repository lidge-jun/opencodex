# T1: [Bug]: Return null bodies for 204 and 205 in raw outbound transports

### Client or integration

Direct HTTP/API client

### Area

Proxy and routing

### Summary

The pinned direct helper constructs a streaming Response for every 2xx response, including 204 and 205. The SOCKS helper excludes 204 but misses 205. These statuses require a null body at the Fetch Response boundary, so a valid no-content upstream response can fail during response construction instead of resolving normally.

### Reproduction

Static source trace at `7864869c31c41cca9830d93540238f17df8faafb`; the following fake-upstream regression is the proposed executable reproduction, not a claimed local test result.

1. Have a fake HTTP upstream return 204 or 205 with no content and keep its connection alive.
2. Invoke `pinnedHttpGet` against its pinned loopback address. Separately return 205 through a fake SOCKS tunnel.
3. Assert the call resolves promptly with the original status and `body === null`, even when representation headers describe an unsupported coding. Current source attaches a stream in those cases.

### Version

7864869c31c41cca9830d93540238f17df8faafb

### Operating system

Source review on macOS 27.0; the transport logic is cross-platform. Runtime reproduction has not been executed in this analysis.

### Provider and model

Not provider- or model-specific. Use a local fake upstream and no real credentials.

### Logs or error output

No live traffic or runtime logs collected. Evidence is the exact source path below.

### Screenshots and supporting files

[src/lib/pinned-http.ts:144](https://github.com/lidge-jun/opencodex/blob/7864869c31c41cca9830d93540238f17df8faafb/src/lib/pinned-http.ts#L144); [src/lib/pinned-http.ts:194](https://github.com/lidge-jun/opencodex/blob/7864869c31c41cca9830d93540238f17df8faafb/src/lib/pinned-http.ts#L194); [src/lib/socks5-fetch.ts:512](https://github.com/lidge-jun/opencodex/blob/7864869c31c41cca9830d93540238f17df8faafb/src/lib/socks5-fetch.ts#L512). Related #2894 and merged #5070; neither covers this residual status set. [Fetch null-body status](https://fetch.spec.whatwg.org/#null-body-status) and [HTTP 205](https://www.rfc-editor.org/rfc/rfc9110.html#name-205-reset-content).

### Redacted configuration

Use a test-owned loopback upstream and SOCKS tunnel or the pinned direct helper as specified above. No user home, provider credentials or running proxy is needed.

### Implementation path

1. MODIFY `src/lib/socks5-fetch.ts`: include 205 in `bodylessResponse`; keep HEAD/204/304 behavior.
2. MODIFY `src/lib/pinned-http.ts`: branch on null-body status before creating the success stream and safely terminate the underlying response/request. Preserve response headers.
3. Share a small eligibility predicate only if it simplifies these two owners; do not introduce a broad transport framework. Keep unsupported upgrade behavior outside this issue.
4. ADD a focused sibling `tests/lib/transport-null-body.test.ts` or extend uncapped existing tests.

### Acceptance criteria and verification

- 204/205 settle with null body without waiting for connection close.
- HEAD/304 existing behavior remains covered where the transport supports those request/status paths.
- 205 carrying `Content-Encoding: br` is not decoded or rejected for nonexistent body bytes.
- Ordinary 200 JSON and cleanup/cancellation still work.

New test files must be registered in `scripts/test-layout/layout.json` and `tests/fixtures/test-layout-expected.json`; split tests rather than raise file-size caps. Update `structure/transports/inventory.md` and any other owner declared by the manifest. Run focused regressions and exact-head hosted CI in the implementation PR; no passing runtime result is claimed here.

### Checks

- [x] I searched existing issues and documentation.
- [x] I removed secrets, tokens, account details, request credentials, and personal data.
