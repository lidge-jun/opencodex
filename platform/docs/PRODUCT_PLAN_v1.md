# OpenCodex Remote Access Platform

> Self-hosted OpenCodex 원격 접속·관리 플랫폼 기획서

| 항목 | 내용 |
|---|---|
| 버전 | v1.0 Final |
| 작성일 | 2026-07-29 |
| 상태 | 조건부 승인 |
| 초기 대상 | 초대 기반 비공개 베타 |

---

## 1. 결론

이 계획은 **비공개 MVP로 실현 가능**하다.

다만 사용자 서브도메인을 Cloudflare Tunnel에 직접 연결하지 않고, 모든 요청을 OpenCodex가 관리하는 Gateway에서 인증한 뒤 비공개 Tunnel로 전달해야 한다.

```text
권장:
사용자 → OpenCodex Auth Gateway → Private Tunnel → 사용자 OpenCodex

비권장:
사용자 → Public Tunnel → 사용자 OpenCodex
```

### 핵심 결정

| 항목 | 결정 |
|---|---|
| 도메인 | 공식 서비스와 사용자 인스턴스 분리 |
| 트래픽 진입점 | OpenCodex Auth Gateway |
| Tunnel | MVP에서 `1 Instance = 1 Tunnel` |
| Tunnel 공개 | 공개 hostname을 직접 연결하지 않음 |
| 접근 범위 | Private only |
| Agent 등록 | 짧은 수명의 페어링 코드 |
| Cloudflare Access | 기본안에서 제외, 서면 허가 시에만 검토 |
| Harness·범용 Shell | MVP 제외 |

### 진행 조건

- Cloudflare 계정 권한은 Control Plane만 보유한다.
- 사용자 서버와 Agent가 보내는 정보는 신뢰하지 않는다.
- 공개 출시 전 Cloudflare의 상용·다중 사용자 이용 조건을 서면으로 확인한다.
- Workers VPC의 스트리밍·WebSocket 호환성을 PoC로 검증한다.

---

## 2. 목표와 MVP 범위

### 목표

사용자가 자신의 서버에서 실행하는 OpenCodex를 포트포워딩, 고정 공인 IP, 직접 TLS 설정 없이 전용 주소로 접속하고 중앙 대시보드에서 관리할 수 있도록 한다.

```text
https://<instance>.<instance-domain>
```

### 포함

- 이메일 또는 OAuth 로그인
- 인스턴스 생성·삭제
- 서브도메인 자동 발급
- Tunnel과 private route 자동 생성
- Linux Agent 설치·페어링
- OpenCodex Auth Gateway
- Heartbeat, Tunnel 상태, 외부 Health Check
- 인증 정보 회전·폐기
- 관리자 정지, Audit Log, Abuse 신고

### 제외

- Public·Link Access 인스턴스
- 범용 Tunnel·웹 호스팅
- SSH·웹 터미널·범용 Shell
- Harness와 작업 큐
- 팀·조직·결제·SSO
- 사용자 지정 도메인
- Windows·macOS Agent
- 자체 Reverse Tunnel 프로토콜

---

## 3. 권장 아키텍처

```text
[사용자 브라우저]
        │
        ▼
[Cloudflare Edge]
        │
        ▼
[OpenCodex Auth Gateway]
- 로그인 검증
- 인스턴스 소유권 확인
- Rate Limit
- 요청 크기 제한
- Audit Log
        │
        ▼
[Private Routing]
예: Cloudflare Workers VPC
        │
        ▼
[인스턴스 전용 Cloudflare Tunnel]
        │
        ▼
[사용자 서버의 cloudflared]
        │
        ▼
[127.0.0.1의 OpenCodex Server]
```

관리 통신은 별도로 구성한다.

```text
OpenCodex Agent → Control Plane API
```

### 구성요소

| 구성요소 | 역할 |
|---|---|
| OpenCodex Web | 로그인, 인스턴스·상태·보안 설정 |
| Auth Gateway | 사용자 인증, 인스턴스 권한 확인, 트래픽 정책 강제 |
| Control Plane | Cloudflare API, Agent 등록, 정지·삭제·감사 로그 |
| OpenCodex Agent | Heartbeat, 로컬 상태 확인, Connector 관리 |
| Cloudflare Tunnel | 사용자 서버에서 Cloudflare로 아웃바운드 연결 |
| Private Routing | Gateway에서 해당 Tunnel로만 비공개 전달 |
| OpenCodex Server | `127.0.0.1`에 바인딩된 실제 애플리케이션 |

### Gateway 라우팅 원칙

```text
<instance>.ocx.run
→ Gateway가 hostname 확인
→ 로그인 사용자와 instance owner 비교
→ DB에 저장된 내부 목적지 조회
→ Private Tunnel로 전달
```

사용자 입력 URL이나 IP를 내부 목적지로 직접 사용하지 않는다. Gateway는 Control Plane이 생성한 고정 매핑만 사용해야 한다.

### Workers VPC 사용안

PoC에서는 하나의 Gateway Worker를 Private Network에 연결하고, 인스턴스별 private hostname 또는 VPC Service를 통해 해당 Tunnel로 라우팅한다.

Workers VPC는 현재 Beta이므로 다음 항목이 실패하면 자체 Gateway 또는 Reverse Tunnel 구조로 전환한다.

- SSE·HTTP 스트리밍
- WebSocket Upgrade
- 장시간 연결
- 요청·응답 크기
- 다지역 지연시간
- 장애 후 재연결

---

## 4. 도메인과 인증

### 도메인 분리

실제로 소유한 도메인이 확정되기 전까지 특정 도메인을 전제로 하지 않는다.

```text
공식 서비스:
app.<official-domain>
api.<official-domain>
auth.<official-domain>

사용자 인스턴스:
<instance>.<instance-domain>
예: <instance>.ocx.run
```

사용자 콘텐츠를 `<instance>.opencodex.com`처럼 공식 서비스와 같은 상위 도메인에서 제공하지 않는다. 사용자 서버가 임의 응답을 반환할 수 있어 피싱, 쿠키, OAuth, 도메인 평판 문제가 공식 서비스까지 번질 수 있다.

### 세션 정책

- 공식 대시보드 쿠키는 Host-only로 설정한다.
- 인스턴스 접속 세션은 사용자 콘텐츠 도메인용으로 분리한다.
- Gateway는 세션 사용자와 요청 hostname의 소유자를 매번 확인한다.
- 사용자 서버에는 공식 세션과 Refresh Token을 전달하지 않는다.

### 서브도메인 정책

- 영문 소문자, 숫자, 하이픈만 허용한다.
- 한 단계 서브도메인만 제공한다.
- `login`, `auth`, `admin`, `billing`, `support`, `official`, `verify`, `status`, `api`, `www` 등을 예약한다.
- `login-*`, `verify-*`, `account-*`, `support-*` 등의 사칭 패턴도 차단한다.

---

## 5. 인스턴스 생성과 연결

### 생성 흐름

1. 사용자 권한을 확인한다.
2. 서브도메인을 검증·예약한다.
3. `pending` 인스턴스를 생성한다.
4. 인스턴스 전용 Cloudflare Tunnel을 생성한다.
5. private hostname 또는 VPC Service를 생성한다.
6. 공개 hostname과 내부 목적지의 매핑을 저장한다.
7. 사용자에게 Agent 설치 절차를 표시한다.

사용자 Tunnel에는 공개 DNS route를 직접 만들지 않는다. 공개 주소는 항상 Gateway로 향한다.

### Agent 페어링

```text
1. 사용자가 Agent 설치
2. Agent가 짧은 수명의 페어링 코드 생성
3. 사용자가 대시보드에서 승인
4. Agent가 키 쌍 생성 후 공개키 등록
5. Control Plane이 Agent 인증 정보와 Tunnel Token 전달
6. Agent와 cloudflared를 시스템 서비스로 등록
```

장기 비밀값을 명령행 인자나 Shell history에 남기지 않는다.

### 설치 원칙

- Agent는 전용 OS 사용자로 실행한다.
- 인증 파일은 관리자만 읽을 수 있도록 제한한다.
- OpenCodex는 `127.0.0.1`에 바인딩한다.
- 바이너리는 서명 또는 체크섬으로 검증한다.
- `curl | sh`는 편의 래퍼로만 제공하고 원문과 무결성 정보를 공개한다.

### 온라인 판정

```text
Agent Heartbeat 정상
AND Tunnel Connector 정상
AND Gateway를 통한 /healthz 성공
= online
```

일부만 정상인 경우 `degraded`, 일정 시간 모두 확인되지 않으면 `offline`으로 표시한다.

---

## 6. 보안·악용 대응

사용자 서버는 완전한 비신뢰 환경이다. 서버 소유자는 Agent, Connector, OpenCodex와 응답 내용을 수정할 수 있다.

| 위험 | 대응 |
|---|---|
| 임의 콘텐츠 반환 | Private only, 모든 요청을 Gateway에서 인증 |
| 공식 서비스 사칭 | 공식·사용자 도메인 분리, 예약어 차단 |
| Cloudflare API 유출 | Control Plane의 Secret Manager에만 저장 |
| Tunnel Token 유출 | 인스턴스별 분리, 회전·폐기·연결 종료 기능 |
| Agent 위조 | 인스턴스별 키, 짧은 수명 Token, 재등록 시 기존 인증 폐기 |
| 상태 조작 | Agent 보고값과 Provider·Gateway 검증값 분리 |
| SSRF·교차 인스턴스 접근 | 고정 목적지 매핑만 사용, 사용자 입력 목적지 금지 |
| 트래픽 남용 | 요청·동시 연결·본문·응답·WebSocket·사용량 제한 |

### 즉시 정지 절차

1. Gateway 라우팅 차단
2. private route 또는 VPC Service 비활성화
3. Tunnel Token 회전·폐기
4. 활성 Connector 연결 종료
5. Agent 인증 폐기
6. 인스턴스·계정 정지
7. 관련 Audit Log 보존

### 운영 정책

- 초대받은 사용자만 가입
- 사용자별 인스턴스 수 제한
- OpenCodex와 무관한 웹 호스팅 금지
- 피싱, 악성코드, 스팸, 공개 프록시, 불법 콘텐츠 금지
- Abuse 신고 페이지와 관리자 긴급 정지 기능 운영

Repository, 프롬프트, 생성 결과물은 Harness 도입 전까지 기본 수집 대상에 포함하지 않는다.

---

## 7. Cloudflare 의존성과 한계

### 기본 한도

2026-07-29 기준 공식 문서의 기본 한도다.

| 리소스 | 기본 한도 |
|---|---:|
| Cloudflare Tunnel | 계정당 1,000개 |
| Tunnel·Mesh Route | 계정당 1,000개 |
| Workers VPC Service | 계정당 1,000개 |
| Cloudflare Access Application | 계정당 500개 |

따라서 `1 Instance = 1 Tunnel`은 초기 베타에는 적합하지만 대규모 서비스의 최종 구조는 아니다.

### 계약상 주의

Cloudflare Zero Trust 약관은 서면 허가 없는 제3자 재판매를 제한한다. Cloudflare Access를 사용자별 인증 기능으로 제공하려면 사전 서면 허가가 필요하다.

Workers VPC와 Tunnel을 SaaS 내부 연결 계층으로 사용하는 구조도 공개·유료 출시 전에 Cloudflare에 서비스 형태, 허용 범위, 필요한 플랜을 확인한다.

### API 주의

Cloudflare는 **2026-10-05**부터 Tunnel list/get 응답의 `connections` 필드를 제거할 예정이다. 처음부터 다음 전용 endpoint를 사용한다.

```text
GET /accounts/{account_id}/cfd_tunnel/{tunnel_id}/connections
```

---

## 8. 개발 단계

### 0단계 — 기술 PoC

- Tunnel 생성·삭제·Token 회전 자동화
- private route 또는 VPC Service 자동 생성·삭제
- Gateway 인증과 인스턴스 격리
- SSE·WebSocket·스트리밍 테스트
- Token 유출 후 회전과 연결 종료
- Cloudflare 상용·다중 사용자 조건 확인

**통과 기준:** 다른 사용자의 인스턴스와 정지된 인스턴스에 접근할 수 없고, OpenCodex의 실시간 기능이 정상 동작해야 한다.

### 1단계 — 비공개 MVP

- 계정·인스턴스 관리
- Linux Agent 페어링
- Tunnel·private route 프로비저닝
- Gateway 인증·권한 검사
- 상태 확인, 재연결, 정지·삭제
- Audit Log와 Abuse 대응

### 2단계 — 공개 출시 준비

- Rate Limit과 사용량 제한
- 약관·개인정보·Abuse 절차
- 모니터링, 알림, 백업, 장애 대응
- Cloudflare 계약·플랜 확정
- Workers VPC 유지 또는 자체 Reverse Tunnel 전환 결정

### 3단계 — Harness·팀 기능

- 작업 큐, 실시간 로그, 작업 취소
- 컨테이너 또는 별도 샌드박스
- 실행 시간·출력·동시 작업·네트워크 제한
- Organization, 역할 기반 권한, SSO, 결제

범용 Shell은 기본 제공하지 않는다.

---

## 9. 출시 전 체크리스트

- [ ] 공식 도메인과 사용자 콘텐츠 도메인을 실제로 소유하고 있는가?
- [ ] 사용자 Tunnel에 외부 공개 route가 없는가?
- [ ] Gateway가 사용자와 인스턴스 소유자를 매 요청마다 검증하는가?
- [ ] 사용자 입력으로 내부 목적지를 지정할 수 없는가?
- [ ] Tunnel, route, Agent 인증을 한 번에 폐기할 수 있는가?
- [ ] 삭제 실패와 고아 Cloudflare 리소스를 탐지·재처리할 수 있는가?
- [ ] `online` 상태가 Agent 자체 보고에만 의존하지 않는가?
- [ ] SSE·WebSocket·스트리밍이 실제 OpenCodex에서 정상 동작하는가?
- [ ] Cloudflare의 상용·다중 사용자 이용 조건을 서면 확인했는가?
- [ ] Abuse 신고, 긴급 정지, 로그 보존 절차가 준비됐는가?
- [ ] 설치와 업데이트의 서명·체크섬 검증이 가능한가?
- [ ] Harness가 원격 접속 MVP와 분리돼 있는가?

---

## 최종 권장 구조

```text
공식 서비스
- app.<official-domain>
- api.<official-domain>
- auth.<official-domain>

사용자 주소
- <instance>.<instance-domain>
- 모든 요청은 OpenCodex Auth Gateway로 전달

중앙 시스템
- Auth Gateway
- Control Plane
- Cloudflare API
- 상태 검증·Audit Log·Abuse 대응

사용자 서버
- OpenCodex Server: 127.0.0.1
- OpenCodex Agent: 최소 권한
- cloudflared: 인스턴스 전용 Token
- 공개 hostname 없음
```

**최종 결론:** 초대 기반 비공개 베타는 진행할 가치가 있다. 사용자 Tunnel을 직접 공개하지 않고 OpenCodex Auth Gateway를 반드시 앞단에 둔다. Workers VPC는 빠른 PoC에 적합하지만 Beta이므로 실시간 통신과 계약 조건을 검증한 뒤 유지 여부를 결정한다.

---

## 참고 자료

- Cloudflare Tunnel API: <https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel-api/>
- Tunnel Permissions: <https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/remote-tunnel-permissions/>
- Cloudflare Workers VPC: <https://developers.cloudflare.com/workers-vpc/>
- Workers VPC Networks: <https://developers.cloudflare.com/workers-vpc/configuration/vpc-networks/>
- Workers VPC Limits: <https://developers.cloudflare.com/workers-vpc/reference/limits/>
- Cloudflare One Account Limits: <https://developers.cloudflare.com/cloudflare-one/account-limits/>
- Cloudflare Tunnel Changelog: <https://developers.cloudflare.com/cloudflare-one/changelog/tunnel/>
- Cloudflare Zero Trust Terms: <https://www.cloudflare.com/service-specific-terms-zero-trust-services/>
