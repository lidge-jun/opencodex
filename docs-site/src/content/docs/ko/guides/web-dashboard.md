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

## 로그인

`localhost`나 `127.0.0.1` 같은 loopback 주소에서 연 대시보드는 짧게 유지되는 GUI 세션을 자동으로 받으므로 보통 토큰을 입력할 필요가 없습니다. loopback이 아닌 호스트로 공개한 대시보드에는 `OPENCODEX_ADMIN_AUTH_TOKEN` 또는 자동 생성되는 `~/.opencodex/admin-api-token` 파일의 관리자 토큰이 필요합니다.

원격 대시보드는 표준 비밀번호 폼을 표시하므로 브라우저 비밀번호 관리자가 토큰 저장과 자동 완성을 제안할 수 있습니다. 대시보드 자체는 토큰을 메모리에만 보관하며 `localStorage`나 `sessionStorage`에 쓰지 않습니다. 저장 여부는 전적으로 브라우저 또는 비밀번호 관리자가 결정합니다.

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
| **Stop** | 프록시와 설치된 백그라운드 서비스를 정상 종료하고 네이티브 Codex를 복원한 뒤 끝냅니다(`POST /api/stop`). 단, Windows 작업 스케줄러로 관리되는 경우에는 대시보드가 거절하고 `ocx stop`을 안내합니다. 작업이 끝나도 래퍼가 프록시를 다시 띄울 수 있어서, 클라이언트 설정을 되돌리기 전에 그 재시작 구간을 확인할 수 있는 건 프록시 바깥에서 도는 stop뿐입니다. 거절될 때는 아무것도 바뀌지 않습니다. |

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

<a id="codex-auth-and-account-pools"></a>

## Codex Auth와 계정 풀

**Codex Auth** 페이지는 네이티브 ChatGPT/Codex 라우트를 관리합니다.

- 계정을 직접 고르면 곧바로 적용됩니다. 이미 계정이 묶인 thread도 다음 요청에서 고른 계정으로
  옮겨가고, 이미 전송 중인 요청만 가져간 계정을 그대로 씁니다. 직접 고른 계정은 고정되기도 합니다. 카드에 **고정됨** 배지가
  붙고, 그 계정이 소진되거나, 다른 계정을 고르거나, 어느 계정의 선택 순서를 바꿀 때까지 더 높은 선택
  순서가 끼어들지 못합니다. 계정이 제외되거나 삭제되거나 명시적으로 failover/promotion 되면 고정도 함께 풀립니다.
- 각 계정 카드에는 **선택 순서** 컨트롤(가장 먼저 / 먼저 / 기본 / 나중에 / 가장 마지막)이 있습니다.
  순서가 높은 계정부터 쓰이며, 그 위의 계정이 모두 소진되거나 사용할 수 없게 된 뒤에야 낮은 순서로
  내려갑니다. 순서를 바꾸면 **다음 미바인딩 요청** 부터 적용되며, 이미 계정에 바인딩된 thread를 옮기지
  않습니다. Codex Desktop(메인) 계정도 똑같이 정렬되므로 **가장 마지막**으로 두어 예비로 남길 수
  있습니다. `ocx account priority`로 프리셋 밖의 값을 지정해도 카드에서 그대로 보이고 선택할 수
  있습니다.
- Thread affinity가 요청마다 계정이 흔들리는 일을 막습니다. 할당량 자동 전환이 켜져 있으면 오래
  실행되는 thread도 주기적으로 다시 평가합니다. 관련 사용량이 임계값 이상이고 사용량이 확실히 더 낮은
  정상 계정이 있으면 그 계정으로 다시 묶일 수 있습니다.
- 새 세션은 사용량이 가장 낮은 정상 계정을 고를 수 있습니다. 유료 플랜은 알려진 5시간, 주간, 30일
  창 중 가장 높은 사용률로 점수를 매기고, Go/Free 플랜은 30일 창만 사용합니다.
- WHAM이 `limit_window_seconds`를 제공하면 Codex Auth는 28일 이상인 primary window를 주간이 아닌
  30일 창으로 분류합니다. 기간이 없는 기존 응답은 이전과 동일하게 주간 창으로 해석합니다.
- **Refresh quotas**는 계정 사용량을 즉시 다시 읽어 라우팅과 화면의 계정 카드가 같은 값을 보게 합니다.
- 풀 요청 로그에는 이메일 대신 `p3fa91c` 같은 불투명한 라벨을 사용합니다.
- **모델 선택기에서 사용할 Codex 계정 지정**은 명시적 opt-in입니다. 활성화하면 일반 GPT picker 항목이
  공개 account selector별 항목으로 대체됩니다. 선택한 대화는 해당 계정에 고정되며 Pool 순환이나
  fallback이 일어나지 않고 active Pool account도 바뀌지 않습니다. 기본 Codex App 로그인에는 자체
  selector가 있으며, 생성된 map에서는 보통 `main`, 충돌 시 `main-2` 같은 안전한 suffix를 사용합니다.
  추가 계정에는 안정적인 privacy-safe label이 부여됩니다. 기존 대화와 저장된 모델 선택은 계속
  라우팅됩니다. 비활성화해도 계정, selector, exact route는 삭제되지 않으며 일반 GPT id는 기존 Pool /
  Direct 동작을 유지합니다.
- 계정 추가·삭제와 picker 설정은 catalog refresh보다 먼저 저장됩니다. refresh가 끝나지 않으면 amber
  복구 안내가 표시됩니다. 변경 자체는 저장되어 있으므로 `ocx sync`로 refresh를 다시 시도하십시오.

Providers 개요는 Pool 모드 사용량을 표시 전용 가중 용량 추정치로 별도 요약하고, 현재 유효 계정의
원본 quota와 다음 용량 회복도 함께 표시합니다. 표시 필드, 불완전한 범위의 의미, 라우팅 경계는
[프로바이더 개요의 풀 용량](/ko/guides/providers/#프로바이더-개요의-풀-용량)을 참고하세요.

## 스타는 에이전트가 아니라 사용자가 결정합니다

사이드바의 스타 버튼, 그리고 `ocx start`가 대화형 터미널에서 한 번 묻는 질문은 모두
**사용자 본인의 `gh` 로그인**을 씁니다. opencodex는 GitHub 토큰을 따로 갖고 있지 않고,
예/아니오 답만 알게 됩니다.

이 동작이 사용자 GitHub 계정에 쓰기를 하기 때문에, 에이전트가 대신 답하지 못하도록 막아둡니다.

- 에이전트나 CI가 실행 중이면(`CLAUDECODE`, `CODEX_THREAD_ID`, `CURSOR_TRACE_ID`, `CI` 등)
  `ocx start`와 `ocx service install`은 질문 자체를 띄우지 않습니다. 1회용 마커도 남기지 않으니
  나중에 직접 손으로 실행할 때 진짜 질문이 그대로 나옵니다. 에이전트에게는 사용자에게 물으라는
  지시가 대신 출력됩니다.
- `POST /api/github/star`는 에이전트 세션에서 대시보드 브라우저 세션 없이 들어오면 `403`과
  `code: "agent_consent_required"`로 거절합니다. 관리자 토큰을 갖고 있다는 사실은 동의가 아닙니다.
  같은 기기의 에이전트는 그 파일을 읽을 수 있으니까요.
- 대시보드 버튼은 평소대로 동작합니다. 실제 클릭은 동일 출처 세션 증거를 함께 보내므로,
  프록시를 에이전트가 띄웠더라도 사용자 본인으로 인식합니다.
- 거절하면 거기서 끝입니다. 상태를 저장하지도, 나중에 다시 권하려고 모델 프롬프트에 무언가를
  끼워 넣지도 않습니다.

## 대시보드가 프록시와 통신하는 방식

GUI는 프록시의 JSON 관리 API를 사용하는 얇은 클라이언트입니다. 주요 엔드포인트는 다음과 같습니다.

| 엔드포인트 | 용도 |
| --- | --- |
| `GET` / `PUT /api/settings` | 설정을 읽고 Codex 자동 시작, stream/memory, account-targeting picker 표시를 업데이트합니다. |
| `GET` / `POST /api/github/star` | `gh`로 확인한 스타 상태를 읽거나 저장소에 스타를 남깁니다. 대시보드 세션 없이 에이전트가 POST하면 `403` `agent_consent_required`로 거절합니다. |
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
| `GET /api/codex-auth/active` · `PUT /api/codex-auth/accounts/priority` | 실효 계정(고정 여부를 나타내는 `pinned`와 고정된 계정을 알려주는 `pinnedAccountId` 포함)을 읽고 계정 하나의 선택 순서를 설정합니다. |
| `POST /api/codex-auth/login` · `GET /api/codex-auth/login-status` | 브라우저 로그인으로 pool 계정을 추가합니다. |
| `GET /api/logs?tail=50&limit=20&offset=0&provider=...&status=5xx` | tail, 프로바이더, 정확한 상태 코드 또는 상태 등급으로 최근 요청 메타데이터를 조회합니다. `limit`/`offset`은 최신 행에서 과거 방향으로 페이지네이션합니다(`offset=0`이 최신 페이지). 응답은 `{ timeZone, total, logs }`이며 `total`은 페이지네이션 전 필터 일치 건수입니다. |
| `GET` / `PUT /api/subagent-models` | `spawn_agent`에 우선 노출할 모델 5개를 읽거나 설정합니다. |
| `POST /api/stop` | 프록시/서비스를 멈추고 네이티브 Codex를 복원한 뒤 종료합니다. Windows 작업 스케줄러 백엔드에서는 `respawnable_service`로, 그 상태를 읽을 수 없으면 `service_state_unknown`으로 거절하며, 두 경우 모두 아무것도 바뀌지 않습니다. |

:::tip
대시보드에서 **Ollama Cloud** 같은 카탈로그 프로바이더를 추가하면 텍스트/비전 모델 분류가 저장된
프로바이더 설정에 복사됩니다. 별도 분류 작업 없이도
[비전 사이드카](/ko/guides/sidecars/)가 올바른 조건에서만 실행됩니다.
:::
