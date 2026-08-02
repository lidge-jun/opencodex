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
| `edit <name>` | 제공자 필드 플래그, `--json` | 키 풀을 바꾸지 않고 검증된 실시간 제공자 필드를 수정합니다. |
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
Usage: ocx account <list|current|use|refresh|auto-switch|login|reauth|code|cancel|remove|add-key|reset-credits> ...

list [provider]     Codex account pool, OAuth accounts and API keys (identifiers shown masked as the API returns them).
current <provider>  Show the active account or key.
use <provider> <id> Switch the active credential; 'main' selects the Codex App login.
refresh <provider>  Force-refresh Codex or provider quota reports.
auto-switch <provider> <on|off|status|threshold N>  Control the Codex pool threshold.
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
  "masked": "sk-ab****wxyz",
  "active": true,
  "needsReauth": false,
  "quota": null
}
```

### `ocx account list [provider] [--json] [--all]`

제공자를 지정하지 않으면 Codex 풀, OAuth 계정, 설정된 API 키 풀을 나열합니다. `--all`이 없으면 비어 있는 제공자는 건너뜁니다. 제공자를 지정하면 해당 자격 증명 계열만 나열합니다. 사람이 보는 출력은 `PROVIDER TYPE ID PLAN/LABEL STATUS` 형식을 사용하며, 수동으로 선택한 Codex 행에는 `selected`가 표시됩니다. 저장된 Kiro 계정이 있으면 출력에 Kiro에는 로그인 슬롯이 하나뿐이고 다시 로그인하면 현재 계정을 바꾼다는 점이 표시됩니다. 빈 결과도 성공입니다. `--json`은 다음을 반환합니다:

```text
{ accounts: AccountRow[], notes: string[] }
```

### `ocx account current <provider> [--json]`

활성 계정이나 키를 보여줍니다. 수동 고정이 없는 Codex 풀은 자동으로 가장 적게 사용한 항목을 선택한다고 보고합니다. 활성 자격 증명이 없는 다른 계열은 그 상태를 보고하고도 종료 코드 0으로 끝납니다. `--json`은 다음을 반환합니다:

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

### `ocx account login|reauth|code|cancel ...`

헤드리스 셸에서 브라우저 기반 또는 수동 코드 계정 인증을 실행합니다. 제공자별 명령 형태는 `ocx account --help`를 보십시오.

### `ocx account remove <provider> <id|main> --yes [--json]`

이 보호된 비대화형 삭제는 `--yes`를 요구합니다. 삭제하기 전에 id가 존재하는지 확인하며, 없는 id는 DELETE를 보내지 않고 종료 코드 1로 끝납니다. Codex App의 main 로그인은 제거할 수 없으므로 `remove openai main --yes`는 거부됩니다. 삭제 후에는 해당 계열을 다시 읽습니다. 고정된 Codex 계정을 제거하면 고정이 풀리고 자동 선택으로 돌아갑니다. OAuth는 남아 있는 첫 번째 계정으로 승격하거나 없다고 보고합니다. API 키 풀은 남아 있는 첫 번째 키로 승격하거나 없다고 보고합니다. `--json`의 성공 및 실패 형식은 다음과 같습니다:

```text
{ ok: true, provider, id, removedActive: boolean, promotedActiveId: string | null }
{ error: string } // stderr, exit 1
```

### `ocx account add-key <provider> [--label <label>] [--json]`

API 키 제공자에 키를 추가하고 활성화합니다. 키는 비TTY 파이프/리디렉션 stdin에서만 읽습니다. 대화형 TTY 입력, 빈 입력, OAuth/Codex 제공자, API 실패는 종료 코드 1로 끝납니다. 라벨 안에 들어 있더라도 키는 절대 출력되지 않습니다. 비밀 관리자나 here-string을 쓰는 편이 좋습니다:

```bash
ocx account add-key openrouter --label personal <<< "$OPENROUTER_API_KEY"
security find-generic-password -w openrouter | ocx account add-key openrouter --json
```

`--json`은 `{ ok: true, id: string | null, label?: string }`를 반환하며 키를 절대 포함하지 않습니다.

### `ocx account reset-credits <id|main> [--consume --yes]`

계정의 Codex reset credits를 확인합니다. credit을 소비하는 동작은 파괴적이므로 `--consume`와 `--yes`를 둘 다 요구합니다.

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
| `context <status\|value <tokens>\|provider <name> <on\|off>\|all <on\|off>>` | `--json` | 전역 또는 제공자별로 컨텍스트 창 한도를 읽거나 설정합니다. |
| `shadow <status\|set> [model\|-]` | `--enabled <on\|off>`, `--json` | Codex의 백그라운드 헬퍼 호출에 사용할 대체 모델을 읽거나 설정합니다. `-`는 모델을 지웁니다. `status`는 프록시가 가로채는 헬퍼 슬러그인 `sourceModels`도 보고합니다(기본값: `gpt-5.4-mini`와 `gpt-5.6-luna`). |

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
