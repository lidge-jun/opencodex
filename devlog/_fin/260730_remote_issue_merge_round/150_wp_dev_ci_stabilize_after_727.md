# 150 — wp: #727 머지 후 dev CI 안정화 (계획)

PR #732는 10/10 green으로 머지됐는데, 같은 코드가 `dev`에서 `windows-latest` 실패로
떴다. 사용자 요구는 "CI까지 안정"이므로 이 실패의 성격을 규명하고 dev를 green으로
되돌리는 것이 이 사이클의 범위다.

## 실패 성격 판별

run [30512710121](https://github.com/lidge-jun/opencodex/actions/runs/30512710121) job 90775975408:

```
Elapsed: 38476ms | User: 10953ms | Sys: 4093ms
panic(thread 2168): Internal assertion failure
oh no: Bun has crashed. This indicates a bug in Bun, not your code.
 https://bun.report/1.3.14/wt10d9b296izBukooC+7xB+inBk9/...
```

세 가지가 우리 변경과 무관함을 가리킨다.

1. **테스트 실패가 아니다.** `(fail)` 줄이 하나도 없다. 실패 로그 전체를 훑어 `(fail)`,
   `error:`, `timed out`을 잡았는데 걸린 건 `panic` 한 줄뿐이다.
2. **크래시 시점이 38초다.** 12분 타임아웃도, 5초 하네스 타임아웃도 아니다. 마지막으로
   통과한 케이스는 `POST run rejects when a job is already running [1716.76ms]`.
3. **#727이 처음부터 배제한 그 플레이크다.** 이슈 본문 첫 문장이 "this is not the Bun
   `panic` flake or the old 12-minute ceiling"이다. 이번 건은 정확히 그 panic이다.

같은 트리(`60e100484`)가 PR 컨텍스트 run 30512174098에서는 windows 10m45s로 통과했다.
동일 커밋이 한 번은 green, 한 번은 Bun 크래시 — 런타임 플레이크의 정의다.

## 조치

`gh run rerun 30512710121 --failed`. 코드 수정이 아니다 — 수정할 우리 결함이 없다.
재실행이 green이면 dev 안정 확인, 또 panic이면 Bun 1.3.14 Windows 이슈로 별도 추적
대상이며 우리 코드로는 해결 불가(BLOCKED 성격).

판정 기준: run 30512710121의 `windows-latest`가 success, 그리고 devlog 포인터 커밋
`616ea9929`의 run도 전부 success.

## 실행 결과

### "flake"로 넘기지 않고 좁혔다

재실행 1회도 같은 panic이었다. 2회 연속 재현이면 flake라는 라벨을 그대로 유지할 근거가
약해지므로 크래시 지점을 특정했다.

| 시도 | 소요 | 결과 |
|------|------|------|
| 최초 | 38476ms | panic(thread 2168) |
| 재실행 1 | 37499ms | panic(thread 9912) |

`bun.report` URL이 두 번 완전히 동일하다 — 같은 내부 어서션이다.

**크래시 지점:** 두 번 모두 마지막 그룹이 `tests\api-storage-policy.test.ts`이고,
마지막 통과 케이스가 `POST run rejects when a job is already running`이다. PR 런
(job 90774391758)에서는 그 다음이 `tests\api-storage.test.ts`로 정상 진행했다. 즉
`api-storage-policy` → `api-storage` 경계에서 죽는다.

**유력 원인:** 크래시 헤더의 `workers_spawned(9) workers_terminated(8)` — 워커 하나가
미종료다. `src/storage/policy-job.ts:220`이 `new Worker(policy-worker.ts)`를 띄우고,
`api-storage-policy` 스위트가 이 경로를 태운다. `--isolate` 모드에서 파일 경계를 넘을 때
살아있는 워커가 Bun 1.3.14 Windows의 내부 어서션을 건드리는 것으로 보인다.

로컬 재현 시도: `bun test --isolate tests/api-storage-policy.test.ts tests/api-storage.test.ts`
→ **9 pass / 0 fail**. macOS에서는 같은 경계가 깨끗하다. Windows 고유다.

### 트리 해시가 동일하다 — 우리 변경 아님이 확정적

```
60e100484 (dev, panic x2)     tree=dc17517e1bab5fc219b4293ea4ba87bc15420f5d
e220753ac (PR #732, green)    tree=dc17517e1bab5fc219b4293ea4ba87bc15420f5d
```

**같은 트리다.** 같은 바이트가 PR 컨텍스트에서는 windows 10m45s green, dev 컨텍스트에서는
두 번 panic. 코드가 원인이면 이런 분기는 나오지 않는다. 러너 인스턴스 의존이다.

과거 dev 실패도 확인해 이 panic이 상습 패턴이 아님을 봤다. run 30503855936과
30501949889의 windows 실패는 panic이 아니라 `kiro oauth — import-first` 어서션
실패(`toContainEqual`)다. 원인이 다르다.

### 세 번째 재실행은 동시성 취소로 끝났다

3차 재실행은 Test 스텝을 지나 38초 크래시 지점을 넘겼는데, 그 사이 `dev`가
`4da468ce6`로 움직여 `cancel-in-progress` 그룹이 이전 run을 취소했다. 120 문서가
기록한 바로 그 취소 유형이다 — 타임아웃이 아니다.

새 커밋 중 `622cdc0a4 test: stop two suites from sharing one fixture home`은 다른
에이전트 작업으로, `server-auth.test.ts`와 `management-provider-validation.test.ts`가
같은 `TEST_DIR` 리터럴을 공유하던 문제를 고친다. panic과는 별개 결함이다.

판정 대상은 새 헤드 `4da468ce6`의 run 30513346191로 이동했다.

### dev green 확인 (D)

run [30513346191](https://github.com/lidge-jun/opencodex/actions/runs/30513346191) — **6잡 전부 success.**

```
windows-latest              success
ubuntu-latest               success
macos-latest                success
npm-global x3               success
```

windows Test 스텝: `Ran 6031 tests across 434 files. [566.86s]` — panic 없이 완주.
#727 대상 케이스는 이렇게 읽힌다:

```
(pass) selectPolicyPreview honors reduceToBytes via oldest files [58.20ms]
(pass) runStorageCleanupPolicy > disabled never calls execute [45.51ms]
```

## 성공 기준 판정

| # | 기준 | 결과 | 증거 |
|---|------|------|------|
| 1 | 실패 성격 규명 | PASS | 크래시 경계 특정 + 미종료 워커 + 동일 트리 해시 |
| 2 | 우리 코드 결함 아님 | PASS | tree `dc17517e1` PR green / dev panic 동일 |
| 3 | dev green | PASS | run 30513346191 6/6 success |
| 4 | #727 케이스 정상 | PASS | windows 50ms대 pass, 6031 테스트 완주 |

터미널 결과 **DONE**.

## 남긴 것 (별도 유닛)

**Bun 1.3.14 Windows panic — 미해결, 재발 가능.** 2회 재현했고 우리 코드로는 못 고친다.
지목 지점은 `src/storage/policy-job.ts:220`의 `new Worker`가 `--isolate` 파일 경계에서
미종료로 남는 조합이다. `runInWorker`는 `finish()`/타임아웃 양쪽에서 `worker.terminate()`를
호출하지만, `workers_terminated`가 `workers_spawned`보다 1 적다.

두 갈래가 있다. Bun에 업스트림 리포트(`bun.report` 링크 확보됨), 또는 우리 쪽에서
워커 종료를 확정적으로 대기하는 방어. 후자는 프로덕션 코드 변경이라 #727 범위 밖이고,
재발 시 별도 이슈로 여는 게 맞다. 이번엔 재발하지 않아 추측으로 패치하지 않았다.

120 문서의 Windows 2.5배 격차도 그대로다(Test 스텝 566초).
