# 010 — wp2 / ISSUE-1: ZCode export를 Responses kind로

## 결함

src/clients/config-export/zcode.ts 가 kind "openai-compatible" 을 내보낸다. ZCode 는 그 kind 에서
{baseURL}/chat/completions 를 호출하고, ocx 의 Chat 인바운드는 본문을 Responses 로 번역해
handleResponses 로 리플레이한 뒤 응답을 다시 Chat SSE 로 역번역한다. 왕복 2회 번역이고 그 과정에서
tool-call delta 와 reasoning 블록이 형태를 바꾼다.

ZCode 는 kind "openai" 로 {baseURL}/responses 를 직접 호출한다(002 문서의 fL / IHe 인용).
ocx 는 POST /v1/responses 를 네이티브로 서빙한다(src/server/index.ts:1994). 번역 0회.

## 변경

### MODIFY src/clients/config-export/zcode.ts

다섯 지점이다. 타입 리터럴(33행), 빌더 값(94행), 그리고 세 주석 블록(10-11행, 49-54행, 76-78행).

    - kind: "openai-compatible";
    + kind: "openai";

    -        kind: "openai-compatible",
    +        kind: "openai",

주석은 3.11.2 번들에서 재추출한 사실로 갱신한다: getDefaultModelProviderEndpointPathForKind 가
anthropic 을 /v1/messages, openai 를 /responses, openai-compatible 을 /chat/completions 로 보낸다는
것과, Responses 가 프록시의 네이티브 인바운드라 이전 배선이 턴마다 번역 두 번을 냈다는 것.

baseURL 은 그대로 ctx.baseUrl 에서 /v1 을 떼고 다시 "/v1" 을 붙인 값이다. ZCode 의
normalizeModelProviderBaseUrlForKind 는 openai kind 에서 /responses 접미사만 떼므로 /v1 은 보존되고
최종 URL 은 http://127.0.0.1:<port>/v1/responses 가 된다.

reasoning 블록(enabled / variants / defaultVariant)은 kind 와 무관하게 같은 스키마다. openai kind 에서는
선택된 variant 가 reasoning.effort 로 나가고, 그건 ocx /v1/responses 가 네이티브로 읽는 필드다.

76-78행 주석이 "ZCode forwards the selected variant as reasoning_effort" 라고 말하는데 그건
openai-compatible kind 의 wire 필드다. openai kind 는 reasoning.effort 로 보낸다(002 문서의
withOpenAiResponsesThoughtLevel 인용). 동작은 스키마가 같아 그대로지만 주석은 틀리므로 함께 고친다.

### MODIFY tests/providers/zcode-client.test.ts

    -    expect(provider.kind).toBe("openai-compatible");
    +    expect(provider.kind).toBe("openai");

options 기대값(baseURL http://127.0.0.1:10100/v1)은 바뀌지 않는다. 같은 describe 에 회귀 테스트를
하나 추가해, ZCode 가 openai kind 에서 조립하는 최종 URL 이 프록시가 실제로 서빙하는 경로와
일치한다는 것을 고정한다.

    test("the exported kind resolves to the proxy's native Responses route", () => {
      const document = buildClientConfig("zcode", context()) as ZcodeGeneratedConfig;
      const provider = document.provider[OPENCODE_PROVIDER_ID]!;
      // ZCode 3.11.2 getDefaultModelProviderEndpointPathForKind: openai -> "/responses".
      expect(provider.kind).toBe("openai");
      expect(provider.options.baseURL + "/responses").toBe("http://127.0.0.1:10100/v1/responses");
    });

### MODIFY tests/config/client-config-export.test.ts

123행 직렬화 바이트 고정값에서 "kind":"openai-compatible" 을 "kind":"openai" 로 바꾼다.
나머지 필드 순서와 값은 동일하다.

## 마이그레이션 — 기대 결과는 stale -> rewrite

감사에서 확정됐다. kind 는 refreshable 경로가 아니지만(ownership-policy.ts:66-84), 사용자가 파일을
손대지 않았다면 recordedBlockIsOwned 가 기존 지문으로 true 를 돌려주고(integrations/state.ts:213)
desired 지문만 달라져 상태가 stale 이 된다(state.ts:411). JSON 클라이언트인 zcode 는 stale refresh 에서
프래그먼트를 다시 쓴다. 즉 미수정 설치는 자동으로 따라온다.

--overwrite-conflict 는 사용자가 kind 나 options 를 직접 고쳐 이미 foreign-edit 인 경우에만 필요하다.
tests/clients/integrations-writer.test.ts:525 의 conflict 케이스는 사용자가 baseURL 을 편집한 상황이지
ocx 가 kind 를 바꾸는 상황이 아니다.

회귀 테스트는 구성 가능한 쪽으로 넣는다. 이전 빌드가 쓴 기록(옛 지문)을 이 하네스에서 만들 수 없어
"옛 기록 + 새 계약 -> stale" 은 직접 재현할 수 없다. 그 경로는 코드로만 확인된다
(state.ts:213 recordedBlockIsOwned, state.ts:405-411 stale 분류, writer.ts:390-391 재작성).
대신 보완 관계인 보호 쪽을 고정한다: 사용자가 kind 를 손으로 되돌리면 여전히 conflict / foreign-edit 이고
apply 가 거부된다. baseURL 편집에만 있던 보호를 kind 에도 명시적으로 건다.

## 검증

    bun test tests/providers/zcode-client.test.ts tests/config/client-config-export.test.ts tests/clients/integrations-writer.test.ts
    bun run typecheck
