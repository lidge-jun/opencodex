# OpenCodex Remote 비공개 MVP 확정 구현 계획

> 2026-07-30 변경: 신규 Remote workspace의 transport와 암호화 기준은 [ADR 0013](../../structure/adr/0013-remote-outbound-e2ee-relay.md)이다. 아래 Mesh 계획은 이미 배포된 private-MVP rollback 경로와 검증 기록으로만 유지한다.

이 문서는 원 기획서 이후 확정된 구현 기준을 요약한다. 세부 제품 배경은 [PRODUCT_PLAN_v1.md](./PRODUCT_PLAN_v1.md), 현재 코드 상태는 [IMPLEMENTATION_STATUS.md](./IMPLEMENTATION_STATUS.md)를 따른다.

## 목표 구조

```text
Browser / CLI
  → Cloudflare public ingress
  → VPS Auth Gateway
  → Cloudflare Mesh private hostname route
  → per-instance Tunnel
  → Rust Agent assigned RFC1918 loopback:10101
  → OpenCodex 127.0.0.1:10100
```

- 사용자 Tunnel에는 공개 hostname을 만들지 않는다.
- `*.instance-domain`은 언제나 중앙 Gateway로 향한다.
- Gateway만 DB의 추측 불가능한 private hostname을 목적지로 사용한다.
- 중앙 Control Plane과 worker는 전용 `ocxr` 사용자로 native systemd 운영한다. 공유 VPS의 host routing을 보호하기 위해 PostgreSQL, Cloudflare Mesh, Gateway는 별도 Docker network namespace에 격리하고 모두 systemd가 수명주기를 관리한다.
- private hostname은 `*.private.remote.opencodexpages.me` DNS-only A record로 인스턴스별 `10.192.0.0/10` `/32`를 가리킨다.
- 같은 `/32` CIDR activation route와 hostname route를 dedicated Tunnel에 연결하며, Agent는 그 주소를 `lo`에만 할당한다.

[Decision Log]
- 목적과 의도: live Cloudflare Mesh에서 검증된 hostname routing 전제조건을 프로비저닝과 Agent에 고정한다.
- 기존 구현 및 제약 조건: `127.0.0.1` hosts 해석과 hostname route 단독 구성은 실제 account에서 TCP data plane을 열지 못했다.
- 검토한 주요 대안: public Tunnel route, LAN listener, custom resolver, 고유 RFC1918 loopback alias.
- 선택한 방식: DNS record 생성 후 `/32` activation route와 hostname route를 만들고 Agent가 alias를 loopback에 bind한다.
- 다른 대안 대신 이 방식을 선택한 이유: public service exposure 없이 Mesh synthetic IP와 Tunnel origin resolution이 모두 통과했다.
- 장점, 단점 및 영향: provisioning/deletion saga가 네 Cloudflare 리소스를 다룬다. 별도 `prepare-network` 단계만 root 또는 `CAP_NET_ADMIN`이 필요하고 장시간 Agent runtime은 비특권으로 실행한다.

[Decision Log]
- 목적과 의도: 기존 TeamWicked 서비스가 함께 있는 중앙 VPS에 Mesh를 배포하되 host network namespace의 route와 DNS를 바꾸지 않는다.
- 기존 구현 및 제약 조건: 초기 문서는 중앙 구성요소 전체를 native systemd로 가정했지만 Cloudflare Mesh client는 kernel route와 resolver를 관리한다.
- 검토한 주요 대안: host-native Mesh, 별도 VPS, 모든 구성요소의 containerization, Mesh와 Gateway만 network namespace를 공유하는 hybrid 배포.
- 선택한 방식: Control Plane과 worker는 native로 유지하고 PostgreSQL·Mesh·Gateway를 고정 Docker network에 격리하며 systemd가 여섯 서비스를 관리한다.
- 다른 대안 대신 이 방식을 선택한 이유: 기존 VPS의 Cloudflare Tunnels와 management traffic을 변경하지 않으면서 Gateway만 Mesh 경로를 사용할 수 있다.
- 장점, 단점 및 영향: host 영향 범위가 작고 재시작 경계가 명확하지만 Docker가 운영 의존성에 추가되며 Gateway는 Mesh 컨테이너와 함께 재시작해야 한다.

## 보안 기준

- GitHub OAuth와 24시간 일회용 초대만 허용한다.
- 최초 관리자는 GitHub numeric ID로 부트스트랩한다.
- official domain과 instance domain은 registrable domain을 분리한다.
- 플랫폼과 인스턴스 쿠키는 `__Host-`, HttpOnly, Secure, SameSite=Lax다.
- Agent pairing code는 12자, 10분, 1회용이다.
- Agent는 Ed25519 challenge 후 5분 token을 사용한다.
- CLI token은 `ocxr_` 256-bit, 30일 기본 만료, SHA-256만 저장하며 `/v1/*`만 허용한다.
- Gateway assertion은 Ed25519, 30초이며 instance/user/method/path hash/iat/exp/jti/kid를 포함한다.
- Agent가 assertion과 replay를 검증하고 OpenCodex가 `/api/*`에서 다시 검증한다.
- Prompt, response, repository, provider credential, OpenCodex 설정 본문은 중앙 수집 대상이 아니다.

## 상태와 lifecycle

```text
pending → provisioning → awaiting_agent → connecting → online
                                                └────→ degraded/offline
online/degraded/offline → suspending → suspended
any live state → deleting → deleted
                         └→ delete_failed → retry
```

- online은 90초 이내 Agent OpenCodex health, dedicated Tunnel connections, Gateway synthetic health가 모두 정상일 때만 표시한다.
- 정지는 DB 차단과 active connection abort를 먼저 수행한다.
- 삭제는 재시도 가능한 saga이며 slug는 30일 tombstone으로 보존한다.
- job claim은 PostgreSQL `FOR UPDATE SKIP LOCKED`와 idempotency key를 사용한다.

## 실행 단계

1. Phase 0: 실제 Mesh/private hostname protocol, HTTP/SSE/WS/long stream/cancel/100 MiB/restart/격리 PoC.
2. Phase 1: PostgreSQL, Better Auth, invite, instance lifecycle, Gateway, tokens, suspend/delete.
3. Phase 2: Rust Agent, OpenCodex assertion 통합, signed installer와 musl artifacts.
4. Phase 3: Instances, onboarding, Activity, Security, Audit/admin UI.
5. Phase 4: live E2E, backup/restore, key rotation, abuse runbook, CI gates, 최대 50명 private beta.

Mesh PoC가 하나라도 실패하면 보안 수준을 낮추거나 Workers VPC/자체 reverse tunnel로 자동 전환하지 않고 MVP를 중단해 transport를 다시 설계한다.
