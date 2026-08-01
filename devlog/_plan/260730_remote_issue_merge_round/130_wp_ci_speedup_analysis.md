# 130 — wp: CI 시간 단축 조사 (#717 후속)

PABCD 1사이클, 터미널 결과 DONE. 조사 전용 사이클로 프로덕션 코드 변경은 없다.
사용자 질문("이걸 좀 줄일 수 있는 방법 없나?")에 대한 측정 기반 답변.

## 시간은 전부 한 스텝에 있다

green run 30459554635 `windows-latest` 스텝별 실측:

```
Test                       581s   <- 전체 708s의 82%
Install dependencies        37s
GUI tests                   31s
GUI lint                    21s
Typecheck                   11s
Checkout                     9s
GUI build                    9s
Privacy scan                 4s
나머지 전부              < 5s
```

같은 run의 ubuntu `Test`는 206s. 즉 2.5배 격차는 전부 `bun test` 안에 있고 워크플로의
다른 부분을 손댈 가치는 없다. 캐싱이나 의존성 설치 최적화 같은 흔한 처방이 여기서는
무의미하다 — 최대 이득이 37초다.

로컬 기준선: `bun test --isolate tests/` → 5990 tests / 430 files / 220.87s / CPU 76%.
단일 프로세스라 코어가 남는다. 그 유휴 용량이 유일한 기회다.

## 옵션 1: `--isolate` 제거 — 기각

낭비가 아니라 필수였다. 제거하고 돌리니 프록시 서버가 307번 부팅되어 공유 전역에 쌓이고
11분이 넘어도 진행되지 않아 강제 종료했다. `--isolate`가 파일 간 핸들 누수를 막고 있다.

`scripts/test.ts`도 이미 `--isolate`를 쓰므로 CI 전용 플래그가 아니라 프로젝트 표준이다.

## 옵션 2: `--parallel=N` — 현 상태로는 기각

`bun test --parallel=4` → fail 7건. 전부 provider-management / credential-separation
계열. 같은 파일 단독 실행은 35 pass / 0 fail. 코드 결함이 아니라 경합이다.

## 옵션 3: `--shard=N/M` — 유효, 단 같은 전제조건에 막힘

`bun test --isolate --shard=1/3 tests/` → 144 files / 89s (전체의 약 40%).
3개 CI 잡으로 쪼개면 Windows가 10~12분에서 3~4분대로 내려간다. 다만 동일한
provider-management 실패가 나타난다.

## 진짜 차단 요인

26~27개 테스트 파일이 고정 임시 디렉터리를 `OPENCODEX_HOME`으로 지정한다:

```ts
// tests/management-provider-validation.test.ts:44
const TEST_DIR = join(import.meta.dir, ".tmp-server-auth-test");
...
process.env.OPENCODEX_HOME = TEST_DIR;
```

디렉터리 하나를 모든 워커가 공유한다. 순차 실행은 눈치채지 못하고 워커 2개부터 깨진다.

참조 밀도 상위: `management-provider-validation` 36회, `service.test.ts` 33회,
`server-auth.test.ts` 28회 — 상위 3개만 약 97회.

수정 패턴은 이미 저장소에 있다: `tests/helpers/isolated-codex-home.ts`가
`mkdtempSync(join(tmpdir(), prefix))` + 이전 env 복원 구조다. 다만 `CODEX_HOME` 전용이라
`OPENCODEX_HOME` 대응을 추가해야 한다. 이미 125개 파일이 per-run 임시 디렉터리를 쓴다.

## 권고 순서

1. 해당 파일들에 per-run 임시 디렉터리 부여(기존 헬퍼 패턴을 `OPENCODEX_HOME`으로 확장).
   이게 나머지 전부의 전제조건이고 그 자체로도 값어치가 있다 — `tests/` 아래 고정 공유
   경로는 지금도 잠재적 플레이크다.
2. 그 다음 `test` 잡을 3-way 샤딩. Windows 3~4분 예상, 이 이슈의 타임아웃 압박도 소멸.
3. `--parallel`은 1단계 후 재검토. 잡 단위 샤딩이 각 잡을 단일 프로세스로 유지하므로 더 안전.

## 도움 안 되는 것 (명시)

느린 테스트 줄이기. 1초 이상 55개가 112.9s / 207.5s(54%)를 차지하지만 가장 느린 것들이
의도적인 스톨/타임아웃 검증이다:

- `honors slow_down without failing the device flow` 7.0s
- `stalled 400 body timeout never authorizes a pool retry` 5.1s
- `stalled passthrough JSON is canceled at five seconds` 5.0s

실제로 기다려야 하는 테스트다. 이들의 비용은 단축 대상이 아니라 병렬화 근거다.

## 이 사이클에서 구현하지 않은 이유

파일 26~27개, 상위 3개만 97회 참조. 단일 사이클에 넣으면 B가 비대해지고 테스트 격리
구조 변경은 회귀 위험이 있어 독립 work-phase가 맞다. 조사 결과를 #717에 게시해
(comment 5124663955) 오너가 착수 여부를 판단할 수 있게 했다.

## 성공 기준 판정

| # | 기준 | 결과 | 증거 |
|---|------|------|------|
| 1 | 시간 소비 지점 특정 | PASS | 스텝별 실측, Test 82% |
| 2 | 후보 옵션 실측 검증 | PASS | 3개 옵션 전부 실행, 2개 기각 근거 확보 |
| 3 | 차단 요인 위치 특정 | PASS | 고정 TEST_DIR, 파일·라인까지 |
| 4 | 추측 배제 | PASS | 모든 기각이 실행 결과 기반 |
| 5 | 워킹트리 무변경 | PASS | `git status` 공백 |

## 다음 사이클 후보

1. per-run 임시 디렉터리 마이그레이션 — 위 1단계. 그 자체로 플레이크 제거
2. 3-way 샤딩 — 1단계 완료 후
3. #717 PR 제출 — `4359d540b` + `a76bf413a` 푸시 승인 필요
