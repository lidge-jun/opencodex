# 070 core.ts 편입 (계획 변경 기록)

000_plan.md 은 `src/server/responses/core.ts` 를 라운드5 범위 밖으로 선언했다. 별도 워크트리에서
다른 에이전트가 담당하고 있었기 때문이다. 그 작업이 완료돼 이 라운드로 편입했으므로 그 선언을 정정한다.

## 무엇이 들어왔는가

`src/server/responses/core.ts` 9,386 -> 210줄. 리프 24개가 `src/server/responses/` 하위에 생겼다.
가장 큰 리프는 `passthrough-dispatch.ts` 1,476줄이고 전부 2,000줄 아래다.

앞선 네 단위와 결정적으로 다른 점이 하나 있다. 나머지는 순수 이동이었지만 이것은 아니다.
`handleResponsesInner` 는 약 5,600줄짜리 단일 함수였고, 그 본문을 13개 처리 구간으로 나눴다.
계정 교체나 재시도 후에도 같은 상태를 보아야 하는 값들은 복사하지 않고 원래 지역 변수에 연결된
getter/setter 로 넘긴다: 전송 예산, adapter, 인증 snapshot, 도구 별칭, 취소 상태, continuation 재시도 횟수.

이 결정이 라운드5 의 `serveOptions` 추출과 같은 성질이다. 거기서도 가변 캡처 3개를 구조 분해하면
스냅샷이 되어 조용히 깨졌다. 여기서는 그 대상이 6종이고, 대상이 하나라도 값 복사로 새면 계정 교체
직후의 재시도가 이전 계정의 예산과 adapter 를 들고 돌아간다.

## 오라클 처리 방식이 더 낫다

라운드5 는 오라클을 손으로 재지정했고 두 번 놓쳤다. bridge 에서는 경로가 조립돼 있어서 리터럴 검색이
못 봤고(CI 에서 `Received value does not have a length property: null`), server/index 에서는 같은 파일
안 세 번째 describe 를 시뮬레이션이 빠뜨렸다.

core.ts 쪽은 `tests/helpers/responses-core-source.ts` 에 모듈 목록을 상수로 두고
`readResponsesCoreSource()` 가 그 전부를 이어 읽는다. 그리고 `tests/responses/responses-core-modules.test.ts` 가
그 목록이 실제 소스 import 그래프와 일치하는지 단언한다. 리프를 추가하고 목록에 넣지 않으면 그 테스트가
실패하므로, 오라클이 조용히 vacuous 해지는 경로가 닫힌다. 다음 라운드는 이 방식을 먼저 쓴다.

## 이 라운드의 최종 상태

| 파일 | 이전 | 이후 |
| --- | ---: | ---: |
| src/adapters/openai-responses.ts | 2,627 | 6 |
| src/bridge.ts | 2,206 | 7 |
| src/server/index.ts | 3,400 | 893 |
| src/server/responses/core.ts | 9,386 | 210 |

이로써 `src/` 의 산출물 제외 2,000줄 이상 파일은 0개가 된다. 산출물은
`src/adapters/cursor/gen/agent_pb.ts`(15,274) 하나이고 ratchet 의 generated 목록에 있다.

## 남은 것

`handleResponsesInner` 는 사라졌지만 그 자리에 1,476줄짜리 `passthrough-dispatch.ts` 가 있다.
2,000줄 게이트는 통과하지만 한 파일이 하나의 일을 한다고 말하기는 어렵다. 다음 라운드의 후보는
줄 수가 아니라 이런 "게이트는 통과하는데 여전히 큰" 리프들이다.


## 이 산출물에 대한 편입 검토

읽기만 하고 판정한 평가를 남긴다. 편입을 결정한 근거이자, 다음 라운드가 무엇을 고칠지의 목록이다.

설계는 이 라운드의 다른 네 건보다 어렵고 결과도 낫다. 나머지는 전부 순수 이동이었고 이것은
저장소에서 가장 위험한 핫 경로를 실제로 재구성했다. `handleResponsesInner` 가 85줄 파이프라인이 됐고
각 단계가 상태 객체 아니면 `Response` 를 반환해서 `if (x instanceof Response) return x` 한 줄로 원본의
조기 반환을 보존한다. 예외로 흐름을 바꾸는 방식을 택하지 않았고, admission lease 의 바깥쪽 `finally` 도
최상위에 그대로 남아 있다.

가변 상태 처리가 특히 정확하다. getter/setter 의 타입을 새로 적지 않고 `typeof rateLimitRetries` 처럼
원래 지역 변수에 묶어 썼다. 타입을 따로 적어두면 나중에 원본만 바뀌어 조용히 어긋난다. 라운드5 의
`serveOptions` 추출이 같은 함정을 만났고, 이쪽이 더 깔끔하다.

`responses-core-modules.test.ts` 는 이 라운드에서 가장 값어치 있는 장치다. `core.ts` 에서 형제 import 를 따라
그래프를 걷고, 발견된 소유자 집합이 선언된 목록과 양방향으로 같은지 단언하고, 각 모듈이 2,000줄 미만인지
확인하고, 그래프가 비순환인지까지 본다. 라운드5 는 오라클을 손으로 재지정하다 두 번 놓쳤다(bridge 는
CI 가, server/index 는 감사자가 잡았다). 이 방식은 그 경로를 구조적으로 닫는다.

새 모듈 24개에 타입 검사나 린트를 끄는 주석이 하나도 없다. 억제로 통과시킨 자리가 없다는 뜻이다.

### 걸리는 것 두 가지

단계 함수가 위치 인자를 최대 8개 받는다. `deliverAdapterResponse(requestContext, requestState,
transportState, sidecarState, responseEffects, completionPolicy, adapterExchange, continuationState)`
같은 모양이고, 타입이 겹치는 인접 인자 두 개가 바뀌어도 컴파일된다. 라운드4 계획이 제안했던 단일
`ResponsesTurnState` 객체라면 이 위험이 없다. "상태가 인자 목록으로 샌다" 는 비용을 실제로 지불한 자리다.

`passthrough-dispatch.ts` 가 1,476줄이다. 게이트는 통과하지만 한 파일이 한 가지 일을 한다고 말하기
어렵고, 덩어리가 `core.ts` 에서 그 옆으로 옮겨간 면이 있다. 이름도 두 계열로 갈린다.
`request-prepare`, `passthrough-delivery` 는 책임으로 지었고 `core-auth`, `core-errors`,
`core-normalize` 는 "예전에 core.ts 에 있었다" 는 출처 표시일 뿐이다. 후자는 시간이 지나면 의미가 없다.

### 편입 과정에서 고친 것

`bun x tsc --noEmit` 을 실제로 돌리니 `TS4058` 한 건이 나왔다. `passthrough-dispatch.ts:143` 의
`preparePassthroughExchange` 가 export 되면서 추론 반환 타입에 `NamespacedTool` 이 노출되는데, 그 인터페이스는
`src/server/responses-image-gen-repair.ts` 에서 export 되지 않아 이름을 지을 수 없었다. 인터페이스를
export 해서 해결했다. 원본이 한 파일이었을 때는 그 타입이 모듈 밖으로 나가지 않아 드러나지 않던 종류다.

이 오류는 그 워크트리에 `node_modules` 가 없어 진짜 typecheck 를 못 돌린 탓이고, 담당 에이전트가
"테스트·타입체크·빌드는 실행하지 않았다" 고 먼저 밝혔다. 편입 쪽에서 주 체크아웃의 `node_modules` 를
링크해 실제 typecheck 를 돌려 잡았다. 다음 라운드는 이 링크를 먼저 걸고 시작한다 — CI 한 바퀴가
로컬 30초보다 비싸다.


## 편입 검증 결과

독립 감사자가 읽기 전용으로 네 항목을 재측정해 전부 통과했다. 기록할 값어치가 있는 부분만 남긴다.

가변 상태는 실제로 accessor 로 연결돼 있다. 선언이 모두 소유 함수 안의 `let` 이고 반환 객체의 accessor 가
그 바인딩을 닫는다. 전송 예산은 `request-send-budget.ts` 의 `pendingHopPermit` get/set 이고 리프 write 는
`passthrough-dispatch.ts` 1142-1144 다. adapter 와 OAuth snapshot, failover 카운터는 `request-transport.ts`
91-111 선언 / 652-733 get/set 이고 리프가 `transportState.anthropicPoolFailovers += 1` 처럼 쓴다.
continuation 재시도 카운터는 `adapter-dispatch.ts` 345 의 `let rateLimitRetries` 로 recovery loop **바깥**에
있고 934-938 get/set 을 통해 `adapter-continuation.ts` 266 이 증가시킨다. 루프 안쪽에 있었다면 재시도마다
0 으로 돌아가 무한 재시도가 된다. 구조 분해 후 대입하는 위험 패턴은 해당 필드에 없다.

값 순환도 없다. 리프 24개와 `core.ts` 그래프에 `from "./core"` 가 값·타입 모두 없다.
`compact.ts` 와 `policy-fallback.ts` 가 파사드를 값으로 import 하지만 `core.ts` 가 그 둘을 import 하지
않으므로 단방향이다. combo 재진입은 `core.ts` 182 에서 만든 `requestDispatchers` 를 주입받아
`request-prepare.ts` 214 와 `core-combo.ts` 478 이 호출한다.

admission lease 는 두 owner 가 분리돼 있다. 바깥 finally 는 `core.ts` 174-178, native 이관은
`passthrough-execution.ts` 26-27 에서 `pendingHostAdmissionLease` 를 native 쪽으로 옮기고 null 로 비운 뒤
48-52 의 native finally 가 받는다. adapter/runTurn 경로는 pending 을 비우지 않으므로 바깥만 해제한다.
`releaseUpstreamHostAdmission` 이 `activeLeaseIds` 불일치 시 no-op 이고 probe 해제도 id 불일치면 return
하므로 이중 해제 경로가 아니다.

