---
title: Codex 통합
description: opencodex가 Codex에 자신을 주입하고, 모델 카탈로그를 동기화하고, 서브에이전트 선택기를 구동하며, 깔끔하게 복원하는 방식.
---

opencodex는 Codex가 읽는 두 가지, 즉 설정(`$CODEX_HOME/config.toml`, 기본값 `~/.codex/config.toml`)과 모델 카탈로그를 편집하여 Codex가
프록시를 경유하도록 만듭니다. 모든 편집은 멱등적이며 되돌릴 수 있습니다.

OpenAI는 bare 모델용 단일 `openai` 경로와 `openai-apikey/<model>` API 경로를 제공합니다.
`openai`는 Pool(기본, 메인+추가 계정) 또는 Direct(현재 caller/메인 bearer) 모드이며 모델 id는
같습니다. 경로 간 fallback은 없습니다. shipped v1 config는 marker 2로 이관되고 수동 복원을 위해
`config.json.pre-openai-tiers-v2.bak`을 보존합니다.

## 설정 주입

`ocx init`, `ocx start`, `ocx sync`는 모두 인젝터를 호출합니다. 기본 loopback 바인드에서는 Codex의
빌트인 `openai` 프로바이더 id를 유지한 채 그 프로바이더가 opencodex를 바라보게 합니다.

```toml
# 첫 번째 테이블보다 앞에 오는 루트 키
model_catalog_json = "/absolute/path/to/opencodex-catalog.json"
# Auto-injected by opencodex
openai_base_url = "http://127.0.0.1:10100/v1"

[features]
fast_mode = true
```

프록시의 기본 포트는 `10100`입니다. `POST /v1/responses`, `POST /v1/responses/compact`,
`POST /v1/images/generations`, `POST /v1/images/edits`, `GET /v1/models`, `GET /healthz`,
`/api/*` 관리 API를 제공합니다.

### 내장 이미지 생성 (`image_gen`)

Codex의 내장 `image_gen` 도구는 `/v1/responses`를 거치지 않습니다. codex-rs 확장이
`{base_url}/images/generations`(참조 이미지가 있으면 `/images/edits`)를 채팅과 동일한
ChatGPT bearer 인증으로 직접 POST합니다. 주입된 `base_url`이 opencodex를 가리키므로,
프록시가 이 호출을 OpenAI 업스트림으로 중계합니다.

- **모드 인식 forward 후보 하나:** Pool은 적격 메인/추가 계정을 선택하고 Direct는 caller OAuth
  bearer를 사용합니다. 설정된 모드는 이미지 요청에도 동일하게 적용됩니다.
- **OpenAI API key:** forward 후보가 인증 실패를 소유하지 않을 때만 사용합니다. 깨진 Pool 인증을
  별도 과금 API 사용으로 숨기지 않습니다.
- **둘 다 없음:** 모호한 404 대신 명확한 오류를 반환합니다. 라우팅되는 다른 프로바이더(Cursor,
  Gemini, Kiro 등)는 이미지 생성을 제공할 수 없습니다. 도구 자체를 끄고 싶다면 Codex에서
  `codex features disable image_generation`(`config.toml`의 `[features] image_generation = false`)을
  사용하세요.

`hostname`이 loopback 주소가 아니면 Codex가 자동 생성된 API 인증 헤더를 보내야 합니다. 이때는 전용
프로바이더를 주입합니다.

```toml
# 루트 키
model_provider = "opencodex"
model_catalog_json = "/absolute/path/to/opencodex-catalog.json"

# 파일 끝에 추가되는 블록
# Auto-injected by opencodex
[model_providers.opencodex]
name = "OpenCodex Proxy"
base_url = "http://your-host:10100/v1"
wire_api = "responses"
requires_openai_auth = true
env_http_headers = { "x-opencodex-api-key" = "OPENCODEX_API_AUTH_TOKEN" }
# supports_websockets = true   # config.websockets가 true일 때만
```

OpenCodex가 라우팅을 소유할 때 두 모드 모두 `$CODEX_HOME/opencodex.config.toml`을 참고용 폴백 설정으로
작성합니다. loopback 모드에서는 자동 주입이 빠졌을 때 직접 합칠 수 있는 루트 키가, non-loopback 모드에서는
전용 프로바이더 설정이 담깁니다. 외부 프로바이더 모드에서는 이 프로필을 변경하지 않습니다.

:::caution
`openai_base_url`, `model_provider`, `model_catalog_json` 같은 루트 키는 첫 번째 `[table]` 헤더보다
**반드시** 앞에 있어야 합니다. 인젝터는 이 위치를 보장하고 자신이 남긴 오래된 값이나 중복을 정리합니다.
사용자가 직접 만든 루트 `openai_base_url`은 덮어쓰지 않습니다. 그런 값이 있으면 카탈로그만 동기화하고
라우팅은 주입하지 않았다고 알립니다.
:::

## 공유 모델 카탈로그

Codex CLI, TUI, App, SDK는 모두 같은 Codex home을 읽습니다. opencodex는 이 디렉터리를
`CODEX_HOME`에서 해석하고, 없으면 `~/.codex`로 폴백하며 다음 파일을 관리합니다:

```text
$CODEX_HOME/config.toml
$CODEX_HOME/opencodex.config.toml
$CODEX_HOME/opencodex-catalog.json
$CODEX_HOME/models_cache.json
```

WSL에서는 `CODEX_HOME`이 없고 Linux 쪽 `~/.codex/config.toml`도 없을 때
`/mnt/c/Users/*/.codex/config.toml` 아래의 Windows Codex Desktop home을 확인합니다. 후보가
정확히 하나면 그 디렉터리를 사용하므로 WSL app-server mode와 Windows Codex Desktop이 같은 config와
auth 파일을 공유합니다. 이 탐지를 덮어쓰려면 `CODEX_HOME`을 명시하세요.

전용 프로바이더 모드의 `requires_openai_auth = true`는 Codex App/TUI의 계정 게이트 UI가 네이티브
Codex와 같은 조건으로 동작하게 합니다. opencodex는 `/v1/responses` WebSocket도 제공합니다. 전용
프로바이더는 `"websockets": true`일 때만 `supports_websockets = true`를 광고합니다. loopback에서는
Codex의 빌트인 프로바이더가 먼저 WebSocket을 시도할 수 있으며, 기능이 꺼져 있으면 프록시가 `426`을
반환해 HTTP/SSE로 폴백시킵니다.

## 스레드 식별자와 대화 기록

기본 loopback 방식은 새 스레드의 프로바이더를 네이티브 `openai`로 유지하므로 일반적인 대화 재개 기록을
다시 매핑할 필요가 없습니다. 첫 동기화 때는 예전 opencodex 빌드가 태그를 바꾼 스레드도 `openai`로
돌려놓습니다. non-loopback 전용 프로바이더 모드는 실행 중에만 기록을 `opencodex` 쪽으로 맞추고,
종료할 때 백업된 메타데이터를 복원합니다. 기록을 건드리지 않으려면 `syncResumeHistory: false`로 설정하세요.

## 모델 카탈로그 동기화

Codex는 디스크의 카탈로그(기본값 `$CODEX_HOME/opencodex-catalog.json`)에 있는 모델을 표시합니다. 시작 시와
`ocx sync` 시, opencodex는:

1. 원본 카탈로그를 `~/.opencodex/catalog-backup.json`에 한 번 **백업**합니다(featuring을 되돌릴 수 있도록).
2. 지원되는 프로바이더의 실시간 모델 카탈로그를 **가져옵니다**(약 5분간 캐시; 마지막 정상 목록,
   설정된 `models[]` 순서로 폴백). `forward` 인증에는 모델 엔드포인트가 없고, Cursor는 `/models` 대신
   `GetUsableModels` RPC를 사용합니다.
3. 라우팅된 모델을 네임스페이스 항목(`provider/model`)으로 **병합**하는데, Codex의 엄격한 파서가 이를
   수용하도록 네이티브 Codex 카탈로그 템플릿에서 복제합니다.
4. `config.disabledModels`와 각 프로바이더의 비어 있지 않은 `selectedModels` 허용 목록을 **적용**합니다.
5. featured 모델이 먼저 정렬되도록 **재정렬**한 뒤(아래 참고), 병합된 카탈로그를 다시 작성합니다.

라우팅된 카탈로그 항목의 GPT-5 정체성 문구도 실제 업스트림 모델 이름에 맞게 바꿉니다. reasoning 선택지는
프로바이더와 모델 메타데이터에 따라 Codex의 `low | medium | high | xhigh | max | ultra` 단계를 사용하며,
업스트림이 지원하지 않는 값은 요청을 보내기 전에 매핑하거나 지원 범위로 낮춥니다.

## 서브에이전트 선택기

Codex의 `spawn_agent`는 우선순위로 정렬한 뒤 **선택기에 표시되는 첫 5개 카탈로그 모델**을 내보냅니다.
`subagentModels`에는 최대 다섯 개를 넣을 수 있으며, 네임스페이스 없는 네이티브 GPT slug와
`provider/model` 경로를 함께 쓸 수 있습니다. 선택한 순서대로 우선순위 0–4가 부여됩니다.

```json
{
  "subagentModels": [
    "gpt-5.5",
    "gpt-5.6-sol",
    "anthropic/claude-opus-4-8",
    "xai/grok-4.5",
    "cursor/gpt-5.6-terra"
  ]
}
```

우선순위 순위: featured (0–4) < 기타 라우팅됨 (5) < 네이티브 (9). 이는
[웹 대시보드](/opencodex/ko/guides/web-dashboard/)에서도 관리할 수 있습니다.

## Codex 계정 워밍업

ChatGPT 계정을 Codex 계정 풀에 추가하면 저장하기 전에 작은 스트리밍 요청을 Codex Responses 백엔드로
보내 자격 증명을 확인합니다. 입력은 문자열이 아니라 실제 Responses item 배열
(`input: [{ type: "message", ... }]`)로 보내며, `response.completed`가 올 때까지 기다립니다. 기본 모델은
`gpt-5.4-mini`이고, 이 모델이 HTTP 400을 반환하면 `gpt-5.5`로 다시 시도합니다. 구조화된 업스트림 오류는
표시하되 원문 응답 body는 노출하지 않습니다. 백그라운드 재검증은 별도 기능이며 기본값은 꺼짐입니다.
Token Guardian이 활성화되고, `chatgpt`의 갱신 정책이 `proactive`이며,
`tokenGuardian.codexWarmupEnabled`가 true일 때만 실행됩니다.

## 네이티브 Codex 복원

opencodex는 절대 당신을 가두지 않습니다. **`ocx stop`은 네이티브 Codex로 완전히 되돌리는 단일 명령입니다** —
프록시를 중지하고, 설치된 백그라운드 서비스를 중지한 뒤, 주입된 모든 라인과 라우팅된 카탈로그 항목을 제거하여
opencodex가 처음부터 없었던 것처럼 일반 `codex`가 정확히 동작합니다:

```bash
ocx stop       # 프록시 + 서비스 중지, 네이티브 Codex 복원
ocx restore    # 중지하지 않고 복원  (별칭: ocx eject)
ocx restore back # 실행 중인 프록시를 일반 Codex에 다시 연결
```

opencodex가 관리형 [백그라운드 서비스](/opencodex/ko/reference/cli/#ocx-service)로 실행될 때는
`OCX_SERVICE=1`을 설정하므로 서비스가 주도하는 재시작이 Codex 설정을 흔들지 **않습니다** — 명시적인
`ocx stop` / `ocx service stop`만이 네이티브 Codex를 복원합니다.
