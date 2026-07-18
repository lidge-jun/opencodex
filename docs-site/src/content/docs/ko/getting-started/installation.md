---
title: 설치
description: opencodex(ocx) 프록시와 사전 요구 사항을 설치하고, 정상 실행되는지 확인합니다.
---

opencodex를 설치하면 같은 실행 파일을 가리키는 `ocx`와 `opencodex` 명령이 함께 제공됩니다.
둘 다 Bun 기반의 작은 로컬 HTTP 서버를 실행합니다. 모델 요청은 라우팅으로 선택된 프로바이더에
전달되며, 필요할 때 vision 및 웹 검색 sidecar가 ChatGPT 로그인을 사용할 수도 있습니다.

## 사전 요구 사항

| 요구 사항 | 이유 |
| --- | --- |
| **[Node](https://nodejs.org) ≥ 18** | `ocx`는 Bun 런타임에서 실행되지만, 런타임이 `npm install` 시 자동으로 번들되므로 Bun을 직접 설치할 필요가 **없습니다**. |
| **[OpenAI Codex](https://openai.com/codex)**(CLI, App, 또는 SDK) | opencodex가 앞단에 위치하는 클라이언트입니다. opencodex는 `$CODEX_HOME/config.toml`(기본값 `~/.codex/config.toml`)에 기록합니다. |
| 프로바이더 계정 또는 API 키 | Anthropic, xAI, Kimi, Ollama Cloud, OpenRouter, OpenAI API 키, OpenAI 호환 엔드포인트, 또는 ChatGPT 로그인. |

## 설치

```bash
npm install -g @bitkyc08/opencodex
```

:::note[npm이 bun postinstall을 차단했다면?]
최신 npm은 bun의 postinstall 스크립트를 차단할 수 있습니다(`npm warn
install-scripts ... blocked because they are not covered by allowScripts`).
이 경우 번들 Bun 런타임이 준비되지 않으므로 bun 스크립트를 허용해서
재설치하세요. npm 경고의 축약 명령에는 패키지 이름이 빠져 있어 현재
디렉터리를 재설치하게 되니, 항상 패키지 이름을 명시해야 합니다:

```bash
npm install -g --allow-scripts=bun @bitkyc08/opencodex

# 처음에 sudo로 설치했다면 sudo를 유지하세요:
sudo npm install -g --allow-scripts=bun @bitkyc08/opencodex
```
:::

두 명령이 모두 `PATH`에 잡히는지 확인합니다:

```bash
ocx --version
opencodex --version
```

### 배포 채널

안정화 채널인 `latest`에도 ChatGPT, OpenAI API 키, OpenRouter, 실험 단계의 Cursor 경로를 위한
GPT-5.6 Sol/Terra/Luna 카탈로그 정보가 이미 들어 있습니다. 다만 모델 사용 권한까지 생기는 것은
아닙니다. 아직 정식 배포되지 않은 opencodex 빌드를 시험할 때만 preview 채널을 사용하세요:

```bash
npm install -g @bitkyc08/opencodex@preview
ocx update --tag preview
```

## 소스에서 실행

opencodex 자체를 직접 수정하며 작업하려면:

```bash
git clone https://github.com/lidge-jun/opencodex.git
cd opencodex
bun install
bun run dev:proxy   # 개발 모드로 프록시 API 시작 (src/cli/index.ts start)
bun run dev:gui     # 대시보드 dev 서버 시작 (다른 터미널)
```

`bun run dev`는 `bun run dev:proxy`의 별칭으로 남아 있습니다. 프록시 API는 `/healthz`,
`/v1/responses`, `/api/*`를 노출하며, `GET /`는 `bun run build:gui`가 `gui/dist`를 생성한
뒤에만 패키징된 대시보드를 서빙합니다. 대시보드를 수정할 때는 `bun run dev:gui`로 프론트엔드를
별도로 실행하세요.

## 생성되는 항목

opencodex 상태 파일은 `$OPENCODEX_HOME`(기본값 `~/.opencodex`) 아래에, Codex 연동 파일은
`$CODEX_HOME`(기본값 `~/.codex`) 아래에 저장됩니다.

| 경로 | 용도 |
| --- | --- |
| `$OPENCODEX_HOME/config.json` | 프로바이더, 기본 프로바이더, 포트, 옵션. |
| `$OPENCODEX_HOME/ocx.pid` | 실행 중인 프록시의 PID(단일 인스턴스 가드). |
| `$OPENCODEX_HOME/runtime-port.json` | 자동으로 고른 대체 포트를 포함한 현재 PID, 호스트명, 포트. |
| `$OPENCODEX_HOME/auth.json` | 저장된 OAuth 자격 증명(`ocx login` 시). |
| `$OPENCODEX_HOME/catalog-backup*.json` | opencodex가 수정하기 전에 만든 Codex 모델 카탈로그 백업. |
| `$CODEX_HOME/config.toml` | 로컬 전용 구성에서는 opencodex가 관리하는 루트 `openai_base_url`을 추가합니다. 로컬이 아닌 주소에 바인딩할 때는 Codex가 API 인증 헤더를 보낼 수 있도록 `model_provider = "opencodex"`와 `[model_providers.opencodex]`를 사용합니다. |
| `$CODEX_HOME/opencodex.config.toml` | 기본 Codex 설정과 함께 생성되는 참고용 fallback 프로필. |
| `$CODEX_HOME/opencodex-catalog.json` | Codex가 사용하는 네이티브 및 라우팅 모델 카탈로그. |

:::note
opencodex는 절대 Codex 설정을 삭제하지 않습니다. 모든 주입은 되돌릴 수 있습니다 — `ocx stop`, `ocx restore`,
또는 `ocx eject`는 opencodex가 추가한 줄만 정확히 제거하고 네이티브 Codex를 복원합니다.
:::

## 다음

[Quickstart](/opencodex/ko/getting-started/quickstart/)로 이동해 첫 프로바이더를 설정하거나,
아키텍처를 알아보려면 [작동 방식](/opencodex/ko/getting-started/how-it-works/)을 읽어 보세요.
