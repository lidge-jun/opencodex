---
title: Codex 통합
description: opencodex가 Codex에 자신을 주입하고, 모델 카탈로그를 동기화하고, 서브에이전트 선택기를 구동하며, 깔끔하게 복원하는 방식.
---

opencodex는 Codex가 읽는 두 가지, 즉 설정(`$CODEX_HOME/config.toml`, 기본값 `~/.codex/config.toml`)과 모델 카탈로그를 편집하여 Codex가
프록시를 경유하도록 만듭니다. 모든 편집은 멱등적이며 되돌릴 수 있습니다.

## 설정 주입

`ocx init`(그리고 `ocx sync`)은 인젝터를 호출하며, 이는 다음을 작성합니다:

```toml
# at the document root — Codex reads this as the active provider
model_provider = "opencodex"
model_catalog_json = "/absolute/path/to/opencodex-catalog.json"

# appended at end of file (TOML tables are position-independent)
[model_providers.opencodex]
name = "OpenCodex Proxy"
base_url = "http://127.0.0.1:10100/v1"
wire_api = "responses"
requires_openai_auth = true
# supports_websockets = true   # config.websockets가 true일 때만
```

또한 `$CODEX_HOME/opencodex.config.toml`에 선택적 프로파일을 작성하여 명시적으로 옵트인할 수 있게 합니다:

```bash
codex --profile opencodex "…"
```

:::caution
루트 `model_provider` 키는 첫 번째 `[table]` 헤더보다 **반드시** 앞에 있어야 합니다. 그렇지 않으면 Codex가
이를 테이블의 일부로 파싱하여 무시합니다. 인젝터는 이 배치를 보장하고 다시 작성하기 전에 떠도는 사본이나
중복된 사본을 제거합니다 — 따라서 `ocx init` / `ocx sync`를 다시 실행해도 절대 중복이 생기지 않습니다.
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

`requires_openai_auth = true`는 Codex App/TUI의 계정 게이트 UI가 네이티브 Codex와 같은 조건으로 동작하게 합니다.
WebSocket 전송은 별도입니다. opencodex는 `/v1/responses` WebSocket 엔드포인트를 제공하지만,
`~/.opencodex/config.json`에서 `"websockets": true`일 때만 `supports_websockets = true`를 광고합니다.

## 모델 카탈로그 동기화

Codex는 디스크의 카탈로그(기본값 `$CODEX_HOME/opencodex-catalog.json`)에 있는 모델을 표시합니다. 시작 시와
`ocx sync` 시, opencodex는:

1. 원본 카탈로그를 `~/.opencodex/catalog-backup.json`에 한 번 **백업**합니다(featuring을 되돌릴 수 있도록).
2. 각 프로바이더의 실시간 `/models` 목록을 **가져옵니다**(약 5분간 캐시; 마지막으로 정상이었던 목록으로,
   그다음 프로바이더에 설정된 `models[]`로 폴백).
3. 라우팅된 모델을 네임스페이스 항목(`provider/model`)으로 **병합**하는데, Codex의 엄격한 파서가 이를
   수용하도록 네이티브 Codex 카탈로그 템플릿에서 복제합니다.
4. `config.disabledModels`에 있는 항목을 모두 **필터링**합니다.
5. featured 모델이 먼저 정렬되도록 **재정렬**한 뒤(아래 참고), 병합된 카탈로그를 다시 작성합니다.

라우팅된 카탈로그 항목은 GPT-5 정체성이 실제 업스트림 모델 이름으로 다시 작성되며,
`low | medium | high` reasoning 레벨만 노출합니다.

## 서브에이전트 선택기

Codex의 `spawn_agent`는 카탈로그에서 **처음 5개의 라우팅된 모델**만 광고합니다. `subagentModels`
(최대 5개의 `provider/model` id)는 이 5개에게 가장 낮은 우선순위 번호를 부여해 먼저 정렬되게 함으로써
어떤 5개가 될지 제어합니다:

```json
{
  "subagentModels": [
    "anthropic/claude-opus-4-8",
    "ollama-cloud/glm-5.2",
    "xai/grok-4.3"
  ]
}
```

우선순위 순위: featured (0–4) < 기타 라우팅됨 (5) < 네이티브 (9). 이는
[웹 대시보드](/opencodex/ko/guides/web-dashboard/)에서도 관리할 수 있습니다.

## 네이티브 Codex 복원

opencodex는 절대 당신을 가두지 않습니다. **`ocx stop`은 네이티브 Codex로 완전히 되돌리는 단일 명령입니다** —
프록시를 중지하고, 설치된 백그라운드 서비스를 중지한 뒤, 주입된 모든 라인과 라우팅된 카탈로그 항목을 제거하여
opencodex가 처음부터 없었던 것처럼 일반 `codex`가 정확히 동작합니다:

```bash
ocx stop       # 프록시 + 서비스 중지, 네이티브 Codex 복원
ocx restore    # 중지하지 않고 복원  (별칭: ocx eject)
```

opencodex가 관리형 [백그라운드 서비스](/opencodex/ko/reference/cli/#ocx-service)로 실행될 때는
`OCX_SERVICE=1`을 설정하므로 서비스가 주도하는 재시작이 Codex 설정을 흔들지 **않습니다** — 명시적인
`ocx stop` / `ocx service stop`만이 네이티브 Codex를 복원합니다.
