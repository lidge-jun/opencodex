---
title: CLI 에이전트, 라우팅, 통합
description: 멀티 에이전트, 콤보, 관측성, 접근, 통합, 시스템, 구성 명령입니다.
---

이 명령들은 에이전트 정책과 라우팅을 제어하고, 실행 중인 프록시를 검사하며, 지원되는 클라이언트를 opencodex에 연결합니다.

## 에이전트 정책

### `ocx agent <status|injection|effort|subagents|fallback|sidecar> ...`

헤드리스 멀티 에이전트 목록, effort 상한, 프롬프트 주입, fallback, sidecar 설정을 관리합니다.
현재 정책은 `status`로 확인합니다. surface mode, delegation, effort, fallback 동작이 어떻게 맞물리는지는 [Sub-agent surfaces](/guides/sub-agent-surface/)를 보십시오.

```bash
ocx agent subagents set ark/model-a,openai/gpt-5.5
ocx agent sidecar web --enabled off
```

`--enabled off`는 대시보드의 **끔 (Off)** 행과 같은 스위치입니다. OpenCodex는 사이드카를
실행하지 않고 Codex 통합은 `~/.codex/config.toml`에
`web_search = "disabled"`를 쓰므로, MCP 검색 서버만 검색 경로로 쓸 수 있습니다.
`--enabled on`은 그 줄을 다시 제거합니다. 저장이 실제로 스위치를 옮기면 명령은 트리거된
Codex 쪽 쓰기(`--json`에서는 `codexWebSearch`, 그 밖에는 마지막
`Codex config:` 줄)를 보고하고, 쓰기가 불가능했다면 `ocx sync`를 안내합니다.
이 플래그는 `vision`에도 동작합니다.

### `ocx effort [status|set|clear]`

실행 중인 프록시를 통해 메인·서브에이전트의 reasoning-effort 상한을 조회하거나 변경하며,
프록시가 없으면 로컬 설정을 사용합니다. 상한은 `low`, `medium`, `high`, `xhigh`, `max`,
`ultra`이고, `-`는 해당 상한을 해제합니다. `none`과 `minimal`은 상한 단계가 아니므로 같은
명령의 다른 옵션이 유효하더라도 프록시 탐색이나 설정 변경 요청 전에 거부됩니다.
두 값은 상한이 아닌 별도의 injection effort를 설정하는 `--injection`에서는 그대로 사용할 수 있습니다.

```bash
ocx effort status --json
ocx effort set --main high --subagent low
ocx effort set --subagent -
```

상태 조회는 저장값 또는 런타임 상한 원문을 보존하고, 지원하지 않는 값은 `warnings`에 표시합니다
(모두 지원되는 값이면 빈 배열). 일반 출력에도 같은 경고가 나오며, 무시되는 필드와 수정 명령을
안내합니다. 상태 조회가 기존 값을 자동으로 복구하거나 덮어쓰지는 않습니다. 서브에이전트 필드가
무시되더라도 유효한 메인 상한이 사라지는 것은 아닙니다. `ocx effort clear`는 별도의 injection-effort
설정을 유지하면서 두 상한을 해제합니다. 상한이 적용되는 요청 surface는
[Sub-agent surfaces](/ko/guides/sub-agent-surface/)를 참고하세요.

### `ocx v2 <status|on|off|mode <v1|default|v2>|threads <n>>`

Codex `multi_agent_v2` 기능 플래그와 세 상태 멀티 에이전트 surface mode를 관리합니다.

| 하위 명령 | 동작 |
| --- | --- |
| `status` (기본값) | 현재 v2 플래그, 멀티 에이전트 모드, thread 동시성을 보고합니다. |
| `on` | `multi_agent_v2` 기능을 켜고 catalog를 다시 동기화합니다. |
| `off` | `multi_agent_v2` 기능을 끄고 catalog를 다시 동기화합니다. |
| `mode v1` | 모든 모델을 v1으로 고정하고, native v2를 끄며, 활성 thread 한도를 유지합니다. |
| `mode default` | 업스트림에서 지정한 model surface pin을 따릅니다. |
| `mode v2` | 모든 모델을 v2로 고정하고, native v2를 켜며, 활성 thread 한도를 유지합니다. |
| `threads <n>` | 활성 v1/v2 thread 한도를 1 이상의 정수로 설정합니다. |

```bash
ocx v2 status
ocx v2 mode v1
ocx v2 mode default
ocx v2 on
ocx v2 threads 16
```

`mode` 하위 명령은 `multiAgentMode`를 opencodex config에 쓰고 Codex catalog를 다시 동기화합니다.
mode와 flag 전환은 현재 숫자 thread 한도를 유효한 v1/v2 Codex key 사이로 옮깁니다.
전환이 실패하면 원래의 `config.toml`이 복원됩니다. 변경은 새 Codex 세션에만 적용되고, 실행 중인 세션은 고정된 surface를 유지합니다.

## 콤보 라우팅

### `ocx combo <list|show|set|remove> ...` · `ocx route combo ...`

콤보 failover와 round-robin 가상 모델을 관리합니다. `ocx route combo`는 계층형 별칭이며,
현재 지원되는 라우팅 리소스는 combo입니다. 대상은 `provider/model[:weight],provider/model[:weight]` 형식을 사용합니다.

```bash
ocx combo list
ocx route combo set reliable --targets ark/model-a:2,openai/gpt-5.5
```

라우팅 동작과 설정 안내는 [Combos](/guides/combos/)를 보십시오.

## 관측성과 디버그

`ocx usage --top 25` (`ocx observe usage --top 25`도 동일)는 사람이 읽는 모델 표의 행 수를 1~1000 정수로 지정합니다. 기본값은 10이며 `--search` 사용 시 100입니다. 검색 필터링 후 로컬 표시에만 적용되며 합계, 제공자/계정 행, API 매개변수는 바뀌지 않습니다. `--json`은 유효한 `--top`을 무시하고 기존 전체 보고서 또는 100행 검색 뷰를 유지합니다. 잘못된 값은 요청 전에 종료 코드 2를 반환합니다.

`ocx logs filter --json`은 최근 로그 한 구간을 읽고 조건에 맞는 행을 고릅니다. `--scan-limit`은 읽을 행 수, `--limit`은 출력할 행 수입니다. 결과가 비어 있어도 전체 기록에 일치 항목이 없다는 뜻은 아닙니다. `ocx usage --search <text>`는 모델 행만 검색하고 보고서의 총계와 조회 권한 범위는 유지합니다.

`ocx companion usage --json`은 저장된 모델·공급자 표시 설정으로 오늘과 30일 사용량을 읽습니다. 한 구간이 실패하면 다른 구간은 남기고 `partial: true`와 종료 코드 1을 반환합니다. 설정 기본값을 사용했다면 `settingsFallback`, 손상된 설정의 기본값이라면 `settingsCorrupt`도 확인하세요. 자세한 옵션과 응답은 [영문 CLI 기준 문서](/reference/cli/agents/#filter-a-bounded-log-snapshot)를 참고하세요.

### `ocx observe <logs|usage|storage|memory|debug|claude-inbound|injection> ...`

프록시 요청, 사용량, 저장소, 메모리, 디버그 데이터를 확인합니다. 직접 별칭은 다음과 같습니다:

| 별칭 | 대응 리소스 |
| --- | --- |
| `ocx logs [filters] [--follow] [--json|--jsonl]` | `ocx observe logs` |
| `ocx usage [--range <today|1d|7d|30d|all>] [--surface <all|codex|claude|grok>] [--provider <name>] [--model <id>] [--search <text>] [--top <1-1000>] [--json]` | `ocx observe usage` |
| `ocx storage [--json]` | `ocx observe storage` |
| `ocx memory [--json]` | `ocx observe memory` |

```bash
ocx observe usage --range 30d --json
```

일부 사용량 기록을 집계하지 못하면 일반 출력은 읽을 수 있는 행이 없어도 경고합니다. 표시되는 합계는 읽을 수 있는 기록만 반영합니다. 필터에 일치하는 읽을 수 있는 기록이 없으면 합계 항목 대신 경고와 안내를 표시하며, 제외된 기록에는 일치하는 항목이 있을 수 있습니다. `--json`은 응답의 `usageIncomplete` 진단과 사유를 그대로 유지합니다.

### `ocx debug <provider|usage|injection|claude> <on|off|status|reset|logs [-f]>`

실행 중인 프록시의 관리 API를 통해 런타임 디버그 override를 읽거나 변경합니다.

```bash
ocx debug provider on|off|status|reset
ocx debug provider logs [-f|--follow]
ocx debug usage on|off|status|reset
ocx debug usage logs [-f|--follow]
```

scope를 지정하지 않으면 `ocx debug`는 사용량을 출력하고, 프록시가 중지된 상태라면 다음 시작 시의 환경 기본값도 함께 보여줍니다. provider 디버그의 기본값은 `OCX_DEBUG=1`에서 오며(`OCX_DEBUG_FRAMES=1`도 예전 방식으로 동작합니다), usage 디버그의 기본값은 `OPENCODEX_USAGE_DEBUG=1`에서 옵니다.

## API 접근

### `ocx access <key|endpoints|models|test> ...`

OpenCodex 접속용 API 키 목록, 외부 엔드포인트와 모델을 조회합니다. `ocx api-key`는 `ocx access key` 명령 계열의 별칭입니다.

키 생성과 교체 시작은 일반 텍스트와 JSON 출력 모두에서 일회성 평문 자격 증명을 반환합니다. 에이전트는 이 단계를 에이전트 세션 밖에서 사람이 직접 조작하는 터미널에 맡겨야 합니다. 키 자체를 채팅으로 요청하지 말고, 설정·연결 확인 결과와 비밀이 아닌 키·교체 ID만 전달받으세요.

```bash
ocx access key list --json
```

새 키의 설정과 연결 확인은 기존 키 폐기 승인이 아닙니다. 교체를 확정하거나 기존 키를 삭제하려면 해당 키 폐기에 대한 별도의 명시적 승인이 필요합니다. 승인된 작업 후에는 목록을 다시 조회하세요. 직접 API를 호출해 이 절차를 우회하지 마세요.

## 클라이언트 통합

### `ocx integration <claude|grok> ...`

지원되는 Claude 및 Grok 통합을 관리합니다. 아래의 직접 명령군이 클라이언트별 제어를 제공합니다.

### `ocx claude [claude args...]`

프록시가 실행 중인지 확인한 뒤, `ANTHROPIC_BASE_URL`,
`ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`, 그리고 `config.claudeCode`의 모델 슬롯을 사용해 Claude Code를 실행합니다. 라우팅된 model은 Claude Code 2.1.129 이상에서 안정적인 slot alias를 통해 기본 `/model` 선택기에 나타납니다. 더 오래된 버전에서는 `ANTHROPIC_MODEL` 또는 `/model <id>`로 선택합니다. 사용자가 내보낸 `ANTHROPIC_*` 변수는 항상 우선합니다.

Claude Desktop 프로필 명령은 다음과 같습니다:

```text
ocx claude desktop [apply]                         Save and apply the four-family profile
ocx claude desktop show [--json]                   Show routes, families, and defaults
ocx claude desktop move <route> <family> [--default]
ocx claude desktop default <family> <route|none>
ocx claude desktop export <path|->                 Export versioned JSON (`-` = stdout)
ocx claude desktop import <path> [--apply]         Validate and import JSON
```

family는 `opus`, `fable`, `sonnet`, `haiku`이며, 새 route는 `opus`에서 시작합니다. `none`은 해당 family가 비어 있을 때만 유효합니다. 레거시 apply 플래그인 `--static`, `--hybrid`, `--discovery-only`도 계속 지원합니다. Claude Code 설정은 `ocx claude config <status|set> ...`를 사용하십시오.

### `ocx codex [codex args...]`

키는 설정과 해당 경로가 다른 보안 주체의 변경으로부터 보호될 때만 전달합니다. 현재 사용자와 권한 있는 OS 주체는 신뢰합니다. 같은 사용자로 실행되는 프로세스는 신뢰 대상입니다. 사용자의 쓰기 권한을 가진 행위자는 사용자의 OpenCodex 키 파일도 이미 읽을 수 있습니다. 검증과 네이티브 시작 사이에 같은 사용자가 설정을 교체하는 시나리오는 이 위협 모델의 범위 밖이며, 런처는 인계 시 설정을 고정하지 않습니다.

일반적인 Windows 설치의 기본 ProgramData 권한은 다른 사용자에게 디렉터리 생성 권한을 줍니다. 따라서 `ProgramData\OpenAI\Codex`가 없어도 자동 자격 증명을 보류합니다. ProgramData 아래의 시스템 Codex 설정 폴더는 존재해야 하고 Administrators/SYSTEM만 쓸 수 있어야 하며, 다른 사용자가 상위 디렉터리를 교체할 수 없어야 합니다. 관리자에게 디렉터리 정책 검토를 요청하세요. opencodex는 직접 ACL을 변경하지 않으며 프로비저닝 명령을 제공하지 않습니다.

대신 사용자가 직접 키를 제공할 수 있습니다. 예를 들어 `OPENCODEX_API_AUTH_TOKEN` 환경 변수를 내보내면 `ocx codex`는 그 값을 그대로 유지합니다. 기존 시스템 설정 파일은 여전히 자동 자격 증명을 보류하며 별도 검토가 필요합니다. 각 보류 사유는 키 값, 키 파일 내용이나 경로 없이 짧고 구체적인 stderr 진단 한 줄로 표시됩니다.

한 단어 프롬프트 앞에는 `--`를 넣어 알 수 없는 Codex 하위 명령 선택을 막으세요.

설정 파일이 없어도 machine 설정 경로에 다른 사용자가 파일을 만들 수 없어야 합니다. Windows ProgramData/OpenAI/Codex 경로의 보호를 증명할 수 없으면 자동 토큰을 보류하며 디렉터리를 만들지 않습니다. macOS는 거부 전용 ACL과 읽기 전용 허용 항목을 수락합니다. 쓰기·추가·삭제·속성·보안·소유자 변경을 허용하는 항목은 앞에 거부 항목이 있어도 거부합니다. 알 수 없는 태그나 검사 오류도 거부합니다.

새 서비스 토큰은 argv가 아래 허용 목록 안에 있고, 비어 있지 않은 HTTP(S)/ALL proxy 및 `CODEX_*`/`OPENAI_*`/`AZURE_OPENAI_*` 환경 재정의가 없으며(정규 `CODEX_HOME`은 허용), 홈·설정·시스템 경로가 소유권 검사를 통과할 때만 읽습니다. 설정에는 검증된 키와 정확한 관리 loopback provider만 있어야 하며 추가 자격 증명 소비자나 설정층이 없어야 합니다. `-c`/`--config`, `-p`/`--profile`, 알 수 없는 플래그, `resume`/`fork` 등 허용 목록 밖의 인자는 토큰을 보류하고 값 없는 진단을 출력합니다. 명시적인 사용자 자격 증명과 원래 인자는 유지합니다.

정규 홈 디렉터리와 `config.toml`은 현재 사용자 소유여야 합니다. POSIX에서는 group/other 쓰기를, Windows에서는 현재 사용자·SYSTEM·Administrators 이외의 DACL 쓰기 권한을 거부하고 소유자 SID를 확인합니다. 상위 경로 교체 권한도 확인합니다. macOS에서는 강제 Codex 설정 preference가 없어야 합니다. 같은 사용자나 관리자의 악성 프로세스로부터 격리하는 기능은 아닙니다.

| Allowlist | Flags |
| --- | --- |
| Switches | `--no-daemon`, `--json`, `--ephemeral`, `--skip-git-repo-check`, `--no-alt-screen`, `--full-auto`, `--dangerously-bypass-approvals-and-sandbox`, `--search` |
| One value | `--model`/`-m`, `--sandbox`/`-s`, `--ask-for-approval`/`-a`, `--image`/`-i` |



자동 자격 증명 전달은 `CODEX_HOME`의 `~`와 공백을 리터럴 경로로 해석하고 검증한 뒤, 동일한 정규 절대 경로를 자식에게 전달합니다. 홈을 읽을 수 없으면 토큰을 읽지 않습니다. 대소문자와 관계없이 `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` 중 비어 있지 않은 값이 있으면 `NO_PROXY`와 무관하게 자동 로딩을 건너뜁니다. 거부된 실행과 사용자가 내보낸 자격 증명은 변경하지 않습니다. 새 토큰을 전달할 때 자식의 `NO_PROXY`와 `no_proxy`에 기존 우회 항목을 보존하면서 `127.0.0.1`과 `::1`을 추가합니다. `features.respect_system_proxy`를 켜거나 `--enable`/`--disable`을 전달하면 자동 로딩을 건너뜁니다.

원래 인자로 Codex를 실행하기 전에 프록시 시작을 시도합니다. 라우팅은 Codex 설정이 소유하며 런처가 재작성하지 않습니다. 네이티브 및 다른 게이트웨이 경로에서는 시작을 생략합니다. 알 수 없는 라우팅은 경고 후 시작을 시도하며, 시작 실패 시에도 경고 후 실행합니다. 도움말·버전 및 `login`, `doctor`, `help` 같은 내부 명령은 시작과 자동 토큰 읽기를 생략합니다.

선택한 provider의 전체 전송 설정이 이 설치의 로컬 리스너 또는 저장된 로컬 클라이언트 연결에 대해 생성한 관리 블록과 일치할 때만, 누락된 `OPENCODEX_API_AUTH_TOKEN`을 이 설치의 `service-api-token`에서 읽습니다. 이름이나 주입 주석만으로는 허용하지 않습니다. 알 수 없거나 원격인 목적지, 기본 profile, 프로젝트 설정, `OPENAI_BASE_URL`, 전달된 `-c`/`--config`, `-p`/`--profile`, `-C`/`--cd`, `--remote`는 자동 읽기를 생략합니다. 사용자가 export한 자격 증명과 인자는 보존하며, 토큰 파일 경로 재정의와 관리 토큰 충돌은 거부합니다.

일치가 확인된(`matched`) autostart wrapper만 backing Codex를 직접 실행합니다. 검사 예외를 포함한 알 수 없는 상태는 검증된 bypass가 필요하며, 관리되는 Windows CMD wrapper는 현재 생성 템플릿 전체와 일치해야 `OCX_SHIM_BYPASS=1`로 실행합니다. 일반 npm 런처는 지원합니다. 검증할 수 없거나 오래된 wrapper는 종료 코드 1로 거부하며 Codex를 시작하지 않습니다. `ocx codex-shim install`로 갱신하세요. 이 실행은 shim을 수리하지 않으며, 내용 검사는 Windows backing 파일 출처나 동시 경로 교체를 보장하지 않습니다.

macOS에서는 도움말과 버전을 포함한 매 실행 시, 선택한 실행 파일의 경로나 정규 경로가 `.app` 번들 내부에 있으면 검증합니다. 이름을 바꾼 번들과 번들 내부를 가리키는 심볼릭 링크도 번들 및 실행 파일의 안전한 소유권, 권한, OpenAI 서명을 요구합니다. 선택한 번들 구성원은 실행 파일, 중간 디렉터리 또는 번들 전체의 심볼릭 링크를 거쳐도 해당 번들의 정규 `Contents/` 내부에 있어야 합니다. 검증 실패 시 Codex를 시작하지 않고 종료 코드 1을 반환합니다. npm 설치를 포함한 일반 번들 외부 실행 파일의 동작은 유지됩니다.

런처 도움말은 `ocx help codex`, Codex 도움말은 `ocx codex --help`입니다. 이후 plain `codex`의 동작은 기존과 같습니다.

### `ocx opencode [opencode args...]`

프록시가 실행 중인지 확인한 뒤, OpenCode의 인라인 런타임 계층(`OPENCODE_CONFIG_CONTENT`)에 생성된 `provider.opencodex` 및 `providers.opencodex` 블록을 넣어 opencode를 실행합니다. 기존 인라인 config는 유지되고, 이번 실행에서는 이 두 키만 교체됩니다. 전역 또는 프로젝트 `opencode.json` 파일은 기존 override가 있는지 경고하기 위해 읽을 수 있지만, 디스크상의 파일은 절대 수정하지 않습니다. 라우팅된 model은 `opencodex/<provider>/<model>`로 나타납니다. 이후 plain `opencode`를 실행하면 이전과 정확히 같은 방식으로 동작합니다.

### `ocx grok <status|exclude|include|set|clear|apply> ...`

Grok Build model fence를 관리하고 적용합니다.

## 클라이언트 설정 내보내기

### `ocx export --client <opencode|pi|omp|hermes|openclaw|kimi|gajae|dsh|mcode|zcode|prime|aside|raycast|omo|cline|kilo|commandcode|droid>`

실행 중인 프록시에 연결할 client config를 출력합니다. 이 명령은 base URL, model list, 그리고 client에 따라 credential reference 또는 `opencodex-loopback` placeholder를 포함한 `opencodex` provider block을 선택한 client의 네이티브 형식으로 직렬화합니다.

프록시는 실행 중이어야 합니다. 이 명령은 실제 포트를 확인하고, `/api/models`를 읽고, 현재 Codex가 볼 수 있는 model만 내보냅니다.

| 플래그 | 동작 |
| --- | --- |
| `--client <opencode\|pi\|omp\|hermes\|openclaw\|kimi\|gajae\|dsh\|mcode\|zcode\|prime\|aside\|raycast\|omo\|cline\|kilo\|commandcode\|droid>` | 필수입니다. 클라이언트 설정 형식을 선택합니다. |
| `--json` | config JSON만 stdout에 출력하므로, redirect가 byte-exact 출력을 캡처합니다. `--out` write note를 포함한 모든 진단 메시지는 stderr로 갑니다. |
| `--out <path>` | config를 `<path>`에 씁니다. 기존 파일이 있으면 덮어쓰지 않습니다. |
| `--force` | `--out`이 기존 파일을 덮어쓰도록 허용합니다. |

```bash
ocx export --client opencode                     # config plus destination, merge warning, and counts
ocx export --client pi --json > pi-models.json   # JSON document for a pipe or a diff
ocx export --client omp --out ./omp-models.yml    # native OMP YAML
ocx export --client opencode --out ~/opencodex-opencode.json
```

`--json`이 없으면 선택한 client의 네이티브 형식으로 생성된 config가 먼저 나오고, 그다음 표준 대상 경로, merge 경고, 해당 client에 env 변수가 있는 경우 env export 줄, 그리고 context limit을 생략한 row 수를 포함한 model count가 이어집니다(이 경우 client는 자체 기본값을 적용합니다).

| 클라이언트 | 표준 대상 경로 | 다운로드 파일명 | 환경 변수 |
| --- | --- | --- | --- |
| `opencode` | `~/.config/opencode/opencode.json` (`XDG_CONFIG_HOME`이 설정되어 있으면 우선합니다) | `opencode.json` | `OPENCODEX_OPENCODE_API_KEY` |
| `pi` | `~/.pi/agent/models.json` (`PI_CODING_AGENT_DIR`가 설정되면 우선. 상대 경로는 거부됩니다) | `pi-models.json` | 없음 - 블록에 리터럴 `opencodex-loopback`이 들어갑니다 |
| `omp` | `~/.omp/agent/models.yml` (기본값. 빈 값이어도 `OMP_PROFILE`이 `PI_PROFILE`보다 우선합니다) | `omp-models.yaml` | 없음 - 리터럴 `opencodex-loopback` |
| `hermes` | `~/.hermes/config.yaml` | `hermes-config.yaml` | `OPENCODEX_HERMES_API_KEY` |
| `openclaw` | `~/.openclaw/openclaw.json` | `openclaw.json5` | `OPENCODEX_OPENCLAW_API_KEY` |
| `kimi` | `~/.kimi-code/config.toml` | `kimi-config.toml` | 없음 - loopback placeholder |
| `gajae` | `~/.gjc/agent/models.yml` | `gajae-models.yaml` | 비밀이 아닌 루프백용 대체 값 |
| `dsh` | `$DSH_HOME/settings.yaml`(기본값 `~/.dsh/settings.yaml`) | `settings.yaml` | 없음 — 비밀이 아닌 loopback bearer placeholder |
| `mcode` | `~/.minimax/config.yaml` (`MINIMAX_DATA_DIR`, 그다음 레거시 `MAVIS_DATA_DIR`가 설정되면 우선. 상대 경로는 거부됩니다) | `mcode-config.yaml` | 없음 — loopback placeholder |
| `zcode` | `~/.zcode/v2/config.json` (`ZCODE_DATA_DIR`가 설정되면 우선. 상대 경로는 거부됩니다) | `config.json` | 없음 — loopback placeholder |
| `prime` | `~/.prime/agent/models.json` (`PRIME_AGENT_CODING_AGENT_DIR`가 설정되면 우선. 상대 경로는 거부됩니다) | `prime-models.json` | 없음 — loopback placeholder |
| `aside` | `~/.aside/u/<account>/models.json`. Aside의 `accounts.json`이 현재 계정으로 지정한 account를 사용합니다. 매니페스트를 읽을 수 없으면 임의의 계정으로 넘어가지 않고 거부합니다 | `aside-models.json` | 없음 — loopback placeholder |
| `raycast` | `~/.config/raycast/ai/providers.yaml` (macOS와 Windows 모두 동일. Raycast는 `XDG_CONFIG_HOME`을 따르지 않습니다) | `raycast-providers.yaml` | 없음 — loopback 전용. `api_keys` 항목은 쓰지 않습니다 |
| `omo` | `~/.omo/agent/models.json` (`OMO_CODING_AGENT_DIR`, `SENPI_CODING_AGENT_DIR`, `PI_CODING_AGENT_DIR` 순서로 설정된 값이 우선. 상대 경로는 거부됩니다) | `omo-models.json` | 없음 — loopback placeholder |
| `kilo` | `~/.config/kilo`에서 먼저 존재하는 `kilo.jsonc`, `kilo.json`, `opencode.jsonc`, `opencode.json` 또는 `config.json` (`XDG_CONFIG_HOME`이 설정되면 해당 디렉터리 사용); 후보가 없으면 `kilo.jsonc` | `kilo.jsonc` | `OPENCODEX_KILO_API_KEY` |
| `commandcode` | `~/.commandcode/providers.json` (Windows 기본 홈 사용 시: `HOME ?? USERPROFILE` 값이 비어 있거나 공백만으로 구성되지 않은 Windows 절대 경로일 때만 사용하고, 그 외에는 `homedir()` 사용. 별도로 전달된 홈은 유지. 해당 홈 아래의 `.commandcode\providers.json`) | `providers.json` | 루프백 전용; `apiKey: false`; 환경 변수 불필요 |
| `droid` | `~/.factory/settings.json` (`%USERPROFILE%\.factory\settings.json` on Windows) | `factory-settings.json` | 루프백 전용, 환경 변수 불필요 |

위 경로는 기본값입니다. 기본 홈의 `~/.zcode/v2/setting.json`에 절대 경로 `dataBaseDir`를 지정하면 저장소는 `<dataBaseDir>/.zcode/v2/provider_config.json`으로 이동합니다. `ZCODE_DATA_DIR`는 `.zcode` 루트 자체를 지정하며 설정값보다 우선하고, `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE`는 제공자 파일 경로에 우선합니다. 잘못되거나 읽을 수 없는 설정, 상대 경로는 새 적용과 갱신을 거부합니다. 기존 소유권과 복구 기록은 보존됩니다. [경로와 복구 규칙의 원문](https://opencodex.me/guides/integrations/#zcode-314-and-later)을 참고하세요.

Raycast 내보내기는 `providers` 시퀀스에 `id: opencodex` 요소 하나만 담은 독립 `providers.yaml` 문서입니다. 내용은 `name: OpenCodex`, proxy의 `/v1` base URL, 그리고 `abilities`가 붙은 라우팅된 모든 모델입니다(`tools`와 `system_message`는 항상 지원, `vision`은 카탈로그의 입력 모달리티를 따름, `reasoning_effort`는 모델에 effort 사다리가 있을 때, `temperature`는 추론 모델에서 꺼짐). Custom Providers는 Raycast Pro 기능이며, Raycast가 이 파일을 감시하므로 저장한 변경은 재시작 없이 적용됩니다. 형식은 [manual.raycast.com/ai/custom-providers](https://manual.raycast.com/ai/custom-providers)에 문서화되어 있습니다. `api_keys` 항목은 쓰지 않으므로 이 내보내기는 loopback 전용이며, loopback이 아닌 bind는 거부됩니다.

opencode는 `{env:OPENCODEX_OPENCODE_API_KEY}`를 보간합니다. opencodex가 생성한 Pi 블록에는 환경 변수가 필요 없으며, 리터럴 placeholder인 `opencodex-loopback`이 들어갑니다. 이 값은 필수입니다. Pi는 모델 목록을 만들 때 `apiKey`를 해석하고, 기존 config에 설정되지 않은 env 참조가 있으면 provider 전체를 숨기기 때문입니다. 루프백에서 proxy는 생성된 placeholder를 검사하지 않습니다.

:::caution[Merge, never replace]
`ocx export`는 실제 client config를 절대 쓰지 않습니다. 대상 경로는 손으로 병합하라고 출력되며, `--out`은 `--force` 없이 기존 파일을 덮어쓰지 않습니다. config를 바꾸어 덮어쓰면 이미 들어 있던 다른 provider, agent, MCP entry가 사라지기 때문입니다.
:::

어떤 key도 직렬화되지 않습니다. 생성되는 config에는 문서화된 env reference 또는 비밀이 아닌 loopback placeholder 중 하나가 들어갑니다. loopback 주소(`127.0.0.1`)만으로 키 없이 접근할 수 있다고 판단하면 안 됩니다. 대상의 인증 정책과 엔드포인트를 확인하세요. 선택한 키를 사용하는 모델·오디오 CLI는 loopback에서도 명시적 키 입력이 필요합니다. 클라이언트의 설정 형식이 지원하고 proxy가 loopback 외부에 바인딩하는 경우에만 참조된 환경변수를 설정하십시오. admission key 발급 방법은 [Remote access](/ko/reference/configuration/server/#remote-access)를 참조하십시오. upstream provider 자체의 key는 별도로 설정하며, [Providers](/guides/providers/)에서 안내합니다.

생성된 gjc 연동은 비밀이 아닌 로컬 접속용 값을 사용하므로 환경변수가 필요하지 않습니다. 루프백 전용이며 원격 접속 인증은 설정하지 않습니다.

같은 payload는 `GET /api/client-config`로 제공되고 dashboard의 API 탭에도 렌더링되므로, CLI, API, GUI가 모두 같은 바이트를 사용합니다.

## 런타임과 설정

### `ocx system <status|settings|startup|diagnostics|sync|codex-app-server|codex-restart|update|codex-cli-update> ...`

헤드리스 런타임 설정, 시작, 동기화, 진단, 업데이트를 관리합니다.

`ocx system codex-restart --yes`는 `ocx sync --restart-codex`와 같은 모듈로 Codex
app-server를 재시작합니다. 모델 선택기는 앱 실행 시점에 만들어지므로, 데스크톱 앱은 현재
모델 카탈로그가 기록되기 전에 실행된 경우나 이 요청으로 `model_catalog_json` 경로가 바뀐 경우 완전히 종료한 뒤 다시 띄웁니다. 그렇지 않으면
앱은 열린 채로 자체 app-server를 다시 띄우고, 보내지 않은 초안과 대기 중인 승인을 유지합니다.
앱이나 카탈로그 상태를 읽을 수 없으면 전체 재시작을 수행합니다. 프록시 자체가 Codex 앱 안에서
실행 중이면 데스크톱 재시작은 넘길 수 없는 handoff를 약속하지 않고, 대신 실행 가능한 안내와
함께 거절합니다.

이 요청으로 `model_catalog_json` 경로가 바뀌면 셸이 카탈로그 파일 작성 후 시작되었어도 데스크톱을 재시작합니다.

```bash
ocx system settings --stream-mode eager-relay
```

`ocx system update`는 OpenCodex 자체를 업데이트합니다. Codex CLI는 다음의 별도 읽기 전용 명령으로 점검합니다.

```bash
ocx system codex-cli-update check --json
```

`check`는 레지스트리를 조회하거나 Codex를 실행하지 않습니다. POSIX에서는 배포 런처가 캡처한 환경 후보와 런타임 리졸버가 선택한 정규 경로가 같으면 `selectionAttested: true`가 될 수 있습니다. 연결된 npm-global 패키지 매니페스트가 소유권을 증명하고, 후보 버전이 보고된 경우 그 버전이 매니페스트 버전과 일치하면 `managed: true`가 될 수 있으며 저장된 후보는 인증되지 않습니다. Windows x64는 증명에 바인딩된 절대 표준 npm `codex.cmd`와 보유 핸들로 바인딩된 Node/npm 도구체인(있으면 프리픽스 로컬, 없다고 확인되면 런처 아키텍처에 고정된 캡처된 PATH 쌍), 검증된 인프리픽스 플랫폼 백킹도 지원하며 reparse를 거부하는 보유 핸들을 사용합니다. 다른 Windows 레이아웃은 계속 연기되거나 관리되지 않습니다. Windows의 `managed` 결과는 관측된 설치 레이아웃만 분류하며, 바인딩된 Node/npm은 업데이터의 읽기 전용 메타데이터 도구체인일 뿐 이후 `codex.cmd` 호출이 어떤 인터프리터를 해석할지를 보증하지 않습니다. 직접 Bun/소스 실행은 런처 증거가 없어 후보를 신뢰하지 않습니다. `plan`은 격리된 임시 npm 설정·캐시·로그로 공식 레지스트리를 조회하고 활성 세션이나 불완전한 프로세스 관측을 거절합니다. 설치하거나 프로세스에 신호를 보내지 않습니다. Windows x64 apply는 검증된 개인 쓰기 권한을 가진 제한된 npm prefix를 요구하고 무관한 패키지·shim을 보존하며, 적용 조건을 충족하지 않는 관측 레이아웃은 `applicable: false`와 `refusal: windows_apply_disabled`를 가진 결정적 읽기 전용 plan을 생성합니다. PATH 전용 선택·OpenCodex 자동 시작 래퍼·global/vendor 폴백은 계속 연기됩니다. [명령과 거절 사유의 전체 설명(영문)](/reference/cli/agents/#read-only-codex-cli-update-plan)을 참고하세요.

Windows에서 `CODEX_CLI_PATH=codex` 같은 단순 명령 이름이나 원격 경로·장치 경로가 후보로 캡처되면 `candidate_path_unavailable`을 보고합니다. 후보는 캡처됐지만 해당 경로가 이 검사 대상에 적합하지 않은 경우입니다.

#### Windows x64 설치의 명시적 관측

```text
ocx system codex-cli-update attest [--json]
ocx system codex-cli-update attest --candidate <absolute-path> --npm-prefix <absolute-path> --npm-cli <absolute-path> --node <absolute-path> [--json]
```

`attest`는 선택되거나 명시한 Windows x64 npm 설치를 읽기 전용으로 관측하는 선택적 명령입니다. 옵션 없이 실행하면 증명된 런처 스냅샷이 식별한 선택 후보(설정된 `CODEX_CLI_PATH` 또는 캡처된 PATH의 첫 `codex`)를 관측하며, opencodex 래퍼는 이름이 바뀐 `codex.opencodex-real.cmd` npm 백업으로 해석합니다. 절대 경로 네 개를 모두 제공하면 자동 식별을 재정의하며, 자동 식별은 경로를 제안할 뿐 핸들 유지 관측이 최종 권위입니다. `--candidate`는 표준 npm `<prefix>/codex.cmd` 또는 `<prefix>/node_modules/@openai/codex/bin/codex.js`여야 합니다. `--npm-cli`는 `node_modules/npm/bin/npm-cli.js`로 끝나야 하고, `--node`에는 `node.exe`를 명시합니다. 앱 번들, 인식된 버전 관리자 경로, npm 백업이 없는 opencodex 소유 shim 및 사용자 지정 래퍼는 거절합니다.

제한된 읽기 동안 네이티브 핸들로 상위 디렉터리와 파일을 유지합니다. 지원하지 않는 플랫폼, 재분석 지점·junction, 충돌하는 쓰기 핸들, 안전하지 않은 경로 및 크기 제한 초과 파일은 거절합니다. 경로를 포함하지 않는 고정 보고서의 `status`는 `observed` 또는 `refused`이며 `installationIdentityObserved`를 제공합니다. `selectionAttested`, `managed`, `applyAllowed`는 항상 `false`입니다. 거절을 보고해도 종료 코드가 0일 수 있으므로 `status`를 확인해야 합니다.

관측한 식별값·해시는 관측 시점의 파일을 설명할 뿐 지속적인 업데이트 허가가 아닙니다. 선택된 런타임, 과거 설치 주체, 실제 npm 설정, 도구 진위를 증명하지 않습니다. 명시한 Node도 관측만 하며 런처가 그 Node를 선택한다는 뜻은 아닙니다. 대상을 실행하거나 레지스트리에 요청하거나 설치·설정 쓰기·프로세스 제어를 하지 않습니다. 기존 Windows `check`의 후보·설정 파일 시스템 I/O 없음 계약은 유지됩니다.

### `ocx config [show|get|set|unset|validate|export|import] ...`

`ocx config [show] [--json] [--source]`는 실행 중인 프록시 없이 로컬 설정을 표시합니다. `show`를 생략해도 두 플래그를 각각 또는 순서와 관계없이 함께 사용할 수 있습니다. `--source`는 진단 출처, 오류, 경고를 포함하며 표시 작업에서만 허용됩니다. `--json`은 명시적 작업 앞에 올 수 있으며 실행할 작업을 바꾸지 않습니다. 중복된 `--json` 또는 `--source` 플래그와 알 수 없는 인수는 거부됩니다.

검증된 OpenCodex configuration을 검사하고 안전하게 수정합니다. `show`와 `get`은 비밀 값을 가립니다. import는 쓰기 전에 검증하며 `--yes`가 필요합니다.

### 연결된 클라이언트의 사용량

`ocx usage`는 등록된 데이터 키로 허브에서 이 클라이언트의 사용량만 읽습니다. 출력에는 허브 출처와 키 범위가 표시됩니다. 기간·모델·공급자 필터와 `--since`/`--until`, `--json`을 그대로 사용할 수 있습니다. 계정별 내역과 다른 클라이언트 기록은 반환하지 않습니다. 허브가 응답하지 않거나 이 기능을 지원하지 않으면 오류를 알립니다. 로컬 기록으로 대신 표시하지 않습니다. 구형 허브라면 허브를 업데이트하세요.

## Explain a listed request

`ocx logs`의 일반 출력에 `id=<request-id>`가 표시됩니다. 이 값을 `ocx logs explain <request-id>`에 넣어 라우팅 결정을 확인할 수 있습니다. ID가 없거나 ID에 제어 문자가 있으면 조회 키를 바꾸어 표시하지 않고 이 항목을 생략합니다. JSON과 JSONL은 원래 ID와 형식을 유지합니다.

## Routing profile lookup status

`ocx route policy show <id>`는 프로필이 없으면 종료 코드 4를 반환합니다. 명령 인수가 빠졌거나 잘못되면 2를 반환하므로 스크립트에서 두 경우를 구별할 수 있습니다.

## Upstream error details

업스트림 오류 응답에 여러 메시지 필드가 있으면 기존 우선순위에서 처음 발견한 비어 있지 않은 문자열을 사용합니다. 빈 값이나 잘못된 형식의 필드 때문에 유효한 후순위 진단이 사라지지 않습니다.

### Forced Claude Code subagent model

The Subagents page offers **Force all subagents onto one model**, off by default. Select an exposed roster-style id, such as `combo/tev-auto`, then enable the switch. The roster is offered first; unavailable saved roster entries cannot be force targets.

`ocx agent subagents force combo/tev-auto` sets `claudeCode.subagentModelForce`; `ocx agent subagents force -` clears it. `ocx agent status` reports the setting. `GET /api/subagent-models` returns `force`, `forceAvailable`, and `forceStatus`; `PUT` accepts `{ "force": "combo/tev-auto" }` or `{ "force": null }` without changing the roster. Omitting `force` leaves it unchanged. Invalid or unexposed targets are rejected on write; stale targets are reported and skipped at launch.

This takes effect on the **next routed `ocx claude` launch**, injecting `CLAUDE_CODE_SUBAGENT_MODEL` as an explicit proxy alias (with `[1m]` only for an authoritative million-token window; native Claude targets use a reversible native alias) and `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1`. Each nonempty shell-exported variable independently wins. Native launches inject neither variable; plain `claude` is not affected. No plugin files or `settings.json` are modified by this setting.

Claude Code **2.1.257 or newer** is required for FORCE. Plugin and built-in agents (including Explore/Plan) and per-call model arguments are overridden. Forks and subagent skills with `model: inherit` keep the main conversation model. The main loop and Haiku/small-fast sidecars are unaffected. Existing roster files remain available.

The dashboard warns about old or unknown CLI versions, unavailable targets, and either variable already present in `settings.json` → `env` (which overrides launch env). Detection is read-only and server-local: it cannot inspect another launch shell, another machine, or project-local settings. An unknown result is not proof of force support.

## Hermes / Command Code: model names

Hermes and Command Code support `--model-names alias|routed` (API: `modelNames`).
The default is `routed`, independent of `preferModelAliasIds`. A connection
stores its mode; later Apply without the option preserves it. Alias mode uses
only provider-qualified aliases that the router proves equivalent; missing,
unsafe or colliding aliases fall back to routed keys. Combos keep their keys.
Removed/renamed aliases migrate on the next successful managed refresh, with
foreign-edit refusal. Named Hermes profiles need explicit Apply.

`ocx export --client hermes --model-names alias --json` previews a current
already loaded catalog without writing client files or managed state; a cold or
stale catalog returns unavailable. Explicit `--out` writes an export artifact.
See the [English integration guide](/guides/integrations/#opt-in-alias-model-names)
for the canonical workflow.
