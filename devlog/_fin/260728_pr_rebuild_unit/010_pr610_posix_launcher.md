# 010 — `dev`의 POSIX 런처가 `PATH=""`에서 깨진다 (WP2)

## 배경 — 그리고 A 게이트 2라운드의 정정

PR #610(이슈 #606 수정)의 회귀 테스트에 `chatgpt-codex-connector`가 **P1**을 남겼다.
초안은 "저자가 아직 응답하지 않았다"고 적었는데, **재감사 시점에는 이미 고쳐져 있었다.**

```
1310dd20b 2026-07-28T08:56:25Z fix(catalog): stop respawning the codex --version probe
056aa2d6e 2026-07-28T09:16:18Z fix(test): address runtime cache review feedback   ← P1 대응
```

`refs/pull/610/head` 실측:

```
327:        "d=${0%/*}",
333:        `while IFS= read -r line || [ -n "$line" ]; do`
```

저자의 형태가 우리 초안보다 낫다. `|| [ -n "$line" ]` 가드가 개행 없이 끝나는 마지막
줄을 잃지 않는다. GitHub에서 P1이 미해결로 보이는 건 아무도 resolve를 누르지 않아서다.

**따라서 #610의 (b) 관문은 ❌** — 미해결 블로커가 없으니 리뷰·머지 대상으로 돌아간다.

### 그런데 결함은 살아남았다

저자는 **자기가 손댄 테스트만** 고쳤다. 같은 파일의 다른 테스트는 그대로다:

| 위치 | 상태 |
| --- | --- |
| `origin/dev:tests/codex-runtime.test.ts:360` | `cat "$(dirname "$0")/catalog.json"` — 결함 존속 |
| `pull/610/head:tests/codex-runtime.test.ts:514` | 동일 — 저자가 건드리지 않음 |
| `pull/610/head:327-335` | 고쳐짐 |

`dev`에 이미 있던 결함이고 #610이 도입한 게 아니다. 그러므로 이 work-phase의 대상은
#610이 아니라 **`dev` 자신**이다. 우리가 고칠 근거가 사라지기는커녕 더 분명해졌다.

## P1 내용 (원문)

> Preserve a usable PATH for the POSIX launcher. On Linux and macOS, clearing `PATH`
> prevents the generated shell launcher from finding both `dirname` and `cat`.
> Consequently `d` is empty, the probe is written outside `probeLog` (or cannot be
> written), catalog output fails, and the assertions at lines 354-355 fail.

## 코드 실측 — `dev` 기준

`dev`의 테스트가 만드는 POSIX 런처
([tests/codex-runtime.test.ts:353-362](/Users/jun/developer/new/700_projects/opencodex/tests/codex-runtime.test.ts)):

```sh
#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "codex-cli 0.133.0"
  exit 0
fi
cat "$(dirname "$0")/catalog.json"
```

그리고 같은 테스트가 실행 직전에:

```ts
process.env.PATH = "";     // tests/codex-runtime.test.ts:372
```

`cat`과 `dirname`은 셸 빌트인이 아니라 `/bin`, `/usr/bin`의 외부 실행 파일이다.
`PATH`가 비면 `sh`가 둘 다 찾지 못한다. `$(dirname "$0")`는 빈 문자열로 축약되고
`cat`은 애초에 실행되지 않으므로, 카탈로그 출력이 나오지 않는다.

`--version` 분기는 `echo`가 POSIX 셸 빌트인이라 우연히 살아남는다. 그래서 프로브
횟수를 세는 쪽은 통과하고, 카탈로그를 읽는 쪽만 조용히 깨진다.

## 이것이 결정 불요인 이유

테스트가 `PATH`를 비우는 의도는 "시스템에 설치된 진짜 `codex`를 우연히 집지 않게
한다"이다. 그 의도는 유지해야 한다. 동시에 런처는 동작해야 한다. 두 요구가
충돌하지 않는 해법이 존재하고 그것이 유일하게 옳다: **런처에서 외부 명령을 없앤다.**

`PATH`를 되살리면 격리가 깨지므로 그쪽은 답이 아니다.

## 변경 — MODIFY `tests/codex-runtime.test.ts`

POSIX 런처를 셸 파라미터 확장과 빌트인만으로 다시 쓴다.

`#610`의 저자가 이미 CI에서 검증한 형태를 그대로 채택한다. 우리가 다른 형태를 쓸
이유가 없고, 같은 형태를 쓰면 두 테스트가 일관된다.

```diff
       } else {
         writeFileSync(path, [
           "#!/bin/sh",
           `if [ "$1" = "--version" ]; then`,
           `  echo "codex-cli ${version}"`,
           "  exit 0",
           "fi",
-          `cat "$(dirname "$0")/catalog.json"`,
+          // This test empties PATH so a real `codex` on the machine can never be picked
+          // up. That also removes `dirname` and `cat`, which are external binaries — the
+          // launcher would die with exit 127. Parameter expansion and `read` are POSIX
+          // shell builtins and need no PATH lookup. The `|| [ -n "$line" ]` guard keeps a
+          // final line that has no trailing newline.
+          "d=${0%/*}",
+          `while IFS= read -r line || [ -n "$line" ]; do`,
+          `  printf "%s\\n" "$line"`,
+          `done < "$d/catalog.json"`,
           "",
         ].join("\n"), "utf8");
         chmodSync(path, 0o755);
       }
```

`${0%/*}`는 `$0`에서 마지막 `/` 이후를 잘라내므로 `dirname`과 같은 결과를 낸다.
테스트가 항상 절대 경로로 런처를 부르므로(`join(oldDir, "codex")`) `/` 없는 경로가
들어와 `$0` 전체가 남는 예외는 발생하지 않는다.

## 활성화 증거 (C-ACTIVATION-GROUNDING-01)

이 변경이 고치는 분기는 "카탈로그를 읽는 경로"다. 그 경로가 실제로 발화하고
**의도한 값을 내는지** 확인해야 한다. 기존 테스트가 그 오라클을 이미 갖고 있다:
`newerAvailable` / 카탈로그 effort 목록 비교 (`:354-355` 계열). `PATH=""` 상태에서
그 assertion이 통과하면 런처가 실제로 파일을 출력했다는 뜻이다.

즉 **수정 전에는 실패하고 수정 후에는 통과**해야 한다. 그 전후 출력이 증거다.

검증 명령:

```
bun test tests/codex-runtime.test.ts
```

## 결함은 `dev`에 이미 있다 — 그리고 조용히 통과 중이다

초안은 "이 테스트 구간이 #610이 신설하는 것"이라고 가정했다. **틀렸다.**

```
$ git show origin/dev:tests/codex-runtime.test.ts | rg -n 'dirname "\$0"|PATH = ""'
360:          `cat "$(dirname "$0")/catalog.json"`,
373:    process.env.PATH = "";
```

`b6ece844d`("sandbox runtime probe CODEX_HOME") 시점부터 `dev`에 있다. #610은 이
테스트를 확장할 뿐 결함을 도입하지 않았다. 리뷰 봇이 #610의 diff 맥락에서 지적했을 뿐,
**고쳐야 할 곳은 `dev`다.**

### 재현 (P1이 맞다)

```
$ printf '#!/bin/sh\n...\ncat "$(dirname "$0")/catalog.json"\n' > $d/codex
$ env PATH="" "$d/codex"
.../codex: line 6: dirname: No such file or directory
.../codex: line 6: cat: No such file or directory
exit=127
```

### 왜 테스트는 통과하는가 — 이게 진짜 문제다

`bun test tests/codex-runtime.test.ts` → 18 pass, 0 fail. 런처가 exit 127로 죽는데도.

`loadBundledCodexCatalog()`가 실패하면 `null`을 반환하고, assertion은 이렇게 쓰여 있다
([tests/codex-runtime.test.ts:382-385](/Users/jun/developer/new/700_projects/opencodex/tests/codex-runtime.test.ts)):

```ts
expect(oldCatalog?.models?.[0]?.supported_reasoning_levels?.some(
  level => (level as { effort?: string }).effort === "max",
)).toBe(false);
```

`oldCatalog`가 `null`이면 옵셔널 체이닝이 전부 `undefined`로 흘러 `.toBe(false)`가…
실패해야 한다. 그런데 통과한다는 것은 **이 경로에서 카탈로그가 실제로 로드되고
있다**는 뜻이다. `--version` 분기는 `echo`(빌트인)라 살아남으므로 런타임 해석은
성공하고, 카탈로그는 `codex debug models` 경로로 별도로 얻는다.

즉 P1이 지적한 "카탈로그 출력 실패"는 `false` 단정 쪽에서는 드러나지 않고,
`.toBe(true)`를 요구하는 두 번째 단정(`:400-402`)에서만 드러난다. 그 단정이 통과한다는
것은 새 런처의 카탈로그가 어떤 경로로든 읽혔다는 의미다.

**따라서 B 단계의 첫 작업은 수정이 아니라 계측이다.** 런처 stderr를 캡처해서
`dirname: No such file or directory`가 실제로 나는지 확인하고, 그럼에도 테스트가 통과하는
경로를 특정한다. 계측 없이 런처만 고치면 "무엇이 고쳐졌는지" 증명할 수 없다
(LOOP-MECHANISM-PROOF-01: 집계 통과는 활성화 증거가 아니다).

### 분기별 처분

| 계측 결과 | 처분 |
| --- | --- |
| 런처가 127로 죽고 카탈로그는 다른 경로로 로드됨 | 런처를 빌트인으로 고치고, **단정을 강화**해 실제 로드 경로를 고정한다 |
| 런처가 정상 동작함 (재현 실패) | P1을 근거와 함께 rebut하고 #610에 기록. NOOP |

## B 단계 계측 결과 — **P1은 오탐이었다 (NOOP)**

계측을 실제로 돌린 결과, 두 번째 분기가 사실이다. 근거는 세 단계다.

### 1. 테스트 안에서 카탈로그는 로드된다

`loadBundledCodexCatalog()` 반환값을 임시로 찍어 봤다 (계측 후 원복함):

```
[PROBE] oldCatalog = loaded, models=1
[PROBE] newCatalog = loaded, models=1
(pass) resolveCodexRuntime > persisted runtime stamp busts resolve memo [140.50ms]
```

`null`이 아니다. 런처가 실제로 카탈로그를 출력했다는 뜻이다.

### 2. `null`이었다면 테스트는 실패했을 것이다

"옵셔널 체이닝이 `undefined`를 내니 `.toBe(false)`가 통과할 것"이라는 초안의 추론은
틀렸다. 직접 확인했다:

```
expect(undefined).toBe(false)
  Expected: false
  Received: undefined
(fail)
```

즉 이 테스트는 카탈로그 로드 실패를 **잡아낸다**. 조용히 통과하는 구조가 아니었다.

### 3. Bun이 시작 시점 환경을 스냅샷한다 — Node와 다르다

> **A 게이트 3라운드 정정.** 초안은 이를 "Node/Bun 공통 동작"이라고 적었다. 틀렸다.
> 이건 **Bun 고유 동작**이고, 그 구분이 결론의 의미를 바꾼다.

`runCodexDebugModels`
([src/codex/catalog/bundled.ts:137-143](/Users/jun/developer/new/700_projects/opencodex/src/codex/catalog/bundled.ts))는
`execFile`에 `env` 옵션을 넘기지 않는다. 같은 스크립트를 두 런타임으로 돌린 결과:

```
process.env.PATH = "";  execFileSync(bin, [], { encoding: "utf8" })

=== BUN  ===  CHILD_PATH=[/Users/jun/.nvm/.../bin:/opt/homebrew/bin:...]   ← 원본 PATH
=== NODE ===  CHILD_PATH=[]                                                ← 반영됨
```

Bun은 자식 스폰용 환경을 프로세스 시작 시점에 스냅샷하고, 이후의
`process.env` 변경을 관찰하지 않는다. Node는 반영한다.

세 조건 비교:

```
A: process.env.PATH='' , no env opt      OK   (Bun 한정)
B: explicit env {...process.env}         THREW 127
C: explicit env {PATH:''}                THREW 127
```

### 3-1. B는 가상이 아니라 실제 호출 지점이다

`src/codex/runtime.ts:261`이 정확히 조건 B다:

```ts
env: { ...(deps.env ?? process.env), CODEX_HOME: probeHome },
```

즉 한 테스트 실행 안에서 **두 프로브가 서로 다른 환경을 본다.**

| 프로브 | 호출 | 자식이 보는 PATH |
| --- | --- | --- |
| `--version` (`runtime.ts:261`) | `env` 명시 | `""` — 반영됨 |
| `debug models` (`bundled.ts:137`) | `env` 생략 | 원본 — Bun 스냅샷 |

`--version` 쪽이 살아남는 건 `echo`가 셸 빌트인이라 PATH 조회가 필요 없기 때문이다.
이 비대칭이 테스트가 초록인 진짜 이유다.

### 결론

리뷰 봇의 P1은 **Node 의미론에서는 옳다.** 다만 이 저장소는 Bun 네이티브 런타임이고
(AGENTS.md), Bun에서는 그 전제가 성립하지 않아 발화하지 않는다. 봇이 틀린 게 아니라
런타임이 다르다.

주의할 점: 이 테스트의 통과가 **Bun 구현 세부에 의존한다.** Bun이 향후 Node와
정렬되면 `tests/codex-runtime.test.ts:360`은 코드 변경 없이 실패하기 시작한다.

### 정정 — `PATH=""`는 장식이 아니다

> 3라운드에서 뒤집힌 두 번째 주장. 초안은 "격리 의도가 달성되지 않는다"고 적었는데
> **틀렸다.**

`PATH`는 자식 프로세스만 쓰는 게 아니라 **in-process에서도 읽힌다.**
`pathCandidates()`
([src/codex/runtime.ts:308-312](/Users/jun/developer/new/700_projects/opencodex/src/codex/runtime.ts))가
`deps.env ?? process.env`의 `PATH`를 분해해 후보 바이너리 목록을 만든다. in-process
읽기는 Bun의 스폰 스냅샷과 무관하게 변경을 즉시 본다.

가짜 `codex`를 PATH에 심고 측정한 결과:

```
PATH=<fakedir> -> source: path      version: 9.9.9
PATH=''        -> source: fallback  version: null
```

`PATH=""`가 결과를 바꾼다. 즉 이 줄은 **머신에 설치된 진짜 `codex`가 후보 목록에
들어오는 것을 실제로 막고 있다.** `CODEX_CLI_PATH` 고정은 두 번째 층이지 대체가 아니다.

이 줄을 "장식이니 지워도 된다"고 판단했다면 테스트를 머신 의존으로 만들 뻔했다.

### 최종 처분

터미널 판정: **NOOP** (코드 변경 없음). NOOP 판정 자체는 유효하다 — P1이 이 런타임에서
발화하지 않는다는 결론은 바뀌지 않았다. 바뀐 것은 그 이유의 설명이고, 잘못 전달한
두 진술은 #610에 정정 코멘트로 바로잡는다.

`mihneaptu`의 포크 브랜치에는 push하지 않는다. 우리는 `dev` 대상 브랜치에 고치고,
#610에 "P1은 네가 `056aa2d6e`에서 이미 고쳤다. 다만 같은 파일의 다른 테스트(head:514,
`dev`:360)에 같은 패턴이 남아 있고 그건 `dev`의 기존 결함이라 우리가 따로 고쳤다"고
코멘트한다. 저자가 P1 미해결로 오해받아 막히지 않게 하는 것이 목적이다.

## SoT 동기화

없음. 테스트 전용 변경이며 사용자 노출 동작이 바뀌지 않는다.
