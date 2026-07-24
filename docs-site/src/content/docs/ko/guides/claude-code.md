---
title: Claude Code 사용하기
description: Claude Code에서 라우팅된 모든 모델을 사용해요. opencodex는 같은 포트에서 Anthropic Messages API와 게이트웨이 모델 검색을 제공해요.
---

opencodex는 `/v1/responses`와 함께 `POST /v1/messages`(및 `count_tokens`)를 제공해요. 따라서 Claude
Code에서 OAuth 로그인, 계정 풀, 키 장애 조치, 사이드카를 포함한 모든 라우팅 제공자를 별도의
인증 작업 없이 사용할 수 있어요.

## 빠른 시작

```bash
ocx claude
```

`ocx claude`는 프록시가 실행 중인지 확인한 다음, 환경을 연결해 Claude Code를 실행해요.

| 변수 | 값 |
| --- | --- |
| `ANTHROPIC_BASE_URL` | `http://127.0.0.1:<port>` |
| `ANTHROPIC_AUTH_TOKEN` | 프록시에 API 키가 필요할 때만 설정해요. 그 외에는 설정하지 않으므로 claude.ai 로그인(구독 + 커넥터)이 유지돼요 |
| `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY` | `1` (기본 `/model` 선택기의 모델 검색) |
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | 자동 컨텍스트 압축 임곗값(기본값 `350000`). 자동 컨텍스트가 켜져 있을 때만 주입해요 |
| `ANTHROPIC_MODEL` | `claudeCode.model` (선택 사항) |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | `claudeCode.tierModels.haiku ?? claudeCode.smallFastModel` (선택 사항, 기존 `ANTHROPIC_SMALL_FAST_MODEL`도 지원) |
| `ANTHROPIC_DEFAULT_{OPUS,SONNET,FABLE}_MODEL` | `claudeCode.tierModels.*` (선택 사항) |
| `CLAUDE_CODE_ALWAYS_ENABLE_EFFORT` | `alwaysEnableEffort`가 켜져 있으면 `1` (조건부) |
| `CLAUDE_CODE_MAX_CONTEXT_TOKENS` / `DISABLE_COMPACT` | `maxContextTokens`가 설정된 경우 기존 컨텍스트 재정의 값 (조건부) |
직접 내보낸 변수가 항상 우선해요. 추가 인자는 그대로 전달돼요: `ocx claude -p "hello"`.

## 시스템 환경 통합(macOS)

`claudeCode.systemEnv`를 `true`로 설정하면(기본값: **꺼짐**) `ocx start`가 `launchctl setenv`를
사용해 `ANTHROPIC_BASE_URL`과 관련 Claude Code 환경 변수를 시스템 전체에 주입해요. 따라서 새
터미널 창과 탭에서는 `ocx claude` 래퍼 없이 일반 `claude` 명령도 프록시를 거쳐요. 이미 열려
있는 셸에는 적용되지 않으므로 다시 열어야 해요.

`ocx stop`과 프록시 종료는 **주입된 키를 해제해요**. 이전 값을 복원하지는 않고 opencodex가
주입한 키만 제거해요. 프록시는 `~/.opencodex/claude-env.sh`도 작성하고, `ocx start`는 이 파일을
자동으로 불러오는 `.zshrc` source hook을 설치해요.

설정에서 `claudeCode.systemEnv: false`로 지정하거나 GUI 토글로 끌 수 있어요. 이 기능은 macOS
전용이며, 다른 플랫폼에서는 `ocx claude`를 사용하세요.

## 네이티브 Claude 패스스루(구독 직접 연결)

인증 재정의가 없으면 Claude Code는 claude.ai OAuth 로그인을 유지한 채 프록시로 보내요. 별칭이나
모델 맵이 차지하지 않은 실제 `claude*`/`anthropic*` 모델 요청은 사용자 자격 증명과 함께
`api.anthropic.com`으로 **그대로** 전달돼요. 베타, thinking 서명, 프롬프트 캐싱, 결제 ID는 모두
네이티브 상태로 유지되고, 같은 세션에서 선택기 별칭을 써서 라우팅 모델도 계속 사용할 수 있어요.

**헤더 처리:** hop-by-hop 헤더와 `host`, `content-length`, `accept-encoding`,
`x-opencodex-api-key`, `origin`은 전달 전에 제거해요. 그 밖의 헤더(`anthropic-beta`,
`anthropic-version` 포함)는 그대로 전달해요.

다음 네 조건을 **모두** 충족하면 패스스루가 작동해요. `nativePassthrough`가 `false`가 아니고,
모델 이름이 `claude` 또는 `anthropic`으로 시작하며, bearer 또는 `x-api-key`가 `sk-ant-`로
시작하고, 별칭/모델 맵 해석 결과가 변경되지 않은 같은 모델이어야 해요. 그래서 `ocx claude`를
사용할 때 "claude.ai connectors are disabled" 경고도 더 이상 나타나지 않아요.

`claudeCode.nativePassthrough: false`로 끌 수 있고, `claudeCode.anthropicBaseUrl`로 다른 주소를
지정할 수 있어요.

## /model 선택기("From gateway")

Claude Code 2.1.129 이상은 `GET /v1/models?limit=1000`에서 게이트웨이 모델을 찾아 기본 `/model`
선택기의 "From gateway" 항목에 표시해요. 선택기는 `claude` 또는 `anthropic`으로 시작하는 ID만
받으므로, opencodex는 라우팅 모델을 안정적이고 되돌릴 수 있는 별칭으로 노출해요.

| 화면 | 형식 | 예시 |
| --- | --- | --- |
| Claude Code CLI | `claude-ocx-<provider>--<model>` | `claude-ocx-native--gpt-5.6-sol` |
| Claude Desktop 3P | `claude-opus-4-8-<code>` (3자리 base36 해시) | `claude-opus-4-8-ncb` |

프록시는 요청마다 계열을 골라요. `?ids=cli` 또는 `?ids=desktop`이 우선하고, 지정하지 않으면
`claude-code/*` user-agent에는 읽기 쉬운 CLI 형식을, 다른 클라이언트에는 Desktop 해시를
제공해요. 두 계열은 계속 디코딩할 수 있으므로 어느 형식이든 `settings.json`에 저장한 모델이
계속 작동해요.

**별칭 문법 규칙:** provider에는 `/`나 `--`를 넣을 수 없고 `native`와 같아도 안 돼요. model에는
`/`를 넣을 수 없어요. 읽기 쉬운 형식으로 표현할 수 없는 라우트는 해시 별칭으로 대체해요. 모델
ID에는 `--`를 넣을 **수 있어요**(해석할 때 첫 번째 `--`만 기준으로 나눠요). `--`가 포함된
네이티브 슬러그는 해시 형식으로 대체해요.

**모델 해석 순서:** `[1m]` 표식 제거 → 읽기 쉬운 별칭 디코딩 → Desktop 해시 별칭 디코딩 →
`modelMap` 정확히 일치 → 날짜를 제거한 값과 일치(`-20250514` 제거) → 패스스루 순서예요.

각 항목에는 `gemini-3-pro (gemini)` 같은 표시 이름과 공식 `ModelInfo` 형식의 전체 모델 기능
(reasoning-effort 단계, thinking 유형)이 들어 있어요. 실제 Anthropic 모델은 두 화면 모두에서
정식 ID를 유지해요.

### 컨텍스트 변형 `[1m]` 표식

공식 컨텍스트 창이 1M인 모델에는 `…[1m]` 선택기 행이 하나 더 생겨요. 자동 컨텍스트를 사용할
때는 컨텍스트가 200k를 넘고 압축 임곗값 이상인 모델도 해당해요. 이 행을 선택하면 Claude Code가
전체 1M 컨텍스트를 계산해요. 프록시는 별칭 해석과 라우팅 전에 대소문자를 구분하지 않고 `[1m]`
접미사를 제거해요.

## 자동 컨텍스트(200k 한계 없이 대형 컨텍스트 모델 사용)

Claude Code는 알 수 없는 모델의 컨텍스트를 200k 토큰으로 계산해요. 기본으로 켜져 있는 **자동
컨텍스트**는 이 문제를 해결해요.

1. 실제 컨텍스트 창이 200k보다 크고 자동 압축 임곗값 이상인 모델의 선택기 행과 환경 슬롯에
   `[1m]` 표식이 붙어요.
2. `CLAUDE_CODE_AUTO_COMPACT_WINDOW`(기본값 `350000`, 범위 `100000`–`1000000`)를 주입해 해당
   지점에서 대화를 자동으로 요약해요.

설정 상태는 세 가지예요.

- **없음 / `true`:** 사용(기본값)
- **`false`:** 사용 안 함. 표식도 붙지 않고 압축 창도 주입하지 않아요
- **기존 `maxContextTokens` 설정:** 자동 컨텍스트를 자동으로 꺼요

Claude 페이지에서 압축 값을 조절할 수 있어요. **경고:** 모델의 실제 컨텍스트 창보다 크게 올리면
요약을 시작하기 전에 채팅 오류가 발생해요.

1M 미만인 네이티브 Anthropic 모델에는 자동으로 표식을 붙이지 않아요. 직접 내보낸 값이 항상
우선하며, 프록시는 **사용자가 지정한** 값을 기준으로 어떤 모델에 안전하게 표식을 붙일지 결정해요.
직접 편집한 설정값이 잘못되면 350k로 돌아가요.

### 실제 모델 환경

`effectiveModelEnv`는 `ocx claude` / 시스템 환경 / 셸 파일이 주입할 슬롯 여섯 개를 계산해요.
`ANTHROPIC_MODEL`, 네 개의 `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU,FABLE}_MODEL`, 기존
`ANTHROPIC_SMALL_FAST_MODEL`이에요. 실제 Haiku 값은 `tierModels.haiku ?? smallFastModel`이며,
두 Haiku 변수에 모두 들어가요.

`tierModels.haiku`와 `smallFastModel`이 모두 없으면 OpenCodex는 두 보조 모델 변수를 설정하지 않아요. 그러면 Claude Code가 네이티브 보조 모델(현재 Sonnet)을 선택하며, 네이티브 프로바이더 요금이 발생할 수 있어요.

## 로스터 에이전트(injectAgents)

`ocx claude`와 시스템 환경 데몬은 추천 서브에이전트 로스터(Subagents 탭, 최대 5개 모델)와
`ocx-self`를 `~/.claude/agents/ocx-*.md`에 동기화해요.

- **`ocx-self`**는 `/model` 선택기의 기본값을 고정하고, 값이 없으면 `claudeCode.model`을 사용해요.
  둘 다 없으면 만들지 않아요. 모델 상속은 사용하지 않아요.
- 각 에이전트 본문에는 `<!-- ocx-route: <model> -->` 지시문이 들어 있어요. 프록시는 이 지시문으로
  실제 라우트를 고정해요. 따라서 Agent 도구의 `model` 인자는 작동하지 않으며, 자리 표시자로
  `"haiku"`를 전달하세요.
- frontmatter에는 별칭이 들어가고, 라우팅은 지시문을 따라요.
- `generated-by: opencodex`가 들어 있는 표식 검증된 `ocx-*.md` 파일만 덮어쓰거나 정리해요.
  사용자가 만든 에이전트는 건드리지 않아요.
- 파일마다 원자적으로 동기화해요(write + rename).
- `enabled: false` 또는 `injectAgents: false`를 설정하면 소유권이 확인된 정의를 모두 정리해요.
- GUI PUT과 로스터 변경은 즉시 다시 동기화하고, launcher/system-env는 실행할 때 동기화해요.

디스패치 예시: `subagent_type: "ocx-gpt-5-6-sol"`. 1M을 지원하는 대상에는 `[1m]`이 자동으로
붙어요.

## 번들 스킬 생략(blockedSkills)

Claude Code의 번들 `claude-api` 스킬은 Anthropic 문서 약 840KB(약 136k 토큰)를 주입하며,
Claude 모델을 언급하면 자동으로 실행돼요. 라우팅 모델은 이 번들로 학습되지 않았으므로,
opencodex는 기본적으로 **라우팅된** 요청에서 스킬 내용을 짧은 스텁으로 바꿔요. 네이티브
Anthropic 패스스루는 그대로 유지해요.

**두 가지 전달 형식을 처리해요.**

1. **도구 결과 전달:** assistant의 `Skill(...)` 호출에서 소문자로 바꾼 JSON 입력에 차단된 이름이
   있으면 짝을 이루는 `tool_result` 본문을 스텁으로 바꿔요.
2. **텍스트 블록 전달:** `Base directory for this skill: `로 시작하는 10,000자 이상의 사용자
   텍스트 블록에서 디렉터리 basename이 차단된 이름과 일치하는지 확인해요(대소문자 구분 없음).

`claudeCode.blockedSkills`로 설정할 수 있어요(기본값 `["claude-api"]`, `[]`이면 생략 기능을 완전히
꺼요). 스텁은 도구 호출과 결과의 짝을 유지해요.

## 모델 맵(가로채기)

`claudeCode.modelMap`은 라우팅 전에 들어오는 Anthropic 모델 ID를 다시 써요.

```json
{
  "claudeCode": {
    "modelMap": {
      "claude-sonnet-4-5": "gemini/gemini-3-pro",
      "claude-haiku-4-5": "gemini/gemini-3-flash"
    }
  }
}
```

조회 순서: 검색 별칭 → 정확한 ID → 날짜 접미사를 제거한 ID(`-20250514`) → 패스스루 순서예요.

## 사이드카 매트릭스: 웹 검색과 이미지 이해

라우팅 모델마다 쓸 수 있는 호스팅 도구와 이미지 지원 범위가 달라요. opencodex는 메인 모델이
답하기 전에 부족한 기능을 다음 두 사이드카로 보완해요.

- **웹 검색 사이드카**는 실제 호스팅 검색을 실행한 뒤 답변과 출처를 도구 결과로 라우팅 모델에
  전달해요.
- **비전 사이드카**는 `noVisionModels`에 등록된 모델을 호출하기 전에 첨부 이미지를 설명하고,
  원본 이미지를 그 설명으로 바꿔요.

두 사이드카 모두 아래 백엔드 중 하나를 사용할 수 있어요.

| 백엔드 | 실행 방식 | 필요한 조건 |
| --- | --- | --- |
| `openai` | ChatGPT `forward` 프로바이더를 통해 작은 GPT 모델을 호출 | ChatGPT 로그인과 활성화된 `authMode: "forward"` 프로바이더 |
| `anthropic` | 저장된 Anthropic OAuth로 Claude를 호출. 웹 검색은 `web_search_20250305`를 쓰고, 비전은 Claude가 이미지를 설명 | 활성 계정이 `needsReauth` 상태가 아닌 `adapter: "anthropic"`, `authMode: "oauth"` 프로바이더 |

`backend`를 직접 지정하면 그 값이 항상 우선해요. 생략하면 쓸 수 있는 Anthropic OAuth 계정이
있을 때 `anthropic`, 없을 때 `openai`를 선택해요. 사용할 수 있는 자격 증명 없이
`anthropic`을 명시하면 **실패 후 중단(fail closed)** 해요. ChatGPT 자격 증명을 빌리거나 다른
백엔드로 몰래 바꾸지 않아요. OpenAI 백엔드도 ChatGPT 로그인과 forward 프로바이더가 둘 다
없으면 켜지지 않아요.

Claude Code에서 들어온 라우팅 요청을 내부에서 재생할 때는 메인 ChatGPT 로그인을 붙여 줘요.
그래서 Claude Code의 bearer가 프록시 인증용 값이어도 OpenAI 사이드카에 연결할 수 있어요. 이
ChatGPT bearer는 메인 라우팅 프로바이더에는 전달하지 않아요.

```json
{
  "webSearchSidecar": {
    "backend": "anthropic",
    "model": "claude-sonnet-5",
    "maxSearchesPerTurn": 3
  },
  "visionSidecar": {
    "backend": "anthropic",
    "model": "claude-sonnet-5",
    "maxDescriptionsPerTurn": 8
  }
}
```

`maxDescriptionsPerTurn`은 메인 모델의 한 턴에서 새로 만들 이미지 설명 수를 제한해요. 캐시
적중과 같은 턴에서 중복된 설명 요청은 한도를 쓰지 않아요. 성공한 `data:` 이미지 설명은 백엔드,
모델, detail, 이미지 바이트, 요청 문맥을 기준으로 캐시해 같은 이미지와 문맥을 매번 다시 설명하지
않아요. 내용이 바뀔 수 있는 원격 `https:` 이미지는 캐시하지 않아요.

전체 설정 키는 [설정 레퍼런스](/opencodex/ko/reference/configuration/#sidecars)에서 확인할 수
있어요. Anthropic OAuth 웹 검색과 이미지 설명은 저장소에서 이미 사용 중인 Claude Code OAuth
fingerprint 방식을 그대로 따르지만, 장시간 무인 작업에 쓰기 전에는 본인 계정과 실제 작업으로
충분히 soak test하는 편이 좋아요.

<!-- TODO(WP5 GUI): GUI 컨트롤이 완성되면 사이드카 설정 화면 안내를 추가하세요. -->

## 추론 강도

Claude Code의 `/effort` 설정은 어댑터에서도 유지돼요.

| 전송 형식 | 매핑 |
| --- | --- |
| `thinking.type: "adaptive"` + `output_config.effort` | Effort를 그대로 전달해요(`minimal`\|`low`\|`medium`\|`high`\|`xhigh`\|`max`\|`ultra`) |
| `thinking.type: "enabled"` + `budget_tokens` | ≤4096→`low`, ≤16384→`medium`, 그보다 크면→`high` |
| `thinking.type: "disabled"` | 추론 매개변수를 모두 생략해요 |

해석된 값은 요청 로그의 **Reasoning effort** 열에 표시돼요.

## 입력 변환(Messages → Responses)

프록시는 모든 Anthropic Messages API 요청을 Codex Responses API 형식으로 변환해요.

| Messages 입력 | Responses 출력 |
| --- | --- |
| 최상위 `system` | `instructions`(텍스트 블록을 `\n\n`으로 연결) |
| `messages[].role: "system"` | `instructions`에도 합쳐요 |
| 사용자 텍스트 / 이미지 | `input_text` / `input_image`(base64 → data URL) |
| Assistant 텍스트 | `output_text` |
| Assistant `tool_use` | `function_call`(`input` → JSON 문자열로 변환한 `arguments`) |
| 사용자 `tool_result` | `function_call_output`(`is_error` → `[tool error]` 접두사) |
| `thinking` / `redacted_thinking` 재생 | 버려요 |
| Function 도구 | `{type: "function"}`(`web_search*` → `{type: "web_search"}`) |
| `tool_choice` | `auto`→`auto`, `none`→`none`, `any`→`required`, 이름 지정→`{type:"function",name}` |
| `max_tokens` | `max_output_tokens` |
| `stop_sequences` | `stop` |

**오류 조건(400):** 잘못된 JSON, 누락되거나 빈 `model`, 누락되거나 빈 `messages`, 지원하지 않는
role, `tool_use_id` 없는 `tool_result`, id/name 없는 `tool_use`, name 없는 이름 지정 `tool_choice`예요.

## 출력 변환(Responses → Messages SSE)

| Responses 이벤트 | Messages SSE |
| --- | --- |
| `response.created` | `message_start` + `ping` |
| Heartbeat | `ping` |
| 텍스트 delta | `content_block_start` → `content_block_delta`(text) → `content_block_stop` |
| 추론 요약/텍스트 | 합성 signature가 있는 `thinking` 블록 |
| Function-call 프레임 | `input_json_delta`가 있는 `tool_use` 블록 |
| 종료 이벤트 | `message_delta` → `message_stop` |
| 종료 전에 EOF | 502 형식 `api_error` |

**중단 이유 매핑:** `completed` → `tool_use`(도구 호출이 있을 때) 또는 `end_turn`,
`incomplete/max_output_tokens` → `max_tokens`, `incomplete/content_filter` → `refusal`이에요.

**오류 분류:** 400 `invalid_request_error`, 401 `authentication_error`,
402 `billing_error`, 403 `permission_error`, 404 `not_found_error`, 409 `conflict_error`,
413 `request_too_large`, 429 `rate_limit_error`, 504 `timeout_error`, 529 `overloaded_error`,
그 밖의 5xx는 `api_error`예요. `Retry-After`는 그대로 유지해요.

## 프롬프트 캐싱과 토큰 사용량

**Anthropic 라우팅 요청:** 어댑터가 도구, 시스템 내용, 끝에서 두 번째 사용자 메시지의 캐시
분기점과 최상위 자동 `cache_control`을 관리해요. 안정적인 대화에서는 보통 캐시 적중률이 약
99.9%예요.

**네이티브 OpenAI/ChatGPT 라우팅:** 세션 범위 `prompt_cache_key`(`metadata.user_id`가 있으면
사용하고, 없으면 시스템 내용 해시 사용)와 캐시 선호도를 위한 `session_id` 헤더를 만들어요.
캐시 키에는 모델과 전체 도구 스키마가 들어가요.

**토큰 계산:** Anthropic 출력은 `input_tokens`에서 `cached_tokens`와 `cache_write_tokens`를 빼고,
각각 `cache_read_input_tokens`와 `cache_creation_input_tokens`로 노출해요. 요청 로그는 이를 다시
포괄적인 `inputTokens`로 매핑하며, 읽기는 `cachedInputTokens`와 `cacheReadInputTokens`에 모두,
쓰기는 `cacheCreationInputTokens`에 기록해요. Usage 페이지는 캐시 적중과 캐시 생성을 따로 보여줘요.

**count_tokens:** 라우팅 모델은 직렬화한 system + messages + tools를 바탕으로 근삿값을 사용해요.
`sk-ant-` 자격 증명이 있는 네이티브 Anthropic 모델은 요청을 실제 Anthropic
`/v1/messages/count_tokens` 엔드포인트로 전달해요.

## 디버그 캡처

`ocx debug claude on|off|status|reset`, `OCX_CLAUDE_DEBUG=1` 또는
`PUT /api/debug {"claude": true}`로 입력 캡처를 제어해요. `GET /api/claude/inbound-debug`는
`{enabled, entries}`를 반환해요(최신 항목부터, 20개 순환 버퍼).

각 항목에는 `at`, `endpoint`, `model`, `resolvedModel`, `stream`, `maxTokens`,
`thinkingType`, `thinkingBudgetTokens`, `outputConfigEffort`, `metadataKeys`,
`hasMetadataUserId`, `hasSystem`, 원본 `anthropicBeta`, 사용자 ID / system의 8자리 HMAC 동등성
태그가 기록돼요. **프롬프트 텍스트, 원본 객체, 실행 간에 유지되는 해시는 저장하지 않아요.** Claude
디버그를 끄면 순환 버퍼가 즉시 비워져요.

## GUI(Claude 페이지)

대시보드 사이드바에는 API 아래에 전용 **Claude** 페이지와 **Claude ON** 토글이 있어요. 토글
레이블은 모든 언어에서 의도적으로 같아요. 페이지에는 다음 항목이 표시돼요.

- 입력 차단 스위치(사용 토글)
- 빠른 시작(`ocx claude`)과 수동 환경 블록
- Fast Mode 선택기(Auto / ON / OFF)
- 자동 컨텍스트 토글과 압축 임곗값 드롭다운
- 서브에이전트 자동 등록 토글
- 모델 가로채기(modelMap) 편집기
- 선택기 별칭 실시간 미리 보기

`GET /api/claude-code`는 실제 기본값, 설정, 컨텍스트 창 레지스트리, 실제 환경, 사용 가능한 라우트
ID, 별칭, 포트를 반환해요. `PUT /api/claude-code`는 부분 업데이트이며 생략한 필드를 유지해요.
`null`은 context/blocklist/compact-window 값을 초기화해요.

## 문제 해결

**Claude Code에 "Did 0 searches"가 표시됨** — 현재 버전은 완료된 Responses
`web_search_call`을 Anthropic의 `server_tool_use`와 `web_search_tool_result` 블록 쌍으로 바꾸고,
`usage.server_tool_use.web_search_requests`도 함께 기록해요. 검색은 됐는데 0회로 표시되는 예전
버전을 쓰고 있다면 opencodex를 업데이트하세요.

**사이드카가 켜지지 않음** — `backend: "openai"`라면 ChatGPT 로그인과 활성화된
`authMode: "forward"` 프로바이더가 모두 있는지 확인하세요. `backend: "anthropic"`이라면 저장된
Anthropic OAuth 활성 계정이 `needsReauth` 상태가 아닌지 확인하세요. 사용할 수 있는 자격 증명 없이
Anthropic 백엔드를 명시하면 의도적으로 실패 후 중단해요.

**"claude.ai connectors are disabled"** — 셸에 `ANTHROPIC_API_KEY` 또는
`ANTHROPIC_AUTH_TOKEN`이 설정되어 있어요. `ocx claude`는 의도적으로 `ANTHROPIC_API_KEY`를
설정하지 않으므로, 직접 내보냈다면 해제하세요. `ocx claude`를 사용할 때는
`ANTHROPIC_BASE_URL`, 검색, 자동 컨텍스트, 설정된 모델 슬롯을 주입하지만
`ANTHROPIC_API_KEY`는 절대 주입하지 않아요.

**/model 선택기에 모델이 표시되지 않음** — `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`이
설정되어 있는지 확인하세요(`ocx claude`에서는 자동). `ocx claude`를 실행해
`~/.claude/cache/gateway-models.json`의 게이트웨이 모델 캐시를 새로 고치세요.
`claudeCode.enabled`가 `false`가 아닌지도 확인하세요.

**포트 변경 뒤 오래된 환경이 남음** — 프록시 포트가 바뀌었다면 기존 셸의
`ANTHROPIC_BASE_URL`이 오래된 값일 수 있어요. 새 터미널을 열거나 `ocx claude`를 다시 실행하세요.

**대형 모델인데도 컨텍스트가 200k로 제한됨** — 선택기에서 `[1m]` 변형을 고르거나 기본으로
켜져 있는 자동 컨텍스트를 사용하세요. 선택기에 `[1m]` 행이 없다면 모델의 공식 컨텍스트 창이
자동 압축 임곗값보다 작을 수 있어요.

**스킬을 불러올 때 토큰 수가 많음** — 번들 `claude-api` 스킬(약 136k 토큰)은 Claude 모델을
언급하면 자동으로 불러와요. 네이티브 패스스루에서는 정상이며, 라우팅 모델에서는 opencodex가
기본적으로 스텁으로 바꿔요(`blockedSkills: ["claude-api"]`).

**서브에이전트가 잘못된 모델로 디스패치됨** — 로스터 에이전트(`ocx-*`)는 Agent 도구의 `model`
인자가 아니라 `<!-- ocx-route: ... -->` 지시문을 사용해요. 지시문이 원하는 라우트와 일치하는지
확인하고, 모델 자리 표시자로 `"haiku"`를 전달하세요.
