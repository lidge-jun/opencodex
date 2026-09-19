# T3: [Bug]: Decode content-coded responses on the pinned direct provider transport

### Client or integration

Direct HTTP/API client

### Area

Proxy and routing

### Summary

SOCKS responses now decode gzip/deflate, but `pinnedHttpRequest` returns raw encoded success bytes. Provider outbound chooses between these transports, so the same gzip JSON response is readable on one route and still compressed on the pinned direct route.

### Reproduction

Static source trace at `7864869c31c41cca9830d93540238f17df8faafb`; the following fake-upstream regression is the proposed executable reproduction, not a claimed local test result.

1. Fake upstream returns gzip or deflate JSON with matching Content-Encoding and coded Content-Length.
2. Read the response through pinned direct and SOCKS routes.
3. Compare logical JSON, coding/length headers, decoder errors and cleanup. Current pinned direct code forwards raw bytes into a Response.

### Version

7864869c31c41cca9830d93540238f17df8faafb

### Operating system

Source review on macOS 27.0; the transport logic is cross-platform. Runtime reproduction has not been executed in this analysis.

### Provider and model

Not provider- or model-specific. Use a local fake upstream and no real credentials.

### Logs or error output

No live traffic or runtime logs collected. Evidence is the exact source path below.

### Screenshots and supporting files

[src/lib/pinned-http.ts:153](https://github.com/lidge-jun/opencodex/blob/7864869c31c41cca9830d93540238f17df8faafb/src/lib/pinned-http.ts#L153); [src/lib/pinned-http.ts:194](https://github.com/lidge-jun/opencodex/blob/7864869c31c41cca9830d93540238f17df8faafb/src/lib/pinned-http.ts#L194); [src/lib/provider-outbound.ts:209](https://github.com/lidge-jun/opencodex/blob/7864869c31c41cca9830d93540238f17df8faafb/src/lib/provider-outbound.ts#L209); [src/lib/socks5-fetch.ts:530](https://github.com/lidge-jun/opencodex/blob/7864869c31c41cca9830d93540238f17df8faafb/src/lib/socks5-fetch.ts#L530). This is the pinned direct residual after #5070, not a duplicate request to decode SOCKS gzip.

### Redacted configuration

Use a test-owned loopback upstream and SOCKS tunnel or the pinned direct helper as specified above. No user home, provider credentials or running proxy is needed.

### Implementation path

1. MODIFY `src/lib/pinned-http.ts`: apply an explicit content-coding policy to success bodies; default identity requests can reduce unnecessary coding but are not the complete fix.
2. EXTRACT only the narrow shared gzip/deflate decoding policy from `src/lib/socks5-fetch.ts` if useful; leave injected executors under their existing contract.
3. Remove stale coded length/encoding after decoding and preserve byte ceilings, cancellation, deadlines and connection cleanup. Define encoded/decoded accounting explicitly for the bounded pinned consumer.
4. Do not reject an entire Accept-Encoding preference list merely because it mentions an unsupported alternative; validate the actual response coding. Brotli and multiple-coding support are separate policy decisions.
5. ADD `tests/lib/pinned-http-content-coding.test.ts` and route-parity fixtures.

### Acceptance criteria and verification

- Identity/gzip/deflate produce identical logical JSON across owned raw transports.
- Corrupt/unsupported coding returns a named error and closes the socket.
- Decoded body size remains bounded when `maxBytes` is configured; existing encoded-byte behavior is explicitly preserved or versioned.
- Abort/bodyless behavior remains intact; no direct-network fallback around operator egress policy.

New test files must be registered in `scripts/test-layout/layout.json` and `tests/fixtures/test-layout-expected.json`; split tests rather than raise file-size caps. Update `structure/transports/inventory.md` and any other owner declared by the manifest. Run focused regressions and exact-head hosted CI in the implementation PR; no passing runtime result is claimed here.

### Checks

- [x] I searched existing issues and documentation.
- [x] I removed secrets, tokens, account details, request credentials, and personal data.
