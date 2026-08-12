# 012 — WP1 CI 첫 결과와 #1263 진단

`011` 의 실행 기록이 보고한 71개 런 승인 이후의 첫 결과다. 승인 집계 자체는
미검증이나(사유는 `011`), 아래 CI 결과는 각 PR의 체크에서 직접 관찰한 것이다.

## 결과 분류

| PR | 결과 | 원인 |
|---|---|---|
| #1264 | **PASS** | — |
| #1263 | **FAIL** | macOS 테스트 실패 — 아래 진단 |
| #1205 | FAIL | `hygiene: unsponsored_surface` — 라벨 필요 |
| #1178 | FAIL | `hygiene: unsponsored_surface` — 라벨 필요 |
| #1163 | FAIL | `react-doctor` — 로그 만료(BlobNotFound), 재실행 필요 |
| 나머지 | pending | 진행 중 |

`unsponsored_surface` 두 건은 코드 결함이 아니다. 보호된 표면을 건드리는 PR에
maintainer 보안 검토와 `maintainer-sponsored` 라벨이 필요하다는 게이트의 정상
동작이며, `002`/`040`이 이미 선행 조건으로 기록한 사항이다.

## #1263 진단 — **정정됨: 우리가 틀렸다**

> **이 절의 결론은 감사에서 뒤집혔다.** 아래 원래 분석은 사전 배치된 FIFO만
> 시험했고, 그 조건에서는 실제로 상위 가드가 0ms에 거부한다. 그러나 이 결함은
> **TOCTOU 경쟁**이다. 검증을 통과한 정규 파일이 `openSync` 직전에 FIFO로
> 바뀌면 상위 가드는 이미 지나간 뒤다.
>
> 대조 실험으로 확증했다(아래 "정정 실험" 참조). **패치 없는 dev는 무한
> 블로킹(타임아웃 exit 124), 패치본은 3ms에 `VAULT_INVALID`.**
>
> **정정된 처분: ADOPT-WITH-TEST-FIX.** 패치는 실재하는 경쟁을 고친다. 틀린 것은
> 기여자의 **테스트**이며, FIFO를 너무 일찍 만들어 상위 가드에 걸리는 바람에
> 정작 패치가 고치는 경로를 통과하지 못한다.

### 정정 실험 (2026-08-08)

`readBounded` 는 `beforeOpen` 테스트 시임(`src/codex/native-profile-store.ts:69-77`,
`:383`)을 갖고 있다. 이 시임은 "검증 이후, open 이전" 시점에 개입하기 위해
코드베이스가 의도적으로 둔 것이다. 정확히 TOCTOU를 재현하는 도구다.

프로브: 정규 vault 파일을 만들어 `assertNativeProfileMetadataLayout`(`:329-345`)을
통과시킨 뒤, 시임에서 그 파일을 지우고 같은 경로에 `mkfifo` 한다.

| 대상 | 결과 |
|---|---|
| `origin/dev@fdc47db7b` (패치 없음) | **행 — 20초 타임아웃 (exit 124)** |
| `luvs01/agent/reject-native-profile-fifo` (패치본) | `threw VAULT_INVALID after 3 ms` |

이것이 활성화 증거다. 패치가 추가한 `O_NONBLOCK` 분기가 실제로 발화하며, 없을
때와 있을 때의 관찰 가능한 차이가 명확하다.

### 왜 처음에 틀렸나

사전 배치된 FIFO만 시험했다. 그 경로에서는 `assertCanonicalFile`(`:257-260`)이
먼저 거부하므로 "결함 없음" 으로 보였고, 그 관찰 자체는 정확했다. 오류는 그
한 가지 트리거로 전체 결함 부재를 결론지은 것이다.

`readBounded` 를 우회하는 호출 경로만 찾았고, **검증과 open 사이의 시간 창**은
보지 못했다. 감사자가 시임의 존재를 근거로 그 창을 지목했다.

교훈: "이 분기가 발화하는 시나리오가 없다" 는 결론은 시나리오를 한 종류만
시험했을 때 내릴 수 없다. 특히 코드베이스가 그 분기를 위한 테스트 시임을
제공하고 있다면, 그 시임이 곧 트리거 설계도다.

### 기여자에게 요청할 것

테스트만 고치면 된다. 현재 테스트(`tests/native-profile-store.test.ts:386-412`)는
FIFO를 미리 만들어 상위 가드에 걸리므로 `PROFILE_STORAGE_UNSAFE` 가 나오고,
`VAULT_INVALID` 를 기대해 red다.

제안하는 대체 테스트 설계는 아래와 같다. **자식 프로세스 격리와 부모 타임아웃이
필수다** — 패치 없는 코드는 행에 걸리므로 인프로세스로 돌리면 테스트 러너 전체가
멈춘다.

부모가 자식에게 넘길 것 (격리 필수):

부모가 `mkdtempSync` 로 임시 루트를 만들고 그 안에 `codexHome` 과 `configDir` 를
생성한 뒤, 전용 환경변수(예: `OCX_FIFO_FIXTURE`)에 JSON으로 넘긴다. 자식이 기본
환경 경로로 폴백하면 사용자의 실제 `CODEX_HOME` 을 건드릴 수 있으므로 **경로를
넘기지 않는 형태는 허용하지 않는다.**

자식이 하는 일:

1. `native-profile-store` 모듈을 import
2. `OCX_FIFO_FIXTURE` 를 파싱해 `resolveNativeProfileContext({ codexHome, configDir })`
   를 호출하고 `rootDir` 생성 (환경변수가 없으면 구분 가능한 코드로 즉시 종료)
3. **정규 파일**로 vault를 쓴다 (`mode: 0o600`) — 상위 검증을 통과시키기 위함
4. 심볼 키 `Symbol.for("opencodex.native-profile-store.bounded-read-test-seam")`
   로 `beforeOpen` 시임을 컨텍스트에 설치한다. 시임 본문에서 경로가 vaultPath일
   때 `unlinkSync` 후 `execFileSync("mkfifo", [vaultPath])`
5. `readNativeProfileVault(ctx)` 호출
6. `VAULT_INVALID` 를 잡으면 정상 종료(exit 0), 아니면 구분 가능한 non-zero

부모가 하는 일:

- `spawnSync` 에 `timeout` 을 준다 (2초면 충분 — 패치본은 3ms대)
- `child.error` 가 undefined, `child.signal` 이 null, `child.status` 가 0 인지 확인
- 실패 시 어서션 메시지에 `child.stderr` 를 포함한다. 그러지 않으면 자식이 왜
  죽었는지 알 수 없어 디버깅이 불가능하다

이 형태여야 패치 없이 **타임아웃으로 red** 가 된다. 시그널/타임아웃을 확인하지
않으면 "행에 걸렸다" 와 "빠르게 거부했다" 를 구분하지 못한다.

플랫폼: `test.skipIf(process.platform === "win32")` — `mkfifo` 는 POSIX 전용이다.

<details>
<summary>원래 분석 (사전 배치 FIFO만 시험 — 결론 무효)</summary>

### 증상

`tests/native-profile-store.test.ts:412` 에서 자식 프로세스 exit code가 0이 아닌
**92**. 92는 테스트가 심어둔 값으로 "던져진 오류의 `code` 가 `VAULT_INVALID` 가
아니다" 를 뜻한다.

로컬(macOS)에서 동일하게 재현했다. CI만의 환경 문제가 아니다.

### 실제로 던져지는 것

FIFO를 vault 경로로 두고 `readNativeProfileVault` 를 직접 호출한 결과:

```
code=PROFILE_STORAGE_UNSAFE name=NativeProfileError
msg=Native-profile storage could not be inspected safely.
threw PROFILE_STORAGE_UNSAFE after 1ms
```

FIFO는 정확히 거부된다. 다만 코드가 다르다.

### 결정적 확인 — 패치 없는 dev에서도 막힌다

별도 워크트리에 `origin/dev@fdc47db7b`(패치 미포함)를 체크아웃해 같은 프로브를
돌렸다:

```
== origin/dev baseline (no patch) ==
threw PROFILE_STORAGE_UNSAFE after 0ms
```

**0ms.** 블로킹이 없다. 즉 이 PR이 고치려는 "writer 없는 FIFO를 열다가 startup이
멈춘다" 는 상황이 현재 dev에 존재하지 않는다.

### 왜 막히는가

`readNativeProfileVault`(`src/codex/native-profile-store.ts:703`)는
`readBounded`(`:379`)의 `openSync` 에 닿기 전에 상위 경로 검증을 거친다.
`assertCanonicalFile`(`:257`)이 `lstatSync` 후 `:260` 에서

```ts
if (!entry.isFile() || entry.isSymbolicLink()) storageUnsafe(`${label} is not a private regular file.`);
```

로 FIFO를 걸러낸다. FIFO는 `isFile()` 이 false이므로 여기서 끝난다. `openSync` 는
호출되지 않으므로 `O_NONBLOCK` 을 더할 대상 자체가 실행되지 않는다.

### 판정

PR의 `O_NONBLOCK` 추가는 심층 방어로는 무해하다. `readBounded` 가 다른 경로에서
직접 불릴 가능성에 대비한다고 볼 수 있다. 그러나:

1. 주장하는 결함이 현재 dev에 없다 — 0ms 거부
2. 테스트가 틀린 코드(`VAULT_INVALID`)를 기대해 red다
3. 테스트를 `PROFILE_STORAGE_UNSAFE` 로 고치면 통과하겠지만, 그때 그 테스트는
   **패치 없이도 통과한다**. 즉 패치를 검증하지 않는 테스트가 된다

3번이 핵심이다. C-ACTIVATION-GROUNDING-01 기준으로 이 변경은 활성화 증거를 만들
수 없다. 추가한 분기가 발화하는 시나리오가 없기 때문이다.

**(무효) 처분: NEEDS-REWORK.** 기여자에게 위 baseline 측정(0ms, `PROFILE_STORAGE_UNSAFE`)을
공유하고, `readBounded` 가 상위 검증을 우회해 호출되는 실제 경로를 제시할 수 있는지
묻는다. 그런 경로가 있다면 그것이 진짜 결함이고 테스트도 그 경로를 타야 한다.
없다면 이 PR은 닫는 것이 맞다.

추정으로 테스트만 고쳐 green을 만들지 않는다. 그것은 아무것도 검증하지 않는
테스트를 dev에 넣는 일이다.

</details>

> 위 마지막 문단은 여전히 옳다. 다만 적용 방향이 반대다. 테스트를
> `PROFILE_STORAGE_UNSAFE` 로 바꾸는 것이 "아무것도 검증하지 않는 테스트" 이고,
> 시임 기반 경쟁 재현이 진짜 검증이다.

## CI 상태 판독 주의 (2026-08-08 관찰)

`gh pr checks` 가 "실패 없음" 을 보인다고 통과가 아니다. #1263이 그 예다.

head `7c3fa5419` 에 대해 `gh pr checks` 는 `CodeRabbit / hygiene / label` 세 개만
보여주고 전부 pass다. 그래서 집계 스크립트는 PASS로 분류한다.

**초안은 여기서 "워크플로가 아직 시작되지 않았다" 고 적었다. 틀렸다.** 런은
존재하며 승인 대기 상태다. REST API로 조회하면 드러난다:

```
$ gh api "repos/lidge-jun/opencodex/actions/runs?head_sha=7c3fa5419268933392452fc16f5fec371907107a"
31245339885 Cross-platform CI status=completed conclusion=action_required
31245339913 React Doctor    status=completed conclusion=action_required
31245338833 PR hygiene      status=completed conclusion=success
31245338824 PR Labeler      status=completed conclusion=success
```

즉 `gh pr checks` 는 `action_required` 런을 **아예 표시하지 않는다.** 승인 대기와
런 부재가 그 출력에서 구분되지 않으며, 둘 다 "그냥 없음" 으로 보인다.

동시에 그 head의 diff는 여전히 낡은 early-FIFO 테스트를 갖고 있다(감사 확인).
이 PR은 "테스트가 고쳐져서 통과" 도 "워크플로 미시작" 도 아니고, **새 head의
CI가 승인 대기로 막혀 있는** 상태다.

**판독 규칙 (정정):** 두 조회를 모두 쓴다.

1. `gh pr checks <n>` — 표시되는 체크의 결론
2. `gh api "repos/OWNER/REPO/actions/runs?head_sha=<headSha>"` — 실제 런 목록과
   `conclusion` (여기서만 `action_required` 가 보인다)

green으로 인정하는 조건은 **CI 런이 존재하고 그 결론이 success** 인 경우뿐이다.
런 부재도, `action_required` 도 green이 아니다. head가 바뀔 때마다 그 head의
런을 새로 승인해야 한다는 점도 이 관찰이 확인해 준다.

## 이 사이클이 확인해 준 것

CI 승인은 단순한 사무 처리가 아니었다. 승인하자마자 실제 결함 하나(#1263 —
유효한 경쟁 수정이되 최초 회귀 테스트가 무효)와 절차 요구사항 둘(#1205·#1178
보안 라벨)이 드러났다.
승인이 막혀 있는 동안에는 이 PR들이 "검증되지 않은 상태" 로 draft에 갇혀 있었고,
무엇이 문제인지 알 방법도 없었다.
