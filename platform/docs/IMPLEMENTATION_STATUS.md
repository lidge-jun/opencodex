# OpenCodex Remote MVP 구현 인수인계

마지막 갱신: 2026-07-31

작업 브랜치: `ingw/remote-outbound-e2ee`

기준 브랜치/커밋: `dev` / `cd46a34d`

이 문서는 다른 컴퓨터에서 작업을 바로 이어가기 위한 현재 상태의 기준 문서다. PostgreSQL 17과 실제 Control Plane·worker·Gateway 프로세스를 사용하는 로컬 통합 검증을 완료했고, 2026-07-30 기존 TeamWicked Oracle VPS에 중앙 bootstrap runtime과 `opencodexpages.me` public ingress를 배포했다. 실제 Cloudflare account의 Linux Mesh/private-hostname transport와 Rust Agent 포함 30분 stream은 통과했지만 실제 OpenCodex process를 포함한 public 운영 E2E는 아직 완료되지 않았다.

## 2026-07-30 outbound E2EE relay 전환 작업

신규 제품 경로는 [ADR 0013](../../structure/adr/0013-remote-outbound-e2ee-relay.md)으로 변경했다. 이 변경은 현재 `ingw/remote-private-mvp-handoff` worktree에만 있고 운영 중앙 서버와 `dev`에는 배포하지 않았다.

- 계정당 주소 하나와 여러 `remote_devices`를 workspace로 사용한다.
- `0003_outbound_e2ee_relay.sql`이 E2EE envelope, device Relay credential/presence, terminal session을 추가한다.
- local OCX는 Argon2id + separated HKDF + AES-GCM vault를 만들고 이전 비밀번호를 확인한 로컬 rewrap을 지원한다.
- Gateway는 `relay.opencodexpages.me/_ocxr/agent` outbound WSS와 wildcard workspace API/WS를 제공하며 DB-per-frame 없이 최대 64 KiB 암호문만 전달한다.
- Rust `relay` command는 현재 사용자 권한의 portable PTY, 상호 서명 ephemeral P-256 handshake, 방향별 AES-GCM counter를 구현한다.
- wildcard web workspace는 xterm.js에서 Shell/Codex/Claude profile을 열고 브라우저-Agent 사이 E2EE를 수행한다.
- 기존 Mesh instance는 새 E2EE password를 설정할 때 slug를 보존해 `outbound-relay`로 전환한다. 기존 Cloudflare resource cleanup은 자동으로 수행하지 않는다.
- 로컬 GUI는 연결 컴퓨터, Relay 상태, 이전 비밀번호가 필요한 암호화 password 변경, 사전 빌드 Agent 시작을 표시한다.

현재 검증: root/platform typecheck, GUI/platform production build와 lint, Rust check/build와 6 unit tests, root 전체 `6035 pass / 2 skip / 0 fail`을 통과했다. PostgreSQL 17에 `0003`까지 적용한 통합 테스트는 실제 Gateway, Rust Agent, WebCrypto client, `/bin/sh` portable PTY를 연결해 암호화한 `OCXR_RELAY_OK` 왕복과 누락된 immutable asset의 404 경계까지 `1 test / 87 expects`로 3회 연속 통과했다. 로컬 GUI와 wildcard workspace는 Playwright viewport에서 수평 overflow 없이 확인했다. signed multi-platform Agent packaging과 런타임 fail-closed 검증 코드는 구현했으며 정확한 PR commit의 Actions 6종 통과가 필요하다. 아직 남은 release 차단 조건은 실제 Codex/Claude CLI를 포함한 public 운영 E2E와 운영 backup/deploy/rollback이다. 이 코드는 운영 중앙 서버와 `dev`에 배포하지 않았다.

## 문서와 디자인 자산

- 원 기획서: [PRODUCT_PLAN_v1.md](./PRODUCT_PLAN_v1.md)
- 확정 구현 범위: [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md)
- Instances 승인 이미지: [instances-reference.png](./assets/instances-reference.png)
- Agent 온보딩 승인 이미지: [agent-onboarding-reference.png](./assets/agent-onboarding-reference.png)
- 아키텍처 문서: [../../structure/12_remote-platform.md](../../structure/12_remote-platform.md)
- ADR: [../../structure/adr/0012-remote-private-mesh.md](../../structure/adr/0012-remote-private-mesh.md)

## 구현 완료된 부분

여기서 “완료”는 코드가 작성되고 해당 범위의 로컬 정적 검사 또는 집중 테스트를 통과했다는 뜻이다. 실제 인프라 검증 완료를 뜻하지 않는다.

### 기존 OpenCodex 통합

- `OcxConfig.remoteAccess` 설정 타입과 Zod 검증 추가.
- `X-OpenCodex-Remote-Assertion` 관리 credential class 추가.
- Ed25519 JWT 형식 assertion 검증:
  - `kid`, issuer, audience, instance ID, user ID
  - HTTP method
  - 정규화한 path/query SHA-256
  - 최대 30초 수명, clock skew
  - bounded `jti` replay cache
- 기존 admin token과 로컬 GUI session 인증 흐름 유지.
- 정상·재사용·잘못된 method/path/instance·만료·수명 초과 집중 테스트 추가.
- `ocx gui`에 **Remote** 로컬 시작점을 추가하고 GitHub device approval, 별도 비밀번호, hostname 예약, 중앙 provisioning 상태를 보호된 `remote.json`과 management API로 연결.
- polling secret과 `ocxr_device_` token은 browser DTO에 포함하지 않고 기존 config directory permission hardening과 atomic write를 재사용.

### 중앙 플랫폼 코드 기반

- `platform/`을 기존 npm 배포 패키지와 분리된 private package로 추가.
- Bun + Hono Control Plane, streaming Gateway, PostgreSQL worker entrypoint 추가.
- PostgreSQL 초기 migration 추가:
  - Better Auth users/sessions/accounts/verifications
  - invites, instances, slug tombstones
  - agents, pairing codes, access/authorization/session tokens
  - provisioning jobs, Cloudflare resources, health observations
  - audit logs, abuse reports
- Better Auth + GitHub provider 설정과 GitHub numeric ID 필드 추가.
- GitHub OAuth account create/update hook에서 access/refresh/ID token을 DB 저장 전에 제거해 identity-only 경계로 축소.
- Remote device authorization, 장치별 token 폐기, Argon2id Remote password, 5회 실패/15분 잠금, password 변경 시 instance session 폐기 추가.
- 장치 token으로 hostname/instance를 만들고 provisioning 상태와 10분 Agent pairing code를 로컬 GUI에 반환하는 API 추가.
- 최초 관리자 numeric ID 부트스트랩과 24시간 일회용 초대 소비 로직 추가.
- 사용자당 live instance 1개, 전체 active 사용자 50명 제한 추가.
- 인스턴스 slug 트랜잭션 예약과 provisioning job 생성 추가.
- 12자/10분/1회용 Agent pairing code 추가.
- Ed25519 challenge와 5분 Agent token, heartbeat 기록 추가.
- `ocxr_` 256-bit 데이터 토큰 발급, SHA-256 저장, 30일 만료 추가.
- 브라우저 authorization code → instance session 교환 추가.
- `FOR UPDATE SKIP LOCKED` worker와 provision/suspend/delete job 골격 추가.
- Tunnel secret AES-256-GCM envelope 저장과 audit network HMAC 추가.
- Cloudflare API adapter와 로컬 fake adapter 추가.
- API token과 Global API Key(`X-Auth-Email` + `X-Auth-Key`) 인증을 모두 지원.
- Tunnel 연결 상태는 전용 `/cfd_tunnel/{id}/connections` endpoint만 사용.
- private hostname route는 `/zerotrust/routes/hostname` endpoint 사용.
- Tunnel token 조회는 현재 API의 `GET /cfd_tunnel/{id}/token`을 사용.
- `*.private.remote.opencodexpages.me` DNS-only A record, 고유 RFC1918 `/32`, narrow CIDR activation route를 hostname route보다 먼저 생성.
- suspend/delete 시 hostname route → CIDR route → DNS record → Tunnel 순서로 제거.

### Gateway

- hostname → active instance → owner 상태를 요청마다 DB에서 확인.
- 인증 실패·정지·삭제·다른 사용자 접근은 모두 `404`로 은닉.
- instance session과 `ocxr_` 데이터 토큰을 분리.
- ChatGPT Direct용 Authorization을 보존할 수 있도록 `x-opencodex-remote-token` 보조 입력 지원.
- 30초 Ed25519 request assertion 생성.
- 사용자 Cookie, `Set-Cookie`, proxy/auth control header, Cloudflare 내부 header 제거.
- Fetch body/response streaming, request abort propagation, WebSocket relay 코드 추가.
- PostgreSQL `NOTIFY instance_state`를 통해 suspend/delete 시 진행 중 HTTP 연결 abort.
- response body가 끝나거나 취소될 때까지 HTTP 요청을 추적하고, suspend/delete 시 활성 WebSocket도 함께 종료하도록 lifecycle 보강.
- Gateway synthetic `/healthz` 경로와 health observation 기록 추가.

### Rust Agent

- `remote-agent/` Rust 2024 package와 lockfile 추가.
- Ed25519 키 생성·pairing·challenge 응답·heartbeat 구현.
- Agent config와 Tunnel token을 `0600`으로 원자 저장.
- Control Plane이 배정한 `10.192.0.0/10` `/32`만 허용. privileged `prepare-network`가 `ip address replace ... dev lo`를 수행하고 비특권 `run`은 `<assigned-ip>:10101` local ingress를 실행.
- assertion signature/scope/method/path/time/replay 검증 구현.
- 사용자 control header 제거, Host·Origin loopback 정규화.
- streaming HTTP body와 WebSocket 양방향 relay 구현.
- `cloudflared tunnel --no-autoupdate run --token-file` 자식 감독과 backoff 재시작 구현.
- OpenCodex에 넣을 `remoteAccess` JSON 출력 명령 추가.
- WebSocket handshake key/version/upgrade header를 hop마다 새로 생성하도록 중복 전달 차단.

### Web UI

- React 19 + Vite 기반 `platform/web` 추가.
- 기존 OpenCodex logo와 dark 운영 콘솔 토큰을 재사용.
- 승인 이미지 기반 Instances 목록·상세, 상태 노드, action UI 구현.
- 3단계 instance 생성·Agent pairing·verify 화면 구현.
- Activity, Security, 로그인, 초대 소비, loading/error/empty/mobile 상태 구현.
- New instance, pairing code, open, token 발급, suspend, delete API 연결.
- 개발 demo data mode: `VITE_REMOTE_DEMO=true`.
- production SPA fallback과 미등록 `/api/*`, `/agent/*` JSON 404 경계 검증.
- apex `/`는 local `ocx gui → Remote` 안내로 교체하고 운영 console은 `/admin`으로 분리.
- `/connect/<request>` GitHub 장치 승인과 `/access/<slug>` GitHub 소유권 + Remote password 접속 화면 추가.
- instance Gateway는 무자격 top-level HTML navigation만 central access 화면으로 redirect하고 API/WebSocket은 계속 은닉 `404` 처리.

### PostgreSQL 17 로컬 통합 검증

- migration 17개 테이블 생성과 Better Auth users/sessions/accounts/verifications CRUD 확인.
- 실제 Control Plane·worker·Gateway 자식 프로세스와 fake Cloudflare provider 동시 실행.
- 두 사용자·두 인스턴스 provision, token/session/hostname 격리, Agent assertion scope 오류가 전부 `404`인지 확인.
- HTTP/SSE, WebSocket 양방향 relay, 100 MiB upload/download streaming 확인.
- Gateway 재시작 후 재연결과 suspend `NOTIFY`에 의한 진행 중 stream 취소 확인.
- 중첩 SPA 경로는 production HTML, 미등록 API 경로는 JSON `404`인지 확인.

### 실제 Cloudflare Phase 0 transport

- `opencodexpages.me` active zone과 실제 Zero Trust account API shape 검증.
- DNS-only RFC1918 A record → `/32` CIDR activation route → hostname route → dedicated Tunnel 순서 검증.
- Linux Cloudflare Mesh node `warp-cli 2026.6.880.0`에서 private hostname이 `100.80.0.0/16` synthetic IP로 해석되고 Tunnel origin까지 HTTP 200 확인.
- `cloudflared 2026.3.0`, QUIC 4 connections, 수동 `max-active-flows` override 없이 통과.
- 10회 HTTP 19.37–23.68 ms, 100 MiB download 1.500초, 100 MiB upload 정확한 byte count, SSE smoke, WebSocket echo 통과.
- Tunnel restart 시 active SSE는 약 17.05초에 종료됐고 신규 HTTP data plane은 39.632초에 복구. 최소 60초 health grace 필요.
- 실제 Control Plane/worker가 live Cloudflare 리소스 4개를 만들고 Rust Agent pair, 전용 `/32` loopback bind, 4 Tunnel connections, heartbeat를 확인.
- 실제 Mesh Gateway의 `ocxr_` 요청이 Rust Agent assertion 검증을 거쳐 origin 200을 반환했고 무자격 요청은 404로 은닉.
- Rust Agent 포함 100 MiB download 1.707초, upload 정확한 byte count, SSE smoke, WebSocket echo 통과.
- transport-only 30분 SSE는 rc 0, 1,801초, 정확히 1,800 events로 통과.
- 실제 Rust Agent 포함 30분 SSE도 rc 0, 1,800초, 정확히 1,800 events로 통과.
- 재현 절차와 실패 원인은 [CLOUDFLARE_PHASE0_2026-07-30.md](./CLOUDFLARE_PHASE0_2026-07-30.md)에 기록.

### 중앙 VPS bootstrap 배포

- `opencodexpages.me` → dedicated Cloudflare Tunnel → Control Plane/UI `127.0.0.1:10200` 구성.
- `*.opencodexpages.me` → 같은 Tunnel → isolated Mesh namespace의 Gateway `127.0.0.1:10201` 구성 및 Universal SSL 확인.
- `ocxr` 전용 사용자와 systemd 여섯 서비스 추가: PostgreSQL, Control Plane, worker, Mesh, Gateway, public Tunnel.
- PostgreSQL 17, Mesh, Gateway를 `ocxr-net`에 격리해 기존 VPS host routing과 DNS를 보존.
- root-only systemd credentials와 `/etc/opencodex-remote/cloudflare-state.json` 운영 state 구성.
- apex는 exact-email Cloudflare Access OTP로 닫고 내부 numeric GitHub ID bootstrap은 한 명에게만 허용.
- 실제 worker가 테스트 인스턴스의 Tunnel·DNS·CIDR·hostname route 네 리소스를 생성하고 delete saga가 모두 회수하는지 확인.
- public apex health/UI/asset, wildcard TLS와 무자격 `404`, Mesh 연결 상태를 운영 경로에서 확인.
- 실제 리소스 ID와 재시작/점검 절차는 [PRODUCTION_DEPLOYMENT.md](./PRODUCTION_DEPLOYMENT.md)에 기록.
- `0002_remote_devices.sql`과 local-first landing/approval/access runtime을 운영에 적용. 적용 전 PostgreSQL 17 dump와 `/opt` runtime archive를 생성.
- capability 없는 Gateway가 read-only bind mount를 읽을 수 있도록 운영 source tree `0755/0644` permission 불변조건을 확인.

## 구현 중인 부분

- 실제 Codex/Claude CLI 프로세스를 포함한 outbound E2EE terminal E2E. `/bin/sh` PTY 암호화 왕복은 완료했다.
- outbound Gateway 프로세스 재시작 시 Agent/browser 재접속 측정. 기존 Mesh transport/Rust Agent 30분과 Tunnel 재시작은 완료.
- suspend/delete saga의 Cloudflare 부분 실패 재시도와 orphan reconciliation.
- 최초 서명 bundle이 실 npm dry-run/package와 각 OS에서 설치·시작되는지 확인.
- UI의 keyboard/focus/reduced-motion/zoom 접근성 브라우저 QA. 기본 viewport 시각 QA와 overflow 검사는 완료했다.

## 남은 부분

### P0 — 다음 컴퓨터에서 가장 먼저

- [x] `platform` typecheck/build, root 전체 테스트, Rust fmt/clippy/test 재실행.
- [x] PostgreSQL 17 migration과 Better Auth schema/CRUD 호환 검증.
- [x] 실제 Control Plane·worker·Gateway를 동시에 띄우는 로컬 통합 테스트.
- [x] 실제 Cloudflare Mesh account Phase 0 core transport. DNS, CIDR activation, hostname route, Tunnel, Linux Mesh HTTP/SSE/WS/100 MiB를 확인했다.
- [x] 실제 Mesh/Rust Agent에서 30분 stream. transport와 Agent 경로 모두 1,800 events로 통과했고 Tunnel 재시작은 신규 요청 39.632초 복구로 확인했다.
- [x] 두 사용자·두 인스턴스 교차 hostname/token/session/assertion 접근 `404` 검증.

### P1 — 운영 기능

- [x] native/isolated hybrid systemd unit 여섯 개와 중앙 `cloudflared`, Linux Mesh node 배포.
- [x] Linux/macOS/Windows x64·arm64 native Agent CI/release matrix와 pinned Rust toolchain.
- [x] Agent binary SHA-256 + Ed25519 detached signature, package version·source commit을 묶는 canonical manifest signature, npm prepare/runtime fail-closed 검증.
- suspend 시 hostname/CIDR/DNS를 먼저 제거하고 Cloudflare connector-cleanup API로 모든 연결을 끊은 뒤 Tunnel을 삭제하는 흐름을 실제 활성 Agent에서 확인했다.
- resume 흐름 추가. 현재 suspend worker는 연결 종료를 확실히 하기 위해 Tunnel과 token을 폐기하며 resume은 미구현이다.
- delete saga 단계별 idempotency와 orphan resource reconciler 추가.
- Gateway rate limit, 동시 연결/본문 크기 정책, abuse report/admin UI 추가.
- audit 조회·90일 retention job, 일일 암호화 backup, 7일/4주 retention, restore drill 추가.
- gateway signing key rotation과 Agent key rotation 구현.
- [x] public instance domain `*.opencodexpages.me`, apex ingress, wildcard TLS 구성.
- dedicated GitHub OAuth app 생성 후 production callback과 multi-user cookie 경계 검증. 현재는 exact-email Access OTP single-user bootstrap이다.

### P2 — 제품 마감

- 승인 이미지와 같은 1488×1058 viewport에서 Instances/Onboarding 시각 비교.
- keyboard, focus, reduced motion, zoom, tablet/mobile QA.
- UI에서 실시간 health signal 세부값과 retry 상태 연결.
- [x] 로컬 `ocx gui`가 별도 privileged installer 대신 npm에 동봉된 서명 Agent를 현재 사용자 권한으로 시작.
- 사용자/인스턴스 관리자 정지 화면과 Audit Log/Activity 실제 API 연결.
- [x] CI에 Rust fmt/clippy/test와 Linux musl, macOS, Windows x64·arm64 native build 추가. platform 전체 CI 확대는 별도 운영 시간 판단이 필요하다.
- Cloudflare 다중 사용자 서비스 허용 범위 서면 확인.

## 알려진 차이와 위험

- 원 기획서의 Workers VPC/fallback보다 이후 확정안인 Cloudflare Mesh private hostname route가 우선한다. Mesh 실패 시 자동 fallback하지 않는다.
- private hostname은 `127.0.0.1` hosts가 아니라 DNS-only RFC1918 A record를 사용한다. Agent `prepare-network`는 구현했지만 installer/systemd의 privileged `ExecStartPre`와 비특권 runtime unit은 아직 미구현이다.
- Cloudflare Tunnel, DNS, CIDR route, hostname route create/delete와 token GET 응답 shape를 live account로 검증했다.
- Gateway synthetic token과 signing key를 포함한 credential은 root-only systemd/container credential mount로 배포했다.
- Better Auth의 GitHub OAuth account token은 DB hook에서 저장 전에 제거한다. callback 성공과 재로그인 후에도 `accounts.access_token`, `refresh_token`, `id_token`이 NULL인지 운영 전환 시 다시 확인한다.
- Gateway와 Rust Agent는 100 MiB 양방향 streaming, SSE/WS, 30분 stream을 통과했다. 실제 OpenCodex process와 public ingress를 포함한 부하·backpressure는 아직 측정하지 않았다.
- private transport DNS는 Phase 0에서 검증했고 public wildcard ingress와 TLS도 운영 배포에서 확인했다. dedicated GitHub OAuth app이 없어 `opencodex.me`와 `opencodexpages.me`의 production OAuth/cookie 분리는 아직 검증하지 않았다.

## 현재까지 확인된 검증

```text
PASS  bun run typecheck                         (root)
PASS  bun test tests/server-management-auth.test.ts
      16 tests / 56 expects
PASS  bun test --isolate tests
      6035 pass / 2 skip / 0 fail / 30582 expects
PASS  bun run privacy:scan
PASS  cd gui && bun run lint && bun test tests && bun run build && bun run doctor
      385 pass / 0 fail / 1663 expects; React Doctor 0 issues
PASS  cd platform && bun run typecheck
PASS  cd platform && bun test server/tests/cloudflare.test.ts
      5 tests / 22 expects
PASS  cd platform && CLOUDFLARE_LIVE_TESTS=true ... \
      bun test server/tests/cloudflare-live.test.ts
      1 test / 7 expects, live create/delete cleanup
PASS  cd platform && VITE_REMOTE_DEMO=true bun run build:web
PASS  cd platform && PLATFORM_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55432/postgres \
      bun test server/tests/postgres-integration.test.ts
      1 test / 87 expects, PostgreSQL 17; real Gateway + Rust Agent + WebCrypto + PTY relay
PASS  cd remote-agent && cargo fmt --check
PASS  cd remote-agent && cargo check
PASS  cd remote-agent && cargo clippy --all-targets --all-features -- -D warnings
PASS  cd remote-agent && cargo test
      6 Rust unit tests
PASS  Playwright visual smoke
      local Remote GUI and wildcard workspace; no horizontal overflow
PASS  cd docs-site && bun run build
      146 pages with localized Remote GUI and CLI documentation
```

운영 bootstrap에서 추가로 통과한 항목:

- systemd 여섯 서비스 enabled/active와 재시작 후 health
- public apex Access redirect, service-token 기반 health/UI/asset 200 검증 후 임시 token/policy 삭제
- public first-level wildcard TLS와 무자격 404
- production worker create/delete Cloudflare 리소스 회수

아직 통과로 간주하면 안 되는 항목:

- 실제 Gateway 프로세스 재시작 측정
- 실제 OpenCodex process와 public ingress를 포함한 HTTP/SSE/WebSocket 운영 E2E
- 시각 QA와 접근성 브라우저 QA
- PostgreSQL backup/restore drill

## 다른 컴퓨터에서 재개

```bash
git fetch origin
git switch ingw/remote-outbound-e2ee

bun install --frozen-lockfile
bun run typecheck
bun test tests/server-management-auth.test.ts

cd gui
bun install --frozen-lockfile
cd ..
bun test --isolate tests

cd platform
bun install --frozen-lockfile
bun run typecheck
VITE_REMOTE_DEMO=true bun run build:web

docker run --name ocx-remote-pg17 -e POSTGRES_HOST_AUTH_METHOD=trust \
  -p 127.0.0.1:55432:5432 -d postgres:17-alpine
PLATFORM_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55432/postgres \
  bun test server/tests/postgres-integration.test.ts

cd ../remote-agent
cargo fmt --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test
```

UI demo는 `http://127.0.0.1:4173`에서 확인한다. production 실행에는 PostgreSQL URL, GitHub OAuth, Better Auth secret, Gateway Ed25519 key, AES key, audit HMAC key, synthetic health token이 필요하다. 환경 변수와 credential 이름은 `platform/server/src/config.ts`가 현재 기준이다.
