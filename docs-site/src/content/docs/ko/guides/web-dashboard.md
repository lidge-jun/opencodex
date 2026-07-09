---
title: 웹 대시보드
description: opencodex GUI — 프록시 상태, 프로바이더 관리, 모델 선택기, 그리고 요청 로그.
---

opencodex는 프록시에서 제공되는 로컬 웹 대시보드(`gui/` 아래의 Vite/React 앱)를 함께 제공합니다. 프로바이더를
추가하고, Codex/ChatGPT 인증 계정을 관리하고, 서브에이전트 모델을 선택하고, 트래픽을 관찰하는 가장 쉬운 방법입니다.

## 열기

```bash
ocx gui
```

이 명령은 브라우저에서 `http://localhost:<port>`를 엽니다(필요한 경우 먼저 프록시를 자동 시작). 개발 시에는
실행 중인 프록시에 대해 GUI 개발 서버를 별도로 실행할 수 있습니다:

```bash
ocx start
bun run dev:gui
```

## 할 수 있는 일

| 영역 | 기능 |
| --- | --- |
| **Status** | 실시간 프록시 상태, 포트, 가동 시간, PID. |
| **Providers** | 프로바이더 추가, 편집, 활성화/비활성화, 제거. |
| **Add provider** | 검색 가능한 프리셋 선택기 — OAuth 로그인(xAI / Anthropic / Kimi), ChatGPT forward, API 키 카탈로그(Ollama Cloud 포함), 로컬 서버, 그리고 Custom. |
| **OAuth login** | 프로바이더의 인증 페이지를 열고 토큰이 들어올 때까지 폴링합니다; 또는 기존 로컬 CLI/키체인 토큰을 가져옵니다. |
| **Codex Auth** | ChatGPT/Codex pool 계정을 추가하고, 다음 세션 계정을 고르고, 5시간 / 주간 / 30일 할당량을 다시 조회하며, auto-switch / failover 임계값을 설정합니다. |
| **Subagent models** | Codex의 `spawn_agent`가 광고할 라우팅된 모델 ≤5개를 선택합니다. |
| **Models** | 개별 라우팅된 모델을 활성화/비활성화합니다(숨겨진 항목은 카탈로그와 `/v1/models`에서 제외됩니다). |
| **Multi-agent mode** | Models 페이지의 3단계 선택기(All v1 / Default / All v2)입니다. 모든 모델의 multi-agent surface를 강제할 수 있습니다. Default는 업스트림 pin을 따릅니다(sol/terra=v2, luna=v1). |
| **Request log** | 최근 요청(모델, 프로바이더, 상태)을 자동 갱신으로 보여주는 뷰. |
| **Stop** | 프록시를 정상 종료하고, 설치된 백그라운드 서비스를 중지한 뒤, 네이티브 Codex를 복원하는 사이드바 버튼입니다 — 한 번의 클릭으로 모두 수행됩니다 (`POST /api/stop`). |

## Codex Auth와 계정 풀

**Codex Auth** 페이지는 네이티브 ChatGPT/Codex 경로를 위한 화면입니다. 기존 세션과 새 세션을
분리해서 다룹니다.

- 기존 Codex thread id는 선택된 계정을 유지합니다. 그래서 SSH, tmux, 모바일 연결로 이어지는 세션이
  안정적이고, 긴 대화가 중간에 다른 계정으로 조용히 이동하지 않습니다.
- 새 세션은 auto-switch가 켜져 있을 때 사용량이 가장 낮은 정상 계정을 자동으로 사용할 수 있습니다.
  점수는 5시간, 주간, 30일 할당량 중 알려진 가장 높은 사용률을 기준으로 합니다.
- 할당량 새로고침 버튼은 프록시에 즉시 계정 사용량 재조회를 요청하므로, 라우팅과 화면의 account card가
  같은 기준을 보게 됩니다.
- pool 요청 로그는 계정 이메일이 아니라 `chatgpt-1` 같은 비식별 라벨을 사용합니다.

## 대시보드가 프록시와 통신하는 방식

GUI는 프록시의 관리 API에 대한 얇은 클라이언트입니다. 유용한 엔드포인트는 다음과 같습니다(모두 JSON):

| 엔드포인트 | 용도 |
| --- | --- |
| `GET /api/providers` | 설정된 프로바이더 목록. |
| `POST /api/providers` | 프로바이더 추가 또는 덮어쓰기(카탈로그 항목은 자동으로 모델 분류 정보가 보강됩니다). |
| `DELETE /api/providers?name=…` | 프로바이더 제거. |
| `GET /api/key-providers` | API 키 카탈로그(Ollama Cloud 포함). |
| `GET /api/oauth/providers` | 어떤 프로바이더가 OAuth 로그인을 지원하는지. |
| `POST /api/oauth/login` · `GET /api/oauth/status` | OAuth 플로우 시작 및 완료 폴링. |
| `GET /api/codex-auth/accounts?refresh=1` | main + pool 계정 목록을 가져오고 할당량을 강제 재조회. |
| `PUT /api/codex-auth/active` | 다음 새 Codex 세션에 사용할 계정 선택. |
| `PUT /api/codex-auth/auto-switch` | 새 세션 자동 계정 선택에 사용할 할당량 임계값 설정. |
| `PUT /api/codex-auth/failover` | 일시적 업스트림 실패가 몇 번 이어지면 이후 세션을 failover할지 설정. |
| `POST /api/codex-auth/login` · `GET /api/codex-auth/login-status` | 브라우저 로그인 플로우로 pool 계정 추가. |
| `GET` / `PUT /api/subagent-models` | featured 서브에이전트 모델 읽기 / 설정. |
| `POST /api/stop` | 프록시(및 설치된 백그라운드 서비스)를 정상 종료하고, 네이티브 Codex를 복원한 뒤 종료합니다. |

:::tip
대시보드에서 **Ollama Cloud**(또는 임의의 카탈로그 프로바이더)를 추가하면 텍스트 대 비전 모델 분류가
자동으로 설정에 복사되므로, 별도의 수동 설정 없이도 [비전 사이드카](/opencodex/ko/guides/sidecars/)가
올바르게 게이팅됩니다.
:::
