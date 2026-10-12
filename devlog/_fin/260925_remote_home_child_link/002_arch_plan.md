# 020 — 아키텍트 제안 처분과 실행 계획 (Plan r1)

아키텍트: read-only 서브에이전트 Poincare (agent 01a0d46e-37da-7bf1-be5d-e22ac114f6cc, 상속 모델). 제안 AR-1..AR-12 원문 요지는 아래 표의 "제안" 열. 처분은 메인이 결정.

## 처분

| ID | 제안 | 처분 |
|---|---|---|
| AR-1 | `src/link/ssh-argv.ts`: tunnel/exec/probe argv, BatchMode, StrictHostKeyChecking=yes, 링크 전용 known_hosts 우선, ExitOnForwardFailure, ServerAlive, ControlMaster=no, ForwardAgent=no, 바인드 항상 127.0.0.1:P:127.0.0.1:L | 수정 수용. 지문 수집은 `-v` 출력 파싱 대신, 빈 임시 known_hosts + `StrictHostKeyChecking=accept-new` + 원격 명령 `true`로 한 번 접속해 임시 파일에 기록된 키를 `ssh-keygen -lf`로 읽는다(OpenSSH 버전별 로그 형식 의존 제거). 사용자가 확인하면 그 줄을 링크 known_hosts로 옮긴다 |
| AR-2 | `ssh-config.ts` 후보 파서(와일드카드·Match 제외, Include 추적) | 수용 |
| AR-3 | `tunnel-state.ts` 순수 리듀서, 상태 idle/connecting/connected/reconnecting/failed, 지터 백오프, 5분 또는 auth/hostkey → failed | 수용 |
| AR-4 | `store.ts` `<configDir>/link/links.json` 0600, 디렉터리 0700, 비밀 없음, `hasLinks()` 동기 게이트 | 수용 |
| AR-5 | `"hub-link"` ingress, Claude intercept 수명 관리를 `src/server/index/optional-listeners.ts`로 합쳐 index.ts 순증 0줄, 바인드 실패는 경고 | 수용 |
| AR-6 | `linkRouteAllowed` 기본 거부, /v1 데이터 + catalog/hub-state/usage + readyz만. /v1/hub-state는 hub 역할 또는 hub-link 입구에서 허용 | 수용 |
| AR-7 | 센티널 hostname 정책으로 키 인증 강제, 키는 links.json에 기록된 id만 | 수용 + 강화: 링크 입구에서는 환경 변수 데이터 토큰도 받지 않는다. 모든 허용 경로에 키 없이 401, 다른 키로 401 테스트 |
| AR-8 | `tests/link/core-link-boundary.test.ts`, 동적 import만 허용 | 수용, 경로는 `tests/lab/core-link-boundary.test.ts`(감사 처분) |
| AR-9 | `OcxClientConnectionConfig.transport?: "hub"|"link"`, `link?: {tunnelPort, linkId}`, 스키마 superRefine, 소비자 분기 | 수용 |
| AR-10 | machine listener link 모드 /v1 중계, 자격 증명 추가 없음, 연결 거부 시 503 + Retry-After | 수용. WebSocket 불필요 여부는 L3에서 확인 |
| AR-11 | `ocx link issue`는 실행 중인 허브의 로컬 관리 API를 거쳐 키 발급, stdout으로만 출력 | 수용 |
| AR-12 | 허브 프로세스가 ssh 터널 감독, pid 파일로 고아 정리, L 고정, P는 프로브 때 원격 `ocx link port`로 선택, /api/link/* 정식 세션 전용 | 수용 |
| 역할 | runtimeRole=hub 승격 안 함, `linkHostActive` 술어 사용 | 수용. PRD D1 보강 |
| 대안 | 양방향 모두 클라이언트 소유 -L | 기각(허브 시작 전제 D3와 충돌). L6만 클라이언트 소유 -L |

## 실행 순서 (스택, 각 레이어 = PABCD 1사이클)

| wp | 레이어 | 파일 변경 | 수락 기준 (활성화 시나리오 → 관찰 증거) |
|---|---|---|---|
| wp1 | L1 core | 신규 `src/link/{ssh-argv,ssh-config,tunnel-state,store,paths}.ts`, `tests/clients/link-*.test.ts`(감사 처분으로 변경), `structure/remote-link.md` + manifest 소유, layout.json·test-layout-expected.json 등록, 이 devlog | argv에 BatchMode/StrictHostKeyChecking=yes/127.0.0.1 바인드 고정(단위 테스트). 와일드카드 Host 제외, Include 추적. 리듀서: auth 실패 exit → failed{auth}, 5분 경과 tick → failed{timeout}, ready → connected. store: 0600 기록·손상 파일은 빈 목록이 아니라 오류. `bun run typecheck`, 대상 테스트, `bun run structure:check`, layout 테스트 |
| wp2 | L2 listener | `src/server/index/optional-listeners.ts`, `src/server/index/link-listener.ts`, `serve-options.ts` ingress·정책, `auth-cors.ts` 링크 정책, `src/server/index.ts`(순증 0) | 링크 없음 → 리스너 미바인드. 링크 있음 → 127.0.0.1:L 바인드, 키 없이 /v1/responses 401, 기록된 키 200, /api/* /opencodex-session / 는 404. 코어 경계 테스트 |
| wp3 | L3 client | `src/types/config.ts`, 스키마, `src/client/connect.ts` 자격 전략 분리, `machine-listener.ts` 중계(`src/cli/link.ts` issue/port와 capabilities는 wp4로 이동, 아래 처분 6) | connect --link 후 Codex 라우팅 localhost:10100, 해제 후 파일 동일(S4), 터널 없음 → 503 |
| wp4 | L4 API | `src/link/supervisor.ts`, `src/server/management/link-routes.ts`, route-registry | 정식 세션 없으면 403, 적용 흐름 목 ssh로 순서 검증, 재시작 고아 정리 |
| wp5 | L5 GUI | `gui/src/pages/RemoteLink.tsx` 등, i18n 10개, docs-site | 화면 테스트, 스크린샷 |
| wp6 | L6 client-initiated | 클라이언트 쪽 "홈 찾기", -L 감독자 | standalone일 때만 노출 |

## 우회 경로 기록 (PLAN-BYPASS-NAMED-01)

- 링크 입구 인증(E-서버 코드): 우회 경로 = 허브 기계의 로컬 프로세스가 기본 루프백 리스너(10100)로 직접 요청. 잔여 위험 = 기존과 동일(허브 로컬 신뢰). 링크는 그 신뢰를 자식에게 넓히지 않는다.
- 호스트 키 확인(E-서버 코드 + UI): 우회 = 사용자가 ~/.ssh/known_hosts에 직접 키를 넣으면 확인 단계 없이 통과. 의도된 동작.

## SoT 동기화 대상

`structure/remote-link.md` 신규 + `structure/manifest.json` 소유 등록, `structure/runtime.md`의 ingress 목록(wp2).


## 아키텍트 반영 확인 (같은 아키텍트, ALIGNED) — 빠진 항목 처분

| # | 빠진 항목 | 처분 |
|---|---|---|
| 1 | 프로브에 GlobalKnownHostsFile=/dev/null, HostKeyAlias/비표준 포트([host]:port) 처리, 확인 전 키 인증 진행 | wp1 argv에 반영. 확인 전 인증 진행은 우회 기록에 추가: 프로브는 원격 명령 `true`만 실행하고 결과를 신뢰하지 않는다 |
| 2 | 환경 변수 토큰 배제 방법 | wp2: `resolveDataPlaneAdmissionSecret`에 제한 전용 옵션(`linkIngress`) 추가. 보안 검토 대상 |
| 3 | wp2 수락 기준에 /v1/hub-state, /readyz 링크 메타데이터, index.ts 줄 수 | wp2 수락 기준에 추가 |
| 4 | 첫 링크 추가 시 재시작 없는 리스너 활성화, 종료 훅 | wp2: `ensureStarted()` 단위 테스트, wp4: 적용 흐름에서 호출·종료 훅 테스트 |
| 5 | wp3 소비자 분기(rotate/revoke 거부, 허브 중계 끔, Claude desktop 소유자) | wp3 수락 기준에 추가 |
| 6 | `ocx link issue`가 links.json 기록을 필요로 하는데 쓰는 라우트는 wp4 | `ocx link issue`, `ocx link port`를 wp4로 이동. wp3는 클라이언트 쪽만 |
| 7 | 중계 경로 집합과 Host 재작성 수락 기준 | wp3에 추가 |
| 8 | 고아 정리 시 pid와 기록된 argv 대조, P 충돌 → failed{forward} | wp4에 추가 |
| 9 | 보안 검토 | wp2, wp3, wp4 PR 설명에 MAINTAINERS.md 보안 검토 필요를 명시 |


## 독립 감사 (Kuhn, NEAR-PASS) 처분

- 차단 1 (tests/link 새 도메인 불가) → 수용. wp1 테스트는 `tests/clients/link-*.test.ts`, layout.json explicit + test-layout-expected.json 양쪽 등록. wp2 경계 테스트는 `tests/lab/core-link-boundary.test.ts`.
- 차단 2 (structure 게이트 절차) → 수용. 새 파일 git add 후 `bun run structure:index`, `bun run structure:check`. remote-link.md는 wp1이 실제로 제공하는 순수 모듈만 현재형으로 기술.
- 차단 3 (문서 모순) → 수용. PRD 상태·D1·D3·범위 밖, 010의 L1 S6·L3/L4 `link issue` 위치 수정.
- 비차단 1 탐색/터널 옵션 분리 테스트, 2 권한 테스트 win32 건너뜀, 3 임시 디렉터리 합성 호스트, 4 `src/link`가 server/router를 import하지 않는 테스트를 wp1에 포함.
- 비차단 5 → wp2: 첫 기동 게이트는 동기 `hasLinks()`, 동적 import는 `ensureStarted()` 경로만. 비차단 7 → wp2/wp3에서 structure/runtime.md 전체 검토. 비차단 8 → 보안 검토 메모는 `.tmp/`.
