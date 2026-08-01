# ADR 0012: Remote access through a central Gateway and private Mesh routes

- Status: superseded for new Remote workspaces by ADR 0013; retained only as the deployed private-MVP rollback path
- Date: 2026-07-30

## Context

OpenCodex Remote must expose a user's loopback OpenCodex GUI, management API, data API, SSE, and WebSocket without publishing the user's Tunnel hostname. User-controlled origins and Agents are untrusted. The public hostname must not reveal whether another user's instance exists.

## Decision

All instance wildcard DNS enters a central VPS Gateway. The Gateway resolves hostname ownership and lifecycle state from PostgreSQL, authenticates an instance session or `ocxr_` token, signs a 30-second Ed25519 assertion, and routes only to a random private hostname through a Linux Cloudflare Mesh node. Each user server runs one Cloudflare Tunnel into a Rust local ingress. The Agent and OpenCodex management API verify the assertion independently.

Each private hostname has a DNS-only A record under `private.remote.opencodexpages.me` whose value is a unique address from `10.192.0.0/10`. The Agent assigns that `/32` to loopback and listens only on that address at port `10101`. The same `/32` is attached to the instance Tunnel as a narrow CIDR activation route because a hostname route alone did not enable `warp-routing` in the live Cloudflare account. The exact DNS record is not a public application route: Internet clients only receive an unroutable RFC1918 address, while enrolled Mesh traffic receives a synthetic `100.80.0.0/16` address and reaches the dedicated Tunnel.

Cloudflare Access Applications are not used. No public hostname is attached to a user Tunnel. Mesh failure does not authorize a weaker automatic fallback.

The onboarding control surface is the local `ocx gui`, not the central instance dashboard. A ten-minute device authorization binds the PC key to a GitHub identity without returning GitHub credentials. Users set an additional Argon2id Remote password and reserve one hostname. Browser entry to that hostname redirects only top-level HTML navigation to the central access page; API and WebSocket failures remain concealed. The central page requires both the owning GitHub session and the Remote password before issuing a short-lived hostname exchange code.

## Consequences

- Positive: one policy enforcement point, hidden instance existence, immediate DB-first suspension, no inbound user-server port.
- Positive: browser, `/api/*`, `/v1/*`, SSE, and WebSocket retain one public instance origin.
- Negative: Mesh/private hostname routing is Beta and must pass Phase 0 before MVP approval.
- Negative: Gateway and Agent must implement careful streaming, cancellation, replay, and header normalization.
- Negative: operating the service requires PostgreSQL, three Bun services, central ingress, Mesh, and instance Tunnel lifecycle reconciliation.
- Negative: provisioning and deletion now own four Cloudflare resources per instance: Tunnel, DNS record, `/32` activation route, and hostname route.
- Negative: the DNS record makes the random internal hostname observable only if guessed; its 160-bit random label and lack of a certificate keep it out of ordinary enumeration surfaces.

[Decision Log]
- 목적과 의도: 사용자 Tunnel을 공개하지 않고 중앙 인증 정책을 강제한다.
- 기존 구현 및 제약 조건: OpenCodex GUI와 API는 동일 origin과 장시간 stream/WS를 사용한다.
- 검토한 주요 대안: 공개 Tunnel hostname, Cloudflare Access, Workers VPC, 자체 reverse tunnel.
- 선택한 방식: central Gateway + Cloudflare Mesh private hostname + DNS-backed RFC1918 loopback origin + per-instance Tunnel.
- 다른 대안 대신 이 방식을 선택한 이유: 확정된 private-only 경계와 전체 protocol surface를 동시에 만족하는 후보이기 때문이다.
- 장점, 단점 및 영향: 격리와 정지는 강해지지만 Beta dependency와 인스턴스당 네 Cloudflare 리소스의 lifecycle이 생긴다. 2026-07-30 live account에서 Mesh HTTP, SSE, WebSocket, 100 MiB 양방향 전송, 30분 stream, Rust Agent 경로와 활성 connector cleanup suspend를 통과했다.
