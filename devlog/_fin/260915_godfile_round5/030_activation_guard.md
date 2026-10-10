# 030 — 활성화 가드 재설계: startServer 동기 도달 경로 전수 검사 (wp4)

단위 산출물은 tests/lab/core-lab-boundary.test.ts(435행) 하나고, 여기에 startServer 동기 도달
경로 검사를 추가한다. 모든 숫자는 2026-09-15 워크트리(codex/godfile-r5-a-openai-responses)에서
rg/awk/cat/wc로 재측정한 값이다. 히스토리가 6커밋으로 절단돼 커밋 빈도 논거는 쓰지 않는다.

## 1. 현재 가드의 기계

tests/lab/core-lab-boundary.test.ts의 describe `activation window stays synchronous`(353-434)는
네 검사로 구성된다.

| 검사 | 테스트 라인 | 판정 입력 |
|---|---|---|
| startServer 비-async 선언 | 357-367 | index.ts 선언부 정규식 |
| 창 안 body-level await 부재 | 369-389 | index.ts 창 텍스트 |
| 블랭킹·중첩 자기공격 | 391-420 | 합성 문자열 |
| 실창 tolerance 고정 | 422-433 | server.stop 클로저 |

앵커 상수 세 개의 실제 문자열과 src/server/index.ts(3,400행) 안 현재 위치다.

| 상수 | 실제 문자열 | index.ts 위치 |
|---|---|---|
| SERVE_ANCHOR(테스트 139) | `server = Bun.serve<WsData>({ ...serveOptions, port: listenPort, hostname: bindHost });` | 3222 |
| ACTIVATION_ANCHOR(테스트 140) | `if (labActivationRequired(config, labConfigDir)) {` | 3386 |
| RETURN_ANCHOR(테스트 150) | 앞 공백 2개 + `return server;` | 3399 |

검사 범위는 source.slice(start, end)(384)다. start는 indexOf(SERVE_ANCHOR), end는
indexOf(RETURN_ANCHOR, start)(370-371)이므로 실질 창은 3222행부터 3399행 직전까지 177행이다.
창 붕괴 알람이 있다: start 미발견은 376, end 역전은 377, activation이 창 밖이면 381-382에서 적색.

주석·문자열 blanking은 blankCommentsAndStrings(165-217)가 담당한다. 개행만 보존하고 나머지는 공백
치환(171)이라 보고 라인 번호가 살아 있다. 템플릿은 모드 스택(168)으로 처리하고 보간 진입(178-182)과
종료(206-209)에서만 코드로 복귀하며, 문자열(195-203)과 행주석(185-188), 블록주석(189-193)도 블랭킹한다.

await 검출은 정규식이 아니라 토큰 스캔이다(bodyLevelAwaitLines, 253-273). 263행에서 slice(i, i+5)가
"await"인지 보고 264-266행에서 앞뒤 단어 경계를 검사하고, 268행에서 점 접두를 제외해 속성 접근
(thing.await())을 거른다. 중첩 함수 제외는 두 부품으로 된다. opensFunctionBody(225-243)가 '{'가 함수
몸체인지 판정하고(228행 화살표, 242행 키워드 제외 if/for/while/switch/catch/do/with), 261-262행이 그
결과를 스택에 넣고 빼며, 269행이 stack.some으로 함수 몸체 안 await를 버린다. try/if/for 블록은 함수
몸체가 아니므로 그 안 await는 잡힌다(자기공격 407-411, for-await 412가 고정).

startServer async 선언 검사는 363행 정규식이고 364-366행이 정확히 "export function startServer("
를 요구한다. 현재 선언은 src/server/index.ts 1006행이다.

소스 오라클 드리프트 실례가 이미 있다. 가드 주석(157-158)은 창 안 prose-await 위치를 index.ts:1853,
:1950이라 적지만 실측은 3237, 3384다. 주석이 흘러도 판정은 무변경이므로 새 가드의 판정 입력에
"문서 속 라인"을 쓰지 않고 근거 서술로만 남긴다.

## 2. 우회 경로 — 가드가 보지 않는 절반

가드가 읽는 것은 index.ts 텍스트의 3222-3399 슬라이스뿐이다. 판정 명제는 "창 텍스트에 await 토큰이
없다"이지 "창에서 호출된 함수가 동기로 끝난다"가 아니다. 창 3222-3399의 호출 토큰은 uniq 기준
30종이다. 이 중 hardenConfigDir(1회, 3307 주석)와 stop 1회(3308 주석)는 blanking 대상 텍스트다.
코드 위치 호출은 다음과 같이 나뉜다.

| 분류 | 이름과 위치 | 수 |
|---|---|---|
| 동기 자유 함수 호출 | bindNativeMainStartupLifecycle 3273, setServerRef 3317, setCorsOrigin 3320, isCanonicalOpenAiForwardProvider 3361, providerCodexAccountMode 3362, getConfigDir 3385, labActivationRequired 3386, activateLab 3387, activateResetCreditAutoRedeem 3393, createResetCreditWhamClient 3395 | 10 |
| 생성자 | AuxiliaryListenerBindError 3245, 3262 | 2 |
| 수신자 메서드(동기 위치) | server.stop 3241, bound.stop 3260, unregisterQuotaAutoRefresh?. 3266, userCostOverlayReconciler?.stop 3267, backgroundLifecycle?.releaseAfterFailedStart 3268, nativeMainLifecycle.release 3269, backgroundLifecycle.scheduleStartupRun 3378 | 7 |
| Bun API | Bun.serve 3222/3230/3250, Object.defineProperty 3277 | 4 |
| 클로저·콜백 안 | server.stop 클로저(3277-3316)의 runListenerShutdown 3284, backgroundLifecycle.release 3304, releaseNativeMainStartupLifecycle 3305, flushConfigDirHardening 3311, then 체인(3364-3374)의 reconcileCodexPlansFromTokens 3367, primeCodexPoolQuotas 3373 | 미일괄 계수 |

우회 시나리오 A — 피호출자 변경(오늘도 성립). src/lib/lab-activation.ts 167행의 activateLab을
async로 고치고 몸체에 await를 넣어도 index.ts는 한 글자도 변하지 않는다. 앵커 세 개 제자리
(376-382 통과), 창 await 0(388 통과)이라 가드는 녹색이다. 그러나 3387행 활성화가 다음 턴으로
밀리고 AGENTS.md(383행, 절 50-93)의 76-79행이 말하는 "policy route가 evidence provider 등록 전에
평가될 수 없다"는 보장이 깨진다.

우회 시나리오 B — wp5가 만드는 형태. 활성화 블록 3385-3388을 src/server/index/ 아래 리프로 옮기고
창에는 호출 한 줄만 남기면, 창 텍스트는 호출 토큰만 남고 리프 안 await는 영원히 미검사다. 단,
블록을 통째로 빼서 ACTIVATION_ANCHOR 문자열이 index.ts에서 사라지면 381-382가 적색이 된다. 기존
가드는 "블록 완전 이탈"은 잡지만 "블록 유지 + 호출 대상 변경"은 못 잡는다.

wp5 연결. wp5는 index.ts를 src/server/index/ 아래 리프로 쪼갠다. 쪼개는 순간 창은 호출 목록이
되고 AGENTS.md 50-93의 불변식은 텍스트상으로만 남는다. 창에서 도달하는 함수 전부를 검사하는 가드가
먼저 없으면 wp5는 불변식을 실질 폐기하는 변경이 된다. 이것이 이 단위가 wp5 선행인 이유다.

## 3. 재설계 명세

수집 범위는 창이 아니라 startServer 몸체 전체(index.ts 1006-3400)다. 창 밖 동기 호출(getConfigDir
1010, setCorsOrigin 1109, providerCodexAccountMode 2042)도 활성화 순서의 일부다.

(1) 수집. index.ts를 blankCommentsAndStrings로 블랭킹하고 1006행 선언부터 짝 괄호 매칭으로 몸체를
추출한다. bodyLevelAwaitLines와 같은 스택 기법(261-262)으로 동기 위치의 `식별자(` 토큰을 모은다.
'.'/'?.' 접두 호출은 수집에서 제외하고 allowlist 대상으로 분류한다. 키워드 제외는 242행 목록에
function/return/new 등을 더한 집합을 쓴다.

(2) 정의 해석. 식별자마다 같은 파일에서 async 표지와 function/class/const 선언을 이름으로 찾고,
없으면 그 파일의 import를 따라간다. import 추출은 Bun.Transpiler.scanImports, 경로 해석은 기존
resolveSpec(52-59)을 쓴다. re-export 추적이 필수다. 실측 체인 두 개: index.ts 72행은
../providers/openai-tiers에서 가져오고 openai-tiers.ts 6행의 export 문을 타서
openai-tiers-destination.ts 22행 정의에 닿는다. index.ts 48행은 ../codex/auth-api에서 가져오고
auth-api.ts 34행을 타서 reset-credit-service.ts 124행 정의에 닿는다. 방문 집합과 깊이 상한
(현재 최대 간선 2, 상한 8)으로 순환을 끊는다.

(3) 단언. 수집된 함수마다 선언에 async가 없고 bodyLevelAwaitLines(몸체)가 빈 배열임을 단언한다.
동적 import는 따라가지 않는다. firstLabPath가 지연 간선으로 취급한 근거(75-80행 주석)와 같고, 실제
then 체인 3364-3374는 모두 콜백 안이라 (4)에서 이미 제외된다.

(4) 제외. 중첩 함수 몸체는 (1)의 스택 규칙이 자동으로 거른다. 실측 대상: server.stop 재정의
클로저 3277-3316(테스트 422-433이 tolerance로 고정한 await 3284, 3304, 3311 포함), then 체인
3364-3374.

(5) allowlist. 테스트 파일 상단에 이름 기반 상수로 박는다. 라인 기반이면 wp5 이동 때 깨지므로
이름과 근거를 기록한다. 양방향 검사를 강제한다. 수집됐는데 미등록이면 적색, 등록됐는데 수집되지
않으면 적색(422-433 tolerance 고정과 같은 부식 방지).

allowlist 초기 항목 후보(실측 근거):

| 이름 | 위치 | 근거 |
|---|---|---|
| server.stop / bound.stop | 3241, 3260 | 보조 리스너 바인드 롤백. Bun Server API라 프로젝트 코드가 아니다 |
| unregisterQuotaAutoRefresh?.() | 3266 | StartServerDeps 계약 메서드. 텍스트 워커로 구현을 해석할 수 없다 |
| userCostOverlayReconciler?.stop | 3267 | 동일 |
| backgroundLifecycle?.releaseAfterFailedStart | 3268 | 동일 |
| nativeMainLifecycle.release | 3269 | 동일 |
| backgroundLifecycle.scheduleStartupRun | 3378 | 동일. "Never blocks listen; cancellable on shutdown"라는 동기성 주장은 3377행 주석뿐이다 |

생성자 AuxiliaryListenerBindError(3245, 3262)는 allowlist에 넣지 않는다. ports.ts 4-18행 생성자는
async일 수 없고 await도 없다(ports.ts 파일 전체 await 7회는 모두 43행 이후 비동기 함수 안). 참고로
수집 대상 정의 파일의 await 분포 실측: reset-credit-auto-redeem.ts 4, native-profile-startup.ts 16,
reset-credit-service.ts 23, paths.ts 2, ports.ts 7, lab-activation.ts·auth-cors.ts·
openai-tiers-destination.ts·registry.ts 0(rg -c 무출력).

## 4. 재사용 판정

같은 파일에서 바로 재사용: IMPORT_RE(50), resolveSpec(52-59), blankCommentsAndStrings(165-217),
opensFunctionBody(225-243), bodyLevelAwaitLines(253-273). namesLabDirectly(115-121)는 용도가 다르다.
firstLabPath(62-102)는 목적이 /src/lab/ 도달 여부(87행)라 정의 해석에는 못 쓰지만 BFS 골격
(64-66 큐, 83 이전노드 지도)은 수집 워커 템플릿이 된다.

Bun.Transpiler 재사용 가능. 실측 사용처 세 곳: tests/responses/responses-fetch-helpers-boundary.test.ts
17/34행(scanImports), tests/providers/api-key-selection-capture.test.ts 52행,
tests/clients/sync-client-integrations.test.ts 681행. scanImports는 지정자 목록만 준다(fetch-helpers
테스트 28-35행 인터페이스 실측)이라 심볼 정의 조회는 별도 텍스트 검색이 필요하다. IMPORT_RE 대신
scanImports를 쓰는 이유: IMPORT_RE의 한정자는 주석이 낀 import에서 오검출 여지가 있고 scanImports는
로더 기반이라 그렇지 않다.

골격:

```ts
const importTranspiler = new Bun.Transpiler({ loader: "ts" });
// (1) 수집: startServer 몸체 동기 위치 호출 식별자(bodyLevelAwaitLines와 동일 스택)
function collectSyncCalls(fnBody: string): string[] { /* ... */ }
// (2) 해석: scanImports -> resolveSpec -> re-export 추적
function resolveExportedDecl(name: string, file: string, seen: Set<string>): Decl | null {
  const text = readFileSync(file, "utf8");
  const local = new RegExp(String.raw`export\\s+(async\\s+)?(function|class|const)\\s+${name}\\b`)
    .exec(blankCommentsAndStrings(text));
  if (local) return { file, body: text, isAsync: local[1] !== undefined };
  for (const spec of importTranspiler.scanImports(text).map(i => i.path)) {
    const next = resolveSpec(spec, file);
    if (!next || seen.has(next)) continue;
    seen.add(next);
    const found = resolveExportedDecl(name, next, seen);
    if (found) return found;
  }
  return null;
}
// (3) 단언
expect(decl.isAsync).toBe(false);
expect(bodyLevelAwaitLines(extractBody(decl.body, declOpenBraceOffset))).toEqual([]);
```

## 5. 비-vacuous 증명 절차

wp4 구현 시점에 순서대로 실행한다(이 문서 작성 시점에는 bun test 금지 규칙이 적용돼 미실행).

1. 베이스라인: `bun test tests/lab/core-lab-boundary.test.ts` 녹색 확인.
2. 적색 구성: src/lib/lab-activation.ts 167행 선언을 `export async function activateLab(`로 고치고
   열는 중괄호 다음 줄에 `await Promise.resolve();`를 넣는다(편집 2개). 실측 원선언:
   `export function activateLab(config: OcxConfig, configDir?: string): void {`
3. 예상: 기존 창 검사 369-389, 391-420, 422-433은 녹색(앵커 무변경, 창 await 0). 새 도달가능성 검사만
   적색 — activateLab이 수집 클로저에 들어가 async 선언과 몸체 await에 걸린다.
4. 되돌림: 167행 복원, 삽입 행 삭제. `git diff --stat`으로 잔여 변경 없음 확인 후 폐기.

이 케이스가 "창 스캔 시절 잡히지 않던 것(피호출자 변경)을 새 가드가 잡는다"의 최소 증명이다. 보조로
guard-on-guard describe(300-351 패턴)에 합성 모듈 공격을 추가한다. 임시 리프에 `export async function
probeStartupStep(): Promise<void> { await Promise.resolve(); }`를 쓰고 startServer가 호출하는 것으로
기록했을 때 수집기가 잡는지 단언하고, finally에서 rmSync한다(309-317 패턴).

소스 오라클 목록. 텍스트로 server/index.ts를 읽는 tests/ 파일은 rg -l 기준 17개다(16개 테스트 +
tests/fixtures/file-size-baseline.json). 이 단위와 직접 관련된 것은 core-lab-boundary.test.ts
354-355행(readFileSync indexPath)과 369-389행 창 슬라이스다. wp5가 앵커 세 줄(3222, 3386, 3399)을
리프로 옮기면 376-382가 적색으로 잡히니, wp5 설계는 앵커를 index.ts에 남기거나 검증을 새 가드로 옮겨야 한다.

## 6. 유지/대체 판정

기존 가드를 지우지 말고 새 검사를 추가한다.

근거. 앵커 위치 단언(376-382)은 활성화 블록의 완전 이탈을 잡는 유일한 검사다. 도달가능성 워커는
호출 토큰이 사라지면 수집할 것 자체가 없어 조용해진다. 창 스캔은 wp5 이후에도 index.ts에 직접 쓰인
await를 잡는다. 자기공격 스위트(391-420)가 blanking과 중첩 제외를 고정하는데 새 워커가 같은 부품을
재사용하므로 이 고정이 그대로 유효하다. 대체 시 손실은 구조 알람인데 유지 비용은 텍스트 스캔 하나다.

startServer 비-async 단언(357-367)도 남긴다. 도달가능성 검사가 startServer를 루트로 다루면 이론상
흡수되지만, 독립 문장이 실패 메시지를 정확히 유지한다.
