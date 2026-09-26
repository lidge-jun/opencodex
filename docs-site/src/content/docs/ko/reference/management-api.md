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

| HTTP 메서드와 경로 | 목적 | 주요 오류 |
| --- | --- | --- |
| `GET, PUT /api/v2` | native multi-agent v2 모드와 thread 설정을 읽거나 변경합니다 | 400 잘못된 설정; 502 전환 또는 영속화 실패 |
| `GET, PUT /api/injection-model` | 주입된 sub-agent 모델, effort, prompt, guidance 설정을 읽거나 설정합니다 | 400 잘못된 모델, effort, 또는 본문 |
| `GET, PUT /api/effort-caps` | 전역 및 sub-agent reasoning-effort 상한을 읽거나 설정합니다 | 400 잘못된 ladder 값 |
| `GET, PUT /api/subagent-models` | sub-agent에 광고되는 모델을 읽거나 순서를 조정합니다 | 400 잘못된 목록 또는 모델 5개 초과 |
| `GET, PUT /api/subagent-model-fallback` | 정렬된 fallback 체인과 poll interval을 읽거나 설정합니다 | 400 잘못된 목록 또는 poll interval |
| `GET /api/grok` | Grok 관리 구성 상태와 후보 모델을 읽습니다 | 400 상태 읽기 실패 |
| `PUT /api/grok/selection` | 제외할 Grok 모델을 영속화합니다 | 400 잘못되었거나 너무 큰 선택 |
| `POST /api/grok/apply` | 관리형 동기화를 통해 영속화된 Grok 구성을 적용합니다 | 409 `grok_apply_busy`; 400/500 적용 실패 |
| `GET /api/grok/reset-coupons?accountId=...` | 활성 또는 지정된 xAI 계정의 남은 Grok billing reset 토큰과 유효 기간을 읽습니다 | 400 누락된 account; 401 인증되지 않음; 502 upstream gRPC-Web 오류 |
| `POST /api/grok/reset-coupons/consume` | 사용할 수 있는 reset coupon을 교환합니다. 본문은 `{ accountId?, tokenId?, operationId? }`. 선택적 `operationId`(UUIDv4)는 교환을 멱등하게 만듭니다 — 같은 id를 반복하면 이중 교환 없이 저장된 결과를 재생합니다. | 400 잘못된 JSON/UUID; 401 인증되지 않음; 409 `identity_mismatch`; 502 upstream 오류; 503 ledger 용량 |
| `GET /api/anthropic/reset-grants?accountId=...` | Anthropic OAuth 계정 하나의 Claude 사용량 리셋 grant를 읽습니다. 사용 가능 여부, grant별 남은 리셋 수와 유효 기간, 초기화하는 한도, 아직 다시 보낼 수 있는 미확인 시도를 함께 돌려줍니다 | 400 일치하는 계정 없음; 401 재로그인 필요; 502 upstream 응답 없음 |
| `POST /api/anthropic/reset-grants/consume` | 리셋 grant 하나를 사용합니다. 본문은 `{ accountId, grantId, operationId }`이고, `operationId`(UUIDv4)는 upstream 요청 ID로 그대로 전송되므로 같은 값을 다시 보내면 같은 요청을 재시도합니다. 대시보드 세션이 필요합니다. | 400 잘못된 본문; 401 재로그인 필요; 403 `session_required`; 409 `grant_not_usable`, `in_flight`, `unresolved_prior_operation`, `unknown_outcome_expired`, `operation_identity_mismatch`; 500 `journal_write_failed`; 502 `unknown_outcome`; 503 저널 사용 중, 열 수 없음, 또는 가득 참 |
| `GET, PUT /api/claude-desktop` | Claude Desktop 라우팅/네이티브 프로필을 읽거나 저장합니다 | 400 잘못되었거나 사용할 수 없는 할당 |
| `POST /api/claude-desktop/apply` | 저장된 프로필을 Claude Desktop의 관리형 구성에 기록합니다 | 400/500 기록 실패 |
| `GET /api/claude-desktop/status` | 저장된 프로필과 적용된 프로필, Desktop 상태를 확인합니다 | 400 상태 읽기 실패 |
| `GET, PUT /api/claude-code` | Claude Code gateway, auth-mode, model-map, context, agent, sidecar 설정을 읽거나 갱신합니다 | 400 잘못된 필드 또는 형태 |

대시보드는 **Providers > xAI Grok > Accounts**에서 두 coupon 경로를 모두 사용합니다. 로그인한 각
계정 행에는 남은 coupon 개수가 표시된 티켓 배지가 있으며, 이 배지는 유효 기간을 나열하고 만료가
가장 가까운 coupon을 교환하는 대화 상자를 엽니다. 대화 상자는 클라이언트가 생성한 `operationId`를
보내며, 재시도하는 대신 타임아웃 후 전송을 중단합니다. 저널 기록이 아직 열린 교환이 다시 실행되기
때문입니다. `ocx account grok-reset-coupons`는 터미널 대응 명령으로 그대로 남습니다.

Claude 사용량 리셋도 **Providers > Anthropic > Accounts**에서 같은 방식으로 씁니다. 로그인한
계정 행마다 남은 리셋 수를 보여 주는 티켓 배지가 붙고, 대화상자에서 한 번 더 확인하면 리셋
하나를 사용합니다. 리셋은 5시간 한도와 주간 한도를 다시 채우며 주간 리셋 요일은 바꾸지
않습니다. 요청이 응답하지 않으면 대화상자는 `operationId`를 그대로 들고 있다가 10분 동안 같은
ID로 다시 보내기를 제안합니다. Claude Code 클라이언트도 이렇게 복구하며, 그동안 같은 grant에
대한 새 작업은 거부됩니다. 사용은 대시보드에서만 가능하며 관리자 토큰만으로는
`403 session_required`가 돌아옵니다.

모델 목록과 암호화된 worker-task 동작의 개념은 [Sub-agent Surface](/guides/sub-agent-surface/)를 참고하십시오.

### 클라이언트 연동 롤백 저널

| 메서드 및 경로 | 목적 | 주요 오류 |
| --- | --- | --- |
| `GET /api/client-integrations/journal?client=...` | 롤백 작업을 조회합니다. 특정 클라이언트로 제한할 수 있으며 각 행에는 서버가 계산한 `deletable` 값이 포함됩니다. | 400 잘못된 클라이언트 |
| `DELETE /api/client-integrations/journal?opId=...` | 이전 롤백 작업을 폐기하고 가능한 경우 스냅샷도 제거합니다. 성공 응답의 `snapshotRemoved`가 `false`면 유지보수 재시도를 위해 정리 작업이 보존됩니다. | 400 `opId` 누락, 404 없거나 이미 폐기된 작업, 409 해당 클라이언트의 최신 작업 |

## 통합 변경 미리 보기

미리 보기는 변경 내용을 적용하지 않고 보여 줍니다. 스냅샷도, 소유권 기록도, 저널도, 잠금도,
복구도 남기지 않습니다.

| 메서드 및 경로 | 목적 | 주요 오류 |
| --- | --- | --- |
| `POST /api/client-integrations/preview` | 클라이언트 하나의 `apply`, `overwrite`, `disable`을 계획합니다. 본문은 `{ "clientId": "...", "operation": "..." }` | 400 잘못된 클라이언트나 작업, 400 `invalid_aside_profile_path`, 409 `integration_preview_unavailable` |
| `POST /api/client-integrations/restore/preview` | 실행 취소를 계획합니다. 본문은 `{ "opId": "...", "confirmDrift": false }` | 404 없는 작업, 400 `invalid_aside_profile_path`, 409 `integration_preview_unavailable` |
| `POST /api/client-integrations/aside/profiles/{profileId}/preview` | Aside 프로필 하나의 변경을 계획합니다. `restore`에는 `opId`가 필요합니다 | 400 잘못된 본문이나 프로필 미지정, 404 없는 프로필이나 작업, 409 `integration_preview_unavailable` |

계획에는 `version`, `clientId`, `operation`, `state`, `foreignEdit`, `kind`와 `path` 쌍으로 이루어진
`changes`, 불투명한 `fingerprint`, `canApply`, `willChange`가 담기고 `refusalReason`과
`profileId`는 선택 항목입니다. 경로는 관리 대상 스키마 경로이거나 `$snapshot`, `$ownership`,
`$journal` 표식이며, 실행 중에 정해지는 자리는 `*`로 적습니다. 설정 값이나 파일 위치, 선택된
항목의 이름은 돌려주지 않습니다.

`canApply`가 참인데 `willChange`가 거짓이면 작업은 성공하지만 관리 대상 클라이언트 문서에서는
아무것도 바뀌지 않습니다. 이미 적용된 것을 다시 적용하는 경우가 그렇습니다.

Aside 프로필 변경은 이때도 한 가지를 저장합니다. 확인을 보내면 클라이언트 문서에 손대기 전에 그
프로필의 동기화 설정이 먼저 기록되므로, 관리 블록이 이미 없는 프로필을 끄면 설정만 저장되고
문서와 기록은 그대로 남습니다.

`integration_preview_unavailable`은 지금 쓸 수 있는 모델 목록이 없다는 뜻입니다. 프록시를 막
시작했을 때도 그렇고, 설정이나 공급자 캐시가 바뀌어 기존 목록을 버린 경우에도 그렇습니다.
`GET /api/client-integrations`를 읽으면 조회가 성공하고 설정을 확인할 수 있을 때 목록이
준비되므로, 보통은 이렇게 해결되지만 항상 보장되지는 않습니다.

## 미리 본 변경 확정하기

변경 요청 본문에 `operation`과 `planFingerprint`를 함께 보냅니다. 둘 다 보내거나 둘 다
생략해야 하며, 하나만 보내거나 요청과 다른 작업을 적으면 거부합니다. Aside는 프로필 하나에만
묶을 수 있습니다. 지문 하나로 여러 파일의 변경을 설명할 수는 없기 때문입니다.

서버는 쓰기 전에 다시 계획해 보고, 확인한 내용이 더 이상 맞지 않으면 새 계획을 담아
`409 integration_preview_stale`을 돌려줍니다. 자동으로 다시 시도하지 않으니 새 계획을 보고
다시 결정하면 됩니다.

지문은 낙관적 확인일 뿐 권한이 아닙니다. 변경을 허용할지는 관리 인증과 소유권 규칙이
결정합니다.

삭제는 저널을 다시 쓰지 않고 툼스톤을 추가합니다. 현재 실행 취소 지점을 유지하기 위해
각 클라이언트의 최신 작업은 서버에서 삭제하지 못하게 보호합니다.

### 콤보

| HTTP 메서드와 경로 | 목적 | 주요 오류 |
| --- | --- | --- |
| `GET /api/combos` | 정규화된 combo와 공개 model id를 나열합니다 | catalog 작업이 `catalog_busy`를 반환할 수 있습니다 |
| `PUT /api/combos` | 하나의 combo를 생성, 대체, 또는 이름 변경합니다 | 400 잘못된 id, target, config, rename, 또는 일반 충돌; 409 Codex-account namespace 충돌 |
| `DELETE /api/combos?id=...` | 하나의 combo를 삭제하고 선택/cooldown 상태를 지웁니다 | 400 id 누락; 404 알 수 없는 combo |

대상 전략, cooldown, alias, 라우팅 실패는 [Combos](/guides/combos/)를 참고하십시오.

### Codex 프롬프트 레이어

| HTTP 메서드와 경로 | 목적 | 주요 오류 |
| --- | --- | --- |
| `GET /api/codex-prompt` | 프롬프트 레이어 스냅샷(레이어, 기본 변형, 선택, drift 상태)을 읽습니다 | — |
| `GET /api/codex-prompt/text` | `codex debug prompt-input`으로 모델에 표시되는 프롬프트 텍스트를 조사합니다 | fail-soft: 사용할 수 없는 probe는 HTTP 오류가 아니라 본문의 상태로 저하됩니다 |
| `PUT /api/codex-prompt/toggle` | 전환 가능한 레이어 하나를 켜거나 끕니다 | 400 잘못된 본문 또는 알 수 없는 레이어; 409 `stale_revision`, `layer_not_toggleable` |
| `PUT /api/codex-prompt/custom` | 사용자 지정 레이어 집합을 교체합니다 | 400 잘못된 본문, `invalid_characters`, 정규화된 UTF-8 레이어가 65,536바이트를 넘으면 `body_too_large`, 131,072바이트를 넘으면 `composed_too_large`; 409 `stale_revision` |
| `PUT /api/codex-prompt/base/select` | 기본 프롬프트 또는 저장된 변형 하나를 선택합니다 | 400 잘못된 본문, 저장된 변형과 일치하지 않는 id에는 `unknown_layer`; 409 `stale_revision`, 현재 base가 외부이면 `developer_instructions_not_owned` |
| `PUT /api/codex-prompt/base` | 기본 변형 하나를 생성(`id` 생략 또는 `id: null`), 편집 또는 삭제(`delete: true`)합니다. 제공된 `id`는 편집 전용이며 저장된 변형을 참조해야 합니다. `body`는 측정·저장 전에 정규화됩니다(탭 확장, CR/CRLF를 LF로 변환) | 400 잘못된 본문, `default` id 또는 저장된 변형과 일치하지 않는 id에는 `unknown_layer`, 정규화된 UTF-8 본문이 65,536바이트를 넘으면 `body_too_large`; 409 `stale_revision` |
| `POST /api/codex-prompt/adopt` | `config.toml`의 `developer_instructions`를 사용자 지정 레이어로 가져옵니다 | 400 잘못된 본문, `invalid_characters`, `body_too_large`, `composed_too_large`; 409 `config_unreadable`, `nothing_to_adopt`, `adopt_unsupported_form`, `stale_revision` |
| `POST /api/codex-prompt/repair` | `config.toml`과 소유 projection 사이의 drift를 복구합니다 | 400 잘못된 본문; 409 `config_unreadable`, `nothing_to_repair`, `repair_unsupported`, `stale_revision` |

레이어 모델과 각 레이어가 쓰는 키는 [Codex 프롬프트 레이어](/ko/guides/codex-prompt/)를 참고하십시오.

### 구성, 시작, 동기화, 업데이트

| HTTP 메서드와 경로 | 목적 | 주요 오류 |
| --- | --- | --- |
| `GET /api/config` | redacted된 management-safe configuration DTO를 반환합니다 | — |
| `PUT /api/config` | 전체 구성 교체 방지 기능이 비활성화되어 있습니다 | 405; 대신 집중된 엔드포인트를 사용하십시오 |
| `GET, PUT /api/settings` | 런타임/시작 설정을 읽거나 auto-start, stream mode, 앱 소유 memory budget, `codexAccountPickerEnabled`를 업데이트합니다 | 400 잘못됨, object 아님, 또는 비어 있는 업데이트 |
| `GET /api/startup-health` | 캐시된 서비스/shim 시작 상태를 읽습니다 | — |
| `POST /api/startup-action` | 서비스 또는 Codex shim을 설치하거나 복구합니다 | 400 잘못된 작업; 500 작업 실패 |
| `GET, POST /api/windows-tray` | Windows tray 상태를 읽거나 설치, 시작, 중지, 제거합니다 | 400 지원되지 않는 플랫폼/작업; 500 작업 실패 |
| `GET /api/diagnostics/project-config` | 캐시된 프로젝트 구성 경고를 읽습니다 | — |
| `POST /api/sync` | 현재 model catalog를 Codex에 동기화합니다 | 500 동기화 실패 |
| `GET /api/update/check` | `latest` 또는 `preview` 패키지 채널을 비동기로 확인하고 성공하면 캐시를 갱신합니다 | 400 잘못된 태그 |
| `POST /api/update/run` | 새 패키지 버전을 비동기로 확인한 뒤 업데이트 작업을 시작하고 선택적으로 재시작합니다 | 400 잘못된 본문; 작업별 충돌/오류 상태 |
| `GET /api/update/status` | id로 업데이트 작업을 조회합니다 | 404 알 수 없는 작업 |
| `GET, PUT /api/sidecar-settings` | web-search 및 vision sidecar 모델/backend 설정을 읽거나 업데이트합니다 | 400 잘못된 형태, backend, 또는 한도 |
| `GET, PUT /api/shadow-call-settings` | shadow-call interception 설정을 읽거나 업데이트합니다 | 400 잘못된 형태 또는 값 |

### 로그, 사용량, 저장소

요청 로그는 상위 서비스가 실제로 응답한 모델을 알려주면 `servedModel`을 기록하고, 상위 서비스로 보낸 모델이
클라이언트에 표시된 모델과 다르면 `wireModel`을 기록합니다. 두 모델이 다를 때 대시보드는 `wire → served`로
표시하고 툴팁에는 두 값을 모두 남깁니다. 상위 서비스가 응답 모델을 알려주지 않았다면 요청한 모델에서
추정하지 않고 해당 정보를 비워 둡니다.

| HTTP 메서드와 경로 | 목적 | 주요 오류 |
| --- | --- | --- |
| `GET /api/logs` | 필터링된 인메모리 요청 로그를 조회합니다 | — |
| `GET, PUT /api/debug` | debug 플래그를 읽거나, capture 범주를 설정, 해제, 초기화합니다 | 400 잘못되었거나 비어 있는 업데이트 |
| `GET /api/debug/logs` | 제한된 provider/debug 로그 항목을 읽습니다 | — |
| `GET /api/debug/usage-logs` | 제한된 usage-debug 항목을 읽습니다 | — |
| `GET /api/debug/injection-logs` | 제한된 guidance-injection debug 항목을 읽습니다 | — |
| `GET /api/claude/inbound-debug` | Claude inbound debug 상태와 항목을 읽습니다 | — |
| `GET /api/usage` | 범위와 클라이언트 surface별 사용량을 요약합니다 | 저장소를 읽을 수 없으면 500 `{ "error": "read_failed" }`를 반환합니다 |
| `GET /api/metrics` | 논리 요청, 실제 송신, 복구 종류, 소요 시간, TTFT에 대한 프로세스 로컬 Prometheus 텍스트 메트릭을 반환합니다. label은 protocol, result, recovery class의 닫힌 집합만 사용하며 요청·자격 증명 식별자는 내보내지 않습니다. | 시작 시 `metricsExport.enabled`가 true가 아니면 404; 일반 관리 인증이 필요하며 데이터 플레인 자격 증명으로는 접근할 수 없습니다 |
| `GET /api/storage` | bucket별 Codex 저장소 사용량을 검사합니다 | 검사 실패 시 `error: "scan_failed"` payload를 반환합니다 |
| `POST /api/storage/cleanup/preview` | archived-session cleanup을 미리 보고 binding digest를 반환합니다 | 400 `invalid_json` 또는 `invalid_percent` |
| `POST /api/storage/cleanup` | 미리 본 archived set을 격리하거나 영구적으로 제거합니다 | 400 잘못된 입력; 409 오래되었음/바쁨/참조됨 상태; 500 파일 시스템/데이터베이스 실패 |
| `GET /api/storage/trash` | 격리된 cleanup 항목을 나열합니다 | 500 `trash_list_failed` |
| `POST /api/storage/trash/restore` | 격리된 항목 하나를 복원합니다 | 400 잘못된 id; 404 trash 없음; 409 busy/대상 충돌; 500 복원 실패 |
| `GET /api/storage/trash/restore/test-stream` | 테스트 전용 restore stream 훅입니다 | 테스트 훅이 꺼져 있으면 404 `not_available` |
| `GET, PUT /api/storage/cleanup-policy` | 예약된 cleanup policy와 작업 상태를 읽거나 업데이트합니다 | 400 잘못된 policy |
| `POST /api/storage/cleanup-policy/run` | 수동 cleanup-policy 실행을 시작합니다 | 409 `already_running`; 500 `cleanup_failed` |
| `GET /api/storage/cleanup-policy/test-stream` | 테스트 전용 policy stream 훅입니다 | 사용할 수 없으면 404 `not_found` |

행이 기존 파서의 크기 제한을 넘으면 `GET /api/usage`와 `GET /api/keys`는 읽을 수 있는 행의 집계를 유지하고 응답 전체에 `usageIncomplete: true`, `usageIncompleteReason: "oversized_rows"`를 추가합니다. 이 진단은 캐시와 증분 추가에서도 유지되며, 빈 결과나 필터 일치 결과가 없는 경우에도 반환됩니다. 재구축 시에는 다시 계산합니다. 행을 맞추기 위해 공급자·모델·API 키 식별자를 줄이지 않습니다. 플래그가 없다고 모든 기록이 유효했다는 뜻은 아닙니다. `historyTruncated`, `entriesTruncated`, 토큰 측정 커버리지와는 별개입니다.

`models`, `providers`, `days[].models`의 행에도 `cacheHitRate`가 포함됩니다. 이 값은 공급자의 프롬프트 캐시에서
제공된 입력 토큰의 비율이며 `[0, 1]` 범위로 제한됩니다. 공급자가 캐시 텔레메트리를 보고하지 않았거나 행에 입력
토큰이 없으면 `0`이 아니라 항상 `null`입니다. "캐시 데이터 없음"과 "실제 적중률 0%"는 서로 다른 사실이며,
이를 똑같이 표시하는 차트는 오해를 부르기 때문입니다.

:::caution
저장소 cleanup 엔드포인트는 archived session 데이터를 이동하거나 영구적으로 제거할 수 있습니다. 항상 먼저 미리 보고, 반환된 digest를 제출하십시오. 복구가 필요할 수 있으면 quarantine를 우선하십시오.
:::

### 모델 및 catalog

| HTTP 메서드와 경로 | 목적 | 주요 오류 |
| --- | --- | --- |
| `GET /api/catalog` | 설치된 Codex catalog 문서를 반환합니다 | 404 catalog 없음 |
| `GET /api/models` | 대시보드/CLI model 행을 반환합니다 | 수집이 포화 상태이면 `catalog_busy` |
| `GET /api/client-config?client=...` | 지원되는 파일 연동의 읽기 전용 client config를 만듭니다 | 400 지원되지 않는 client; 503 catalog 사용 불가 |
| `PUT /api/disabled-models` | 공유 disabled-model 목록을 교체합니다 | 400 잘못된 JSON |
| `PUT /api/model-visibility` | provider 또는 model 수준의 visibility를 원자적으로 변경합니다 | 400 잘못된 provider, scope, target, 또는 본문; 409 `initial_model_selection_pending` (목록을 새로고침한 뒤 다시 시도하세요.) |
| `GET, POST /api/custom-models` | custom model을 나열하거나 하나를 추가합니다 | 400 잘못된 필드; 404 provider 없음; 409 중복 model |
| `PUT, DELETE /api/custom-models/{id}` | custom model 하나를 수정하거나 삭제합니다 | 400 잘못된 id/필드; 404 찾을 수 없음; 409 중복 model |
| `GET, PUT /api/selected-models` | provider allowlist와 가용성을 읽거나 allowlist 하나를 교체합니다 | 400 provider/body 누락; 404 알 수 없는 provider; PUT 409 `initial_model_selection_pending` |
| `GET, PUT /api/model-presets` | 프리셋 정보를 읽거나 preset/all/custom 모드를 선택합니다 | 400 잘못된 mode 또는 지원하지 않는 프리셋; 404 알 수 없는 provider; PUT 409 `initial_model_selection_pending` |

수동 모델은 Models 대시보드에서 provider와 model ID가 같은 행을 대체합니다. OpenAI 수동 행은 `openai/<model>`을 유지하며 표시 여부를 바꿀 수 있습니다. 수동 행을 삭제하면 계정 한정자가 없는 네이티브 행이 다시 나타납니다. 계정 한정자가 있는 네이티브 행은 별도로 유지됩니다. 네이티브 경로나 계정 권한은 바뀌지 않습니다. OpenAI의 비네이티브 표시 대상은 설정된 수동 모델과 일치해야 합니다.


신뢰할 수 있는 초기 모델 목록을 확보하기 전에는 유효한 `PUT /api/selected-models`와 `PUT /api/model-presets` 요청도 HTTP 409와 `initial_model_selection_pending` 코드를 반환합니다. `GET /api/models` 등으로 모델 목록을 정상적으로 갱신한 뒤 재시도하세요.

### OAuth 계정, provider key, 데이터 평면 키

| HTTP 메서드와 경로 | 목적 | 주요 오류 |
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
| `GET, PUT, PATCH /api/pool/settings` | 모든 pool 종류(codex, anthropic, generic)의 policy를 읽거나 업데이트합니다. 세 종류 모두 같은 키로 응답하고, 해당 종류가 실제로 적용하는 필드는 `supported`에 나옵니다 | 400 알 수 없는 provider, 해당 종류가 지원하지 않는 필드, 잘못된 값 |
| `GET, PUT, PATCH /api/oauth/accounts/pool` | Anthropic과 일반 OAuth provider의 기존 pool policy입니다. `/api/pool/settings`로 대체되었고 기존 클라이언트를 위해 유지합니다 | 400 codex 또는 API 키 provider, 잘못된 policy |
| `POST /api/oauth/accounts/clear-cooldown` | OAuth 계정 하나의 런타임 cooldown을 지웁니다 | 400 잘못된 provider/account |
| `PUT /api/oauth/accounts/alias` | OAuth 계정 alias를 설정하거나 지웁니다 | 400 잘못된 provider/account/alias |
| `GET, POST, DELETE /api/providers/keys` | 마스킹된 provider key를 나열, 추가/활성화, 또는 제거합니다 | 400 잘못된 입력; 404 provider/key 없음 |
| `PUT /api/providers/keys/active` | provider의 활성 key를 선택합니다 | 400 잘못된 입력; 404 provider/key 없음 |
| `PUT /api/providers/keys/alias` | provider-key alias를 설정하거나 지웁니다 | 400 잘못된 입력; 404 provider/key 없음 |
| `GET, POST, PATCH, DELETE /api/keys` | 데이터 평면 admission key를 나열, 생성, 수정, 또는 삭제합니다 | 400 잘못된 본문/id; 404 key 없음 |

자격 증명 목록 응답은 의도적으로 마스킹됩니다. OAuth access token과 완전한 provider API key는 대시보드 클라이언트에 반환되지 않습니다.

### 제공자

| HTTP 메서드와 경로 | 목적 | 주요 오류 |
| --- | --- | --- |
| `GET /api/providers` | redacted된 provider 구성과 discovery 상태를 나열합니다 | — |
| `POST /api/providers` | 검증된 provider 하나를 추가하거나 교체하고, 선택적으로 기본 provider로 설정합니다 | 400 잘못되었거나 위험한 대상 또는 구성; 409 namespace 충돌 |
| `PATCH /api/providers?name=...` | 허용된 provider 필드(병합되는 `headers` 블록 포함), enabled/default 상태, 또는 OpenAI account mode를 업데이트합니다 | 400 잘못된 필드 또는 전환; 404 알 수 없는 provider |
| `DELETE /api/providers?name=...` | provider를 삭제하고, 가능하면 기본 provider를 재지정합니다 | 404 알 수 없는 provider; 409 `last_provider`; 409 `provider_has_dependent_combos` |
| `POST /api/providers/test?name=...` | 제한된 live provider connectivity/model-discovery 탐색을 수행합니다 | 404 알 수 없는 provider; 실패는 보통 `ok: false` 증거로 반환됩니다 |
| `GET /api/provider-quotas` | provider quota 보고서를 읽습니다. `refresh=1`은 새로 고침을 강제합니다 | — |
| `GET, PUT /api/provider-context-caps` | 전역, 모든 provider, 또는 하나의 provider context cap을 읽거나 업데이트합니다 | 400 잘못된 요청; 404 알 수 없는 provider |
| `GET /api/provider-presets` | 런타임 registry에서 파생된 GUI provider preset을 반환합니다 | — |

컨텍스트 상한 응답에는 `caps`(활성 상한)와 `values`(꺼도 유지되는 마지막 선택값)가 포함됩니다.
`value` 없이 공급자의 상한을 켜면 선택값을 복원하고, 처음 켤 때는 전역 `contextCapValue`를 씁니다.
OpenAI도 같은 규칙을 따르며, 스위치를 켠다고 별도의 922k 모드가 선택되지는 않습니다.
활성 상한은 모든 네이티브 윈도에 적용됩니다. 장문 컨텍스트를 지원하는 모델은 해당 모델의 지원 상한까지만
확장할 수 있습니다. `{ "value": 600000, "setAll": true }`는 전역 값과 활성 상한만 갱신합니다.
상한이 꺼진 공급자는 선택값을 유지하고, 나중에 켜면 그 값을 복원합니다.
`value` 없이 `{ "setAll": true }`를 보내면 설정된 모든 공급자의 상한을 현재 전역 값으로 켜고,
저장된 선택값도 바꿉니다. 상한을 꺼도 선택값은 다시 불러온 뒤까지 유지되지만 제한으로 적용되지는 않습니다.

`provider_has_dependent_combos`는 안전 장치입니다. provider를 삭제하기 전에 종속된 combo를 제거하거나 수정하십시오.

### 사이드바 및 동의가 필요한 작업

| HTTP 메서드와 경로 | 목적 | 주요 오류 |
| --- | --- | --- |
| `GET /api/github/star` | 사용자의 `gh` 세션을 통해 저장소 star 상태를 읽습니다 | 상태별 고정 결과 코드 |
| `POST /api/github/star` | 인증된 사람의 작업에서만 저장소를 star합니다 | 대시보드 세션 증거가 없는 agent-driven 호출에는 403 `agent_consent_required` |
| `GET /api/update/badge` | 레지스트리 조회 없이 캐시된 패키지 배지를 읽습니다. 캐시가 없거나 채널이 다르거나 40시간 이상 지났으면 `unknown: true`를 반환합니다. `surface=desktop&session=<id>`는 해당 데스크톱 앱 세션만 읽습니다. | 400 잘못된 surface; 데스크톱 세션이 없거나 만료되면 `unknown: true` |
| `POST /api/update/desktop-snapshot` | 데스크톱 셸이 바인딩된 프록시 클라이언트로 Tauri 업데이터의 표시 상태를 게시합니다 | `Origin` 헤더가 있거나 원시 `admin-token` principal이 아니면 403; 필드가 잘못되면 400; 1 KiB를 넘으면 413 |

데스크톱 snapshot은 임시 표시 상태이며 설치 요청이 아닙니다. 프록시는 메모리에 최대 32개 세션을 보관하고 마지막 heartbeat 후 180초가 지나면 만료시킵니다. surface=desktop이 없는 일반 브라우저는 계속 패키지 배지를 읽습니다.

대상 패키지 설치에서는 시작 후 캐시가 없거나 20시간 이상 오래됐으면 확인하고, 이후 매시간 신선도를 검사합니다. `OCX_DISABLE_UPDATE_CHECK=1`은 자동 확인만 끕니다. 명시적인 확인 및 실행 요청은 계속 동작합니다.

:::caution
관리자 인증은 프록시에 대한 접근만 증명할 뿐, 사용자의 신원을 써도 된다는 동의까지 증명하지는 않습니다. 에이전트는 `agent_consent_required`를 우회해서는 안 됩니다. 저장소를 star할지 여부는 사용자가 직접 선택해야 합니다.
:::

### 시스템 수명 주기

| HTTP 메서드와 경로 | 목적 | 주요 오류 |
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

| HTTP 메서드와 경로 | 목적 | 주요 오류 |
| --- | --- | --- |
| `GET, POST, DELETE /api/codex-auth/accounts` | Codex account를 나열/갱신하거나 삭제합니다. POST는 비활성화된 호환성 endpoint로만 유지되며, 성공한 DELETE는 `catalogRefreshPending`를 포함합니다. | POST는 항상 403 `manual_import_disabled`; DELETE 입력이 잘못되면 400 |
| `PUT /api/codex-auth/accounts/alias` | 계정 alias를 설정하거나 지웁니다 | 400 잘못된 account/alias |
| `PUT /api/codex-auth/accounts/pause` | 계정 하나를 일시 중지하거나 재개합니다 | 400 잘못된 account/state; 404 누락된 account |
| `PUT /api/codex-auth/accounts/pause-exhausted` | quota가 소진된 account를 일시 중지합니다 | mutation-lock 실패는 503이 됩니다 |
| `POST /api/codex-auth/accounts/clear-cooldown` | account 하나 또는 모든 account의 runtime cooldown을 지웁니다 | 400 잘못된 id |
| `GET, PUT /api/codex-auth/active` | 활성 account를 읽거나 선택합니다 | 400 잘못되었거나 누락된 account; 409 paused/legacy-row 충돌 |
| `PUT /api/codex-auth/auto-switch` | `id`를 생략한 `{ threshold }`로 전역 임계값을, `{ id, threshold }`로 계정별 재정의 값을 설정합니다. `id: '__main__'`은 Codex Desktop 계정을 지정합니다. `id`가 지정된 경우 `threshold: null`은 재정의 값을 삭제하고 전역 임계값 상속을 복원합니다 | 400 잘못된 ID/임계값, 404 계정 없음 |
| `PUT, PATCH /api/codex-auth/pool-strategy` | Codex account-pool 선택 전략을 업데이트합니다 | 400 잘못된 전략/구성 |
| `PUT /api/codex-auth/failover` | account failover threshold를 설정합니다 | 400 잘못된 threshold |
| `GET /api/codex-auth/quota` | 계정별 캐시된 quota 상태를 읽습니다 | — |
| `GET /api/codex-auth/reset-credits` | 계정의 reset-credit 자격을 확인합니다 | 400 누락된 account id; upstream 상태 전달; 500 조회 실패 |
| `POST /api/codex-auth/reset-credits/consume` | 사용할 수 있는 reset credit을 소비합니다. 선택적 `operationId`(UUIDv4)를 보내면 소비가 멱등해집니다 — 같은 id는 크레딧을 다시 쓰지 않고 저장된 결과 하나를 재생합니다. | 400 누락된 account id 또는 잘못된 `operationId`; id가 다른 계정 소유이면 409 `identity_mismatch`; upstream 상태 전달; 503 `server_busy`/`capacity`/`unavailable`; 500 소비 실패 |
| `POST /api/codex-auth/login` | Codex 로그인 또는 재인증을 시작합니다 | 400 잘못된 요청; 충돌/바쁨 로그인 상태 |
| `POST /api/codex-auth/login/code` | Codex 로그인 흐름용 수동 코드를 제출합니다 | 400 잘못된 흐름/code |
| `POST /api/codex-auth/login/cancel` | `{ "flowId": "..." }`로 지정한 대기 중인 Codex 로그인만 취소합니다 | 400 흐름 ID 누락, 알 수 없음 또는 대기 중이 아님 |
| `GET /api/codex-auth/login-status` | 흐름 또는 account 로그인 상태를 조회합니다. 새 계정 완료 시 복구가 필요할 때만 `catalogRefreshPending: true`를 포함합니다. | 알 수 없는 흐름은 `expired`로 보고되며, 활성 흐름이 없으면 `idle`로 보고됩니다 |

수동 소비가 `reset`으로 확인되면 같은 계정의 새 usage를 조회하여 기존 shared reset-derived
쿨다운을 즉시 복구할 수 있습니다. 복구는 조건부입니다. 계정이 일시 정지되었거나 재인증이
필요하거나 다른 진행 중인 probe가 쿨다운을 소유하면 쿨다운은 유지됩니다. reset 이전에 시작한
조회, 불완전하거나 소진된 usage, 신원이 바뀐 계정, 더 최근의 quota 실패로는 복구하지 않습니다.
오래된 main usage 응답은 더 최근에 반영한 관측을 덮어쓰지 않습니다. credential 갱신을 거쳤다면
해당 인증에서 이어진 갱신인지 확인되어야 하며, 외부에서 교체된 credential은 같은 계정이어도
복구 근거가 되지 않습니다. 명시적 `Retry-After`, Reserve 쿨다운, pause·pin·선택
설정도 보존됩니다. `already_redeemed`와 저장된 결과 재생은 새 reset을 증명하지 않습니다.

`reset` 또는 `already_redeemed`가 확인된 뒤 usage 조회가 실패하거나 바쁘더라도 소비 응답은
HTTP 200과 원래 `code`를 유지합니다. 새 잔여 수를 얻지 못하면 `remaining`을 생략합니다.
이는 소비 결과의 확인이며 라우팅 가능 상태를 보장하지 않습니다. usage를 다시 조회하십시오.
usage 조회 실패를 재시도하기 위해 reset credit을 다시 소비하지 마십시오.

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

## 원격 세션과 데이터 키 교체

`POST /api/keys/rotate {id}`는 최대 10분의 전환을 시작하며 새 데이터 키를 한 번만 반환합니다. `POST /api/keys/rotate/commit {id,rotationId}`는 확정하고, `DELETE /api/keys/rotate {id,rotationId}`는 취소합니다. 모두 관리 인증이 필요하며 데이터 키로 호출할 수 없습니다. `POST /api/session/logout`은 현재 `gui-session`, 일치하는 Origin, CSRF가 필요합니다. 관리자 토큰은 403을 받고 동의 세션을 만들거나 교환할 수 없습니다.
