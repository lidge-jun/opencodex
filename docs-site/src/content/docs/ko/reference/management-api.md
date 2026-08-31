---
title: 관리 API
description: opencodex 제어 평면의 인증, 오류, 엔드포인트 참고 문서입니다.
---

Management API는 opencodex의 제어 평면입니다. `http://localhost:10100`의 대시보드는 이 API의 한 클라이언트이며, 헤드리스 `ocx` provider, model, combo, account, settings, diagnostics, lifecycle 명령도 모두 클라이언트입니다. 이 API는 프록시가 실행 중일 때만 사용할 수 있습니다.

대화형 클라이언트가 필요하면 [Web Dashboard](/guides/web-dashboard/)를 사용하고, 자동화를 만들 때는 이 참고 문서를 사용하십시오. 영속 값은 결국 [Configuration](/reference/configuration/)을 따릅니다.

## 인증 모델

Management API에는 데이터 평면 API 키와는 독립된 자체 관리자 자격 증명이 있습니다. 시작 시 opencodex는 다음 순서로 이를 확인합니다.

1. 설정되어 있으면 `OPENCODEX_ADMIN_AUTH_TOKEN`
2. 강화된 비밀 파일에 저장된 생성된 `ocx_admin_*` 토큰

파일 기반 토큰은 해당 디렉터리와 파일 권한 또는 ACL이 강화된 뒤에만 허용됩니다. 이를 보장할 수 없으면 관리 인증은 실패를 닫는 방식으로 처리되며, 환경 토큰이 제공되거나 파일 상태가 복구될 때까지 API는 503을 반환합니다.

관리자 토큰은 다음 두 형식 중 하나로 보내면 됩니다.

```http
X-OpenCodex-API-Key: <admin-token>
```

```http
Authorization: Bearer <admin-token>
```

:::caution
관리자 토큰은 모든 데이터 평면 자격 증명과 달라야 합니다. 시작 시 프록시 admission key와 충돌하는 관리 자격 증명은 거부됩니다. 관리자 토큰을 Codex, Claude Code, 또는 다른 모델 클라이언트에 넣지 마십시오. 이 토큰은 제어 평면 변경 권한을 부여합니다.
:::

### 루프백 대시보드 세션

루프백 바인드에서는 대시보드 초기화가 수명이 짧은 `ocx_session_*` 자격 증명을 받을 수 있습니다. 각 세션은 5분 동안 유지되며 정확한 대시보드 origin에 묶입니다. 안전한 요청은 그 origin과 일치해야 합니다. 안전하지 않은 메서드에는 브라우저 `Origin`과 세션의 CSRF 토큰도 필요합니다.

세션 발급은 원격 바인드와 같이 데이터 평면 인증이 필요한 경우에는 항상 비활성화됩니다. 원격 운영자는 원시 관리자 토큰으로 인증해야 하며, 루프백 방식의 GUI 세션은 발급되지 않습니다.

## 공통 오류

아래의 모든 엔드포인트 행은 이 경계 오류를 상속합니다. “주요 오류” 열에는 이 표를 반복하지 않고 경로별로 추가되는 결과만 적습니다.

| 상태 | 유형 또는 코드 | 의미 |
| --- | --- | --- |
| 401 | `opencodex admin token required` | 관리자 토큰 또는 GUI 세션이 없거나, 잘못되었거나, 만료되었거나, origin이 일치하지 않거나, CSRF 증거가 없습니다 |
| 403 | `cross-origin request blocked` | 요청 origin이 management allowlist 밖에 있습니다 |
| 404 | `not_found` | method와 path에 맞는 management route가 없습니다 |
| 413 | `request body too large` | POST, PUT, PATCH 본문이 management 2 MiB 제한을 초과했습니다 |
| 503 | `management API unavailable` | 관리자 자격 증명 초기화 또는 hardening을 사용할 수 없습니다 |
| 503 | `oauth_mutation_busy` | 다른 OAuth 자격 증명 변경이 writer를 점유하고 있습니다. 응답에는 `Retry-After: 1`이 포함됩니다 |
| 503 | `catalog_busy` | catalog 수집이 이미 최대치입니다. 응답에는 `Retry-After: 1`이 포함됩니다 |

## 엔드포인트 표

### 에이전트 및 클라이언트 설정

| Method and path | 목적 | 주요 오류 |
| --- | --- | --- |
| `GET, PUT /api/v2` | native multi-agent v2 모드와 thread 설정을 읽거나 변경합니다 | 400 잘못된 설정; 502 전환 또는 영속화 실패 |
| `GET, PUT /api/injection-model` | 주입된 sub-agent 모델, effort, prompt, guidance 설정을 읽거나 설정합니다 | 400 잘못된 모델, effort, 또는 본문 |
| `GET, PUT /api/effort-caps` | 전역 및 sub-agent reasoning-effort 상한을 읽거나 설정합니다 | 400 잘못된 ladder 값 |
| `GET, PUT /api/subagent-models` | sub-agent에 광고되는 모델을 읽거나 순서를 조정합니다 | 400 잘못된 목록 또는 모델 5개 초과 |
| `GET, PUT /api/subagent-model-fallback` | 정렬된 fallback 체인과 poll interval을 읽거나 설정합니다 | 400 잘못된 목록 또는 poll interval |
| `GET /api/grok` | Grok 관리 구성 상태와 후보 모델을 읽습니다 | 400 상태 읽기 실패 |
| `PUT /api/grok/selection` | 제외할 Grok 모델을 영속화합니다 | 400 잘못되었거나 너무 큰 선택 |
| `POST /api/grok/apply` | 관리형 동기화를 통해 영속화된 Grok 구성을 적용합니다 | 409 `grok_apply_busy`; 400/500 적용 실패 |
| `GET, PUT /api/claude-desktop` | Claude Desktop 라우팅/네이티브 프로필을 읽거나 저장합니다 | 400 잘못되었거나 사용할 수 없는 할당 |
| `POST /api/claude-desktop/apply` | 저장된 프로필을 Claude Desktop의 관리형 구성에 기록합니다 | 400/500 기록 실패 |
| `GET /api/claude-desktop/status` | 저장된 프로필과 적용된 프로필, Desktop 상태를 확인합니다 | 400 상태 읽기 실패 |
| `GET, PUT /api/claude-code` | Claude Code gateway, auth-mode, model-map, context, agent, sidecar 설정을 읽거나 갱신합니다 | 400 잘못된 필드 또는 형태 |

모델 목록과 암호화된 worker-task 동작의 개념은 [Sub-agent Surface](/guides/sub-agent-surface/)를 참고하십시오.

### 콤보

| Method and path | 목적 | 주요 오류 |
| --- | --- | --- |
| `GET /api/combos` | 정규화된 combo와 공개 model id를 나열합니다 | catalog 작업이 `catalog_busy`를 반환할 수 있습니다 |
| `PUT /api/combos` | 하나의 combo를 생성, 대체, 또는 이름 변경합니다 | 400 잘못된 id, target, config, rename, 또는 일반 충돌; 409 Codex-account namespace 충돌 |
| `DELETE /api/combos?id=...` | 하나의 combo를 삭제하고 선택/cooldown 상태를 지웁니다 | 400 id 누락; 404 알 수 없는 combo |

대상 전략, cooldown, alias, 라우팅 실패는 [Combos](/guides/combos/)를 참고하십시오.

### 구성, 시작, 동기화, 업데이트

| Method and path | 목적 | 주요 오류 |
| --- | --- | --- |
| `GET /api/config` | redacted된 management-safe configuration DTO를 반환합니다 | — |
| `PUT /api/config` | 전체 구성 교체 방지 기능이 비활성화되어 있습니다 | 405; 대신 집중된 엔드포인트를 사용하십시오 |
| `GET, PUT /api/settings` | 런타임/시작 설정을 읽거나 auto-start, stream mode, 앱 소유 memory budget, `codexAccountPickerEnabled`를 업데이트합니다 | 400 잘못됨, object 아님, 또는 비어 있는 업데이트 |
| `GET /api/startup-health` | 캐시된 서비스/shim 시작 상태를 읽습니다 | — |
| `POST /api/startup-action` | 서비스 또는 Codex shim을 설치하거나 복구합니다 | 400 잘못된 작업; 500 작업 실패 |
| `GET, POST /api/windows-tray` | Windows tray 상태를 읽거나 설치, 시작, 중지, 제거합니다 | 400 지원되지 않는 플랫폼/작업; 500 작업 실패 |
| `GET /api/diagnostics/project-config` | 캐시된 프로젝트 구성 경고를 읽습니다 | — |
| `POST /api/sync` | 현재 model catalog를 Codex에 동기화합니다 | 500 동기화 실패 |
| `GET /api/update/check` | `latest` 또는 `preview` 업데이트 채널을 확인합니다 | 400 잘못된 태그 |
| `POST /api/update/run` | 선택적으로 restart를 뒤따르게 할 수 있는 업데이트 작업을 시작합니다 | 400 잘못된 본문; 작업별 충돌/오류 상태 |
| `GET /api/update/status` | id로 업데이트 작업을 조회합니다 | 404 알 수 없는 작업 |
| `GET, PUT /api/sidecar-settings` | web-search 및 vision sidecar 모델/backend 설정을 읽거나 업데이트합니다 | 400 잘못된 형태, backend, 또는 한도 |
| `GET, PUT /api/shadow-call-settings` | shadow-call interception 설정을 읽거나 업데이트합니다 | 400 잘못된 형태 또는 값 |

### 로그, 사용량, 저장소

| Method and path | 목적 | 주요 오류 |
| --- | --- | --- |
| `GET /api/logs` | 필터링된 인메모리 요청 로그를 조회합니다 | — |
| `GET, PUT /api/debug` | debug 플래그를 읽거나, capture 범주를 설정, 해제, 초기화합니다 | 400 잘못되었거나 비어 있는 업데이트 |
| `GET /api/debug/logs` | 제한된 provider/debug 로그 항목을 읽습니다 | — |
| `GET /api/debug/usage-logs` | 제한된 usage-debug 항목을 읽습니다 | — |
| `GET /api/debug/injection-logs` | 제한된 guidance-injection debug 항목을 읽습니다 | — |
| `GET /api/claude/inbound-debug` | Claude inbound debug 상태와 항목을 읽습니다 | — |
| `GET /api/usage` | 범위와 클라이언트 surface별 사용량을 요약합니다 | 저장소를 읽을 수 없으면 `error: "read_failed"` 요약을 반환합니다 |
| `GET /api/storage` | bucket별 Codex 저장소 사용량을 검사합니다 | 검사 실패 시 `error: "scan_failed"` payload를 반환합니다 |
| `POST /api/storage/cleanup/preview` | archived-session cleanup을 미리 보고 binding digest를 반환합니다 | 400 `invalid_json` 또는 `invalid_percent` |
| `POST /api/storage/cleanup` | 미리 본 archived set을 격리하거나 영구적으로 제거합니다 | 400 잘못된 입력; 409 오래되었음/바쁨/참조됨 상태; 500 파일 시스템/데이터베이스 실패 |
| `GET /api/storage/trash` | 격리된 cleanup 항목을 나열합니다 | 500 `trash_list_failed` |
| `POST /api/storage/trash/restore` | 격리된 항목 하나를 복원합니다 | 400 잘못된 id; 404 trash 없음; 409 busy/대상 충돌; 500 복원 실패 |
| `GET /api/storage/trash/restore/test-stream` | 테스트 전용 restore stream 훅입니다 | 테스트 훅이 꺼져 있으면 404 `not_available` |
| `GET, PUT /api/storage/cleanup-policy` | 예약된 cleanup policy와 작업 상태를 읽거나 업데이트합니다 | 400 잘못된 policy |
| `POST /api/storage/cleanup-policy/run` | 수동 cleanup-policy 실행을 시작합니다 | 409 `already_running`; 500 `cleanup_failed` |
| `GET /api/storage/cleanup-policy/test-stream` | 테스트 전용 policy stream 훅입니다 | 사용할 수 없으면 404 `not_found` |

`models`, `providers`, `days[].models`의 행에도 `cacheHitRate`가 포함됩니다. 이 값은 공급자의 프롬프트 캐시에서
제공된 입력 토큰의 비율이며 `[0, 1]` 범위로 제한됩니다. 공급자가 캐시 텔레메트리를 보고하지 않았거나 행에 입력
토큰이 없으면 `0`이 아니라 항상 `null`입니다. "캐시 데이터 없음"과 "실제 적중률 0%"는 서로 다른 사실이며,
이를 똑같이 표시하는 차트는 오해를 부르기 때문입니다.

:::caution
저장소 cleanup 엔드포인트는 archived session 데이터를 이동하거나 영구적으로 제거할 수 있습니다. 항상 먼저 미리 보고, 반환된 digest를 제출하십시오. 복구가 필요할 수 있으면 quarantine를 우선하십시오.
:::

### 모델 및 catalog

| Method and path | 목적 | 주요 오류 |
| --- | --- | --- |
| `GET /api/catalog` | 설치된 Codex catalog 문서를 반환합니다 | 404 catalog 없음 |
| `GET /api/models` | 대시보드/CLI model 행을 반환합니다 | 수집이 포화 상태이면 `catalog_busy` |
| `GET /api/client-config?client=...` | 지원되는 파일 연동의 읽기 전용 client config를 만듭니다 | 400 지원되지 않는 client; 503 catalog 사용 불가 |
| `PUT /api/disabled-models` | 공유 disabled-model 목록을 교체합니다 | 400 잘못된 JSON |
| `PUT /api/model-visibility` | provider 또는 model 수준의 visibility를 원자적으로 변경합니다 | 400 잘못된 provider, scope, target, 또는 본문 |
| `GET, POST /api/custom-models` | custom model을 나열하거나 하나를 추가합니다 | 400 잘못된 필드; 404 provider 없음; 409 중복 model |
| `PUT, DELETE /api/custom-models/{id}` | custom model 하나를 수정하거나 삭제합니다 | 400 잘못된 id/필드; 404 찾을 수 없음; 409 중복 model |
| `GET, PUT /api/selected-models` | provider allowlist와 가용성을 읽거나 allowlist 하나를 교체합니다 | 400 provider/body 누락; 404 알 수 없는 provider |

### OAuth 계정, provider key, 데이터 평면 키

| Method and path | 목적 | 주요 오류 |
| --- | --- | --- |
| `GET /api/oauth/providers` | 공개 OAuth 로그인 흐름이 있는 provider를 나열합니다 | — |
| `GET /api/key-providers` | API-key 로그인으로 구성된 provider를 나열합니다 | — |
| `POST /api/oauth/login` | OAuth 로그인 또는 계정 추가 흐름을 시작합니다 | 400 알 수 없거나 잘못된 provider; `oauth_mutation_busy` |
| `POST /api/oauth/login/code` | 수동 callback URL 또는 authorization code를 제출합니다 | 400 잘못된 provider/code; `oauth_mutation_busy` |
| `POST /api/oauth/login/cancel` | 공개적으로 진행 중인 OAuth 흐름을 취소합니다 | 400 알 수 없는 provider |
| `GET /api/oauth/status` | 하나의 provider OAuth 흐름을 조회합니다 | 400 알 수 없는 provider |
| `POST /api/oauth/logout` | 선택된 provider 자격 증명을 제거합니다 | 400 알 수 없는 provider; `oauth_mutation_busy` |
| `GET, DELETE /api/oauth/accounts` | 마스킹된 계정을 나열하거나 계정 하나를 제거합니다 | 400 잘못된 provider/id; 404 계정 없음; `oauth_mutation_busy` |
| `PUT /api/oauth/accounts/active` | 활성 OAuth 계정을 선택합니다 | 400 잘못된 provider/account; `oauth_mutation_busy` |
| `GET, PUT, PATCH /api/oauth/accounts/pool` | Anthropic OAuth pool policy를 읽거나 업데이트합니다 | 400 Anthropic이 아닌 provider 또는 잘못된 policy |
| `POST /api/oauth/accounts/clear-cooldown` | OAuth 계정 하나의 런타임 cooldown을 지웁니다 | 400 잘못된 provider/account |
| `PUT /api/oauth/accounts/alias` | OAuth 계정 alias를 설정하거나 지웁니다 | 400 잘못된 provider/account/alias |
| `GET, POST, DELETE /api/providers/keys` | 마스킹된 provider key를 나열, 추가/활성화, 또는 제거합니다 | 400 잘못된 입력; 404 provider/key 없음 |
| `PUT /api/providers/keys/active` | provider의 활성 key를 선택합니다 | 400 잘못된 입력; 404 provider/key 없음 |
| `PUT /api/providers/keys/alias` | provider-key alias를 설정하거나 지웁니다 | 400 잘못된 입력; 404 provider/key 없음 |
| `GET, POST, PATCH, DELETE /api/keys` | 데이터 평면 admission key를 나열, 생성, 수정, 또는 삭제합니다 | 400 잘못된 본문/id; 404 key 없음 |

자격 증명 목록 응답은 의도적으로 마스킹됩니다. OAuth access token과 완전한 provider API key는 대시보드 클라이언트에 반환되지 않습니다.

### 제공자

| Method and path | 목적 | 주요 오류 |
| --- | --- | --- |
| `GET /api/providers` | redacted된 provider 구성과 discovery 상태를 나열합니다 | — |
| `POST /api/providers` | 검증된 provider 하나를 추가하거나 교체하고, 선택적으로 기본 provider로 설정합니다 | 400 잘못되었거나 위험한 대상 또는 구성; 409 namespace 충돌 |
| `PATCH /api/providers?name=...` | 허용된 provider 필드(병합되는 `headers` 블록 포함), enabled/default 상태, 또는 OpenAI account mode를 업데이트합니다 | 400 잘못된 필드 또는 전환; 404 알 수 없는 provider |
| `DELETE /api/providers?name=...` | provider를 삭제하고, 가능하면 기본 provider를 재지정합니다 | 404 알 수 없는 provider; 409 `last_provider`; 409 `provider_has_dependent_combos` |
| `POST /api/providers/test?name=...` | 제한된 live provider connectivity/model-discovery 탐색을 수행합니다 | 404 알 수 없는 provider; 실패는 보통 `ok: false` 증거로 반환됩니다 |
| `GET /api/provider-quotas` | provider quota 보고서를 읽습니다. `refresh=1`은 새로 고침을 강제합니다 | — |
| `GET, PUT /api/provider-context-caps` | 전역, 모든 provider, 또는 하나의 provider context cap을 읽거나 업데이트합니다 | 400 잘못된 요청; 404 알 수 없는 provider |
| `GET /api/provider-presets` | 런타임 registry에서 파생된 GUI provider preset을 반환합니다 | — |

`provider_has_dependent_combos`는 안전 장치입니다. provider를 삭제하기 전에 종속된 combo를 제거하거나 수정하십시오.

### 사이드바 및 동의가 필요한 작업

| Method and path | 목적 | 주요 오류 |
| --- | --- | --- |
| `GET /api/github/star` | 사용자의 `gh` 세션을 통해 저장소 star 상태를 읽습니다 | 상태별 고정 결과 코드 |
| `POST /api/github/star` | 인증된 사람의 작업에서만 저장소를 star합니다 | 대시보드 세션 증거가 없는 agent-driven 호출에는 403 `agent_consent_required` |
| `GET /api/update/badge` | 저렴한 sidebar update-badge 상태를 읽습니다 | — |

:::caution
관리자 인증은 프록시에 대한 접근만 증명할 뿐, 사용자의 신원을 써도 된다는 동의까지 증명하지는 않습니다. 에이전트는 `agent_consent_required`를 우회해서는 안 됩니다. 저장소를 star할지 여부는 사용자가 직접 선택해야 합니다.
:::

### 시스템 수명 주기

| Method and path | 목적 | 주요 오류 |
| --- | --- | --- |
| `GET /api/system/memory` | 프로세스, heap, stream, response-state, watchdog, active-turn의 스칼라 메트릭을 반환합니다 | — |
| `POST /api/system/restart` | 클라이언트 injection을 제거하지 않고 drain-aware 프로세스 재시작을 시작합니다 | 202 반환; 반복 호출은 기존 drain을 보고합니다 |
| `POST /api/stop` | 서비스를 중지하고, native Codex를 복원하며, 관리형 Grok injection을 제거하고, 프록시를 drain합니다 | 409 서비스 소유권 충돌; Windows 작업 스케줄러 래퍼가 프록시를 다시 띄울 수 있고 호출자가 `ocx stop`이 아니면 409 `respawnable_service`(아무것도 바뀌지 않음); 설치된 관리자가 정지를 거부하면 409; 작업 스케줄러 상태를 읽을 수 없으면 409 `service_state_unknown`(아무것도 바뀌지 않음, 조회를 고친 뒤 재시도) |

### Codex 인증 위임

`GET /api/settings`는 유효한 `codexAccountPickerEnabled` boolean을 반환합니다. 이 strict boolean을
`PUT`하면 빈 map을 활성화할 때 privacy-safe selector를 초기화하고 기존 label을 보존한 채 먼저
영속화한 다음, 유효한 picker 표시가 바뀐 경우에만 bounded catalog convergence를 한 번 요청합니다.
성공 응답의 `catalogRefreshPending: true`는 설정은 저장되었지만 `POST /api/sync` 재시도가 필요하다는 뜻입니다.

루트 management dispatcher는 모든 `/api/codex-auth/*` 요청을 Codex account manager에 위임합니다. 해당 route는 다음과 같습니다.

| Method and path | 목적 | 주요 오류 |
| --- | --- | --- |
| `GET, POST, DELETE /api/codex-auth/accounts` | Codex account를 나열/갱신하거나 삭제합니다. POST는 비활성화된 호환성 endpoint로만 유지되며, 성공한 DELETE는 `catalogRefreshPending`를 포함합니다. | POST는 항상 403 `manual_import_disabled`; DELETE 입력이 잘못되면 400 |
| `PUT /api/codex-auth/accounts/alias` | 계정 alias를 설정하거나 지웁니다 | 400 잘못된 account/alias |
| `PUT /api/codex-auth/accounts/pause` | 계정 하나를 일시 중지하거나 재개합니다 | 400 잘못된 account/state; 404 누락된 account |
| `PUT /api/codex-auth/accounts/pause-exhausted` | quota가 소진된 account를 일시 중지합니다 | mutation-lock 실패는 503이 됩니다 |
| `POST /api/codex-auth/accounts/clear-cooldown` | account 하나 또는 모든 account의 runtime cooldown을 지웁니다 | 400 잘못된 id |
| `GET, PUT /api/codex-auth/active` | 활성 account를 읽거나 선택합니다 | 400 잘못되었거나 누락된 account; 409 paused/legacy-row 충돌 |
| `PUT /api/codex-auth/auto-switch` | 자동 account 전환을 위한 quota threshold를 설정합니다 | 400 잘못된 threshold |
| `PUT, PATCH /api/codex-auth/pool-strategy` | Codex account-pool 선택 전략을 업데이트합니다 | 400 잘못된 전략/구성 |
| `PUT /api/codex-auth/failover` | account failover threshold를 설정합니다 | 400 잘못된 threshold |
| `GET /api/codex-auth/quota` | 계정별 캐시된 quota 상태를 읽습니다 | — |
| `GET /api/codex-auth/reset-credits` | 계정의 reset-credit 자격을 확인합니다 | 400 누락된 account id; upstream 상태 전달; 500 조회 실패 |
| `POST /api/codex-auth/reset-credits/consume` | 사용할 수 있는 reset credit을 소비합니다 | 400 누락된 account id; upstream 상태 전달; 503 `server_busy`; 500 소비 실패 |
| `POST /api/codex-auth/login` | Codex 로그인 또는 재인증을 시작합니다 | 400 잘못된 요청; 충돌/바쁨 로그인 상태 |
| `POST /api/codex-auth/login/code` | Codex 로그인 흐름용 수동 코드를 제출합니다 | 400 잘못된 흐름/code |
| `POST /api/codex-auth/login/cancel` | Codex 로그인 흐름을 취소합니다 | — |
| `GET /api/codex-auth/login-status` | 흐름 또는 account 로그인 상태를 조회합니다. 새 계정 완료 시 복구가 필요할 때만 `catalogRefreshPending: true`를 포함합니다. | 알 수 없는 흐름은 `expired`로 보고되며, 활성 흐름이 없으면 `idle`로 보고됩니다 |

새 account의 config row는 저장되었지만 credential setup을 완료하지 못하면 OAuth `login-status`는
`status: "error"`를 보고하며
`code: "codex_credential_persistence_failed"`, `accountId`, `needsReauth: true`, 필요한 경우
`catalogRefreshPending: true`를 포함하며 storage error 세부 정보는 노출하지 않습니다. account row는
저장된 상태이므로 account 생성을 다시 시도하기 전에 재인증하거나 삭제하십시오.

이 위임된 계열에서 configuration-writer 또는 credential-refresh lock timeout이 발생하면 HTTP 503과 `CONFIG_MUTATION_LOCK_UNAVAILABLE` 코드가 반환됩니다. 클라이언트는 이를 영구적인 계정 실패로 보지 말고 곧바로 다시 시도해야 합니다.

계정 생성과 삭제는 catalog convergence보다 먼저 영속화됩니다. 실패하거나 연기된 catalog 작업은 저장된
mutation을 되돌리지 않고 내부 provider/account/path/credential 세부 정보도 반환하지 않습니다. 삭제된
account의 selector binding은 남아 있어 계정이 없을 때 exact route가 fail closed하고 같은 id를 다시 추가하면 같은 selector가 복원됩니다.

## 클라이언트 선택

일반적인 관리 작업에는 [Web Dashboard](/guides/web-dashboard/)가 가장 안전한 안내형 워크플로를 제공합니다. 헤드리스 호스트와 자동화에는 대응하는 `ocx` 명령을 사용하십시오. 이 명령들은 동일한 실시간 API를 호출하며, 프록시에 접근할 수 없거나 작업이 실패하면 0이 아닌 결과를 반환합니다. 직접 HTTP는 위의 정확한 엔드포인트 계약이 필요한 통합에 가장 유용합니다.
