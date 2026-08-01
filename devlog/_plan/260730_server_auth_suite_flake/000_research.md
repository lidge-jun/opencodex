# 000 — server-auth 전체 스위트 flake: 공유 TEST_DIR 충돌

## 증상

`bun run test`(전체 432파일)가 동일 트리에서 실패 개수를 바꾼다. 관측: 한 번은 9건,
다음은 2건. 2건 실행에서 지목된 것:

- `server local API auth > Activation C: malformed-input 400 never authorizes a pool retry`
  (`tests/server-auth.test.ts:1803`)
- `server local API auth > missing or non-string detail never authorizes a pool retry`
  (`tests/server-auth.test.ts:1947`)

파일 단독 실행은 57/57 통과. 제 커밋이 하나도 없는 `origin/dev` worktree에서도 2건
실패했으므로 기존 결함이다.

영향이 실질적인 이유: `package.json`의 `prepush`가 전체 스위트를 돌리고
`.git/hooks/pre-push`가 그것을 exec한다. 비결정적 스위트는 **푸시를 무작위로 막고**,
결국 `--no-verify` 습관을 만든다. 그게 진짜 피해다.

## 원인 — 두 테스트 파일이 같은 디렉터리를 공유한다

```
tests/server-auth.test.ts:39
  const TEST_DIR = join(import.meta.dir, ".tmp-server-auth-test");

tests/management-provider-validation.test.ts:44
  const TEST_DIR = join(import.meta.dir, ".tmp-server-auth-test");   ← 동일 경로
```

둘 다 setup에서 그 경로를 **삭제하고 다시 만든 뒤** `process.env.OPENCODEX_HOME`을
거기로 돌린다:

```
if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
mkdirSync(TEST_DIR, { recursive: true });
process.env.OPENCODEX_HOME = TEST_DIR;
```

`server-auth.test.ts:146-148`, `management-provider-validation.test.ts:160-162`(그리고
같은 파일에서 189, 406, 437, 492, 522 … 총 열 곳 이상 반복).

한쪽이 config와 credential을 써 둔 상태에서 다른 쪽이 그 디렉터리를 통째로 지우면,
먼저 돌던 테스트는 `config.json`도 credential도 없는 home을 보게 된다. pool 계정 정의가
사라지므로 "pool retry가 승인되지 않아야 한다" 류의 단정이 전부 무너진다.

### 왜 순차 실행에서는 안 잡히나

`bun test a.test.ts b.test.ts`처럼 **순차**로 주면 92 pass / 0 fail이다. 한 파일이 끝난
뒤 다음 파일이 시작하니 충돌 창이 없다. 그래서 페어링 bisect로는 원인이 드러나지 않는다.

전체 스위트는 파일을 **병렬로** 돌린다. 두 파일이 겹치는 순간에만 깨지고, 겹치는지 여부는
러너 스케줄링에 달렸다. 그래서 실패 개수가 9 → 2로 흔들린다. 같은 원인, 다른 폭발 반경이다.

## 결정적 재현

두 파일을 실제로 동시에 띄우면 재현된다.

```sh
cd /Users/jun/Developer/new/700_projects/opencodex
(bun test tests/management-provider-validation.test.ts > /tmp/f_mgmt.log 2>&1 & \
 bun test tests/server-auth.test.ts > /tmp/f_auth.log 2>&1 & wait)
```

결과:

| 실행 방식 | management | server-auth |
|---|---|---|
| 순차 (`bun test a b`) | 92 pass / 0 fail (합계) | — |
| **동시** | 25 pass / **10 fail** | 36 pass / **21 fail** |

동시 실행 실패 목록에 목표 테스트가 그대로 있다:
`Activation C: malformed-input 400 never authorizes a pool retry`. 그 외 `Activation A/B/D/E`,
`#584 pre-stream 429` 계열, `WS-REBIND-01`, `OpenAI option auth matrix` 등 pool/credential을
읽는 케이스가 함께 무너진다 — 9건 관측의 정체가 이것이다.

### 실패의 실제 모양 (서브에이전트 Meitner 검증)

단일 파일 내에서도 같은 파일을 동시에 돌리면 재현된다. 즉 이것은 파일 간 이름 중복만의
문제가 아니라 **고정 경로 자체**의 문제다.

```zsh
# poison: 같은 파일의 다른 테스트를 반복 실행
(while true; do bun test --isolate tests/server-auth.test.ts \
   -t "OpenAI option auth matrix keeps direct, pool, and API credentials independent" \
   >/dev/null 2>&1; done) & poison_pid=$!

for i in {1..20}; do
  bun test --isolate tests/server-auth.test.ts \
    -t "Activation C: malformed-input 400 never authorizes a pool retry" || break
done
kill "$poison_pid" 2>/dev/null; wait "$poison_pid" 2>/dev/null
```

3개 배치 전부 재현, 누적 26/60 실패(배치별 6/20, 14/20, 6/20).

실패 단정은 pool 로직이 아니라 **인증**이 무너진 모습이다:

```
Expected: 400
Received: 401
  at expectOriginal400 (tests/server-auth.test.ts:237:27)
  at tests/server-auth.test.ts:1807:13
```

`:1947` 케이스도 동일하게 `Expected: 400 / Received: 401`(`:1951`). 로그에 남의 계정이
섞여 들어온 흔적까지 찍힌다:

```
[codex-auth] Pool account openai-p893430 token failed; reauthentication required
```

해석: 다른 실행이 `TEST_DIR`을 지우거나 덮어쓰면 credential이 사라져 요청이 401이 된다.
테스트는 "400이 유지되어야 한다"를 보고 있으므로 실패한다. **pool 재시도 로직에는 결함이
없다** — 픽스처가 사라진 것이다. `src/` 변경이 필요 없다는 근거이기도 하다.

원자적 저장 경로에서도 같은 원인이 관측됐다: 다른 워커가
`config.json.ocx.<pid>.<seq>.tmp`를 rename 전에 지워 `src/config.ts:50`이 실패한다.
그 외 페어링에서도 재현된다: `server-key-failover-e2e`(2/4),
`server-combo-failover-e2e`(2/4), `codex-pool-rotation`(1/1).

## 유일한 중복인가

그렇다. tests/ 전체에서 `import.meta.dir` 기반 `.tmp-*` 리터럴 중 **중복은 이 하나뿐**이다.

```sh
grep -rhn 'import.meta.dir, "\.tmp' tests/*.ts | sed 's/.*import.meta.dir, "//; s/".*//' | sort | uniq -d
# → .tmp-server-auth-test
```

참고로 `tests/model-visibility-management-api.test.ts:9`는 이미 올바른 패턴을 쓴다:
`` `.tmp-model-visibility-management-${process.pid}` `` — 프로세스별로 갈라 둔다.

## 언제 들어왔나

`commit 665b65643` (2026-07-23) `refactor(tests): split provider-management validation tests
into management-provider-validation.test.ts`. 원본에서 파일을 떼어낼 때 `TEST_DIR` 리터럴이
그대로 복사됐고, 새 이름을 받지 못했다. 커밋 메시지가 "60 cases preserved, 355 expect()
identical"이라고 밝히듯 케이스 보존에 집중한 분리였고, 픽스처 경로의 유일성은 검토 대상이
아니었다.

## 이것이 아닌 것

`#727` / `commit ae6ab453c`의 `tests/storage-policy.test.ts` 5초 기본 타임아웃 문제와는
**별개**다. 그건 느린 Windows 러너에서 결정적으로 실패하는 예산 문제였고, 이건 로컬
macOS에서도 재현되는 픽스처 경로 충돌이다. 타임아웃을 늘려서 고칠 문제가 아니다.

격리 옵션도 원인이 아니다. `scripts/test.ts`가 `bun test --isolate`를 쓰므로 **모듈 상태는
파일별로 격리**된다. 공유되는 것은 모듈 변수가 아니라 **디스크 경로**다. `--isolate`는
파일시스템을 격리하지 않는다.
