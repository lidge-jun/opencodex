---
title: CLI 제공자, 계정, 모델
description: 제공자 설정, 자격 증명, 할당량, 모델 카탈로그 명령입니다.
---

이 명령들은 상위 제공자를 설정하고, 계정을 인증하고, 자격 증명 풀을 관리하고, Codex에 노출되는 모델 카탈로그를 제어합니다.

## 제공자

### `ocx provider <subcommand>`

비대화형 제공자 관리입니다. 레지스트리 항목은 이름으로 시드되며, 사용자 지정 이름을 쓰려면 `--adapter`와 `--base-url`을 둘 다 지정해야 합니다.

| 하위 명령 | 지원 플래그 | 동작 |
| --- | --- | --- |
| `list` | `--json` | 설정된 제공자와 남아 있는 레지스트리 항목을 나열합니다. |
| `add <name>` | `--adapter <adapter>`, `--base-url <url>`, `--api-key <key>`, `--default-model <model>`, `--set-default`, `--force`, `--json`, `--sync` | 레지스트리/사용자 지정 제공자를 추가합니다. `--force`는 덮어쓰고, `--sync`는 사람이 읽는 출력 모드에서 실행 중인 프록시를 새로 고칩니다. |
| `edit <name>` | 제공자 필드 플래그, `--headers <json>`, `--json` | 키 풀을 바꾸지 않고 검증된 실시간 제공자 필드를 수정합니다. `--headers`는 사용자 지정 요청 헤더를 병합하며, `{}` 또는 `-`로 지울 수 있습니다. |
| `test <name>` | `--json` | 실제 상위 모델 엔드포인트를 확인합니다. |
| `show <name>` | `--json` | API 키를 마스킹한 설정을 보여줍니다. |
| `remove <name>` | `--json` | 기본값이 아닌 제공자를 제거합니다. 마지막 제공자는 제거할 수 없습니다. |
| `set-default <name>` | `--json` | 기존 제공자를 기본값으로 선택합니다. |
| `selected <name>` | `--set <ids>`, `--clear`, `--json` | 제공자 모델 허용 목록을 읽거나 업데이트합니다. |
| `quota` | `--refresh`, `--json` | 제공자 할당량 보고서를 읽습니다. |
| `presets` | `--json` | 대시보드 제공자 프리셋을 나열합니다. |
| `account-mode` | `pool`, `direct`, `--json` | Codex 계정 라우팅을 풀 기반으로 할지 직접 연결로 할지 선택합니다. |

```bash
ocx provider list --json
ocx provider test ark
ocx provider add anthropic --api-key sk-ant-... --set-default --sync
ocx provider add local-dev --adapter openai-chat --base-url http://localhost:11434/v1
ocx provider show anthropic --json
ocx models --provider anthropic --json
ocx models live --provider ark --json
```

:::caution[커스텀 헤더는 자격증명 통로가 아닙니다]
`--headers`는 비밀이 아닌 요청 메타데이터용입니다 — 라우팅 힌트, 테넌트나 프로젝트
선택자, 추적 id 같은 것들이요. 인증 정보를 넣는 자리가 아니고, 검증기는 표준 자격증명
헤더 이름(`Authorization`, `X-Api-Key`, `Cookie` 등)을 `apiKey` / `authMode`를
쓰라는 안내와 함께 거부합니다.

다만 `X-My-Token` 같은 임의 이름까지 알아볼 수는 없으니 그 경계는 사용자가 지켜야
합니다. 이유는 두 가지입니다.

- JSON이 명령줄 인자라서, 비밀이 들어가면 셸 히스토리와 프로세스 목록에 남습니다.
  CLI가 무엇을 가리기도 전에 같은 머신의 다른 프로세스가 읽을 수 있습니다.
- 헤더 값은 `config.json`에 평문으로 저장됩니다. 별도 저장·마스킹 경로가 있는
  API 키와 다릅니다.

비밀에 해당하는 값은 `--api-key`나 OAuth 로그인을 쓰세요.
:::

## 인증

### `ocx login <provider>`

제공자에 등록된 로그인 흐름을 시작합니다. OAuth 제공자는 브라우저를 열고 자동 갱신되는 자격 증명을 `~/.opencodex/` 아래에 저장합니다. API 키 로그인 제공자는 키 대시보드를 열고, 키 입력을 요청한 뒤, 가능한 경우 검증하고, 그 결과 나온 제공자 설정을 저장합니다. 이름이 없거나 알 수 없으면 현재 허용되는 OAuth 및 API 키 제공자 id를 출력합니다.

`ocx status` / `ocx doctor`가 재인증 필요 또는 터미널 새로고침 실패를 보고한 뒤에는 같은 명령으로 **재인증**하면 됩니다(대시보드의 Reauthenticate를 써도 됩니다). Codex 풀 계정은 공개 `ocx login` 제공자가 아닙니다. 대신 대시보드의 Codex 계정 풀(Reauthenticate)이나 헤드리스 `ocx account reauth` 흐름으로 재인증해야 합니다.

```bash
ocx login xai
ocx login anthropic
```

### `ocx logout <provider>`

제공자에 저장된 OAuth 자격 증명을 제거합니다.

## 계정과 키 풀

### `ocx account <subcommand>`

실행 중인 프록시를 통해 제공자 계정과 API 키 풀을 나열하고 전환합니다. 제공되는 도움말 표면은 다음과 같습니다:

```text
Usage: ocx account <list|current|use|refresh|auto-switch|priority|login|reauth|code|cancel|remove|add-key|reset-credits> ...

list [provider]     Codex account pool, OAuth accounts and API keys (identifiers shown masked as the API returns them).
current <provider>  Show the active account or key.
use <provider> <id> Switch the active credential; 'main' selects the Codex App login.
refresh <provider>  Force-refresh Codex or provider quota reports.
auto-switch <provider> <on|off|status|threshold N>  Control the Codex pool threshold.
priority <provider> <id|main> [first|earlier|normal|later|last|-100..100|reset]  Selection order; omit the value to read it.
remove <provider> <id> --yes  Remove a stored account or key after an existence check.
add-key <provider> [--label <label>]  Add a key read only from piped stdin.
login/reauth/code/cancel  Run browser or manual-code auth from a headless shell.
reset-credits <id|main> [--consume --yes]  Inspect or consume Codex reset credits.
Codex pool selection applies to the next request after clearing existing affinity; in-flight requests keep their captured account.
```

모든 하위 명령은 프록시가 실행 중이어야 합니다. CLI는 기록된 런타임 포트를 자동으로 찾습니다. 성공한 작업은 종료 코드 0으로 끝납니다. 잘못된 사용, 알 수 없는 제공자 또는 계정/키 id, 도달할 수 없는 프록시, API 실패는 종료 코드 1로 끝납니다. 자격 증명 필드는 관리 API가 반환한 그대로 표시됩니다(마스킹도 그대로 포함됩니다). 원시 API 키와 OAuth 토큰은 절대 반환하지 않습니다. 표시 편의 기능은 대시보드와 마찬가지로 클라이언트 쪽에서 합성합니다. `main`은 `openai` 계정 풀의 Codex App 로그인에 대한 CLI 별칭이고, 이메일이 없는 OAuth 계정은 `Account N`으로 표시되며, plan/label 열은 plan, 마스킹된 이메일, label, 마스킹된 키 순으로 대체합니다.

`--json` 계정 행은 다음 공통 형태를 사용합니다(사용할 수 없는 필드는 생략됩니다):

```json
{
  "provider": "openai",
  "type": "codex | oauth | api-key",
  "id": "__main__",
  "label": "plus",
  "email": "m***@example.com",
  "plan": "plus",
  "priority": 0,
  "masked": "sk-ab****wxyz",
  "active": true,
  "needsReauth": false,
  "quota": null
}
```

### `ocx account list [provider] [--json] [--all] [--quota [--refresh]]`

제공자를 지정하지 않으면 Codex 풀, OAuth 계정, 설정된 API 키 풀을 나열합니다. `--all`이 없으면 비어 있는 제공자는 건너뜁니다. 제공자를 지정하면 해당 자격 증명 계열만 나열합니다. 사람이 보는 출력은 `PROVIDER TYPE ID PLAN/LABEL PRIORITY STATUS` 형식을 사용하며, 수동으로 선택한 Codex 행에는 `selected`가 표시됩니다. 사용 가능한 Kiro 계정이 두 개 이상 저장되어 있으면 기본적으로 429 응답 시 다른 계정으로 자동 전환하며, 알려진 잔여 할당량이 가장 많은 계정을 우선합니다. 이 전환은 계정 존재만으로 활성화되며 `oauthAccountFailover.enabled: false`로 끌 수 있습니다. `ocx account login kiro`는 계정을 한 번에 하나씩 풀에 추가합니다. 빈 결과도 성공입니다. `--json`은 다음을 반환합니다:

```text
{ accounts: AccountRow[], notes: string[] }
```

### `ocx account current <provider> [--json]`

활성 계정이나 키를 보여줍니다. 수동 고정이 없는 Codex 풀은 우선순위를 고려한 자동 선택을 보고합니다. 가장 우선순위가 높은 적격 tier를 고르고, 그 tier 안에서 할당량 라우팅 기준으로 가장 적게 사용한 항목을 선택합니다. 활성 자격 증명이 없는 다른 계열은 그 상태를 보고하고도 종료 코드 0으로 끝납니다. `--json`은 다음을 반환합니다:

```text
{ provider, type, activeId: string | null, autoSwitchThreshold?: number, account: AccountRow | null }
```

### `ocx account use <provider> <account-or-key-id|main> [--json]`

기존 Codex 계정, OAuth 계정 또는 API key를 선택합니다. `openai`에서 `main`은 Codex App 로그인을
선택합니다. Codex Pool 선택은 프로세스 로컬 affinity를 지우고 기존에 보이던 작업을 포함한 다음 요청부터 적용됩니다. 프록시 재시작이나 affinity eviction 뒤에도 작업이 바인딩 없는 상태가 될 수 있지만, 진행 중인 요청은 이미 확보한 계정을 유지합니다. 이 선택은 Pool 라우팅만 제어하며 Direct mode는 호출자 소유/native main credential을 계속 사용합니다. 사용량 기반 선제 전환, 401/403 재인증, 429/retry-after cooldown, 제외, 출력 전 429/402 실패 복구는 나중에 다른 적격 Pool 계정을 선택할 수 있습니다. 이러한 복구 경로는 사용량 기반 전환이 꺼져 있어도 동작합니다. 계정이 바뀌어도 OpenCodex는 대화 문맥을 재생하지만 프로바이더 측 prompt cache는 다시 예열해야 할 수 있습니다.
알 수 없는 프로바이더나 id는 종료 코드 1입니다. `--json`은 다음을 반환합니다.
**401/403**이 발생하면 해당 계정의 프로세스 로컬 affinity를 해제하고 재인증을 요구합니다.
**429**에서는 `Retry-After`를 준수해 계정 cooldown을 시작하고 affinity를 해제한 뒤,
다른 적격 Pool 계정으로 요청을 전환할 수 있습니다. 이러한 실패 복구는
`autoSwitchThreshold: 0`에서도 계속 작동하며, `0`은 사용량 기반 선제 전환만 비활성화합니다.

```text
{ ok: true, provider, type, activeId }
```

### `ocx account refresh <provider> [--json]`

Codex 풀에는 `ocx account refresh openai [--json]`를 사용합니다. 계정 할당량을 강제로 새로 고치고 사용 가능 주간/월간 비율과 재설정 시간을 출력합니다. 할당량 데이터가 없으면 0%가 아니라 알 수 없음으로 보고합니다. JSON 봉투는 `{ accounts: AccountRow[] }`이며, Codex 행마다 `quota`가 붙습니다.

OAuth 및 API 키 제공자에는 제공자의 할당량 보고 엔드포인트를 강제로 새로 고칩니다. 토큰 재로그인이나 단순한 계정 목록 재읽기가 아닙니다. `--json`은 `{ provider, report: ProviderQuotaReport | null }`를 반환합니다. 지원되는 할당량 보고가 없는 제공자는 `no quota report available for <provider>`를 출력하고 종료 코드 0으로 끝납니다. 알 수 없는 제공자와 관리 API 실패는 종료 코드 1로 끝납니다. 상위 할당량 확인이 실패하거나 시간 초과되면 대시보드의 할당량 막대와 맞추어 null 또는 오래된 보고로만 떨어집니다(종료 코드 0).

### `ocx account auto-switch <provider> <on|off|status|threshold <0-100>> [--json]`

`openai` Codex 계정 풀만 제어합니다. `on`은 80%, `off`는 0%를 설정하고, `status`는 현재 값을 읽으며, `threshold <n>`은 0부터 100까지의 정수를 받습니다. 다른 제공자와 잘못된 값은 종료 코드 1로 끝납니다. `--json`은 다음을 반환합니다:

```text
{ provider, autoSwitchThreshold: number, enabled: boolean }
```

### `ocx account priority <provider> <account-id|main> [<-100..100|first|earlier|normal|later|last|reset>] [--json]`

Codex pool 계정 하나의 선택 순서를 읽거나 설정합니다. **값이 클수록 먼저** 쓰이고 기본값은 `0`,
범위는 `-100`부터 `100`까지입니다. 순서를 갖는 것은 `openai` Codex pool뿐이므로 다른 프로바이더는
종료 코드 1입니다. `main`은 Codex Desktop 로그인을 가리키며 다른 pool 계정과 똑같이 정렬됩니다.
`ocx account priority openai main last`로 예비 계정으로 남겨 둘 수 있습니다.

프리셋 단어는 작은 정수의 다른 이름입니다. `first`는 `+2`, `earlier`는 `+1`, `normal`은 `0`,
`later`는 `-1`, `last`는 `-2`입니다. `reset`은 기본값으로 되돌리고 저장된 항목을 지웁니다. **값을
생략하면 읽기**가 되어 현재 순서를 바꾸지 않습니다.

순서는 어떤 계정을 먼저 볼지 정할 뿐 어떤 계정을 쓸 수 있는지는 정하지 않습니다. 선택은 여전히
적격한 계정 안에서 이루어지며, quota 여유가 남은 최상위 tier를 고른 뒤 그 안은
`accountPoolStrategy`가 정합니다. 일시 중지, cooldown, 재인증에는 영향을 주지 않습니다. 변경은 새 세션뿐 아니라 **다음 미바인딩 요청** 부터 적용됩니다. 상위 순서에 여유가 돌아오면 preemption이
미바인딩 요청을 곧바로 끌어올립니다. 이미 계정에 바인딩된 thread는 보통 그 계정이 소진될 때까지 유지하지만, 재인증 실패나 quota cooldown, 연속된 일시적 실패는 그보다 먼저 바인딩을 해제합니다. 받아들여진 쓰기는 어떤 계정에 걸려 있든 수동 "지금 이 계정 사용" 고정도 해제합니다. 이미 설정된 순서를 그대로 쓰는 경우에도 마찬가지이며, 이는 현재 선택된 계정을 그대로 두고 고정만 해제하는 유일한 방법입니다(관리 API로 활성 계정을 비우면 고정도 풀리지만 그 선택까지 사라집니다). 프록시에 연결할 수 없거나, 없는
계정 id, 허용되지 않는 값은 모두 종료 코드 1입니다. `--json`은 다음을 반환합니다.

```text
{ ok: true, provider, id, priority: number, preset: string | null }
```


### `ocx account login|reauth|code|cancel ...`

헤드리스 셸에서 브라우저 기반 또는 수동 코드 계정 인증을 실행합니다. 제공자별 명령 형태는 `ocx account --help`를 보십시오. Codex account login이 저장되었지만 catalog refresh가 보류 중이면 성공으로 종료하고 human output의 stderr에 고정된 `ocx sync` 안내를 표시합니다. `--json`은 안내를 섞지 않고 완료 state의 `catalogRefreshPending: true`를 유지합니다.

### `ocx account remove <provider> <id|main> --yes [--json]`

이 보호된 비대화형 삭제는 `--yes`를 요구합니다. 삭제하기 전에 id가 존재하는지 확인하며, 없는 id는 DELETE를 보내지 않고 종료 코드 1로 끝납니다. Codex App의 main 로그인은 제거할 수 없으므로 `remove openai main --yes`는 거부됩니다. 삭제 후에는 해당 계열을 다시 읽습니다. 고정된 Codex 계정을 제거하면 고정이 풀리고 자동 선택으로 돌아갑니다. OAuth는 남아 있는 첫 번째 계정으로 승격하거나 없다고 보고합니다. API 키 풀은 남아 있는 첫 번째 키로 승격하거나 없다고 보고합니다. `--json`의 성공 및 실패 형식은 다음과 같습니다:

```text
{ ok: true, provider, id, removedActive: boolean, promotedActiveId: string | null, catalogRefreshPending?: boolean }
{ error: string } // stderr, exit 1
```

`catalogRefreshPending`는 Codex 삭제에만 포함됩니다. `true`여도 삭제는 이미 저장되었으며 human output은
stderr에 `ocx sync` 안내를 표시하고 종료 코드 0을 유지합니다. OAuth account와 API key 삭제 형식은 바뀌지 않습니다.

### `ocx account add-key <provider> [--label <label>] [--json]`

API 키 제공자에 키를 추가하고 활성화합니다. 키는 비TTY 파이프/리디렉션 stdin에서만 읽습니다. 대화형 TTY 입력, 빈 입력, OAuth/Codex 제공자, API 실패는 종료 코드 1로 끝납니다. 라벨 안에 들어 있더라도 키는 절대 출력되지 않습니다. 비밀 관리자나 here-string을 쓰는 편이 좋습니다:

```bash
ocx account add-key openrouter --label personal <<< "$OPENROUTER_API_KEY"
security find-generic-password -w openrouter | ocx account add-key openrouter --json
```

`--json`은 `{ ok: true, id: string | null, label?: string }`를 반환하며 키를 절대 포함하지 않습니다.

### `ocx account reset-credits <id|main> [--consume --yes]`

계정의 Codex reset credits를 확인합니다. credit을 소비하는 동작은 파괴적이므로 `--consume`와 `--yes`를 둘 다 요구합니다.

### `ocx account main <subcommand>`

OpenCodex 계정 풀 라우팅을 변경하지 않고 이름이 지정된 네이티브 Codex 기본 로그인 프로필을 관리합니다.

```text
ocx account main doctor [--json]
ocx account main list [--json]
ocx account main register <label> [--json]
ocx account main add <label>
ocx account main switch <profile-id-or-label> --yes [--json]
ocx account main recover [--rollback --yes] [--json]
```

각 변경 명령은 실행 중인 프록시가 반환한 정규화된 유효 `CODEX_HOME`을 표시합니다. 이 경로는
호출자의 `CODEX_HOME`과 다를 수 있으며, JSON을 지원하는 명령은 같은 값을
`effectiveCodexHome`으로 반환합니다.

버전 1은 파일 기반 Codex 인증을 지원하고 저장된 프로필을 AES-256-GCM으로 암호화하며 암호화 키를 운영 체제 자격 증명 저장소에 보관합니다. `add`는 생성된 자격 증명을 가져오기 전에 공식 Codex 로그인을 스테이징합니다. 프로필을 전환하기 전에 Codex를 종료하십시오. 전환에 성공하면 로컬 작업과 기록은 보존되지만 계속하기 전에 Codex를 다시 시작해야 합니다. `doctor`로 프로필 상태를 확인하고 `recover`로 중단된 전환을 완료하거나 롤백할 수 있습니다. `switch`에는 프로필 ID 또는 라벨을 지정할 수 있습니다.

v1 복구 매트릭스는 트랜잭션 파일이 rename으로 게시된 뒤 OpenCodex 프로세스가 종료되는 경우를 다룹니다. 운영 체제 또는 커널 충돌이나 갑작스러운 전원 손실에 대한 내구성은 보장하지 않습니다. `atomicWriteFileAsync()`는 파일이나 부모 디렉터리에 `fsync`를 수행하지 않습니다.

암호화된 볼트, 전환 저널, 복구 마커 및 저널 격리 파일은 정규 `<real CODEX_HOME>/.opencodex-native-main-profiles` 디렉터리에 저장됩니다. 따라서 해당 Codex 홈을 공유하는 모든 OpenCodex 인스턴스는 동일한 단일 소유자와 단일 복구 상태를 관찰합니다. 평문 로그인 스테이징은 각 `<OPENCODEX_HOME>/native-main-profile-staging` 디렉터리 아래에 서로 분리된 채 유지됩니다.

native-main 트래픽이나 저널 복구를 허용하기 전에 수명 주기 소유자가 자격 증명에 대한 배타적 점유권을 획득하고, 이름이 정확히 `auth.json.ocx.<pid>.<sequence>.tmp`인 충돌 잔여 파일만 제거합니다. 각 후보는 변경되지 않은 정규 `CODEX_HOME` 아래에서 하드 링크 수가 1인 일반 파일로 유지되어야 하며, 내용을 잘라내고 flush한 다음 unlink합니다. 링크나 재분석 지점(reparse point)으로의 바꿔치기, 파일 식별 정보 변경 또는 그 밖의 모호성이 있으면 native-main 트래픽은 계속 차단되며, 이름이 비슷할 뿐 정확히 일치하지 않는 파일은 자동으로 제거하지 않습니다. 이는 정상적으로 협력하는 OpenCodex 프로세스의 충돌을 방어하지만, 이미 같은 운영 체제 사용자로 실행 중인 악의적 프로세스까지 방어하지는 않습니다. 해당 사용자와 `CODEX_HOME`이 있는 파일 시스템은 계속 신뢰 대상으로 간주되며, 내용을 잘라내더라도 copy-on-write 저장소, 스냅샷 또는 SSD 잔류 데이터에서 물리적으로 지워진다고 보장할 수 없습니다.

프리뷰 빌드는 `<OPENCODEX_HOME>/native-main-profiles`를 사용했습니다. 이 레이아웃은 절대로 자동으로 가져오지 않습니다. `doctor`가 레거시 프로필 상태를 보고하면 동일한 `CODEX_HOME`을 공유하는 모든 OpenCodex 프록시를 중지하십시오. 그런 다음 해당하는 `*.vault.json`, `*.journal.json`, 복구 마커 및 참조된 journal-quarantine 파일을 백업하고, 소유자 전용 권한을 유지한 채 모두 함께 정규 디렉터리로 옮기십시오. 또는 이전 프리뷰 파일 세트를 제거하고 `ocx account main register`를 다시 실행하십시오. 동일한 `CODEX_HOME`을 공유하는 프록시가 하나라도 실행 중인 동안에는 여러 이전 루트 중 하나를 선택하거나 두 레이아웃을 동시에 사용하지 마십시오. Windows에서는 이전의 대소문자를 구분하지 않는 홈 식별자를 키로 사용한 프리뷰 상태를 옮기지 말고 재설정해야 합니다. 암호화된 AAD와 운영 체제 키링 식별자는 의도적으로 재사용하지 않기 때문입니다.

## 모델

### `ocx models [subcommand]` · `ocx model <subcommand>`

`ocx model`은 `ocx models`의 별칭입니다. 하위 명령이 없으면 설정된 제공자에 사전 등록된 모델을 나열합니다. `--provider`는 설정된 제공자 하나를 필터링하고 `--json`은 모델 메타데이터를 반환합니다. `live`는 실행 중인 카탈로그를 읽습니다. `add`, `edit`, `remove`, `list-custom`은 수동 카탈로그 항목을 관리합니다. `enable`, `disable`, `provider`는 가시성을 제어합니다. `selected`는 제공자 허용 목록을 제어합니다. `context`는 제공자 컨텍스트 한도를 제어합니다. `shadow`는 백그라운드 shadow-call 가로채기를 관리합니다.

대시보드가 제공하는 모델별 작업은 모두 여기에서도 사용할 수 있으므로, 헤드리스 설치에서는 카탈로그를 관리할 때 GUI가 필요하지 않습니다. `add`, `remove`, `list-custom`은 구성 파일을 대상으로 하며 카탈로그 동기화를 통해 실행 중인 프록시에 적용됩니다. 나머지는 실시간 관리 API와 통신하며 프록시가 실행 중이어야 합니다(`ocx start` 또는 설치된 서비스).

| 하위 명령 | 지원 플래그 | 동작 |
| --- | --- | --- |
| `list` (기본값) | `--provider <name>`, `--json` | 설정된 제공자에 사전 등록된 모델을 나열합니다. |
| `live` | `--provider <name>`, `--json` | 런타임에 발견된 모델을 포함해 실행 중인 카탈로그를 읽습니다. 행에는 `native`/`routed`, `custom`, `enabled`/`disabled` 표시가 붙습니다. |
| `add <provider> <modelId>` | `--display-name <name>`, `--context-window <tokens>`, `--modalities <text,image,audio>` | 제공자 카탈로그가 광고하지 않는 모델을 등록합니다. |
| `edit <custom-id>` | `--model-id <id>`, `--display-name <name\|->`, `--context-window <tokens\|0>`, `--modalities <text,image,audio\|->`, `--json` | 사용자 지정 모델을 수정합니다. `-`는 필드를 지우고, `0`은 컨텍스트 창을 지웁니다. |
| `remove <custom-id\|provider/modelId>` | `--yes` | 사용자 지정 모델을 삭제합니다. stdin이 대화형 터미널이 아닐 때는 `--yes`가 필요합니다. |
| `list-custom` | `--json` | 다른 하위 명령이 사용하는 `custom-id`와 함께 모든 사용자 지정 모델을 보여줍니다. |
| `enable <provider/model\|native-model>` | `--native`, `--json` | Codex에 하나의 모델을 보이게 합니다. |
| `disable <provider/model\|native-model>` | `--native`, `--json` | Codex에서 하나의 모델을 숨깁니다. |
| `provider <name> <on\|off>` | `--json` | 한 제공자의 모든 모델을 한 번의 쓰기로 활성화하거나 비활성화합니다. |
| `selected <provider>` | `--set <id,id...>`, `--clear`, `--json` | 제공자 모델 허용 목록을 읽거나 교체합니다. `--clear`는 허용 목록을 제거해 모든 모델을 제공하도록 합니다. |
| `context <status\|value <tokens> [--set-all]\|provider <name> on [--value <tokens>]\|provider <name> off\|all <on\|off>>` | `--json` | 전역 또는 제공자별로 컨텍스트 창 한도를 읽거나 설정합니다. `value <tokens> --set-all`은 모든 라우팅된 공급자에도 값을 다시 적용합니다(대시보드 토글과 동일). 지정하지 않으면 값은 기본값만 변경됩니다. `provider ... on --value <tokens>`는 해당 제공자에만 별도 한도를 설정합니다(`--value`는 `on`에서만 사용할 수 있습니다). |
| `shadow <status\|set> [model\|-]` | `--enabled <on\|off>`, `--json` | Codex의 백그라운드 헬퍼 호출에 사용할 대체 모델을 읽거나 설정합니다. `-`는 모델을 지웁니다. `status`는 프록시가 가로채는 헬퍼 슬러그인 `sourceModels`도 보고합니다(기본값: `gpt-5.6-luna`; 0.144.x 이하 클라이언트가 사용한 `gpt-5.4-mini`는 명시적인 `sourceModels` 재정의로 복원할 수 있습니다). |

```bash
ocx models live --json                                  # what Codex can actually see right now
ocx models disable anthropic/claude-haiku-4             # hide one routed model
ocx models enable gpt-5.6-sol                           # no slash, so it is treated as native
ocx models provider zenmux off                          # hide a noisy provider wholesale
ocx models selected anthropic --set claude-opus-5,claude-fable-5
ocx models selected anthropic --clear                   # drop the allowlist again
ocx models add deepseek deepseek-v4 --display-name 'DeepSeek V4' --context-window 128000 --modalities text,image
ocx models list-custom --json                           # read the custom-id for edit/remove
ocx models remove deepseek/deepseek-v4 --yes
```

슬래시가 있는 모델 선택기는 라우팅됩니다(`anthropic/claude-opus-5`). 슬래시가 없는 id는 native OpenAI 모델로 취급되므로, 라우팅된 것처럼 보일 수 있는 id에 대해 그 읽기를 강제하려면 `--native`가 필요합니다.

`--modalities`는 `text`, `image`, `audio`만 허용합니다. Codex는 이 필드를 닫힌 enum으로 해석하고 다른 값이 하나라도 있으면 카탈로그 전체를 거부하므로, `add`, `edit`, 관리 API는 나중에 카탈로그 작성기가 정리해야 할 값을 저장하지 않도록 잘못된 값을 바로 거부합니다(#759).
