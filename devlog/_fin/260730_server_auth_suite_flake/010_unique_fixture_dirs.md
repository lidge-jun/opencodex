# 010 — 픽스처 디렉터리를 파일별로 유일하게 만든다

의존: 없음

## 문제

`tests/server-auth.test.ts:39`와 `tests/management-provider-validation.test.ts:44`가
같은 `.tmp-server-auth-test` 경로를 쓰고, 양쪽 setup이 그것을 `rmSync`로 지운다.
병렬 실행에서 서로의 home을 파괴한다(000 참조).

## 변경

### 접근 정정 — pid 대신 `mkdtempSync` (측정 + 서브에이전트 검증 반영)

`--isolate`가 파일마다 별도 프로세스를 준다고 가정하면 안 된다. 직접 측정했다:

```
bun test --isolate tests/pidprobe_a.test.ts tests/pidprobe_b.test.ts
PIDPROBE_B 97322
PIDPROBE_A 97322      ← 같은 pid
```

즉 `--isolate`는 파일별 모듈 레지스트리를 주지만 **프로세스는 하나**다. 따라서
**pid 접미사는 이 두 파일을 갈라주지 못한다.** 같은 pid를 받으니 접미사가 동일해진다.

서브에이전트(Turing)가 독립 조사에서 같은 결론에 도달하며 더 나은 대안을 지적했다:
이름만 바꾸면 파일 간 충돌은 사라지지만 **같은 파일을 두 프로세스가 동시에 돌리는 경우**
(로컬 반복 실행, `--failed` 재시도, 병렬 worktree, 이 워크스페이스처럼 여러 에이전트가
동시에 테스트를 돌리는 상황)는 여전히 깨진다. Turing은 실제로 다른 Bun 프로세스가
`server-auth.test.ts`를 동시에 돌리는 것을 관측했다.

그래서 **`mkdtempSync`로 매 실행 고유 디렉터리를 만든다.** 이것이 두 문제를 동시에 해결하고,
이미 저장소 관례다 — `tests/account-pool-management-api.test.ts:160`
(`mkdtempSync(join(tmpdir(), "ocx-pool-mgmt-"))`), `tests/alibaba-region-backup.test.ts:11`
등 다수가 쓴다.

두 파일 모두 다음 형태로 바꾼다:

```ts
// 고정 경로였을 때 이 파일과 server-auth.test.ts가 같은 .tmp-server-auth-test를
// rmSync/mkdirSync 하며 서로의 OPENCODEX_HOME을 파괴했다(665b65643 분리 때 리터럴이
// 복사됨). --isolate는 모듈만 격리하고 디스크는 격리하지 않으며, 파일들이 같은 pid를
// 공유하므로 pid 접미사로도 갈라지지 않는다. 실행마다 고유한 디렉터리가 유일하게
// 파일 간 충돌과 동일 파일의 동시 실행을 모두 막는다.
const TEST_DIR = mkdtempSync(join(tmpdir(), "ocx-management-provider-validation-"));
```

`server-auth.test.ts`도 동일하게 `ocx-server-auth-` 접두어로 바꾼다.

`mkdtempSync`는 디렉터리를 **즉시 만든다.** 기존 setup의 `if (existsSync) rmSync` +
`mkdirSync` 흐름은 그대로 둬도 무해하다(자기 디렉터리를 비우고 다시 만드는 것이므로).
다만 모듈 로드 시점에 한 번 생성되므로, 파일 종료 시 `rmSync(TEST_DIR, { recursive: true,
force: true })`로 정리하는지 확인한다. `tmpdir()`로 옮기면 `tests/` 아래 잔여물이 사라지는
부수 효과도 있다.

### `.gitignore` — 확인 완료, 변경 불필요

`.gitignore:30`이 `tests/.tmp-*/`를 무시한다. `tmpdir()`로 옮기면 애초에 워킹 트리
밖이라 추적 대상이 아니고, 옛 이름의 잔여 디렉터리도 이 glob이 계속 덮는다.

### 범위를 여기서 멈추는 이유

`import.meta.dir` 기반 고정 `.tmp-*` 픽스처를 쓰는 파일이 tests/에 **26개** 있다.
전부 `mkdtempSync`로 옮기는 것은 이번 작업 범위가 아니다. 재현된 결함은 **이름이
중복된 한 쌍**이고, 나머지 24개는 각자 고유 이름을 갖고 있어 파일 간 충돌이 없다.
동일 파일 동시 실행 취약성은 그들에게도 남지만, 그것은 증거가 있는 별개 개선 과제다.
지금 26개를 건드리면 재현된 결함의 수정과 검증되지 않은 대량 리팩터가 섞인다.

## 검증

000의 결정적 재현이 그대로 검증 도구가 된다.

```sh
(bun test tests/management-provider-validation.test.ts > /tmp/f_mgmt.log 2>&1 & \
 bun test tests/server-auth.test.ts > /tmp/f_auth.log 2>&1 & wait)
```

수정 전: 10 fail + 21 fail. 수정 후: 양쪽 0 fail이어야 하고, **연속 3회** 확인한다.
그 다음 전체 `bun run test`를 돌려 9/2건 흔들림이 사라졌는지 본다.

## 회귀 가드

이름을 다시 복사해 붙이는 실수를 사람이 잡을 거라고 기대하면 안 된다. tests/ 전체에서
픽스처 디렉터리 리터럴의 유일성을 단정하는 테스트를 추가한다.

`tests/fixture-dir-uniqueness.test.ts` (신규):

- `tests/*.test.ts`를 읽어 `import.meta.dir, "…"` / `` import.meta.dir, `…` `` 형태의
  `.tmp-*` 픽스처 경로를 추출한다.
- pid 등 런타임 보간이 없는 **정적 리터럴**이 두 파일 이상에서 등장하면 실패시키고,
  어떤 파일들이 겹치는지 이름을 출력한다.
- 보간이 포함된 경로는 프로세스별로 갈라지므로 검사에서 제외한다.

이 가드가 있으면 다음 파일 분리에서 같은 실수가 CI에서 잡힌다. 없으면 또 조용히 들어온다.

## 위험

- 낮음. 테스트 하니스 전용이고 `src/` 변경이 없다. 선택 로직이 잘못됐다는 증거는 없다.
- 디렉터리 이름이 바뀌므로, 이전 이름의 잔여 디렉터리가 워킹 트리에 남을 수 있다.
  gitignore 확인으로 처리한다.
- 가드 테스트가 과하게 엄격하면 정당한 공유 픽스처를 막을 수 있다. 그래서 보간된 경로는
  면제하고, 정적 리터럴 중복만 잡는다.
