# 000 — Windows Bun 안정성 조사 (조사 전용)

`dev`의 `windows-latest` CI가 하루에 여러 번 빨갛게 뜬다. 사용자 요청은 **조사와 문서화
뿐**이며 이 단위는 어떤 패치도 적용하지 않는다. 목적은 "무엇이 깨지는가"를 실패 모드별로
분리하고, 각 모드에 대해 근거 있는 개선 후보를 남기는 것이다.

수집일 2026-07-31. CI 런 ID와 커밋 SHA는 모두 실제 조회 결과다.

## 요약 — 하나의 증상이 아니라 세 가지다

"Windows CI가 불안정하다"는 한 문장이 서로 원인이 다른 세 가지를 덮고 있었다. 이걸 섞어
보면 "매번 다른 테스트가 실패하는 무작위 플레이크"로 보이지만, 로그를 분리하면 패턴이
분명하다.

| 모드 | 지문 | 원인 위치 | 고칠 수 있는 주체 |
|------|------|-----------|-------------------|
| A. Bun 런타임 크래시 | `oh no: Bun has crashed`, `(fail)` 줄 **0개** | Bun 1.3.14 Windows | 업스트림 (우리는 회피/트리거 축소) |
| B. 테스트 실패 (주로 5초 예산 초과) | `(fail)` 줄 **1개 이상**, 크래시 **0개** | 우리 테스트 | 우리 |
| C. 잡 타임아웃 / 동시성 취소 | `cancelled`, 잡 20분 한도 | 워크플로 설정 | 우리 (이미 조치됨) |

**지문 주의:** 크래시 판별에 `panic(thread`를 쓰면 안 된다. 스레드 표기가 런마다 다르다 —
30613324981은 `panic(thread 2852)`, 30606401943은 `panic(main thread)`다. 안정적인 지문은
`oh no: Bun has crashed` 또는 `Internal assertion failure`다. 마찬가지로 모드 B의
`timed out after 5000ms`는 `(fail)` 줄이 아니라 그 아래 별도 줄(`^ this test timed out...`)에
찍히므로, `(fail)` 줄만 grep하면 안 걸린다.

A와 B는 **상호 배타적**이다. 추정이 아니라 로그 카운트다.

```
run 30613324981 (모드 A): "(fail)" 0개, 크래시 1개
run 30615086938 (모드 B): 크래시 0개, "(fail)" 2개
```

감사에서 실패 런 8건(30612358421, 30611549111, 30610504499, 30609285180, 30600828044,
30597652077, 30595616725, 30594516343)으로 표본을 넓혔는데, 전부 `(fail)` > 0이고 크래시는
0이었다. 배타성은 2건이 아니라 10건에서 성립한다.

패닉 런에는 실패한 테스트가 단 하나도 없고, 테스트 실패 런에는 크래시가 없다. "매번 범인이
바뀌는 무작위 실패"라는 인상은 두 개의 다른 고장을 한 바구니에 담아서 생긴 착시다.

## 모드 A — Bun 패닉 (외부 결함)

### 지문

```
Features: ... workers_spawned(9) workers_terminated(8)
panic(thread 2852): Internal assertion failure
oh no: Bun has crashed. This indicates a bug in Bun, not your code.
https://bun.report/1.3.14/wt10d9b296izBukooC+7xB+inBk9/...
```

### 크래시 지점 (표본 2건)

패닉 런 두 건(30613324981, 30606401943)의 마지막 테스트 그룹이 **둘 다 동일**하다. 표본이
2건뿐이므로 "항상"이 아니라 "지금까지 2/2"로 읽어야 한다.

```
##[group]tests\api-storage-cleanup.test.ts:
##[group]tests\api-storage-policy.test.ts:   ← 여기가 마지막
```

`api-storage-policy`는 `src/storage/policy-job.ts:238`의 `new Worker()` 경로를 태운다. 다만
**워커를 띄우는 유일한 스위트는 아니다** — `tests/storage-worker-lifecycle.test.ts`,
`storage-policy-job-responsive`, `storage-restore-job-*`, `storage-mutation-race`도 워커
경로를 건드린다(`src/storage/restore-job.ts:130`에도 `new Worker()`가 있다). 따라서 "유일한
워커 스위트라서 여기서 죽는다"는 설명은 성립하지 않는다.

**파일 순서를 감안해야 한다.** Bun은 파일을 알파벳 순으로 도는데, 통과 런(30616856523)의
456개 그룹에서 `api-storage-policy`는 30번째 근처(`api-debug` → `api-storage-cleanup` →
`api-storage-policy` → `api-storage` → `api-usage`)다. 즉 크래시는 전체의 7% 지점에서
일어난다. 이건 "오래 돌다가 상태가 누적돼서"라는 설명과 맞지 않는다.

`bun.report` URL은 두 런에서 앞부분(`wt10d9b296izBukooC+7xB+inBk9`)이 동일하다. 다만 이
공통 구간은 플랫폼/버전/빌드 메타데이터일 수 있고 뒷부분은 서로 다르며, 스레드 표기도
`main thread` vs `thread 2852`로 갈린다. **같은 어서션이라고 단정할 근거는 아니다** — 같은
계열일 가능성을 시사하는 정황으로만 취급한다.

### 이미 방어를 넣었고, 그런데도 재발했다

`1a46299b5 fix(storage): wait for storage workers to exit before the test file boundary`가
`src/storage/worker-lifecycle.ts`를 추가해 워커 종료를 `close` 이벤트로 await 한다.

문제는 **그 커밋 이후 런에서도 패닉이 났다**는 것이다.

| run | 커밋 | worker 방어 포함 | 결과 |
|-----|------|------------------|------|
| 30606401943 | 12eae74ec | 포함 | panic |
| 30608166216 | bf9bc1ac8 | 포함 | 타임아웃 |
| 30613324981 | ebd4cdf02 | 포함 | panic |

30606401943의 크래시 헤더는 `workers_spawned(9) workers_terminated(9)` — **숫자가
맞는데도** 죽었다. 이건 중요한 반증이다. 원래 가설(미종료 워커 1개가 어서션을 건드린다)은
`8 vs 9` 불일치를 근거로 삼았는데, 9/9인 런도 같은 지점에서 같은 어서션으로 죽었다.

즉 워커 카운트 불일치는 **원인이 아니라 동반 증상**일 가능성이 높다. 방어 자체는
무해하고 유지할 가치가 있지만, 이걸로 모드 A가 닫혔다고 볼 수 없다.

### `--isolate`의 실제 의미 (오해 정정 2건)

기존 devlog(`120_wp_ci_windows_timeout.md:56-57`)는 `--isolate`에 대해 두 가지를 적었는데
**둘 다 사실과 다르다.**

**정정 1 — 프로세스 격리가 아니다.** 그 문서는 `--isolate`를 "테스트별 프로세스 격리"로
적고, Windows 프로세스 생성 비용이 2.5배 격차의 원인일 것으로 추정했다.

Bun v1.3.13 릴리스 노트 기준으로 `--isolate`는 **같은 프로세스 안에서 파일마다 새 realm
(fresh global)을 만드는** 기능이다. 프로세스를 파일당 하나씩 띄우는 것이 아니다. 프로세스를
실제로 나누는 건 `--parallel=N` 쪽이고, 우리는 그 플래그를 쓰지 않는다.

따라서 "프로세스 생성 비용" 가설은 근거가 약하다. 한 프로세스가 realm만 갈아끼우며 456파일을
끝까지 들고 간다는 구조 자체는 사실이지만, 위에서 본 대로 크래시가 30번째 파일에서 나므로
**"장시간 누적" 설명도 성립하지 않는다.** 현재 증거가 가리키는 건 프로세스 수명이 아니라
`api-storage-policy` 스위트가 하는 일(워커 스레드 생성/종료)과 Bun isolate의 realm 정리가
Windows에서 만나는 지점이다. 다만 워커를 띄우는 다른 스위트에서는 죽지 않으므로, 이 스위트만의
무엇이 남았는지는 아직 규명되지 않았다.

**정정 2 — 로컬에도 `--isolate`가 있다.** 그 문서는 "`--isolate`는 CI에만 있고
`package.json`의 로컬 `test` 스크립트에는 없다"고 적었다. 실제로는 `package.json`의
`"test": "bun scripts/test.ts"`가 `scripts/test.ts:122`에서
`[process.execPath, "test", "--isolate", ...]`로 자식을 띄운다. 즉 로컬 `bun run test`도
CI와 동일하게 `--isolate`로 돈다.

이 정정은 실무적으로 중요하다. "로컬은 격리 없이 도니까 CI만의 문제"라는 추론이 성립하지
않는다는 뜻이고, 반대로 로컬 macOS에서 같은 플래그로 패닉이 재현되지 않는다는 사실이
**Windows 고유성**을 더 강하게 뒷받침한다.

### Bun 업그레이드로는 못 피한다

조사 시점(2026-07-31) 기준 **1.3.14가 최신 안정 버전**으로 확인됐다(2026-05-12 릴리스 공지).
더 올릴 곳이 없다. 다만 검색 중 "Bun 1.4 regression"을 제목에 단 이슈가 보였으므로, 이
문장을 근거로 삼기 전에 릴리스 페이지를 직접 열어 재확인하는 것이 안전하다.

1.3.14가 고친 것들은 우리 증상과 인접하지만 일치하지 않는다: macOS isolate GC 경쟁,
isolate/parallel 모드의 NAPI finalizer 크래시, Windows 자식 프로세스 teardown과 일부
libuv/경로 패닉. 즉 **isolate 불안정성 자체가 1.3.14에서 끝나지 않았다** — 1.3.14에서
보고된 isolate 세그폴트(oven-sh/bun#35301)와 isolate 워커 데드락(#36235)이 존재한다.

공개 이슈 중 우리 증상 4가지(Windows + 1.3.14 + `--isolate` + Internal assertion)를
**동시에** 만족하는 건 찾지 못했다. 이건 없다는 증명이 아니라 미발견이다.

인용한 isolate 관련 이슈 번호(oven-sh/bun#35301, #36235)는 검색 단계에서 수집한 것으로
원문을 직접 열어 확인하지 않았다. 업스트림 리포트를 쓸 때는 먼저 열어볼 것.

### 러너 이미지

실패 런의 이미지는 `windows-2025-vs2026`, 릴리스 태그 `win25-vs2026/20260728.188`이다.
`windows-latest`는 2026-06 중 Windows Server 2025 / VS 2026으로 이미 이관됐다. 저장소는
public이라 GitHub-hosted 러너의 표준 사양을 쓴다.

## 모드 B — 5초 예산 초과 (우리 쪽)

### 지문

크래시 없이 `(fail)` 줄이 나온다. 대부분 5초 예산 초과이지만 **전부는 아니다.** Bun `test`의
기본 타임아웃이 5000ms이므로, 예산을 명시하지 않은 테스트는 전부 5초 안에 끝나야 한다.

예외가 실제로 있다. run 30610504499은 이 모드로 분류했지만 실패 2건의 성격이 다르다.

```
(fail) ... missing or non-string detail never authorizes a pool retry [5353.12ms]  ← 5초 초과
(fail) ... wrong model id in exact sentence never authorizes a pool retry [412.09ms] ← 어서션 불일치
```

412ms짜리는 예산 문제가 아니라 `expect(...).toEqual(...)` 불일치다. 같은 파일의 앞선
테스트가 타임아웃으로 하네스를 남긴 뒤 오염이 전파된 것으로 보이지만 **확인하지 못했다.**
모드 B를 "5초 초과만"으로 정의하면 이 케이스를 놓친다.

### 걸린 테스트들의 공통점

| run | 실패 테스트 | 성격 |
|-----|-------------|------|
| 30615086938 | Windows tray packaging — 소켓 미상속 증명 | PowerShell + Bun 자식 실제 spawn |
| 30612358421 | executeArchivedCleanup — spawn edge 정리 | DB/정리 작업 |
| 30610504499 | server local API auth — pool retry | 실제 HTTP 서버 (+ 어서션 실패 1건 동반) |
| 30609285180 | GET /api/github/star | 외부 바이너리 spawn |
| 30611549111 | CLI status JSON + tray | CLI 자식 프로세스 |

타임아웃으로 걸린 것들은 전부 **프로세스를 띄우거나 실제 서버를 세우는** 테스트다. 순수 함수
테스트가 타임아웃으로 실패한 사례는 없었다. Windows에서 프로세스 spawn과 파일시스템이 느린
것은 알려진 특성이고, 5초는 그 위에서 너무 얇다.

### 이미 상당 부분 조치됐다 (그리고 그게 최근 실패를 설명한다)

커밋 타임스탬프는 작성자 타임존이 섞여 있으므로 오프셋까지 적는다.

```
3e95ba33f 2026-07-31 10:11:02 +0200  test(storage): raise cleanup suite timeout for Windows CI load
217db0426 2026-07-31 10:15:17 +0200  fix(test): raise Windows timeout for CLI spawn smoke tests
81f3f689a 2026-07-31 17:22:34 +0900  test(tray): budget the socket-inheritance proof …
cd9ad7396 2026-07-31 17:05:37 +0900  Merge pull request #797 (오늘 머지)
```

`+0200` 두 건은 KST로 환산하면 17:11 / 17:15다. 즉 세 수정은 모두 오늘 오후에 몰려 있고,
tray 예산 수정(17:22 KST)은 우리 머지 `cd9ad7396`(17:05 KST)보다 **17분 늦다**. 그래서
`cd9ad7396`의 tray 타임아웃 실패는 수정이 들어오기 전 트리에서 난 것이고, 지금 `dev`에는
이미 고쳐져 있다.

`81f3f689a`의 주석이 좋은 판단 기준을 남겼다: 예산을 올리는 것이 일반해가 아니고, **기다림이
주장의 본질인지**를 봐야 한다. tray 테스트는 실제로 프로세스를 띄우는 것이 증명 자체이므로
예산을 올리는 게 맞고, 같은 라운드에서 sidebar 라우트 테스트는 `gh` spawn이 주장과 무관해서
spawn을 **삭제**하는 쪽으로 고쳤다.

### 현재 상태

최신 런 30616856523(`81f3f689a`)에서 **windows-latest는 통과**했다. 실패한 건 macOS의
`claude outbound SSE > idle keepalive pings flow during upstream silence` 한 건으로, Windows와
무관한 별개 건이다.

## 모드 C — 잡 타임아웃과 동시성 취소

`120_wp_ci_windows_timeout.md`가 이미 다뤘다. 12분 한도에 여유가 12초밖에 없어서 러너 변동이
결과를 좌우했고, 20분으로 올렸다. 최근 런은 9~11분대라 한도 문제는 당장은 아니다.

`cancelled`는 실패가 아니라 `cancel-in-progress: true` 동시성 그룹의 정상 동작이다. 연속
머지 시 앞선 런이 취소된다. 다만 `gh pr checks`에서는 이것도 빨갛게 보여서 체감 실패율을
부풀린다.

## 실패율 (2026-07-30 ~ 07-31, `dev`)

`Cross-platform CI` 워크플로, `dev` 브랜치, 최근 40개 런 (조회 시점 2026-07-31 오후):
failure 19, cancelled 13, success 7, 진행중 1.

숫자를 읽을 때 주의할 점 세 가지.

- **워크플로를 반드시 필터해야 한다.** `--workflow "Cross-platform CI"` 없이 `gh run list`를
  돌리면 Service lifecycle, Issue quality 등이 섞여 전혀 다른 값이 나온다.
- **failure에 모드 A/B/C가 섞여 있다.** "19번 깨졌다"가 아니다.
- **cancelled는 대부분 정상 동작이다.** 연속 머지 시 `cancel-in-progress`가 앞선 런을 자른다.

슬라이딩 윈도우라 재조회하면 값이 달라진다. 이 집계는 스냅샷이며, 인용할 때는 위 명령과
시점을 함께 적어야 한다.

## 열린 질문 (닫힌 것 포함)

조사 중 확인해서 닫은 것:

- `test.concurrent` / `--concurrent` 사용 여부 → **미사용**. `bunfig.toml`에는 `root`와
  `preload`만 있고 동시성 설정이 없다.
- 저장소 공개 여부 → **public**.
- 패닉과 타임아웃이 같은 런에 공존하는가 → **아니오**, 상호 배타적.
- 러너 이미지 → `windows-2025-vs2026` / `win25-vs2026/20260728.188`.
- Bun 상위 버전 존재 → **없음**, 1.3.14가 최신 안정.

아직 열린 것:

- 크래시가 `api-storage-policy`에서만 나는 이유. 워커 카운트가 맞는 런도 죽었으므로 워커
  미종료 단독 설명은 반증됐고, 워커를 띄우는 다른 스위트는 멀쩡하며, 위치가 30/456이라
  누적 설명도 막혔다. **현재 유력 가설이 없다.**
- `--isolate` 없이 돌리면 크래시가 사라지는가 — 미측정.
- 실패 시작 시점이 Windows Server 2025 이미지 이관과 상관있는가 — 미측정.
- run 30610504499의 412ms 어서션 실패가 앞선 타임아웃의 오염 전파인가 — 미확인.
- Bun 테스트 러너가 `--shard`를 지원하는가 — 미확인.
- 인용한 oven-sh/bun 이슈 원문(#35301, #36235) — 미열람.

## 개선 후보 (제안일 뿐, 적용하지 않음)

### 모드 A용

1. **`--isolate` A/B 측정.** Windows 잡만 `--isolate` 없이 여러 번 돌려 패닉이 사라지는지
   본다. 사라지면 Bun isolate 생명주기가 원인이라는 강한 증거다. 대가는 파일 간 전역 상태
   격리가 약해지는 것 — 우리 스위트가 realm 격리에 실제로 의존하는지부터 확인해야 한다.
2. **`api-storage-policy` 경계 최소 재현 (우선순위 높음).** 그 스위트 + 인접 파일만
   Windows에서 반복 실행해 크래시를 좁힌다. macOS에서는 이 경계가 깨끗하다 — 로컬에서
   `bun test --isolate tests/api-storage-cleanup tests/api-storage-policy tests/api-storage`를
   돌려 20 pass / 0 fail을 확인했다. 따라서 재현에는 Windows 러너가 필요하다. 재현되면
   oven-sh/bun에 올릴 최소 케이스가 나온다. 지금은 `bun.report` URL만 있고 최소 재현이 없어
   업스트림 리포트가 어렵다.
3. **러너 이미지 고정 비교.** `windows-2022` vs 명시적 2025로 나눠 이미지 이관 영향을 본다.
4. **분할(sharding)은 근거가 약해졌다.** 원래는 "한 프로세스가 456파일을 끝까지 들고 가는
   것"을 완화한다는 논리였는데, 크래시가 30번째 파일에서 나므로 그 논리가 무너진다. 어느
   샤드에 들어가든 `api-storage-policy`는 여전히 돈다. 러닝타임 단축 효과는 남지만 모드 A
   대책으로는 부적절하다. 참고로 Bun 테스트 러너의 `--shard` 지원 여부 자체를 확인하지 않았다.

### 모드 B용

5. **프로세스 spawn 테스트의 예산 정책화.** 이미 3건을 개별로 올렸는데, 지금은 케이스마다
   임기응변이다. "실제 프로세스를 띄우는 테스트는 Windows에서 최소 N초"를 헬퍼로 만들면
   다음 테스트가 같은 함정을 반복하지 않는다. 단 `81f3f689a`의 기준 — 기다림이 주장의
   본질일 때만 — 을 깨지 않아야 한다.
6. **spawn이 본질이 아닌 테스트는 spawn 제거.** sidebar 라우트 테스트에서 이미 한 방식이
   맞는 방향이다.

### 하지 말아야 할 것

- **전역 `--timeout` 상향.** 모드 B는 가리고 모드 A는 못 고친다. 진짜 느려진 테스트도 같이
  숨는다.
- **재시도(retry)로 덮기.** 모드 A는 프로세스가 죽는 것이라 재시도가 통계만 바꾼다.
- **`--max-concurrency` 조정.** 파일 내 동시 테스트 수 제어라 우리 상황과 무관하다.
- **Defender 예외 추가.** 근거가 오래된 정황뿐이고 CI 보안 표면을 건드린다.

## 판정

- 모드 B와 C는 우리 쪽 문제이고 대부분 조치됐다. 최신 `dev`에서 windows-latest가 통과한 것이
  그 증거다.
- 모드 A는 **Bun 1.3.14 Windows의 외부 결함**이다. 조사 시점 기준 상위 안정 버전이 없어
  업그레이드로 피할 수 없다(이 문장이 "업그레이드 경로 없음"의 유일한 근거이므로, 인용 전
  릴리스 페이지를 다시 열어 확인할 것). 우리가 할 수 있는 건 트리거를 좁히는 것과 업스트림
  리포트용 최소 재현이다.
- 모드 A의 **원인은 아직 규명되지 않았다.** 초기 가설(미종료 워커)은 반증됐고, 대체 가설
  (프로세스 수명 누적)도 크래시 위치가 30/456이라는 사실에 막혔다. 현재는 "이 스위트에서만
  재현되는 Bun isolate + Windows 상호작용"까지가 확인된 범위다.
- 오늘 머지한 #808/#797은 어느 모드와도 무관하다. 레지스트리 상수와 순수 함수만 건드렸고,
  패닉 지점과 타임아웃 대상 테스트 어디에도 닿지 않는다.
