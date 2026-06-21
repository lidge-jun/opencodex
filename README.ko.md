<p align="center">
  <img src="assets/banner.png" alt="opencodex — 어떤 LLM이든 Codex에서 사용" width="820">
</p>

<p align="center">
  <a href="README.md">English</a> · <b>한국어</b> · <a href="README.zh-CN.md">简体中文</a> · 📖 <a href="https://lidge-jun.github.io/opencodex/ko/"><b>전체 문서 →</b></a>
</p>

<p align="center">
  <img src="assets/architecture.png" alt="opencodex 아키텍처 — Codex CLI가 opencodex 프록시를 통해 모든 LLM 프로바이더로 라우팅" width="820">
</p>

Codex는 오직 Responses API(`/v1/responses`)만 사용합니다. opencodex는 Codex와 LLM 프로바이더 사이에서
프로토콜을 실시간으로 변환해 줍니다. streaming, tool 호출, reasoning, 이미지까지 양방향으로 처리합니다.

```
Codex CLI / App / SDK ──/v1/responses──▶ opencodex ──▶ Any provider
                                              │
              Anthropic · Google · xAI · Kimi · Ollama Cloud · Groq
              OpenRouter · Azure · DeepSeek · GLM · …and OpenAI itself
```

## 지원 플랫폼

| OS | 지원 상태 | 서비스 관리자 |
|---|---|---|
| macOS (arm64 / x64) | 완전 지원 | launchd |
| Linux (x64 / arm64) | 완전 지원 | systemd (user unit) |
| Windows (x64) | 완전 지원 | Task Scheduler |

[Bun](https://bun.sh) 1.1 이상이 필요합니다. 세 플랫폼 모두 네이티브로 동작합니다 (Windows에서도 WSL 없이 사용 가능합니다).

## 빠른 시작

```bash
# 설치
npm install -g @bitkyc08/opencodex      # 또는: bun install -g @bitkyc08/opencodex

# 대화형 설정 (config 작성 + Codex 주입 + 자동 시작 shim 설치 선택)
ocx init

# 프록시 시작
ocx start

# init에서 건너뛰었다면 나중에 온디맨드 자동 시작 shim 설치
ocx codex-shim install

# Codex를 평소처럼 사용하세요 — opencodex를 통해 라우팅됩니다
codex "Write a hello world in Rust"
```

<details>
<summary><b><a href="https://bun.sh">bun</a>이 없으신가요?</b> — 먼저 설치해 주세요 (opencodex는 bun에서 실행됩니다)</summary>

<br/>

```bash
# macOS / Linux / WSL
curl -fsSL https://bun.sh/install | bash

# Windows (PowerShell)
powershell -c "irm bun.sh/install.ps1 | iex"
```

설치 후 `npm install -g @bitkyc08/opencodex`를 다시 실행하세요. (`ocx` 바이너리는 bun 기반이므로 bun이 `PATH`에 있어야 합니다.)

</details>

## 프로바이더 추가하기

가장 쉬운 방법은 웹 대시보드를 이용하는 것입니다.

```bash
ocx gui        # 브라우저에서 localhost:10100 대시보드를 엽니다
```

대시보드에서 할 수 있는 일:

1. **프로바이더 선택** — 20개 이상의 내장 프로바이더(Anthropic, Google, xAI, Ollama Cloud 등)에서 원하는 것을 고르세요.
2. **API 키 입력** — 키를 붙여넣으면 바로 저장됩니다. OAuth를 지원하는 프로바이더는 로그인 버튼으로 인증할 수도 있습니다.
3. **모델 자동 감지** — 프로바이더를 추가하면 사용 가능한 모델을 자동으로 가져옵니다. Codex 모델 선택기에도 곧바로 반영됩니다.

물론 `~/.opencodex/config.json`을 직접 편집해도 됩니다. 하지만 대시보드가 훨씬 편리합니다.

## 모델 라우팅

`provider/model` 형식으로 원하는 모델을 직접 지정할 수 있습니다:

```bash
codex -m "anthropic/claude-opus-4-8"   "이 스택 트레이스를 설명해 줘"
codex -m "google/gemini-2.5-pro"       "이 코드를 리팩터링해 줘"
codex -m "ollama-cloud/glm-5.2"        "SQL 마이그레이션 작성"
codex -m "xai/grok-4"                  "이 PR을 리뷰해 줘"
```

프로바이더 이름 없이 모델명만 쓰면 `defaultProvider`로 라우팅됩니다.

## 주요 기능

- **다섯 가지 adapter**로 Anthropic Messages, Google Gemini, Azure, OpenAI Responses passthrough, 그리고 **모든 OpenAI 호환 Chat Completions** 엔드포인트를 지원합니다. 프로바이더가 OpenAI 호환 API를 제공한다면 별도 adapter 없이 바로 연결할 수 있습니다.
- **OAuth, API 키, ChatGPT forward** 중 원하는 인증 방식을 선택하세요. xAI / Anthropic / Kimi 계정으로 OAuth 로그인하면 토큰이 자동 갱신됩니다. `codex login`을 forward 하거나, API 키를 직접 입력해도 됩니다(`${ENV_VARS}` 지원). 18개 프로바이더의 API 키 카탈로그(**Ollama Cloud** 포함)가 기본 내장되어 있습니다.
- **Codex CLI, TUI, App, SDK에 바로 연결됩니다.** `$CODEX_HOME/config.toml`(기본 `~/.codex/config.toml`)에 `[model_providers.opencodex]` 테이블을 자동 주입하고, 공유 모델 카탈로그를 작성합니다. 라우팅된 모델이 Codex 모델 선택기에 자동으로 나타납니다.
- **서브에이전트 제어.** `subagentModels` 또는 웹 대시보드에서 최대 5개의 모델을 골라 Codex `spawn_agent` 선택기에 우선 노출할 수 있습니다.
- **기본은 HTTP/SSE, WebSocket은 opt-in.** 프록시에 Responses WebSocket 엔드포인트가 있지만, `"websockets": true`로 설정할 때만 `supports_websockets`를 광고합니다.
- **Sidecar로 기능 확장.** OpenAI가 아닌 모델에서도 ChatGPT 로그인을 통한 `gpt-5.4-mini`로 실제 **웹 검색**과 **이미지 이해** 기능을 사용할 수 있습니다.
- **웹 대시보드** 하나로 프로바이더 관리, OAuth 로그인, 모델 선택, 요청 로그 확인까지 가능합니다.
- **깔끔한 종료, 잔여물 제로.** `ocx stop`(또는 대시보드의 Stop 버튼)을 누르면 프록시가 종료되고, 백그라운드 서비스가 설치돼 있으면 함께 내려가며, Codex 설정이 원본으로 복원됩니다. 이후 `codex` 명령은 opencodex 없이 원래대로 동작합니다.

## 프로바이더 및 adapter

| Provider | Adapter | 인증 방식 |
|---|---|---|
| OpenAI (ChatGPT 로그인) | `openai-responses` | forward (키 불필요) |
| OpenAI (API 키) | `openai-responses` | key |
| Anthropic Claude | `anthropic` | oauth / key |
| xAI Grok | `openai-chat` | oauth / key |
| Kimi (Moonshot) | `openai-chat` | oauth / key |
| Google Gemini | `google` | key |
| Azure OpenAI | `azure` | key |
| Ollama Cloud + 17개 프로바이더 카탈로그 | `openai-chat` | key |
| Ollama / vLLM / LM Studio (로컬) | `openai-chat` | key (보통 비워둠) |
| 모든 OpenAI 호환 엔드포인트 | `openai-chat` | key |

## CLI

```bash
ocx init                       # 대화형 설정
ocx start [--port 10100]       # 프록시 시작; 포트가 사용 중이면 빈 포트로 자동 전환
ocx stop                       # 프록시 중지 + Codex 원래 설정 복원
ocx restore                    # 중지 없이 복원 (별칭: ocx eject)
ocx ensure                     # 필요 시 시작 + Codex config/cache 갱신
ocx sync                       # 모델 갱신 + Codex에 재주입
ocx status                     # 프록시 실행 중인지 확인
ocx login <xai|anthropic|kimi> # OAuth 로그인
ocx logout <provider>          # 저장된 로그인 정보 삭제
ocx gui                        # 웹 대시보드 열기
ocx codex-shim install         # codex 실행 시 `ocx ensure` 실행
ocx service <install|start|stop|status|uninstall>   # 백그라운드 서비스 (launchd/systemd/schtasks)
ocx update                     # opencodex를 최신 버전으로 업데이트
```

### 자동 시작: service vs shim

opencodex에는 프록시를 자동 시작하는 두 가지 방법이 있습니다:

| | `ocx service install` | `ocx codex-shim install` |
|---|---|---|
| **방식** | OS 서비스 관리자 (launchd / systemd / schtasks) | `codex` 바이너리를 래퍼 스크립트로 교체 |
| **시점** | 로그인 후 항상 실행 | 온디맨드 — `codex` 실행 시 `ocx ensure` 실행 |
| **재시작** | 크래시 시 자동 재시작 | `codex` 호출마다 한 번 시작 |
| **Codex 업데이트** | 영향 없음 | `ocx codex-shim install` 또는 `ocx update` 시 복구 |
| **제거** | `ocx service uninstall` | `ocx codex-shim uninstall` |

항상 프록시를 켜두려면 **service** (개발 머신 권장), 가볍게 온디맨드로 쓰려면 **shim**을 사용하세요.
shim 자동 시작은 기본으로 켜져 있으며 GUI 대시보드에서 끌 수 있습니다. 설정된 프록시 포트가 이미 사용
중이면 `ocx start`가 자동으로 다른 빈 로컬 포트를 고르고 Codex 설정도 그 포트로 갱신합니다.

## 설정

설정 파일은 `~/.opencodex/config.json`에 저장됩니다. 최소 설정 예시:

```json
{
  "port": 10100,
  "defaultProvider": "anthropic",
  "providers": {
    "anthropic": {
      "adapter": "anthropic",
      "baseUrl": "https://api.anthropic.com",
      "authMode": "oauth",
      "defaultModel": "claude-sonnet-4-6"
    },
    "ollama-cloud": {
      "adapter": "openai-chat",
      "baseUrl": "https://ollama.com/v1",
      "apiKey": "${OLLAMA_API_KEY}",
      "defaultModel": "glm-5.2"
    }
  }
}
```

로컬에서 Ollama나 LM Studio를 실행 중이라면 이렇게 추가하세요:

```json
{
  "ollama-local": {
    "adapter": "openai-chat",
    "baseUrl": "http://localhost:11434/v1",
    "apiKey": "",
    "defaultModel": "llama3.1"
  }
}
```

WebSocket 전송은 기본적으로 꺼져 있습니다. Codex가 HTTP/SSE 대신 Responses WebSocket 경로를 사용하게 하려면 `"websockets": true`를 설정하세요.

모든 필드에 대한 자세한 내용은 **[설정 레퍼런스](https://lidge-jun.github.io/opencodex/ko/reference/configuration/)** 를 참고하세요.

## 문서

공개 문서(설치, 프로바이더, 라우팅, sidecar, Codex 통합, Codex App 모델 선택기, CLI/설정 레퍼런스)는 [`docs-site/`](./docs-site)의 Astro 사이트로 빌드되어
**[lidge-jun.github.io/opencodex](https://lidge-jun.github.io/opencodex/ko/)** 에 게시됩니다.

유지보수용 source of truth는 [`structure/`](./structure)에, 과거 조사/진단 노트는 [`docs/`](./docs)에 있습니다.

## 개발

```bash
git clone https://github.com/lidge-jun/opencodex.git
cd opencodex
bun install
bun run dev          # dev 모드로 프록시 시작
bun x tsc --noEmit   # 타입 체크
```

**[기여하기](https://lidge-jun.github.io/opencodex/ko/contributing/)** 를 참고하세요.

## 면책 조항

opencodex는 독립적인 커뮤니티 프로젝트이며, **OpenAI, Anthropic 등 어떤 제공업체와도 제휴하거나 보증을 받지 않습니다.**

일부 제공업체 — 특히 Anthropic (Claude) — 는 서드파티 프록시를 통한 API 트래픽 라우팅 시 계정을 정지하거나 제한할 수 있습니다. **사용에 따른 책임은 본인에게 있습니다 (UAYOR).** 제공업체를 연결하기 전에 해당 서비스 약관에서 프록시 기반 접근이 허용되는지 확인하세요. opencodex 유지보수자는 업스트림 제공업체의 계정 조치에 대해 책임을 지지 않습니다.

## 라이선스

MIT
