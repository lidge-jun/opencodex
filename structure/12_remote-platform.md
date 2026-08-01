# OpenCodex Remote platform boundary

OpenCodex Remote는 로컬 `ocx gui` 계정/기기 설정, 중앙 Control Plane/Gateway, 브라우저 작업공간, 사용자 권한 Rust Agent로 구성된다. 신규 경로의 기준 결정은 [ADR 0013](./adr/0013-remote-outbound-e2ee-relay.md)이다. 기존 Cloudflare Mesh 경로는 [ADR 0012](./adr/0012-remote-private-mesh.md)에 rollback 기록으로 남긴다.

## Repository boundary

- `src/remote/` — 보호된 `remote.json`, GitHub device flow, E2EE vault 생성/변경, Agent lifecycle.
- `src/server/management/remote-routes.ts` — local `ocx gui`가 사용하는 same-origin management API.
- `platform/server/` — GitHub identity, workspace/device metadata, access session, outbound relay Gateway.
- `platform/web/` — 중앙 로그인/해제 화면과 wildcard domain의 xterm.js 작업공간.
- `platform/server/migrations/0003_outbound_e2ee_relay.sql` — E2EE envelope, relay device presence, terminal session schema.
- `remote-agent/` — Rust outbound WSS, E2EE handshake, fixed-profile portable PTY.

중앙 플랫폼 source는 npm package에 포함하지 않는다. 일반 OCX release에는 플랫폼별로 빌드·서명된 최소 Agent binary만 `bin/remote-agent/<platform>-<arch>/`에 동봉해야 한다. 런타임 `cargo build`는 금지한다.

## Signed multi-platform Agent bundle

지원 bundle은 정확히 여섯 개다.

| Package path | Rust target | GitHub runner |
| --- | --- | --- |
| `linux-x64` | `x86_64-unknown-linux-musl` | `ubuntu-24.04` |
| `linux-arm64` | `aarch64-unknown-linux-musl` | `ubuntu-24.04-arm` |
| `macos-x64` | `x86_64-apple-darwin` | `macos-15-intel` |
| `macos-arm64` | `aarch64-apple-darwin` | `macos-15` |
| `windows-x64` | `x86_64-pc-windows-msvc` | `windows-latest` |
| `windows-arm64` | `aarch64-pc-windows-msvc` | `windows-11-arm` |

`.github/workflows/ci.yml`은 pinned Rust `1.97.1`로 각 native runner에서 fmt, clippy, test, release build를 수행한다. 수동 release workflow는 같은 matrix를 다시 build해 1일 보관 Actions artifact로 publish job에 넘긴다. 보호된 `remote-agent-release` Environment 승인을 통과한 실제 publish job만 Environment secret `REMOTE_AGENT_SIGNING_KEY`를 파일 mode `0600`으로 잠깐 materialize하고, `scripts/remote-agent-bundle.ts`가 다음을 생성한다.

- npm payload: `bin/remote-agent/<package>/opencodex-remote-agent[.exe]`
- exact six-entry `remote-agent-manifest.json`: npm package version, source commit, release filename, SHA-256, raw-binary Ed25519 signature, canonical manifest signature
- GitHub Release assets: 각 native binary, raw detached `.sig`, 동일 manifest와 manifest `.sig`, public key PEM

manifest signature는 domain-separated canonical payload 전체를 인증하므로 이전 binary/signature를 새 commit처럼 보이게 섞을 수 없다. package preparation과 런타임은 manifest의 package version이 독립적인 root `package.json` version과 같은지도 확인해 완전한 이전 bundle replay를 막는다. `scripts/prepare-package.ts`는 release에서 bundle 전체를 다시 검증하고 하나라도 없거나 다르면 publish 전에 실패한다. 런타임은 현재 OS/architecture artifact만 고정 public key로 검증한 직후 실행한다. bundle이 존재하지만 manifest, checksum, signature가 틀리면 unsigned development build로 fallback하지 않는다. 명시적인 absolute `OPENCODEX_REMOTE_AGENT_BIN`은 source checkout 개발용 override로만 남는다.

실제 production private key는 `remote-agent-release` GitHub Environment secret에만 두고, 해당 environment 승인 뒤 실제 publish job에서만 읽는다. 기본 dry-run은 매번 임시 Ed25519 key를 생성해 동일한 조립·검증·packaging 경로를 시험하며 production key를 읽지 않는다. `expected-sha`는 모든 dispatch에서 필수이고 현재 `GITHUB_SHA`와 다르면 signing 전에 실패한다.

[Decision Log]
- 목적과 의도: 설치 직후 Remote를 사용할 수 있게 하면서 사용자 PC의 컴파일과 변조 binary 실행을 모두 제거한다.
- 기존 구현 및 제약 조건: Rust Agent source와 local target fallback만 있었고 npm release에는 native artifact나 신뢰 기준이 없었다.
- 검토한 주요 대안: 런타임 cargo build, checksum-only bundle, 플랫폼별 optional npm package, 한 npm package에 서명된 6종 동봉.
- 선택한 방식: official native runner 6종 build, exact manifest, Ed25519 raw-binary signature, release-time bundle assembly를 사용한다.
- 다른 대안 대신 이 방식을 선택한 이유: 기존 `npm install -g` UX와 단일 버전을 유지하면서 cross-compilation 차이와 캐시/패키지 변조를 fail-closed로 처리한다.
- 장점, 단점 및 영향: Linux/macOS/Windows x64·arm64는 바로 실행되지만 release secret 보관과 6개 runner 성공이 새 release 필수 조건이다.

## User flow

```text
local ocx gui → Remote
  → GitHub device approval
  → first account device: local Argon2id E2EE password + encrypted vault envelope
  → reserve one unique <slug>.opencodexpages.me workspace
  → register this computer under a unique account-local name
  → start the unprivileged prebuilt Agent
  → Agent opens one outbound WSS to relay.opencodexpages.me

another browser
  → owning GitHub account
  → local E2EE password derivation and vault unlock
  → host-only workspace session
  → choose an online computer and shell/codex/claude
  → first authenticated resize/input frame starts the selected PTY
  → browser ↔ Agent encrypted PTY frames through the opaque relay
```

기존 계정은 새 E2EE 비밀번호를 처음 설정할 때 기존 slug를 보존한 채 `mesh-tunnel`에서 `outbound-relay`로 전환한다. 기존 Cloudflare 리소스 삭제는 자동 전환과 분리된 운영 작업이다.

## Trust boundaries

1. GitHub는 계정 소유권만 증명한다. OAuth access/refresh/ID token은 DB에 저장하지 않는다.
2. Remote 비밀번호와 Argon2id root, vault wrapping key는 로컬 브라우저/OCX를 떠나지 않는다.
3. 서버가 받는 32-byte authentication secret은 password-equivalent이지만 HKDF 분리 때문에 vault envelope를 복호화할 수 없다.
4. 브라우저는 account root Ed25519로 handshake를 서명하고 Agent는 device Ed25519로 응답을 서명한다.
5. 세션별 ephemeral P-256 ECDH와 방향별 AES-256-GCM counter가 기밀성, endpoint binding, replay 방지를 제공한다.
6. Gateway는 연결 경계에서만 DB를 사용하고 terminal frame을 해석·저장·로그하지 않는다.
7. Agent는 `shell`, `codex`, `claude` 고정 profile만 실행하며 현재 OS 사용자 권한을 넘지 않는다.
8. Cloudflare는 public TLS/ingress와 패킷 전달 경계다. E2EE endpoint나 plaintext authority가 아니다.

## Live data flow

```text
Browser xterm.js
  ↕ encrypted session frames (AES-GCM, signed ephemeral ECDH)
Cloudflare wildcard ingress
  ↕ WSS
Gateway in-memory bounded relay
  ↕ one outbound WSS per online computer
Rust Agent + portable-pty
  ↕ current-user local process
shell / codex / claude
```

Gateway frame header는 protocol version, kind, 128-bit terminal session ID만 가진다. payload는 최대 64 KiB 암호문이다. 기기당 active session은 4개, socket buffered output은 1 MiB로 제한한다. Agent가 연결되면 workspace는 `online`, 마지막 Agent가 끊기면 `offline`이다.

## Credential and key classes

- `ocxr_device_`: 로컬 management API용 장치별 폐기 가능 token. `remote.json` 0600에만 저장.
- `ocxr_agent_`: 해당 컴퓨터의 outbound Relay 연결 token. DB에는 SHA-256만 저장.
- Instance session: 중앙 access code를 wildcard host-only HttpOnly cookie로 교환한 12시간 browser session.
- E2EE authentication secret: Remote password의 Argon2id root에서 auth 전용 HKDF info로 만든 32 bytes. 서버는 다시 SHA-256하여 저장.
- Vault wrapping key: 동일 root에서 별도 HKDF info로 만든 AES-256 key. 서버로 전송하지 않음.
- Account root Ed25519: private key는 encrypted vault 안, public key는 서버/Agent 검증 metadata.
- Device Ed25519: private key는 해당 컴퓨터 `remote.json`, public key는 workspace metadata.
- Session ECDH/AES keys: 브라우저와 Agent memory에만 존재하고 session 종료 시 폐기.

## Runtime and release invariants

- Agent는 root, `CAP_NET_ADMIN`, port forwarding, LAN listener를 요구하지 않는다.
- Relay token을 argv, URL query, browser storage, log에 넣지 않는다.
- 브라우저 vault handoff는 URL fragment로만 전달하고 wildcard origin 진입 즉시 `sessionStorage`로 옮긴 뒤 주소 표시줄/history에서 제거한다.
- suspend/delete PostgreSQL 알림만 active sockets를 강제 종료한다. online/offline presence 알림은 revocation으로 취급하지 않는다.
- Agent handshake 또는 frame 오류는 해당 terminal session만 닫아야 하며 다른 세션과 Agent WSS를 불필요하게 끊지 않는다.
- build/test는 운영 VPS에서 transient systemd unit의 `CPUQuota=50%`, low CPU weight, positive nice로 실행한다. Remote runtime 서비스에는 영구 CPUQuota를 두지 않는다.
- release 전 플랫폼별 signed Agent artifact, migration backup/rollback, real browser E2E, reconnect/backpressure, XSS/CSP 검증이 모두 필요하다.

[Decision Log]
- 목적과 의도: 실제 구현과 문서가 하나의 현재 구조를 설명하고 기존 Mesh 기록은 rollback 근거로 보존한다.
- 기존 구현 및 제약 조건: 기존 문서는 인스턴스당 Mesh/Tunnel과 중앙 plaintext proxy를 현재형으로 설명해 새 다중 컴퓨터 E2EE 구조와 충돌했다.
- 검토한 주요 대안: 기존 문서에 부록만 추가, 완전 삭제, 현재 구조 재작성과 이전 ADR 보존.
- 선택한 방식: 현재 구조를 이 문서의 본문으로 만들고 기존 경로는 superseded ADR과 운영 문서로 남긴다.
- 다른 대안 대신 이 방식을 선택한 이유: 신규 개발자가 잘못된 root/Cloudflare lifecycle을 계속 구현하지 않으면서 검증된 rollback 지식도 잃지 않는다.
- 장점, 단점 및 영향: 현재 data flow가 명확해지지만 운영 배포가 전환되기 전까지 코드 경로 두 개를 구분해 유지해야 한다.
