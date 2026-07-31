# 010 — capability gate 구현 계약

근거는 `000_plan.md`.

## 변경 파일

| 파일 | 종류 |
|---|---|
| `src/providers/openai-tiers.ts` | MODIFY (capability helper) |
| `src/server/responses/core.ts` | MODIFY (v2 gate) |
| `src/server/responses/compact.ts` | MODIFY (v1 gate + 내부 실패 검출) |
| `src/adapters/openai-responses.ts` | MODIFY (routed compaction용 parser) |
| `src/bridge.ts` | MODIFY (incomplete terminal에 compaction item 생성 금지) |
| `tests/responses-compaction-routing.test.ts` | NEW |

## 1. v2 gate (`core.ts:990`)

```ts
-const routedCompaction = parsed._compactionRequest === true && !("passthrough" in adapter && adapter.passthrough);
+// A Responses-shaped wire does not imply Codex v2 trigger support: only the canonical
+// ChatGPT backend speaks that contract. An API-key gateway would receive the private
+// `compaction_trigger` item, answer with an ordinary message, and make Codex fatal (#422).
+const routedCompaction = parsed._compactionRequest === true
+  && !isCanonicalOpenAiForwardProvider(route.provider);
```

passthrough 실행 분기(999행)도 함께 좁힌다. routedCompaction일 때는 passthrough로 내려가면
안 된다.

```ts
-if ("passthrough" in adapter && adapter.passthrough) {
+if ("passthrough" in adapter && adapter.passthrough && !routedCompaction) {
```

`isCanonicalOpenAiForwardProvider`는 이미 65행에 import되어 있다.

### gate만으로는 부족하다 (P에서 확인)

`core.ts:993`의 routedCompaction 블록은 `parsed.context.messages`에 `COMPACT_PROMPT`를
push하고 `parsed.context.tools`를 지운다. 그런데 passthrough adapter의 `buildRequest`
(`openai-responses.ts:564`)는 **`parsed._rawBody`를 사용한다.**

```ts
let outBody = stripPreviousResponseId(parsed._rawBody, ...);
```

따라서 gate만 고치면:

- `COMPACT_PROMPT`가 upstream에 도달하지 않는다 (context에만 들어감)
- `compaction_trigger`가 raw body에 그대로 남아 계속 전달된다
- tools도 제거되지 않는다

즉 **buildRequest 쪽에서 raw body를 compaction용으로 다시 쓰는 처리가 반드시 함께 필요하다.**

```ts
/**
 * Rewrite a routed compaction turn for an upstream that does not speak Codex's
 * private `compaction_trigger`: drop the trigger and the tool surface, and ask for
 * the handoff summary in plain terms instead (#422).
 */
function buildRoutedCompactionBody(body: unknown): unknown
```

- `input`에서 `type === "compaction_trigger"` 항목 제거
- 끝에 `{type:"message", role:"user", content:[{type:"input_text", text: COMPACT_PROMPT}]}` 추가
- `tools` / `tool_choice` / `parallel_tool_calls` 제거
- `input`에서 `type === "additional_tools"` 항목 제거. Codex Desktop의 responses-lite
  형식은 top-level `tools`가 아니라 이 input item에 도구를 싣는다(`parser.ts:275`).
  남기면 "no tools" 불변식이 깨지고 호환 게이트웨이가 private item을 거부하거나 tool call을
  반환해 compaction이 다시 실패한다.
- `input` 안의 raw `input_image` 파트를 짧은 텍스트 마커로 치환한다.

### 이미지 동기화가 필요한 이유

`core.ts:950`의 `describeImagesInPlace()` / `stripImagesInPlace()`는 `parsed.context.messages`만
바꾼다. adapter가 `_rawBody`를 쓰므로 `noVisionModels` provider의 compaction에서는 설명이나
제거 결과가 아니라 **원본 `input_image`가 그대로 upstream으로 간다.** text-only 게이트웨이는
400을 낼 수 있고 sidecar 호출도 낭비된다.

**결정 (B로 미루지 않는다): marker 치환을 택하고, compaction 턴에서는 vision sidecar를
아예 건너뛴다.**

근거: compaction은 대화 요약을 만드는 작업이라 이미지 원본도, 이미지 설명도 필요 없다.
sidecar를 돌린 뒤 결과를 버리면 비용만 낭비된다. `core.ts`의 routedCompaction 블록이
`_webSearch`를 지우는 것과 같은 이유로 vision 처리도 건너뛴다.

치환 범위는 **`input` 하위 전체를 재귀 순회**한다. `input_image`는 message content뿐 아니라
`function_call_output.output` 안에도 들어갈 수 있다. 발견되는 모든 `input_image` 파트를
`{type:"input_text", text:"[image omitted for compaction]"}`로 바꾼다.

테스트 8의 oracle: upstream body에 `input_image`가 없고, **vision sidecar가 호출되지 않았다**는
것까지 확인한다.

`buildRequest`에서 **core gate와 동일한 조건**으로 적용한다.

```ts
if (parsed._compactionRequest === true && !isCanonicalOpenAiForwardProvider(provider)) {
  outBody = buildRoutedCompactionBody(outBody);
}
```

`authMode !== "forward"`를 조건으로 쓰면 안 된다. 설정 스키마는 custom provider의
`authMode:"forward"`를 허용하고(`config.ts:329` passthrough) router도 보존하므로
(`router.ts:120`), noncanonical forward provider가 실재한다. 그 경우 core는
`routedCompaction === true`로 판정하는데 adapter는 rewrite를 건너뛰어 trigger와 tools가
다시 upstream으로 나간다. **두 조건은 반드시 같은 판정자를 써야 한다.**

## 2. v1 gate (`compact.ts:206`)

```ts
-if (route.provider.adapter === "openai-responses") {
+// Native /responses/compact exists on the canonical ChatGPT backend and on the official
+// OpenAI API. Any other Responses-shaped gateway must use the routed path below (#422).
+if (supportsNativeResponsesCompactEndpoint(route.providerName, route.provider)) {
```

새 helper를 `src/providers/openai-tiers.ts`에 추가한다.

```ts
/**
 * Whether this provider can serve `POST /responses/compact`. The canonical ChatGPT
 * backend does, and so does the official OpenAI API — but an arbitrary
 * Responses-shaped gateway does not, and calling it there fails the compaction (#422).
 */
export function supportsNativeResponsesCompactEndpoint(
  providerName: string,
  provider: OcxProviderConfig,
): boolean
```

구현: `isCanonicalOpenAiForwardProvider(provider)` 이거나, provider가 공식 OpenAI API.
같은 파일의 기존 심볼을 그대로 쓴다 — `OPENAI_API_PROVIDER_ID`(4행)와 private
`normalizedBaseUrl()`. 새 상수를 만들지 않는다.

판정 matrix (테스트 11로 고정):

| provider | 기대값 |
|---|---|
| canonical ChatGPT forward (`isCanonicalOpenAiForwardProvider` 참) | `true` |
| `OPENAI_API_PROVIDER_ID` + `https://api.openai.com/v1` | `true` |
| `OPENAI_API_PROVIDER_ID` + `https://api.openai.com/v1/` (trailing slash) | `true` |
| custom key gateway (`openai-responses`, 임의 baseUrl) | `false` |
| `OPENAI_API_PROVIDER_ID` id지만 baseUrl이 다른 경우 | `false` |

## 3. non-stream parser (`openai-responses.ts:588`)

### 3b. v1 내부 실패 검출 (`compact.ts:325`)

`parseResponse()`가 error를 반환하면 내부 `/responses` JSON은 `status:"failed", output:[]`이지만
**HTTP status는 200**이다. 현재 코드는 `response.ok`만 확인하고 compaction item 부재를 빈
summary로 바꿔 최종적으로 200 + `"(no summary available)"`를 반환한다. 조용한 컨텍스트 유실이다.

내부 응답 JSON을 파싱한 뒤 아래를 각각 비-2xx 오류로 반환한다.

| 조건 | 처리 |
|---|---|
| `json.status !== "completed"` | 502. `failed`는 `upstream_error`로 upstream 메시지 전달, `incomplete`도 거부 — 잘린 요약을 replacement history로 설치하면 안 된다 |
| `json.error`가 존재 | 502, `upstream_error`, 그 메시지 전달 |
| `compaction` item 개수 `!== 1` | 502, `invalid_response_error`, 개수 명시 |
| decoded summary가 비어 있음 | 502, `invalid_response_error`. `decodeCompactionSummary("ocx1:")`는 null이 아니라 **빈 문자열**을 반환하므로 null 검사만으로는 통과한다. `decoded !== null && decoded.trim().length > 0`을 요구한다 |

빈 summary를 성공으로 포장하지 않는다. 호출자가 실패를 알아야 재시도든 다른 경로든 택할 수 있다.

gate를 고치면 API-key `openai-responses`가 routed 경로로 간다. 그런데 v1 synthetic 경로
(`compact.ts:311`)는 내부 요청을 **`stream: false`** 로 만들고, `core.ts:1803`은
`activeAdapter.parseResponse`가 없으면 1844행에서 400을 낸다.

```ts
return formatErrorResponse(400, "invalid_request_error", "Non-streaming not supported by this adapter");
```

현재 passthrough adapter에는 `parseStream` stub만 있고 `parseResponse`는 없다. 따라서
**두 메서드를 모두 제공해야** v1이 동작한다.

```ts
-    async *parseStream(): AsyncGenerator<AdapterEvent> {
-      yield { type: "error", message: "passthrough adapter should not parse stream" };
-    },
+    // Normally the passthrough never parses: the raw upstream stream is relayed as-is.
+    // The exception is a routed compaction turn, where core.ts drives this adapter like
+    // an ordinary one so the bridge can build the compaction item (#422).
+    async *parseStream(response: Response): AsyncGenerator<AdapterEvent> { ... },
+    async parseResponse(response: Response): Promise<AdapterEvent[]> { ... },
```

매핑:

```
SSE  텍스트 추출 우선순위 (기존 production parser와 동일, src/web-search/parse.ts:131 참조):
       1. response.completed 의 response.output[]  (authoritative snapshot)
       2. response.output_text.done
       3. response.output_text.delta 누적
     세 경로가 중복 누적되지 않게 한다 (completed snapshot이 있으면 그것만 쓴다).
     response.completed          -> done (+usage)
     response.failed / error     -> error
JSON output[].type === "message" 의 content[].type === "output_text" 를 이어붙여
     text_delta + done

     실패 상태 매핑 (누락하면 bridge가 빈 결과를 completed compaction으로 재포장한다):
       status "failed" 또는 error 존재 -> AdapterEvent.error (upstream 메시지 보존)
       status "incomplete"             -> incomplete 신호 (성공으로 취급 금지)
       status "completed"인데 usable text 없음 -> error
```

SSE 쪽도 동일하게 명시한다.

```
SSE  response.incomplete -> AdapterEvent.incomplete
```

없으면 partial delta 뒤에 incomplete가 와도 parser가 성공으로 마감해 잘린 요약이 남는다.

## 5. bridge: incomplete terminal에는 compaction item을 만들지 않는다

`src/bridge.ts:1082`:

```ts
if (options?.compaction && !errorEvent) {
```

error만 제외하므로 **`status:"incomplete"`에도 compaction item이 생성된다.** 실측 확인:
`status:"incomplete"`이면서 `compactionCount:1`, summary `"partial summary"`가 만들어진다.
v1은 새 status validator가 막아주지만, 직접 non-stream `/responses`를 쓰는 경로에서는
잘린 요약이 그대로 compaction output으로 노출된다.

같은 함수가 이미 `incompleteEvent`와 `stopReason === "max_tokens"`로 status를 계산하므로
그 판정을 재사용한다.

```ts
-if (options?.compaction && !errorEvent) {
+// A truncated turn must not be installed as replacement history: emit no compaction
+// item unless the turn actually completed (#422).
+if (options?.compaction && !errorEvent && !incompleteEvent && stopReason !== "max_tokens") {
```

`incompleteEvent`/`stopReason`이 이 시점에 계산돼 있는지 B에서 확인하고, 아니면 status 계산을
compaction 블록보다 앞으로 옮긴다.

delta 없이 `output_text.done`이나 completed snapshot만 보내는 게이트웨이가 실재한다.
delta만 처리하면 **빈 compaction이 성공으로 처리되어 대화 컨텍스트가 통째로 유실된다.**

```
```

B에서 확인할 것:

1. 이 저장소의 SSE 디코더 export 이름과 시그니처.
2. `AdapterEvent`의 `done` variant가 usage를 받는 형태와 기존 usage 추출 헬퍼.
3. `parseStream`이 받는 실제 인자 형태 (다른 adapter의 시그니처와 맞춘다).
4. routedCompaction 경로가 `_webSearch`/이미지/encrypted payload 등 다른 분기와 충돌하지
   않는지. `core.ts:993`이 이미 `_webSearch`를 지우고 있으므로 그 전제를 재확인한다.

## 회귀 테스트 (`tests/responses-compaction-routing.test.ts`, NEW)

`tests/responses-shadow-intercept.test.ts:66`의 `globalThis.fetch` + `handleResponses()`
패턴을 따른다.

1. `key openai-responses runs a synthetic compaction (stream)` — **핵심 회귀**
   - **upstream이 실제로 받은 body**에 `compaction_trigger` 없음, tools 없음,
     `COMPACT_PROMPT` 포함 (context가 아니라 wire를 검사해야 한다 — buildRequest가
     `_rawBody`를 쓰므로 context만 확인하는 테스트는 이 버그를 놓친다)
   - proxy SSE의 `response.output_item.done`이 정확히 1개이고 type이 `compaction`
   - 수정 전 실패: trigger가 그대로 전달되고 결과가 `message`
2. 같은 조건 `stream:false`
   - JSON `output`에 `compaction` 1개
   - 수정 전 실패: `parseResponse` 부재로 400
3. `canonical forward keeps native passthrough`
   - trigger가 ChatGPT upstream으로 전달되고 응답이 무변경 relay
   - gate가 forward를 synthetic으로 오분류하지 않음을 고정
4. `custom key provider uses the routed v1 path`
   - `/responses/compact`가 아니라 `/responses` 호출
   - 최종 output이 retained user message + `SUMMARY_PREFIX` summary
5. `official openai-apikey keeps the native compact endpoint`
6. `upstream error surfaces as an error, not an empty compaction`
   - stream/non-stream 각각에서 upstream `response.failed`가 빈 compaction을 만들지 않음
7. `additional_tools are stripped from the compaction wire`
   - top-level `tools` 없이 `input[].type === "additional_tools"`만 있는 요청
   - upstream body에 그 item이 없어야 함
8. `raw input_image does not reach a text-only upstream`
   - `noVisionModels` provider의 compaction에서 upstream body에 `input_image`가 없음
   - sidecar 성공/불가 두 경우 모두
9. `v1 compact surfaces an internal failure as an error`
   - 내부 `/responses`가 `status:"failed"`를 HTTP 200으로 반환할 때
     `/v1/responses/compact`가 비-2xx를 반환 (200 + "(no summary available)"가 아님)
   - 응답 코드가 `upstream_error`이고 upstream 메시지가 보존되는지도 확인한다.
     빈-summary 검사가 대신 실패시켜서 통과하면 wiring 누락을 놓친다
9b. `v1 compact rejects incomplete and empty envelopes`
   - 내부 응답 `status:"incomplete"` → 비-2xx (잘린 요약 설치 금지)
   - `encrypted_content`가 `"ocx1:"`(빈 envelope) → 비-2xx
9c. `noncanonical forward provider still gets the rewrite`
   - `authMode:"forward"`인 custom baseUrl provider의 upstream body에
     `compaction_trigger`와 tools가 없어야 함
   - `authMode !== "forward"` 조건으로 구현하면 여기서 실패한다
9d. `incomplete terminal produces no compaction item`
   - partial text + `status:"incomplete"`에서 stream/non-stream 모두 compaction item 0개
   - 같은 조건에서 v1 `/responses/compact`는 계속 비-2xx
   - `!errorEvent`만 검사하는 구현은 여기서 실패한다
10. `stream text is recovered from every valid event shape`
    - delta만 / `output_text.done`만 / completed snapshot만 보내는 세 경우 모두에서
      compaction summary가 비어 있지 않음
11. `capability helper matrix` — canonical forward / 공식 openai-apikey / trailing slash /
    custom key gateway / 다른 baseUrl의 openai-apikey id

## 검증

```bash
bun run typecheck
bun test tests/responses-compaction-routing.test.ts tests/responses-compaction.test.ts \
         tests/openai-responses-passthrough.test.ts
```
