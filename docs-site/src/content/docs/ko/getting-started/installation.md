---
title: 설치
description: opencodex(ocx) 프록시와 사전 요구 사항을 설치하고, 정상 실행되는지 확인합니다.
---

opencodex는 단일 CLI인 `ocx`로 제공됩니다. 작은 로컬 HTTP 서버(Bun 기반)로 실행되며, 설정한
프로바이더 외에는 어디로도 트래픽을 전송하지 않습니다.

## 사전 요구 사항

| 요구 사항 | 이유 |
| --- | --- |
| **[Bun](https://bun.sh) ≥ 1.1**(권장) 또는 **Node ≥ 20** | `ocx`는 Bun 런타임에서 실행되며, 서비스 러너가 `bun`을 호출합니다. |
| **[OpenAI Codex](https://openai.com/codex)**(CLI, App, 또는 SDK) | opencodex가 앞단에 위치하는 클라이언트입니다. opencodex는 `~/.codex/config.toml`에 기록합니다. |
| 프로바이더 계정 또는 API 키 | Anthropic, xAI, Kimi, Ollama Cloud, OpenRouter, OpenAI 호환 엔드포인트, 또는 ChatGPT 로그인. |

## 설치

```bash
# With npm (recommended)
npm install -g @bitkyc08/opencodex

# With Bun
bun install -g @bitkyc08/opencodex
```

바이너리가 `PATH`에 있는지 확인합니다:

```bash
ocx --help
```

## 소스에서 실행

opencodex 자체를 직접 수정하며 작업하려면:

```bash
git clone https://github.com/lidge-jun/opencodex.git
cd opencodex
bun install
bun run dev      # starts the proxy in dev mode (src/cli.ts start)
```

웹 대시보드는 `gui/`에 있으며 별도로 실행됩니다:

```bash
cd gui && bun install && bun dev
```

## 생성되는 항목

| 경로 | 용도 |
| --- | --- |
| `~/.opencodex/config.json` | 프로바이더, 기본 프로바이더, 포트, 옵션. |
| `~/.opencodex/ocx.pid` | 실행 중인 프록시의 PID(단일 인스턴스 가드). |
| `~/.opencodex/auth.json` | 저장된 OAuth 자격 증명(`ocx login` 시). |
| `~/.opencodex/catalog-backup.json` | 변경 전에 백업해 둔 원본 Codex 모델 카탈로그. |
| `~/.codex/config.toml` | opencodex가 `ocx init` 시 여기에 `[model_providers.opencodex]` 테이블을 추가합니다. |

:::note
opencodex는 절대 Codex 설정을 삭제하지 않습니다. 모든 주입은 되돌릴 수 있습니다 — `ocx stop`, `ocx restore`,
또는 `ocx eject`는 opencodex가 추가한 줄만 정확히 제거하고 네이티브 Codex를 복원합니다.
:::

## 다음

[Quickstart](/opencodex/ko/getting-started/quickstart/)로 이동해 첫 프로바이더를 설정하거나,
아키텍처를 알아보려면 [작동 방식](/opencodex/ko/getting-started/how-it-works/)을 읽어 보세요.
