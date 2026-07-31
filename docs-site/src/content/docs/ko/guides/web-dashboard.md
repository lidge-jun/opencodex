---
title: 웹 대시보드
description: 프록시 상태, 프로바이더, 모델, 위임 안내, 인증 풀, 사용량, 로그를 관리하는 opencodex GUI.
---

opencodex는 프록시가 제공하는 로컬 웹 대시보드(`gui/` 아래의 Vite/React 앱)를 포함합니다.
프로바이더, Codex/ChatGPT 계정, 카탈로그 모델, 사이드카, 서브에이전트 설정, 요청 트래픽을 가장
빠르게 관리할 수 있는 화면입니다.

## 열기

```bash
ocx gui
```

브라우저에서 `http://localhost:<port>`를 엽니다. 프록시가 꺼져 있으면 먼저 자동으로 시작합니다.
개발 중에는 실행 중인 프록시와 GUI 개발 서버를 따로 띄울 수 있습니다.

```bash
ocx start
bun run dev:gui
```

## 할 수 있는 일

| 영역 | 기능 |
| --- | --- |
| **Dashboard 요약** | Multi-agent 모드, 온라인 상태, 버전, 가동 시간, 프로바이더 수, 최근 30일 토큰 합계, 활성 프로바이더와 사용 가능한 네이티브/라우팅 모델을 보여줍니다. |
| **Sub-agent delegation** | OpenCodex 위임 가이드와 선택적인 Codex 네이티브 서브에이전트 기본값이 함께 사용할 네이티브/라우팅 모델과 선택적 reasoning 강도를 고릅니다. 스폰별 라우터는 아닙니다. 아래 설명을 확인하세요. |
| **사이드카** | 웹 검색 모델과 강도, 이미지 설명 모델을 선택합니다. 다음 요청부터 적용됩니다. |
| **Maintenance** | Codex 모델 카탈로그를 다시 동기화하고, 프로젝트 로컬 설정의 우회 경고를 확인하고, latest/preview 업데이트를 조회하거나 선택적 프록시 재시작과 함께 설치합니다. |
| **시작 안전성** | 주입된 Codex 라우팅이 재부팅 후에도 유지되는지 서비스와 launcher shim 상태, 정확한 복구 명령과 함께 표시합니다. |
| **Windows 트레이** | 로그인할 때 사용자 전용 트레이를 시작하고 프록시 시작·중지·재시작·대시보드·상태를 클릭으로 제어합니다. 트레이는 재시작 서비스가 아닙니다. |
| **Codex 자동 시작** | 이미 설치된 Codex launcher shim이 `ocx ensure`를 실행하도록 허용합니다. 이 토글은 shim이나 백그라운드 서비스를 설치하지 않습니다. |
| **Providers** | 프로바이더를 추가, 편집, 기본으로 설정(활성만), 활성화/비활성화, 제거하고, 지원되는 OAuth 계정 풀과 API key 풀을 관리합니다. 현재 기본 프로바이더를 제거하면 남아 있는 첫 번째 활성 프로바이더로 전환됩니다(있는 경우); 없으면 삭제가 거부되고 현재 기본이 유지됩니다. Claude(Anthropic) OAuth 풀에서는 로그인한 계정마다 자체 5시간·주간 한도 막대가 표시되며(사용량은 자격 증명 단위), 조회 실패 시 마지막 값을 유지하고 일시 불가 상태로 표시합니다. |
| **Add provider** | 레지스트리 기반 프리셋에서 계정 로그인, API key 서비스, 로컬 서버, custom endpoint를 검색합니다. |
| **Codex Auth** | ChatGPT/Codex 풀 계정을 추가하고, 다음 세션 계정을 선택하고, 5시간 / 주간 / 30일 할당량을 갱신하며, 할당량 자동 전환을 켜거나 끄고 1~100% 임계값과 일시적 실패 failover를 설정합니다. |
| **Subagents** | `spawn_agent` override 목록에 네이티브 또는 라우팅 모델을 최대 5개까지 우선 노출합니다. |
| **Models** | 네이티브 GPT와 라우팅 모델을 켜고 끄고, 프로바이더 allowlist와 컨텍스트 상한, v1/base/v2, v2 thread 수를 설정합니다. |
| **Logs** | 토큰, 요청한 강도와 (사용 가능한 경우) 실제 전송 강도, 실제 모델, 프로바이더, 상태, 요청 id, 소요 시간, 오류 상세가 포함된 최근 요청을 자동 갱신합니다. 어댑터가 reasoning 매개변수를 전송한 경우 상세 보기에 정확한 wire field도 표시됩니다. 클라이언트가 보낸 불투명 대화/세션 id로 필터하면 현재 로드된 Logs 링의 토큰·추정 정가 합계를 볼 수 있습니다. |
| **Usage / Debug** | 토큰 사용량의 측정 범위와 추이를 보거나, 선택적 프로바이더 전송/사용량 추출 진단을 켭니다. |
| **Storage** | CODEX_HOME 디스크 사용량(세션, 보관, DB, 첨부)을 읽기 전용으로 표시합니다. 선택적 보관 정리: 가장 오래된 N%를 미리본 뒤 기본으로 `CODEX_HOME/.trash`에 격리하거나, 명시 체크 후 영구 삭제합니다. **자동 정리 정책**은 opt-in이며 **기본 OFF**(`storageCleanupPolicy.enabled`)입니다. Storage 페이지에서 임계값/목표/일정/모드를 설정하거나 **지금 실행**하세요. Storage 페이지에서 격리 항목을 복원할 수 있습니다(JSONL + 스레드). 활성 세션은 읽기 전용입니다. Codex가 최신/활성 `state_*.sqlite`를 잠그면 정리와 복원을 거절합니다. |
| **Stop** | 프록시와 설치된 백그라운드 서비스를 정상 종료하고 네이티브 Codex를 복원한 뒤 끝냅니다(`POST /api/stop`). |

### 섹션으로 바로 가기

레이아웃은 하나뿐이라 전환할 설정이 없습니다. 대신 Dashboard의 섹션마다 주소가 있습니다. `#dashboard`는 Overview, `#dashboard/providers`와 `#dashboard/models`는 나머지 두 섹션입니다. 새로고침하거나 북마크해도, 뒤로 가도 보던 섹션이 그대로 유지됩니다. **Logs**도 `#logs`와 `#logs/debug`로 똑같이 동작합니다. 예전 `#providers/workspace` 북마크는 `#providers`로 넘어갑니다.

**Logs**와 **Usage**의 비용 값은 보고된 토큰으로 계산한 API 정가 환산치입니다. 결제 영수증이나
실제 청구 증거가 아니며, 구독 사용량 또는 프로바이더 크레딧이 대신 적용될 수 있습니다.

## 모델 노출

**Models** 스위치는 Codex의 최종 노출 상태를 나타냅니다. 라우팅 모델은 프로바이더 allowlist에 포함되거나 allowlist가 없고, 동시에 비활성화되지 않았을 때만 켜집니다. 모델을 켜면 두 필터를 원자적으로 조정하며, **모두 활성화**는 allowlist를 해제해 새로 발견되는 모델도 켭니다.

## 위임 선택기와 스폰 라우팅의 차이

Dashboard의 **Sub-agent delegation** 선택기는 `injectionModel`과 선택적인 `injectionEffort`를
저장합니다. 선택한 값은 OpenCodex가 작성하는 위임 가이드에 사용되고, 이 가이드는
`multiAgentGuidanceEnabled`가 별도로 제어합니다. 모델을 지우면 저장된 강도도 지워지고 네이티브
기본값 동기화도 꺼집니다.

**Codex 네이티브 서브에이전트 기본값으로 사용**을 켜면 OpenCodex가 활성 Codex 라우팅을 관리하는
경우 다음 sync 또는 restart에서 선택한 모델과 강도를 네이티브 `[agents]` 기본값으로 적용합니다. 외부
사용자 관리 provider 설정은 변경하지 않습니다. 이 기본값은 새로 생성되는 Codex task에만 적용되고,
이 옵션 자체가 위임을 일으키지는 않습니다. 기존 사용자 소유 `[agents]` 기본값은 덮어쓰지 않고
보존하므로 요청한 기본값과 실제 Codex 기본값이 다를 수 있습니다.

:::caution
두 토글은 서로 독립적입니다. OpenCodex 위임 가이드를 꺼도 네이티브 기본값 동기화는 꺼지지 않고,
네이티브 기본값 동기화를 켜도 위임 가이드를 켜거나 위임을 발생시키지 않습니다. 어느 쪽도 프록시가
스폰마다 모델을 바꾸는 라우터가 아닙니다. v1/base/v2의 정확한 동작은
[서브에이전트 서피스](/ko/guides/sub-agent-surface/)를 참고하세요.
:::

선택기에는 활성화된 네이티브 및 라우팅 모델과 Codex 전역 reasoning 단계가 표시됩니다. API는
선택한 강도가 전역 단계에 있는지 검사하고, Codex는 다시 대상 카탈로그 항목이 그 강도를 지원하는지
검사합니다.

## Codex Auth와 계정 풀

**Codex Auth** 페이지는 네이티브 ChatGPT/Codex 라우트를 관리합니다.

- 계정을 직접 고르면 다음 새 Codex 세션부터 바뀝니다. 이미 계정이 묶인 thread는 이 수동 전환만으로
  중간에 이동하지 않습니다.
- Thread affinity가 요청마다 계정이 흔들리는 일을 막습니다. 할당량 자동 전환이 켜져 있으면 오래
  실행되는 thread도 주기적으로 다시 평가합니다. 관련 사용량이 임계값 이상이고 사용량이 확실히 더 낮은
  정상 계정이 있으면 그 계정으로 다시 묶일 수 있습니다.
- 새 세션은 사용량이 가장 낮은 정상 계정을 고를 수 있습니다. 유료 플랜은 알려진 5시간, 주간, 30일
  창 중 가장 높은 사용률로 점수를 매기고, Go/Free 플랜은 30일 창만 사용합니다.
- WHAM이 `limit_window_seconds`를 제공하면 Codex Auth는 28일 이상인 primary window를 주간이 아닌
  30일 창으로 분류합니다. 기간이 없는 기존 응답은 이전과 동일하게 주간 창으로 해석합니다.
- **Refresh quotas**는 계정 사용량을 즉시 다시 읽어 라우팅과 화면의 계정 카드가 같은 값을 보게 합니다.
- 풀 요청 로그에는 이메일 대신 `p3fa91c` 같은 불투명한 라벨을 사용합니다.

## 대시보드가 프록시와 통신하는 방식

GUI는 프록시의 JSON 관리 API를 사용하는 얇은 클라이언트입니다. 주요 엔드포인트는 다음과 같습니다.

| 엔드포인트 | 용도 |
| --- | --- |
| `GET` / `PUT /api/settings` | 설정을 읽거나 Codex 자동 시작을 켜고 끕니다. |
| `GET /api/startup-health` | 비밀값 없이 라우팅, 서비스, shim, 재부팅 안전성 진단을 읽습니다. |
| `GET` / `POST /api/windows-tray` | Windows 트레이 설치 및 표시 상태를 읽거나 `install`, `start`, `stop`, `uninstall` 작업을 수행합니다. |
| `POST /api/sync` | 공유 모델 카탈로그를 다시 만들고 Codex 모델 캐시를 오래된 상태로 표시합니다. |
| `GET /api/update/check` · `POST /api/update/run` · `GET /api/update/status` | 자체 업데이트 작업을 확인, 실행, 추적합니다. |
| `GET` / `PUT /api/sidecar-settings` | 검색/비전 사이드카 모델 설정을 읽거나 바꿉니다. |
| `GET` / `PUT /api/injection-model` | 위임 가이드의 모델/강도, 가이드 토글, Codex 네이티브 서브에이전트 기본값 동기화 토글을 읽거나 바꿉니다. |
| `GET` / `PUT /api/v2` | 서피스 모드, Codex 기능 플래그, v2 thread 상한을 읽거나 바꿉니다. |
| `GET /api/providers` · `POST /api/providers` · `PATCH /api/providers?name=...` · `DELETE /api/providers?name=...` | 프로바이더 목록 조회, 추가/교체, 활성화/비활성화, 기본 설정, 제거. `PATCH`는 활성 프로바이더에 `{ "setDefault": true }`만 보냅니다. `POST`는 생성/교체 시 `setDefault`를 함께 보낼 수 있으며 역시 활성만 허용합니다. 현재 기본을 삭제하면 남아 있는 첫 번째 활성 프로바이더로 재지정됩니다(있는 경우); 없으면 `409`(`code: "last_provider"`)를 반환하고 현재 기본을 유지합니다. |
| `GET /api/models` · `PUT /api/disabled-models` | 네이티브/라우팅 모델 행을 조회하고 공용 disabled model 목록을 갱신합니다. |
| `GET /api/selected-models` · `PUT /api/model-visibility` | 프로바이더 allowlist를 읽고 개별 모델 또는 프로바이더 그룹의 최종 노출 상태를 원자적으로 변경합니다. |
| `GET /api/key-providers` · `GET /api/oauth/providers` | API key 및 OAuth 프로바이더 카탈로그를 읽습니다. |
| `POST /api/oauth/login` · `GET /api/oauth/status` | 프로바이더 OAuth 로그인을 시작하고 완료 여부를 확인합니다. |
| `GET /api/codex-auth/accounts?refresh=1` | main 및 pool 계정을 조회하고 할당량을 강제로 갱신하며 main 계정의 `hasCredential` / terminal `needsReauth` 상태를 표시합니다. |
| `PUT /api/codex-auth/active` · `PUT /api/codex-auth/auto-switch` · `PUT /api/codex-auth/failover` | 다음 요청에 사용할 계정과 풀 라우팅 정책을 설정합니다. |
| `POST /api/codex-auth/login` · `GET /api/codex-auth/login-status` | 브라우저 로그인으로 pool 계정을 추가합니다. |
| `GET /api/logs?tail=50&limit=20&offset=0&provider=...&status=5xx` | tail, 프로바이더, 정확한 상태 코드 또는 상태 등급으로 최근 요청 메타데이터를 조회합니다. `limit`/`offset`은 최신 행에서 과거 방향으로 페이지네이션합니다(`offset=0`이 최신 페이지). 응답은 `{ timeZone, total, logs }`이며 `total`은 페이지네이션 전 필터 일치 건수입니다. |
| `GET` / `PUT /api/subagent-models` | `spawn_agent`에 우선 노출할 모델 5개를 읽거나 설정합니다. |
| `POST /api/stop` | 프록시/서비스를 멈추고 네이티브 Codex를 복원한 뒤 종료합니다. |

:::tip
대시보드에서 **Ollama Cloud** 같은 카탈로그 프로바이더를 추가하면 텍스트/비전 모델 분류가 저장된
프로바이더 설정에 복사됩니다. 별도 분류 작업 없이도
[비전 사이드카](/ko/guides/sidecars/)가 올바른 조건에서만 실행됩니다.
:::
