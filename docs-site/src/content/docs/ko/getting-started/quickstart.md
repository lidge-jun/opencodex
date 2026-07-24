---
title: Quickstart
description: 첫 프로바이더를 설정하고 명령어 세 개로 OpenAI Codex를 opencodex로 라우팅합니다.
---

이 가이드는 새로 설치한 상태에서 OpenAI가 아닌 모델로 Codex를 실행하기까지의 과정을 안내합니다.

## 1. 설정 마법사 실행

```bash
ocx init
```

`ocx init`은 다음 과정을 안내합니다:

1. **프로바이더 선택** — 내장 레지스트리 프리셋 50개 중 하나를 고르거나, `custom`을 선택해
   base URL과 adapter를 직접 입력합니다.
2. **API 키** — 키를 붙여넣거나, `${ANTHROPIC_API_KEY}`와 같은 환경 변수를 참조합니다.
3. **기본 모델** — API 키, 로컬, custom 프로바이더에서는 프리셋 값을 쓰거나 모델 id를 직접 입력합니다.
4. **프록시 포트** — 기본값은 `10100`입니다.
5. **Codex에 주입할까요?** — 일반적인 로컬 전용 구성에서는
   `$CODEX_HOME/config.toml`(기본값 `~/.codex/config.toml`) 루트에 `openai_base_url`을 추가해
   Codex의 내장 `openai` 프로바이더가 프록시를 바라보게 합니다. LAN 등 외부 주소에 바인딩한
   구성에서는 API 인증 헤더가 포함된 전용 프로바이더 항목을 대신 사용합니다.
6. **자동 시작 shim을 설치할까요?** — 켜 두면 `codex`를 실행할 때 먼저 `ocx ensure`가 실행됩니다.

결과는 `$OPENCODEX_HOME/config.json`(기본값 `~/.opencodex/config.json`)에 저장됩니다.

:::note[GPT-5.6 배포 준비 항목]
안정화 버전 v2.7.1은 ChatGPT 패스스루, OpenAI API 키, OpenRouter, 실험 단계의 Cursor adapter에
GPT-5.6 Sol/Terra/Luna 항목을 기본으로 제공합니다. 해당 업스트림 계정에 사용 권한이 있어야 실제로
호출할 수 있습니다. OpenAI API 키와 OpenRouter 프리셋은 372,000토큰의 가용 컨텍스트 정보를
Codex에 제공하며, Cursor는 adapter가 제공하는 별도 메타데이터를 사용합니다.
:::

## 2. 프록시 시작

```bash
ocx start            # 기본 포트 10100
ocx start --port 8080
```

시작 시 opencodex는:

- PID를 `~/.opencodex/ocx.pid`에 기록하고(두 번 실행되는 것을 거부),
- 지원하는 프로바이더에서는 실시간 모델을 조회하고, 네이티브 및 라우팅 항목을 **Codex 모델
  카탈로그에 동기화**하며,
- `http://localhost:<port>/v1`에서 수신 대기합니다.

요청한 포트가 이미 사용 중이면 빈 포트를 찾아 `runtime-port.json`에 기록하고, Codex가 실제
리스너를 사용하도록 설정을 갱신합니다.

확인:

```bash
ocx status
ocx gui       # 현재 포트에서 대시보드 열기
```

## 3. Codex 사용

이제 Codex는 opencodex와 투명하게 통신합니다:

```bash
codex "Refactor this function for readability"
```

특정 라우팅 모델을 지정하려면, Codex의 모델 선택기에 표시되는 `provider/model` 형식을 사용하세요:

```bash
codex -m "anthropic/claude-opus-5" "Explain this stack trace"
codex -m "ollama-cloud/glm-5.2"      "Write a SQL migration"
```

GPT-5.6 사용 권한이 있다면 네이티브 ChatGPT 경로는 bare 모델명, API 키와 OpenRouter 경로는 명시적
`provider/model` 형식을 사용하세요:

```bash
codex -m "gpt-5.6-sol"                    "Plan a risky refactor"
codex -m "openai-apikey/gpt-5.6-terra"    "Review this architecture"
codex -m "openrouter/openai/gpt-5.6-luna" "Summarize this trace"
```

## Sub-agent 모델 선택(선택 사항)

새 구성에는 `gpt-5.5`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.4-mini`가
Codex의 sub-agent 선택기에 기본으로 표시됩니다. `ocx gui`에서 네이티브 모델과 라우팅 모델을
합쳐 최대 다섯 개까지 바꾸거나 순서를 조정할 수 있습니다. 선호하는 sub-agent 모델과 reasoning
effort도 지정할 수 있으며, opencodex는 이 값을 v1 협업 요청의 안내 메시지에 반영합니다.

## 키를 붙여넣는 대신 로그인하기

일부 프로바이더는 실제 계정 로그인을 지원합니다(OAuth, 자동 갱신):

```bash
ocx login xai          # 또는 anthropic, kimi, kiro, google-antigravity, cursor
ocx logout xai
```

기본 OpenAI 경로는 **키가 필요 없습니다** — 기존 `codex login` 자격 증명을 그대로 포워딩합니다.
OpenAI API 키를 따로 쓰려면 `openai-apikey` 프로바이더를 추가하세요. 이 프리셋에는
`gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`가 포함되지만, API 키에 실제 사용 권한이 있어야 합니다
([프로바이더](/ko/guides/providers/) 참고).

## 중지 및 복원

```bash
ocx stop          # 프록시를 중지하고 네이티브 Codex 복원
ocx restore       # 프록시는 둔 채 네이티브 Codex 복원(별칭: ocx eject)
ocx restore back  # 실행 중인 프록시로 Codex를 다시 연결
```

## 다음

- [작동 방식](/ko/getting-started/how-it-works/) — 각 요청에 무슨 일이 일어나는지.
- [프로바이더](/ko/guides/providers/) — 인증하는 모든 방법.
- [구성](/ko/reference/configuration/) — 전체 `config.json` 레퍼런스.
