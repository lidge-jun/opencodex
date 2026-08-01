# ADR 0013: Account workspace with outbound E2EE terminal relay

- Status: accepted for implementation; not deployed to production
- Date: 2026-07-30
- Supersedes: ADR 0012 for newly activated Remote workspaces

## Context

The Mesh private-MVP proved that a loopback OpenCodex GUI could be reached without a public user origin, but it requires four Cloudflare resources, a privileged loopback address, and a dedicated `cloudflared` connector per computer. The intended product is different: one GitHub account owns one stable Remote address, multiple named computers can attach to it, and a browser should run Shell, Codex CLI, or Claude Code on any online computer. Home users cannot be required to configure port forwarding.

The central service must minimize CPU, database, and trust. It must not receive terminal plaintext, the user's Remote password, or a vault decryption key.

## Decision

An `instance` becomes an account workspace and keeps one unique `<slug>.opencodexpages.me` address. `remote_devices` are the named computers attached to that workspace. Every computer opens one outbound WSS connection to `relay.opencodexpages.me`; no inbound user port, private Mesh enrollment, per-device Tunnel, or root network preparation is required.

The browser enters through the central GitHub page and derives two values locally from the separate Remote password with Argon2id:

- an authentication secret sent over TLS after GitHub ownership is established;
- an independent AES-256-GCM wrapping key that never leaves the client.

HKDF domain separation prevents the authentication secret from decrypting the vault envelope. The encrypted vault contains an account Ed25519 root private key and a random vault key. The server stores only the authentication-secret hash, KDF parameters, public root key, and encrypted envelope.

For every terminal session, the browser creates an ephemeral P-256 key and signs the session transcript with the account root key. The Agent verifies that signature, creates its own ephemeral P-256 key, and signs the reply with the device Ed25519 key. Both sides derive directional AES-256-GCM keys and nonce prefixes with HKDF. Strict monotonically increasing counters are authenticated as AAD and reject replay or reordering. The central Gateway sees the device, session UUID, command profile, frame size, and connection timing, but relays only bounded ciphertext payloads.

The Agent does not start the PTY while returning its signed handshake. It waits for the first authenticated browser application frame, which acts as the PTY-start signal. This ordering is required because a shell can emit a prompt before the browser has installed its encrypted-frame handler; losing counter zero would otherwise make the next legitimate frame indistinguishable from replay or reordering.

The only command choices accepted by the Agent are fixed profiles: `shell`, `codex`, and `claude`. The browser cannot provide an arbitrary executable. Each device permits at most four active sessions. Relay payloads are limited to 64 KiB and each socket is closed when its buffered output exceeds 1 MiB. The Gateway performs database work only at authentication, session creation, and close boundaries; it does not query or persist per terminal frame.

The Rust Agent runs as the current user with `portable-pty`, Tokio, and `tokio-tungstenite`. OCX may start only a prebuilt platform binary with explicit argv; it never compiles the Agent at runtime. Release remains blocked until signed binaries are packaged for each supported platform.

Cloudflare remains the public TLS and wildcard ingress boundary. It is not the terminal encryption boundary and is not relied on to see or protect terminal plaintext.

## Consequences

- Positive: no port forwarding, root helper, private Mesh enrollment, or per-computer Cloudflare lifecycle.
- Positive: one account/domain naturally supports multiple computers and a future managed VPS as another device.
- Positive: the server can route live traffic without decrypting or storing terminal data and without database work per frame.
- Positive: ephemeral ECDH keys provide forward secrecy for terminal sessions; device and account signatures prevent an active relay from silently substituting an endpoint.
- Negative: metadata such as device identity, selected command profile, frame size, and timing remains visible to the service.
- Negative: the authentication secret is password-equivalent. TLS, attempt limits, session revocation, and GitHub ownership remain required; OPAQUE is a future hardening candidate.
- Negative: browser memory and session storage hold the unlocked vault for the current tab. CSP, same-origin delivery, dependency integrity, and immediate fragment removal are security-critical.
- Negative: signed multi-platform Agent packaging and a public operating E2E with real Codex/Claude CLI processes are still release blockers. The local PostgreSQL 17 + Gateway + Rust Agent + WebCrypto + PTY encrypted round trip is complete.
- Negative: old Mesh resources are not automatically deleted by the schema migration. Conversion preserves the existing slug and marks the workspace `outbound-relay`; resource cleanup requires a separate audited operation.

[Decision Log]
- 목적과 의도: 서버 부하와 신뢰를 줄이면서 계정 주소 하나에서 여러 컴퓨터의 CLI 터미널을 포트포워딩 없이 제공한다.
- 기존 구현 및 제약 조건: 기존 Mesh MVP는 컴퓨터마다 Cloudflare 리소스 네 개와 root loopback 준비가 필요했고 중앙 proxy가 GUI 전체 평문을 처리했다.
- 검토한 주요 대안: 기존 Mesh 유지, 공개 user Tunnel, 중앙 PTY/VPS 실행, Tailscale형 overlay, outbound application relay와 브라우저-Agent E2EE.
- 선택한 방식: 한 컴퓨터당 outbound WSS 하나, 세션별 상호 서명 ephemeral P-256, 방향별 AES-GCM, 중앙의 bounded opaque relay를 사용한다. Agent handshake 응답 뒤 첫 인증된 browser frame을 PTY 시작 신호로 사용한다.
- 다른 대안 대신 이 방식을 선택한 이유: 일반 가정용 네트워크에서도 동작하고 서버가 터미널 평문이나 복호화 키를 보지 않으면서 계정당 여러 컴퓨터를 자연스럽게 지원한다.
- 장점, 단점 및 영향: 운영 리소스와 중앙 CPU는 줄지만 signed Agent 배포, 브라우저 crypto 상호운용, 메타데이터 노출 관리가 새 완료 조건이 된다.
