---
title: Codex 통합
description: opencodex가 Codex에 자신을 주입하고, 모델 카탈로그를 동기화하고, shim을 설치하고, 깔끔하게 복원하는 방식.
---

opencodex는 Codex가 읽는 두 가지, 즉 설정(`$CODEX_HOME/config.toml`, 기본값 `~/.codex/config.toml`)과 모델 카탈로그를 편집해서 Codex가 프록시를 경유하게 합니다. 모든 편집은 멱등적이며 되돌릴 수 있습니다.

프록시는 bare `openai` Codex 로그인 경로 하나와 Pool(기본) 및 Direct 계정 모드, 그리고 설정된 API 키용 `openai-apikey/<model>`을 제공합니다. Pool은 메인 계정과 추가된 계정을 포함하고, Direct는 호출자/메인 bearer만 사용합니다. 경로들은 서로 fallback하지 않습니다. shipped v1 config는 marker 2로 이관되며, 수동 복원을 위해 `config.json.pre-openai-tiers-v2.bak`를 보존합니다.

## 설정 주입

`ocx init`, `ocx start`, `ocx sync`는 모두 인젝터를 호출합니다. 기본 loopback 바인드에서는 Codex의 빌트인 `openai` 프로바이더 id를 그대로 유지한 채, 그 프로바이더가 opencodex를 바라보게 합니다.

```toml
# root keys, before the first table
model_catalog_json = "/absolute/path/to/opencodex-catalog.json"
# Auto-injected by opencodex
openai_base_url = "http://127.0.0.1:10100/v1"

# fastMode를 설정했을 때만 들어갑니다. 설정하지 않으면 [features] 자체가 생기지 않습니다
[features]
fast_mode = true
```

주입되는 `fast_mode`는 3-상태 `fastMode` 설정을 따릅니다. `true`면 `fast_mode = true`를 쓰고,
`false`면 `fast_mode = false`를 쓰며, 설정하지 않으면 기존 `fast_mode`를 그대로 두고
`[features]` 테이블도 추가하지 않습니다.

프록시는 기본적으로 포트 `10100`에서 듣고 `POST /v1/responses`, `POST /v1/responses/compact`, `POST /v1/images/generations`, `POST /v1/images/edits`, `GET /v1/models`, `GET /healthz`, 그리고 `/api/*` 관리 표면을 제공합니다.

### 내장 이미지 생성 (`image_gen`)

Codex의 내장 `image_gen` 도구는 `/v1/responses`를 거치지 않습니다. codex-rs 확장은 채팅과 같은 ChatGPT bearer 인증을 사용해서 `{base_url}/images/generations`를 직접 POST하며, 참조 이미지가 붙어 있으면 `/images/edits`를 POST합니다. 주입된 `base_url`이 opencodex를 가리키므로, 프록시가 이 호출을 OpenAI upstream으로 전달합니다.

이것은 [Image Bridge](/guides/image-bridge/)와는 별개입니다. Image Bridge는 **Responses** 턴이 호스티드 `image_generation` 도구를 나열하고, 선택된 모델이 OpenAI가 아닐 때만 활성화됩니다. 독립적인 `/images/generations` 호출은 이 브리지로 들어가지 않습니다.

- **모드 인식 forward 후보 하나:** Pool은 적격한 메인/추가 계정을 선택하고, Direct는 호출자 OAuth bearer를 사용합니다. 설정된 모드는 이미지 요청에도 일관되게 적용됩니다.
- **OpenAI API-key provider:** forward 후보 중 누구도 인증 실패를 가지지 않을 때만 사용합니다. 고장 나거나 만료된 Pool credential을 별도로 청구되는 API 사용 뒤에 숨기지 않습니다.
- **명시적 커스텀 provider:** `images.provider`를 OpenAI Images API를 구현한 커스텀 API-key `openai-responses` provider id로 설정할 수 있습니다. 명시적으로 선택한 provider는 닫힌 상태로 실패하며, 다른 유료 upstream으로 fallback하지 않습니다. registry-managed provider id는 여기서 허용하지 않습니다. 기본 제공 OpenAI tiers를 쓰려면 `images.provider`를 생략하세요.
- **Google Antigravity (CCA) fallback:** OpenAI forward 후보도 keyed provider도 없을 때, `/v1/images/generations`(`/images/edits`는 제외)는 `gemini-3.1-flash-image` 모델을 사용해서 Antigravity **Cloud Code Assist** endpoint로 fallback합니다. OpenAI 인증 해석이 실패할 때(예: 만료되었거나 누락된 ChatGPT credential)에도 이 fallback이 동작하며, OpenAI 후보가 아예 없을 때만 발생하는 것은 아닙니다. 이 기능은 `ocx login google-antigravity`를 필요로 합니다. OAuth token은 오직 고정된 CCA registry host로만 전송되며, config-level `baseUrl` override로는 가지 않습니다. 응답은 Codex가 기대하는 `{created, data:[{b64_json}]}` 형식으로 반환됩니다.
- **둘 다 없음:** 프록시는 generic 404 대신 명확한 오류를 반환합니다. 라우팅되는 provider(Cursor, Gemini, Kiro 등)는 `image_generation` tool relay를 제공할 수 없습니다. 이 도구를 아예 노출하고 싶지 않다면 Codex에서 `codex features disable image_generation`(`config.toml`의 `[features] image_generation = false`)으로 끄세요.

도구 선언은 여전히 모델의 Responses 요청과 함께 전달됩니다. API-key Responses provider에서는 opencodex가 Codex의 private `image_gen` namespace를 업스트림에서 안전한 `image_gen__<inner-name>` alias(예: `image_gen__imagegen`)로 낮춥니다. 이 사용 가능한 alias가 클라이언트 선언을 대체할 때만 중복된 hosted `image_generation` 선언을 제거합니다. 함수 호출은 Codex가 보기 전에 명시적인 `image_gen` namespace로 다시 매핑되고, 이후 기록이 업스트림으로 replay될 때 다시 인코딩됩니다. 이렇게 하면 namespace를 예약하거나 점이 들어간 함수 이름을 거부하는 공개 호환 upstream에서도 클라이언트 측 이미지 생성을 호출할 수 있습니다. ChatGPT forward 모드는 건드리지 않으며, 네이티브 Responses Lite 형식을 유지합니다.

OpenAI 호환 커스텀 gateway를 쓰려면 전용 provider를 설정하고 standalone Images 요청에만 선택하세요:

```json
{
  "providers": {
    "custom-images": {
      "adapter": "openai-responses",
      "baseUrl": "https://gateway.example.com/v1",
      "authMode": "key",
      "apiKey": "${IMAGE_GATEWAY_API_KEY}"
    }
  },
  "images": {
    "provider": "custom-images",
    "timeoutMs": 300000
  }
}
```

커스텀 endpoint는 `POST /v1/images/generations`와 `/v1/images/edits`를 받아야 하고, Codex가 기대하는 OpenAI Images response shape를 반환해야 합니다. provider에 설정된 key는 upstream 요청 전에 호출자의 bearer를 대신합니다.

> **참고:** 이것은 Codex `image_generation` 도구(`/images/generations` relay)만 가리킵니다. 이미지 생성이 가능한 Gemini 모델은 `google` adapter를 통해(`responseModalities: ["TEXT", "IMAGE"]`) 이 relay와 무관하게 inline image를 네이티브로 생성합니다. 자세한 내용은 [Adapters](/reference/adapters/#google)를 보세요.

`hostname`이 loopback이 아니면 Codex는 생성된 API auth header를 보내야 합니다. 따라서 인젝터는 전용 provider를 주입합니다:

```toml
# root keys
model_provider = "opencodex"
model_catalog_json = "/absolute/path/to/opencodex-catalog.json"

# appended at the end of the file
# Auto-injected by opencodex
[model_providers.opencodex]
name = "OpenCodex Proxy"
base_url = "http://your-host:10100/v1"
wire_api = "responses"
requires_openai_auth = true
env_key = "OPENCODEX_API_AUTH_TOKEN"
# supports_websockets = true   # only when config.websockets is true
```

OpenCodex가 라우팅을 소유할 때는 두 모드 모두 `$CODEX_HOME/opencodex.config.toml`을 참고용/폴백 설정으로 작성합니다. loopback에서는 자동 주입이 사라졌을 때 수동으로 합칠 수 있는 root key가 들어가고, non-loopback에서는 전용 provider 형식이 들어갑니다. 외부 provider 모드는 이 프로필을 건드리지 않습니다.

:::caution
`openai_base_url`, `model_provider`, `model_catalog_json` 같은 root key는 첫 번째 `[table]` 헤더보다 **반드시** 앞에 있어야 합니다. 인젝터는 그 위치를 보장하고, 자신이 남긴 오래되었거나 중복된 복사본은 지웁니다. 사용자가 소유한 root `openai_base_url`은 덮어쓰지 않습니다. 그런 값이 있으면 sync는 카탈로그만 갱신하고 라우팅은 주입하지 않았다고 알립니다.
:::

## 공유 모델 카탈로그

Codex CLI, TUI, App, SDK는 모두 같은 Codex home을 읽습니다. opencodex는 이 디렉터리를 `CODEX_HOME`에서 해석하고, 없으면 `~/.codex`로 폴백하며 다음 파일을 관리합니다:

```text
$CODEX_HOME/config.toml
$CODEX_HOME/opencodex.config.toml
$CODEX_HOME/opencodex-catalog.json
$CODEX_HOME/models_cache.json
```

WSL에서는 `CODEX_HOME`이 비어 있고 Linux `~/.codex/config.toml`도 없을 때 `/mnt/c/Users/*/.codex/config.toml` 아래의 단일 Windows Codex Desktop home도 확인합니다. 후보가 정확히 하나면 그 디렉터리를 사용하므로 WSL app-server mode와 Windows Codex Desktop이 같은 config와 auth 파일을 공유합니다. 이 탐지를 덮으려면 `CODEX_HOME`을 명시하세요.

Windows에서 Orca shell은 `CODEX_HOME`과 `ORCA_CODEX_HOME`을 Orca의 번들 런타임 home으로 설정할 수 있지만, ChatGPT/Codex app은 여전히 `%USERPROFILE%\\.codex`를 읽습니다. `ocx status`와 `ocx doctor`는 이 정확한 불일치를 경고하고, 경로는 가린 채 대상 home을 출력합니다. 해당 Orca shell에서 background service를 설치했다면 먼저 원래 shell에서 uninstall하고, `CODEX_HOME`을 app home으로 설정한 뒤 `ORCA_CODEX_HOME`을 해제하고, sync/restore를 다시 실행한 다음 service를 다시 설치하세요.

전용 provider 모드의 `requires_openai_auth = true`는 Codex App/TUI의 계정 게이트 화면을 네이티브 Codex와 같은 조건으로 맞춥니다. opencodex는 `/v1/responses`도 WebSocket으로 제공합니다. 전용 provider는 `"websockets": true`일 때만 `supports_websockets = true`를 광고합니다. loopback에서는 Codex의 빌트인 provider가 먼저 WebSocket을 시도할 수 있으며, 비활성화된 proxy는 `426`을 반환해서 Codex가 HTTP/SSE로 fallback합니다.

## 스레드 식별자와 대화 기록

기본 loopback 형식은 새 thread에 네이티브 `openai` provider 태그를 유지하므로 일반적인 resume history는 다시 매핑할 필요가 없습니다. 첫 sync 때는 더 오래된 opencodex 빌드가 태그를 붙인 thread도 `openai`로 이관합니다. non-loopback 전용 provider 모드는 활성 상태일 때만 history를 `opencodex` provider 아래로 미러링하고, 종료할 때는 백업된 메타데이터를 복원합니다. history를 건드리지 않으려면 `syncResumeHistory: false`로 설정하세요.

## 모델 카탈로그 동기화

Codex는 디스크의 카탈로그(`$CODEX_HOME/opencodex-catalog.json`이 기본값)에 있는 모델을 보여줍니다. 시작 시와 `ocx sync` 시 opencodex는 다음을 수행합니다.

1. 원본 카탈로그를 `~/.opencodex/catalog-backup.json`에 한 번 **백업**합니다(그래서 featuring도 되돌릴 수 있습니다).
2. 적격한 provider의 live model catalog를 **가져옵니다**(약 5분 캐시, `modelCacheTtlMs` 기본값 `300000`; 마지막 정상 목록, 그다음 설정된 `models[]`로 fallback). Forward auth에는 model endpoint가 없고, Cursor는 `/models` 대신 `GetUsableModels` RPC를 사용합니다.
3. 라우팅된 모델을 네임스페이스 항목(`provider/model`)으로 **병합**합니다. Codex의 엄격한 parser가 받아들이도록 네이티브 Codex catalog template에서 복제합니다.
4. `config.disabledModels`와 각 provider의 비어 있지 않은 `selectedModels` allowlist를 **필터링**합니다.
5. featured 모델이 먼저 정렬되도록 **다시 순서화**한 뒤(아래 참고), 병합된 catalog를 다시 씁니다.

라우팅된 카탈로그 항목의 GPT-5 정체성 문구도 실제 업스트림 모델 이름에 맞게 바꿉니다. reasoning 선택지는
프로바이더와 모델 메타데이터에 따라 Codex의 `low | medium | high | xhigh | max | ultra` 단계를 사용하며,
업스트림이 지원하지 않는 값은 요청을 보내기 전에 매핑하거나 지원 범위로 낮춥니다.

### 라우팅된 로컬 도구

네이티브가 아닌 라우팅 catalog 항목은 `tool_mode: "code_mode_only"`를 사용합니다. 이를 통해 Codex는 공식
`exec` 진입점과 Browser 및 Computer Use를 포함한 중첩 MCP 도구를 노출할 수 있으며, opencodex는 모델의 일반
function call만 라우팅합니다. 도구 실행, 권한, 확인은 Codex에 그대로 남고 opencodex가 별도의 browser 또는
desktop-control executor를 구현하지는 않습니다.

Codex의 `exec` custom-tool grammar를 허용하지 않는 key-auth Responses provider의 경우, opencodex는 해당 선언과
history를 업스트림 function tool로 인코딩한 다음 스트리밍된 function-call lifecycle을 Codex에 전달하기 전에
`custom_tool_call`로 복원합니다. 네이티브 OpenAI forward routing과 지원되는 `apply_patch` custom tool은 변경되지
않습니다.

선택한 provider는 function/tool calling을 지원해야 합니다. tool call을 지원하지 않는 text-only provider에서는
`exec`, Browser 또는 Computer Use를 사용할 수 없습니다. 네이티브 OpenAI 항목은 업스트림 tool mode를 그대로
유지합니다.

`ocx sync`가 이 metadata를 변경한 뒤에는 Codex App을 다시 시작하고 새 task를 여세요. 기존 app-server process와
task는 시작할 때 불러온 catalog와 tool plan을 계속 유지할 수 있습니다.

### 사용자 지정 모델 표시 이름

사용자 지정 모델은 사람이 읽을 수 있는 **표시 이름**을 가질 수 있습니다. 이 이름은 Codex의 model picker에 보이는 label만 바꾸고, 모델이 라우팅되는 방식은 바꾸지 않습니다. 표시 이름은 catalog entry의 `display_name` 필드에만 매핑되며, routing slug(`<provider>/<model>`), alias collision order, provider, native OpenAI marketing name은 모두 그대로 둡니다.

CLI에서 표시 이름을 추가할 수 있습니다(proxy가 live 상태면 catalog를 바로 동기화합니다):

```bash
ocx models add deepseek deepseek-v4 --display-name "DeepSeek V4" --context-window 128000
```

원격 Codex client는 management API로 같은 생성된 catalog를 가져올 수 있습니다(다른 `/api/*` 경로와 같은 admission token을 사용합니다):

```bash
dest="${CODEX_HOME:-$HOME/.codex}/opencodex-catalog.json"
tmp="$(mktemp "${dest}.XXXXXX")"
curl -fsS -H "x-opencodex-api-key: $OPENCODEX_ADMIN_AUTH_TOKEN" \
  "https://proxy.example.com/api/catalog" > "$tmp" \
  && mv "$tmp" "$dest"
ocx sync-cache
```

응답은 원시 `opencodex-catalog.json` 문서입니다( provider credential 없음). 사용 가능할 때는 `x-opencodex-codex-version` header가 서버 쪽 Codex runtime version을 보고해서 client가 version skew를 알아볼 수 있습니다.

또한 management API(`POST /api/custom-models`, `PUT /api/custom-models/<id>`의 `displayName` string)와 웹 대시보드에서도 설정하거나 수정할 수 있습니다. `/`는 routed-slug separator와 충돌하므로 거부됩니다.

표시 이름은 **표시 전용이며 재생성 사이에서도 안정적**입니다. 모든 `ocx sync`와 catalog refresh는 `config.json`(`customModels` 포함)에서 routed entry를 다시 계산하므로, 설정된 이름이 라우팅 slug로 되돌아가지 않고 다시 적용됩니다. 관리형 service restart도 proxy가 bind된 직후 이 sync를 다시 시도합니다. 예를 들어 offline login 중이라 이 best-effort boot sync가 실패하면, 이전에 저장된 catalog는 유지되고 다음에 성공한 `ocx sync`가 설정된 이름을 다시 적용합니다. 진짜 upstream native name(예: `gpt-5.6-sol` → "GPT-5.6-Sol")은 고정된 upstream snapshot에서 오며, custom display name으로 덮어쓰지 않습니다.

### 외부 provider manager

`config.toml`이 이미 `openai`나 `opencodex`가 아닌 provider를 선택하고 있으면, OpenCodex는 그 파일을 그대로 두고 profile write, catalog/cache refresh, 즉시 및 background Codex history migration을 건너뜁니다. custom provider를 관리하는 도구는 기존 session에 그 provider id를 붙이는 경우가 많고, 활성 id를 바꾸면 그 온전한 session이 Codex의 history view에서 사라질 수 있습니다. 이 보호는 legacy root profile이 선택한 외부 provider에도 동일하게 적용됩니다.

Codex provider configuration의 소유자는 한 도구만 맡게 하세요. 기존 provider manager 뒤에서 OpenCodex를 쓰려면, 그 provider를 `http://127.0.0.1:10100/v1`로 향하게 하고 Responses passthrough를 쓰세요(`wire_api = "responses"` in Codex TOML). Chat Completions translation은 쓰지 않습니다. proxy API auth가 켜져 있으면, 위의 non-loopback provider 형식과 맞추어 `OPENCODEX_API_AUTH_TOKEN`에서 `x-opencodex-api-key`도 함께 전달하세요. OpenCodex가 routing을 직접 주입하게 하려면 먼저 Codex를 built-in `openai` provider로 되돌리고, 사용자가 소유한 root `openai_base_url`을 지운 다음, `ocx start`를 다시 실행하세요.

### 카탈로그 문제 해결

Codex에서 model이 빠졌거나 catalog 순서/가시성이 이상해 보이면 다음 순서로 확인하세요.

1. provider의 **`selectedModels`** - 비어 있지 않은 allowlist는 해당 id만 Codex에 노출합니다. 비어 있거나 생략하면 발견된 model이 모두 노출됩니다. allowlist에 없는 id는 catalog에 절대 들어가지 않습니다.
2. **`disabledModels`**(top level) - catalog와 `/v1/models`에서 model을 숨기고, bare native GPT slug는 `visibility: "hide"`로 바꿉니다.
3. **`liveModels: false`와 비어 있는 `models`** - live discovery가 꺼져 있고 `models`가 비어 있거나 생략되면, opencodex는 그 provider에 대해 routed model을 하나도 노출하지 않습니다.
4. **Cursor `GetUsableModels`** - Cursor adapter는 `/models`가 아니라 protobuf `GetUsableModels` RPC로 model을 찾습니다. 그래서 Cursor 쪽 변경이 다른 provider와 무관하게 어떤 id가 보이는지 바꿀 수 있습니다.
5. **캐시와 `ocx sync`** - live catalog는 약 5분(`modelCacheTtlMs`, 기본값 `300000`) 동안 캐시됩니다. `ocx sync`를 실행하면 새로 가져와서 catalog를 즉시 다시 쓸 수 있습니다.
6. **실행 중인 Codex `app-server`** - 오래 살아 있는 Codex `app-server`(Desktop / CLI background host)가 이전 목록을 메모리에 쥐고 있으면 디스크 catalog를 다시 쓰는 것만으로는 부족합니다. `ocx sync`와 `ocx sync-cache`는 그런 process를 감지하면 경고합니다. `ocx sync --restart-codex`로 다시 시작하거나(아니면 일치하는 `app-server` process를 직접 중지한 뒤), Codex가 다시 만들게 해서 새 목록이 보이게 하세요.

:::caution[다른 로컬 writer]
catalog write(`opencodex-catalog.json`, `config.toml`)는 opencodex 내부에서만 원자적입니다. 이것은 두 개의 opencodex 소유 writer가 경합할 때 반쯤만 써진 파일을 막아줄 뿐입니다. 다른 로컬 process, file watcher, sync agent가 opencodex가 쓴 뒤에 catalog visibility나 순서를 다시 쓸 가능성은 막지 못합니다. Codex는 별도의 `models_cache.json`을 유지하고 독립적으로 갱신할 수 있으므로, 이 과정에서 `opencodex-catalog.json`을 다시 쓰지 않고도 보이는 목록이 바뀔 수 있습니다. proxy가 실행 중인데 model이 예상치 않게 바뀌면, 경쟁 writer를 중지하거나 재설정한 뒤 `ocx sync`를 실행하세요. 이것은 외부 writer 위험이지, 확인된 opencodex 결함이 아닙니다.
:::

## 프록시 연결 오류

Codex가 재시도한 뒤 `stream disconnected before completion: error sending request for url (http://127.0.0.1:10100/v1/responses)` 같은 오류로 실패하거나 Claude Code가 비슷한 연결 실패를 보고하면, opencodex proxy가 실행 중이 아닙니다. 설정된 포트에서 아무도 듣지 않으므로 client가 그 raw connection error를 그대로 보여줍니다. proxy를 다시 시작하세요:

```bash
ocx start              # foreground
ocx service install    # persistent: auto-starts on login and respawns on crash
```

`ocx status`는 proxy가 실행 중인지 보여주고, 실행 중이 아닐 때는 같은 restart 힌트를 출력합니다. `ocx doctor`는 restart safety(service/shim coverage)를 보고합니다.

## 서브에이전트 선택기

catalog sync는 선택된 서브에이전트 모델을 Codex가 쓸 수 있게 합니다. picker 순서는 [Codex App model picker](/guides/codex-app-models/#subagent-selection)에서, v1/base/v2 위임과 fallback 동작은 [Sub-agent Surface](/guides/sub-agent-surface/)에서 확인하세요.

## Codex 계정 워밍업

ChatGPT 계정을 Codex account pool에 추가하면, opencodex는 이를 저장하기 전에 Codex Responses backend로 작은 streaming request를 보내 확인합니다. 요청은 실제 Responses item array(`input: [{ type: "message", ... }]`)를 사용하고, `response.completed`를 기다리며, 기본값은 `gpt-5.4-mini`입니다. 그 모델이 HTTP 400을 반환하면 `gpt-5.5`로 다시 시도합니다. 구조화된 upstream error detail은 보여 주되 raw response body는 노출하지 않습니다. background revalidation은 별도 기능이며 기본값은 꺼져 있습니다. Token Guardian이 활성화되고, `chatgpt` refresh policy가 `proactive`이며, `tokenGuardian.codexWarmupEnabled`가 true일 때만 실행됩니다.

## 네이티브 Codex 복원

opencodex는 절대 사용자를 가두지 않습니다. **`ocx stop`은 네이티브 Codex로 완전히 되돌리는 단일 명령입니다**. proxy를 중지하고, 설치된 background service가 있으면 그것도 중지한 뒤, 주입된 모든 라인과 라우팅된 catalog 항목을 제거해서 plain `codex`가 opencodex가 처음부터 없었던 것처럼 정확히 동작하게 합니다:

```bash
ocx stop       # stop the proxy + service, restore native Codex
ocx restore    # restore without stopping  (alias: ocx eject)
ocx restore back # point plain Codex at the running proxy again
```

opencodex가 managed [background service](/reference/cli/#ocx-service)로 실행될 때는 `OCX_SERVICE=1`을 설정하므로 service-driven restart가 Codex config를 흔들지 **않습니다**. 네이티브 Codex를 복원하는 것은 명시적인 `ocx stop` / `ocx service stop`뿐입니다.
