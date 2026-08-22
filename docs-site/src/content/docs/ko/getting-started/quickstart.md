---
title: 빠른 시작
description: 첫 프로바이더를 설정하고 명령어 세 개로 OpenAI Codex를 opencodex로 라우팅합니다.
---

이 가이드는 새로 설치한 상태에서 OpenAI가 아닌 모델로 Codex를 실행하기까지의 과정을 안내합니다.

## 1. 설정 마법사 실행

```bash
ocx init
```

`ocx init`은 다음 과정을 안내합니다:

1. **프로바이더 선택** — 내장 레지스트리 프리셋 79개 중 하나를 고르거나 `custom`을 선택해 base URL과 adapter를 직접 입력합니다.
2. **API 키** — 키를 붙여넣거나 `${ANTHROPIC_API_KEY}` 같은 환경 변수를 참조합니다.
3. **기본 모델** — 키, 로컬, custom 프로바이더에서는 프리셋을 그대로 쓰거나 모델 ID를 직접 입력합니다.
4. **프록시 포트** — 기본값은 `10100`입니다.
5. **Codex에 주입할까요?** — 일반적인 루프백 구성에서는 opencodex가 `$CODEX_HOME/config.toml`의 루트(`~/.codex/config.toml`이 기본값)에 `openai_base_url`을 추가해 Codex의 내장 `openai` 프로바이더가 프록시를 바라보게 합니다. 원격/LAN 바인딩에서는 API 인증 헤더를 포함한 전용 프로바이더 항목을 대신 사용합니다.
6. **자동 시작 shim을 설치할까요?** — 켜 두면 `codex`를 실행할 때 먼저 `ocx ensure`가 실행됩니다.

결과는 `$OPENCODEX_HOME/config.json`(기본값 `~/.opencodex/config.json`)에 저장됩니다.

:::note[GPT-5.6 적용 항목]
현재 안정 버전은 ChatGPT 패스스루, OpenAI API 키, OpenRouter, 실험 단계의 Cursor adapter에 GPT-5.6 Sol/Terra/Luna를 기본으로 넣습니다. 이 항목들은 해당 업스트림 계정에 접근 권한이 있을 때만 동작합니다. OpenAI API 키와 OpenRouter 프리셋은 사용 가능한 컨텍스트 창을 922,000토큰으로 제공합니다. Cursor는 자체 adapter 메타데이터를 유지합니다.
:::

## 2. 프록시 시작

```bash
ocx start            # defaults to port 10100
ocx start --port 8080
```

시작하면 opencodex는:

- PID를 `~/.opencodex/ocx.pid`에 기록하고 중복 시작을 거부하며,
- 프로바이더가 지원하는 경우 실시간 모델을 찾아 네이티브와 라우팅 항목을 **Codex 모델 카탈로그에 동기화**하고,
- `http://localhost:<port>/v1`에서 수신 대기합니다.

요청한 포트가 이미 사용 중이면 `ocx start`가 빈 포트를 고르고, 그 값을 `runtime-port.json`에 기록한 뒤 Codex가 실시간 리스너를 쓰도록 갱신합니다.

확인:

```bash
ocx status
ocx gui       # open the dashboard on the live port
```

## 3. Codex 사용

이제 Codex는 opencodex와 투명하게 연결됩니다:

```bash
codex "Refactor this function for readability"
```

특정 라우팅 모델을 지정하려면 Codex의 모델 선택기에 보이는 `provider/model` 형식을 사용합니다:

```bash
codex -m "anthropic/claude-opus-5" "Explain this stack trace"
codex -m "ollama-cloud/glm-5.2"      "Write a SQL migration"
```

## Sub-agent 모델 선택(선택 사항)

새 구성에는 Codex의 sub-agent 선택기에 네이티브 모델 다섯 개인 `gpt-5.5`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.4-mini`가 표시됩니다. `ocx gui`를 열어 네이티브 또는 라우팅 모델을 최대 다섯 개까지 바꾸거나 순서를 다시 정할 수 있습니다. 대시보드에서는 선호하는 sub-agent 모델과 추론 강도도 설정할 수 있습니다. [Sub-agent Surface](/guides/sub-agent-surface/)에서 v1/base/v2를 고르고, guidance, 네이티브 기본값, fallback이 언제 적용되는지 확인합니다.

## 키를 붙여넣는 대신 로그인하기

일부 프로바이더는 실제 계정 로그인을 지원합니다(OAuth, 자동 갱신):

```bash
ocx login xai          # or: anthropic, kimi, kiro, google-antigravity, cursor
ocx logout xai
```

OpenAI 자체는 **키가 필요 없습니다** — 기본 프로바이더가 기존 `codex login` 자격 증명을 그대로 전달합니다([Providers](/guides/providers/) 참고).

## 중지 및 복원

```bash
ocx stop          # stop the proxy and restore native Codex
ocx restore       # restore native Codex without stopping (alias: ocx eject)
ocx restore back  # route Codex through the still-running proxy again
```

## 다음

- [How It Works](/getting-started/how-it-works/) — 각 요청에 무슨 일이 일어나는지.
- [Providers](/guides/providers/) — 인증하는 모든 방법.
- [Configuration](/reference/configuration/) — 전체 `config.json` 레퍼런스.
