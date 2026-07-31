# WP7 — PR #431 MiniMax split reasoning (축소 슬라이스)

대상: PR #431 (H-H-E), head `9568cb81`. `git merge-tree` clean.
기여자가 이전 응답 순서 리뷰를 현재 head에서 반영했다.
MiniMax 공식 문서로 `reasoning_split`, M3의 `adaptive|disabled` thinking 제어,
M 시리즈 모델명과 context window를 확인했다
(https://platform.minimax.io/docs/api-reference/text-openai-api).

## 범위 축소 (STRICT)

DO NOT TAKE — 런타임 동작에 불필요한 중복 전파:

```
src/oauth/index.ts
src/oauth/login-cli.ts
src/server/auth-cors.ts
```

### 제외 근거 정정 (A-gate blocker)

최초 안은 이 세 파일을 "OAuth/자격증명/safe-DTO 리뷰 표면을 만든다"는 이유로 제외했다.
**이 근거는 과한 해석이었다.** 세 훅은 각각 기존 필드 목록에 문자열
`"reasoningSplitModels"` 하나를 더하는 한 줄이다.

| 파일 | 변경 | 실제 성격 |
|---|---|---|
| `src/oauth/index.ts:495` | `OAUTH_RECONCILE_FIELDS`에 이름 추가 | 비밀이 아닌 capability 목록 조정 |
| `src/oauth/login-cli.ts:89` | 복사 필드 목록에 추가 | 모델 ID 복사. API 키 취급 무변경 |
| `src/server/auth-cors.ts:323` | `safeConfigDTO` 허용 목록에 추가 | 공개 모델 식별자만 노출 |

이웃 필드 `preserveReasoningContentModels`와 `autoToolChoiceOnlyModels`가 이미
세 곳 모두에 동일하게 존재한다. 파일 위치만으로 신뢰 경계 변경이 되지는 않는다.
WP2(#429)를 보안 경계로 재분류한 것은 모델 생성 인자가 **shell 실행 도구**로
진입하는 지점이었기 때문이고, 여기에는 그런 성격이 없다.

제외하는 진짜 이유는 **런타임에 불필요**하기 때문이다.

- MiniMax는 OAuth provider가 아니다(`registry.ts:930-951`에서 `authKind: "key"`).
  `reconcileOAuthProviders`는 이 provider를 아예 건너뛴다. 게다가 목록에 없는 필드는
  건드리지 않으므로 저장된 값이 삭제되지도 않는다.
- `routeModel()`이 매 라우팅마다 registry seed를 union해 되살린다
  (`router.ts:151-153,205-207`). 리뷰어가 저장 필드를 일부러 제거하고도
  `reasoning_split: true`가 나오는 것을 실행으로 확인했다.
- GUI에 `reasoningSplitModels` 소비자가 없고, 전체 config PUT은 405로 막혀 있으며
  provider PATCH는 언급되지 않은 필드를 보존한다.

다만 `login-cli.ts` 제외에는 실제 대가가 있다: `ocx login minimax`가 저장하는 config에
이 필드가 빠진다. 런타임은 안전하지만 **저장 형태의 완결성은 떨어진다.**
이웃 필드와의 일관성을 생각하면 포함하는 편이 낫다는 판단도 가능하다.
이번 통합은 최소 범위 원칙에 따라 제외하되, 이것이 무해해서가 아니라
런타임 영향이 없어서임을 기록해 둔다.

TAKE:

```
src/adapters/openai-chat.ts
src/providers/derive.ts
src/providers/registry.ts
src/router.ts
src/types.ts
tests/adapter-usage.test.ts
tests/minimax-reasoning-split.test.ts
tests/openai-chat-eof.test.ts
tests/provider-registry-parity.test.ts
```

## MODIFY `src/adapters/openai-chat.ts`

요청 본문 구성 후 추가:

```ts
if (modelInList(provider.reasoningSplitModels, parsed.modelId)) {
  body.reasoning_split = true;
}
```

M3의 adaptive 토글 허용:

```ts
if (
  reasoningEffort === "enabled"
  || reasoningEffort === "disabled"
  || reasoningEffort === "adaptive"
) {
  body.thinking = { type: reasoningEffort };
}
```

스트리밍 순서는 reasoning이 먼저, content가 나중이어야 한다:

```ts
if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
  yield { type: "reasoning_raw_delta", text: delta.reasoning_content };
}
if (typeof delta.content === "string" && delta.content.length > 0) {
  yield { type: "text_delta", text: delta.content };
}
```

비스트리밍도 동일 순서:

```ts
if (typeof msg.reasoning_content === "string" && msg.reasoning_content.length > 0) {
  events.push({ type: "reasoning_raw_delta", text: msg.reasoning_content });
}
if (typeof msg.content === "string") {
  events.push({ type: "text_delta", text: msg.content });
}
```

## 타입 확장

`reasoningSplitModels?: string[]`를 아래 4개 타입에 추가한다.

- `OcxProviderConfig` (`src/types.ts`)
- `ProviderRegistryEntry`
- `ProviderConfigSeed`
- `DerivedKeyLoginProvider`

`routedProviderConfig()`에서 병합하고, `enrichProviderFromRegistry()`에서는
값이 없을 때만 채운다.

## 회귀 테스트

`tests/adapter-usage.test.ts`에 아래 테스트를 유지한다.

```ts
test("OpenAI-compatible streaming emits split reasoning before final content", async () => {
  const adapter = createOpenAIChatAdapter(provider);
  const response = new Response([
    "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"raw stream\",\"content\":\"answer\"}}]}\n\n",
    "data: {\"usage\":{\"prompt_tokens\":9,\"completion_tokens\":4,\"prompt_tokens_details\":{\"cached_tokens\":2},\"completion_tokens_details\":{\"reasoning_tokens\":1}}}\n\n",
    "data: [DONE]\n\n",
  ].join(""));

  const events = [];
  for await (const event of adapter.parseStream(response)) events.push(event);

  expect(events).toEqual([
    { type: "reasoning_raw_delta", text: "raw stream" },
    { type: "text_delta", text: "answer" },
    {
      type: "done",
      usage: {
        inputTokens: 9,
        outputTokens: 4,
        cachedInputTokens: 2,
        reasoningOutputTokens: 1,
      },
    },
  ]);
});
```

현재 head에 비스트리밍/스트리밍/빈 delta/finish-only/중단된 EOF 커버리지가 이미 있다.

## RED 근거 정정 (A-gate blocker 6)

최초 안의 RED 설명은 **사실과 다르다.** `dev:src/adapters/openai-chat.ts:703` 기준으로
baseline은 응답에 `reasoning_content`가 있으면 이미 `reasoning_raw_delta`를 방출한다.
위 테스트가 RED인 진짜 이유는 baseline이 `content`를 reasoning보다 **먼저** 내보내기
때문이지, `reasoning_split`을 지원하지 않아서가 아니다.

즉 위 테스트는 응답 순서 회귀일 뿐, 요청 게이트(`body.reasoning_split = true`)가
활성화되는지는 전혀 증명하지 못한다. 요청 측 테스트를 별도로 추가한다.

## 회귀 테스트 2 — 요청 게이트 활성화 (필수)

A-gate R2 blocker 5 반영: 최초 안의 `configWithMiniMax()` / `parsedWith()`는 존재하지 않는
헬퍼였다. `git show pr-431:tests/minimax-reasoning-split.test.ts`로 확인한 실제 헬퍼는
`minimaxRoute()`, `body()`, `parsed()` 세 개다. 파일이 `dev`에는 없고 이 PR이 신규 추가한다.

실제 헬퍼 시그니처 (PR #431이 추가하는 파일 상단):

```ts
function parsed(modelId: string, reasoning?: ReasoningEffort): OcxParsedRequest
function body(provider: OcxProviderConfig, modelId: string, reasoning?: ReasoningEffort): Record<string, unknown>
function minimaxRoute(modelId = "MiniMax-M3", provider: Partial<OcxProviderConfig> = {}): { provider: OcxProviderConfig; modelId: string }
```

`body()`가 이미 `buildRequest` 결과를 JSON 파싱해 돌려주므로 어댑터를 직접 만들 필요가 없다.

APPEND: `tests/minimax-reasoning-split.test.ts`의 `describe("MiniMax split reasoning")` 블록 안

```ts
  test("a routed MiniMax model sends reasoning_split in the request body", () => {
    const route = minimaxRoute("MiniMax-M2");
    expect(body(route.provider, route.modelId)).toMatchObject({
      model: "MiniMax-M2",
      reasoning_split: true,
    });
  });

  test("a model outside reasoningSplitModels does not send reasoning_split", () => {
    const route = minimaxRoute("some-other-model");
    expect(body(route.provider, route.modelId).reasoning_split).toBeUndefined();
  });
```

`minimaxRoute()`가 `routeModel()`을 거치므로 registry backfill 경로까지 함께 밟는다.
즉 `reasoningSplitModels`가 registry 시드에서 provider config로 실제 전달되는지도 증명된다.

RED→GREEN 근거: 수정 전에는 `body.reasoning_split`이 항상 `undefined`라 첫 테스트의
`toMatchObject`가 실패한다. 두 번째 테스트는 게이트가 무분별하게 켜지지 않음을 잠그는
음성 대조군이며 수정 전후 모두 통과해야 한다 — 수정 후에도 통과해야 의미가 있다.

## 범위 한정 — `reasoning_details` 미지원 (A-gate blocker)

MiniMax 공식 문서는 멀티턴 tool 루프에서 **완전한 `reasoning_details` 필드**를 히스토리에
보존하도록 요구한다. 이 PR은 합성된 `reasoning_content`만 파싱·재생하고,
저장소 전체에 `reasoning_details` 파서·타입·재생 경로·테스트가 **하나도 없다**
(`rg reasoning_details src/ tests/` 결과 0건).

따라서 이 통합이 실제로 보장하는 범위는 다음과 같다.

| 보장됨 | 미보장 |
|---|---|
| 추론 텍스트가 별도 채널로 노출됨 | 멀티턴 tool 루프에서의 interleaved-thinking 연속성 |
| 요청에 `reasoning_split: true` 전송 | `reasoning_details` 왕복 |
| 응답 순서(reasoning → content) | 상류가 `reasoning_content`만으로 continuation을 수락하는지 |

`tests/minimax-reasoning-split.test.ts:87`의
`expect(requestBody.messages[1]?.reasoning_content).toBe("prior reasoning")`이
히스토리 재생을 검증하지만, 이는 우리가 만든 픽스처를 우리가 다시 읽는 구조라
**상류 계약을 증명하지 못한다.**

이번 통합에서는 `reasoning_details`를 구현하지 않는다. 대신 위 한계를 커밋 메시지와
PR close 코멘트에 명시하고, 후속 후보로 기록한다. 근거 없는 계약 주장을 코드로 옮기는
것보다, 범위를 정확히 말하고 남기는 편이 낫다.

구현을 시도한다면 필요한 것: 내부 표현에 `reasoning_details` 보존, 재생 경로 추가,
그리고 **캡처된 실제 wire 픽스처**로 멀티턴 회귀를 잠그는 것. 우리에게 그 wire 캡처가
없으므로 지금은 할 수 없다.

## 활성화 시나리오

새 분기: `modelInList(provider.reasoningSplitModels, ...)` 게이트와 `adaptive` 분기.
위 테스트가 split 경로를 활성화하고, `tests/minimax-reasoning-split.test.ts`가
registry 시드에서 해당 모델 목록이 실제로 채워지는지 확인한다.

## 커밋

```
feat(minimax): support split reasoning and adaptive thinking (#431)

Co-authored-by: Hussein <59151492+H-H-E@users.noreply.github.com>
```

## 검증

```bash
bun test --isolate tests/adapter-usage.test.ts tests/minimax-reasoning-split.test.ts tests/openai-chat-eof.test.ts tests/provider-registry-parity.test.ts
bun run typecheck
```

원본 PR은 draft이고 branch/label 체크만 있다. 축소 슬라이스도 전체 스위트를 새로 돌린다.
