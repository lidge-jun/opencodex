# 260914 L5 — provider account lifecycle edges (#4503, #3781)

R1 라운드의 L5 레인. 계정 수명주기 경계에서 생긴 두 건을 한 PR로 닫는다.
분기: `codex/260914-l5-provider-account-edges`, 타깃 `dev`.

## 다루는 것

- **#4503** Devin 프로바이더 병합 마이그레이션이 남긴 host-selection 창.
  config 저장은 동기인데 credential rekey는 detached라, 그 사이(그리고 rekey가
  실패하거나 collision으로 거부되면 그 프로세스 내내) EU/FedStart 테넌트가 US
  기본 호스트로 키를 보낸다.
- **#4503 부록** 같은 감사에서 함께 기록된 커버리지 공백. Pi-shape 이미지 파트의
  tool 경로가 합성으로만 덮여 있어, tool 분기 한정 회귀는 잡히지 않는다.
- **#3781** Antigravity 할당량 갱신 실패. canonical Fake-IP 처리 가설을 실제
  소스에서 확인하고, 남은 구멍과 커버리지를 메운다.

## 레인 경계

쓰기 가능: `src/oauth/devin.ts`, `src/providers/quota.ts`의 Antigravity 블록,
그리고 위 서브시스템의 테스트.

쓰면 안 되는 것: account pool 커널, `src/codex/routing.ts`,
`src/server/responses/*`, `src/codex/catalog/*`, `src/adapters/cursor/*`, `gui/`.
같은 라운드의 다른 레인이 별도 워크트리에서 그 경로들을 소유한다.

## 검증 방침

로컬 스위트/타입체크/설치는 레인 제약으로 **실행하지 않는다**. `node_modules`도
없다. 증거는 최종 head의 hosted CI 하나뿐이다. 그래서 구현은 타입체커 대신
기존 파일의 import 경로/타입 이름/strict null 처리를 그대로 맞추는 방식으로 간다.

## 작업 단위

- `010_wp1_account_lifecycle_edges.md` — 단일 work-phase. 여섯 개 서브에이전트에
  서로 겹치지 않는 write scope를 배정해 병렬로 구현한다.
