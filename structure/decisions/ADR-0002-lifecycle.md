# ADR-0002 — Lifecycle

- Contract owner: [runtime.md](../runtime.md#lifecycle)

## Decision record

- 목적과 의도: Give a headless hub a browser management ingress without widening its data plane or trusting spoofable forwarding headers on the public listener.
- 기존 구현 및 제약 조건: `startServer` is synchronous through Lab activation, already owns an optional-listener transaction, and the service installer already has an owner-only token-file flow.
- 검토한 주요 대안: Add management routes to the public listener; infer trusted ingress from `Host`/`Forwarded`/Tailscale headers; create a separate service manager; extend the existing composition root.
- 선택한 방식: Bind a third socket exactly to `127.0.0.1`, select trust by receiving `Bun.serve` instance, keep a fixed route allowlist, and reuse the current launchd/systemd definitions.
- 다른 대안 대신 이 방식을 선택한 이유: Headers do not prove which transport received a request, while a kernel loopback bind plus Tailscale Serve supplies a concrete ingress boundary without duplicating lifecycle or secret delivery.
- 장점, 단점 및 영향: Public/default behavior stays unchanged and management can use Tailscale identity; operators must provide a co-located HTTPS frontend and pairing remains necessary for generic TLS proxies.
