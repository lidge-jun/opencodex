---
title: Codex App 모델 선택기
description: 공유 Codex 카탈로그를 통해 opencodex 모델이 Codex App, Codex CLI, Codex TUI에 표시되는 방식.
---

opencodex는 Codex App을 패치하지 않습니다. Codex CLI/TUI가 이미 읽는 Codex 설정과 모델
카탈로그를 같은 위치에 작성합니다. Codex App이 이 공유 상태를 읽기 때문에 라우팅된 모델이 일반
Codex 카탈로그 항목처럼 App의 모델 선택기에 표시될 수 있습니다.

## 통합 경로

`ocx init`, `ocx start`, `ocx sync`는 해석된 `CODEX_HOME` 디렉터리 아래의 다음 파일을 맞춥니다:

```text
$CODEX_HOME/config.toml
$CODEX_HOME/opencodex.config.toml
$CODEX_HOME/opencodex-catalog.json
$CODEX_HOME/models_cache.json
```

활성 프로바이더는 루트 설정 키로 설치됩니다:

```toml
model_provider = "opencodex"
model_catalog_json = "/absolute/path/to/opencodex-catalog.json"
```

프로바이더 자체는 Responses 호환 엔드포인트로 등록됩니다:

```toml
[model_providers.opencodex]
name = "OpenCodex Proxy"
base_url = "http://127.0.0.1:10100/v1"
wire_api = "responses"
requires_openai_auth = true
```

`websockets`는 기본적으로 꺼져 있습니다. `"websockets": true`일 때만 opencodex가
`supports_websockets = true`를 provider 테이블과 카탈로그 항목에 광고합니다.

## 라우팅 모델이 표시되는 이유

Codex 모델 선택기는 Codex 형태의 카탈로그 항목을 기대합니다. opencodex는 네이티브 Codex 모델
템플릿을 복제한 뒤 라우팅 모델 정체성만 바꿔 해당 항목을 만듭니다:

```text
slug = "anthropic/claude-sonnet-..."
display_name = "anthropic/claude-sonnet-..."
visibility = "list"
```

복제된 항목은 reasoning 레벨, shell 타입, API 지원 플래그, base instructions 같은 엄격한 파서
필드를 유지합니다. 그래서 각 라우팅 항목은 선택기에 표시 가능한 유효한 Codex 모델처럼 보입니다.

## 서브에이전트 선택

Codex의 `spawn_agent`는 카탈로그에서 우선순위가 높은 처음 5개 모델만 노출합니다. `subagentModels`
또는 웹 대시보드에서 최대 5개의 `provider/model` 또는 네이티브 모델 id를 고르면 opencodex가 해당
항목을 카탈로그 앞쪽에 정렬합니다.

## 모델 상태 새로고침

선택기에 오래된 항목이 남아 있으면 카탈로그를 새로 쓰고 대상 Codex 표면을 다시 여세요:

```bash
ocx sync
```

opencodex는 라우팅 모델의 표시 여부나 카탈로그 메타데이터를 바꿀 때 Codex의 `models_cache.json`도
무효화합니다.
