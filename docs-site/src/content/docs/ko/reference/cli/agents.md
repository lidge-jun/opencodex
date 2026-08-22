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
```

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

### `ocx observe <logs|usage|storage|memory|debug|claude-inbound|injection> ...`

프록시 요청, 사용량, 저장소, 메모리, 디버그 데이터를 확인합니다. 직접 별칭은 다음과 같습니다:

| 별칭 | 대응 리소스 |
| --- | --- |
| `ocx logs [filters] [--follow] [--json|--jsonl]` | `ocx observe logs` |
| `ocx usage [--range <today|1d|7d|30d|all>] [--surface <all|codex|claude|grok>] [--provider <name>] [--model <id>] [--json]` | `ocx observe usage` |
| `ocx storage [--json]` | `ocx observe storage` |
| `ocx memory [--json]` | `ocx observe memory` |

```bash
ocx observe usage --range 30d --json
```

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

OpenCodex admission API key를 관리하고 외부 endpoint와 model을 검사합니다. `ocx api-key
<list|create|remove> ...`는 `ocx access key`의 별칭입니다.

```bash
ocx access key create deployment
```

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

### `ocx opencode [opencode args...]`

프록시가 실행 중인지 확인한 뒤, OpenCode의 인라인 런타임 계층(`OPENCODE_CONFIG_CONTENT`)에 생성된 `provider.opencodex` 블록을 넣어 opencode를 실행합니다. 기존 인라인 config는 유지되고, 이번 실행에서는 `provider.opencodex`만 교체됩니다. 전역 또는 프로젝트 `opencode.json` 파일은 기존 override가 있는지 경고하기 위해 읽을 수 있지만, 디스크상의 파일은 절대 수정하지 않습니다. 라우팅된 model은 `opencodex/<provider>/<model>`로 나타납니다. 이후 plain `opencode`를 실행하면 이전과 정확히 같은 방식으로 동작합니다.

### `ocx grok <status|exclude|include|set|clear|apply> ...`

Grok Build model fence를 관리하고 적용합니다.

## 클라이언트 설정 내보내기

### `ocx export --client <opencode|pi|omp|hermes|openclaw|kimi|gajae|dsh|mcode|zcode|prime>`

실행 중인 프록시에 연결할 client config를 출력합니다. 이 명령은 base URL, model list, 그리고 client에 따라 credential reference 또는 `opencodex-loopback` placeholder를 포함한 `opencodex` provider block을 선택한 client의 네이티브 형식으로 직렬화합니다.

프록시는 실행 중이어야 합니다. 이 명령은 실제 포트를 확인하고, `/api/models`를 읽고, 현재 Codex가 볼 수 있는 model만 내보냅니다.

| 플래그 | 동작 |
| --- | --- |
| `--client <opencode\|pi\|omp\|hermes\|openclaw\|kimi\|gajae\|dsh\|mcode\|zcode\|prime>` | 필수입니다. 클라이언트 설정 형식을 선택합니다. |
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
| `gajae` | `~/.gjc/agent/models.yml` | `gajae-models.yaml` | `OPENCODEX_GAJAE_API_KEY` |
| `dsh` | `$DSH_HOME/settings.yaml`(기본값 `~/.dsh/settings.yaml`) | `settings.yaml` | 없음 — 비밀이 아닌 loopback bearer placeholder |
| `mcode` | `~/.minimax/config.yaml` (`MINIMAX_DATA_DIR`, 그다음 레거시 `MAVIS_DATA_DIR`가 설정되면 우선. 상대 경로는 거부됩니다) | `mcode-config.yaml` | 없음 — loopback placeholder |
| `zcode` | `~/.zcode/v2/config.json` (`ZCODE_DATA_DIR`가 설정되면 우선. 상대 경로는 거부됩니다) | `config.json` | 없음 — loopback placeholder |
| `prime` | `~/.prime/agent/models.json` (`PRIME_AGENT_CODING_AGENT_DIR`가 설정되면 우선. 상대 경로는 거부됩니다) | `prime-models.json` | 없음 — loopback placeholder |

opencode는 `{env:OPENCODEX_OPENCODE_API_KEY}`를 보간합니다. opencodex가 생성한 Pi 블록에는 환경 변수가 필요 없으며, 리터럴 placeholder인 `opencodex-loopback`이 들어갑니다. 이 값은 필수입니다. Pi는 모델 목록을 만들 때 `apiKey`를 해석하고, 기존 config에 설정되지 않은 env 참조가 있으면 provider 전체를 숨기기 때문입니다. 루프백에서 proxy는 생성된 placeholder를 검사하지 않습니다.

:::caution[Merge, never replace]
`ocx export`는 실제 client config를 절대 쓰지 않습니다. 대상 경로는 손으로 병합하라고 출력되며, `--out`은 `--force` 없이 기존 파일을 덮어쓰지 않습니다. config를 바꾸어 덮어쓰면 이미 들어 있던 다른 provider, agent, MCP entry가 사라지기 때문입니다.
:::

어떤 key도 직렬화되지 않습니다. 생성되는 config에는 문서화된 env reference 또는 비밀이 아닌 loopback placeholder 중 하나가 들어갑니다. loopback proxy(`127.0.0.1`, 기본값)는 admission key가 전혀 필요하지 않습니다. proxy가 loopback을 넘어 바인딩할 때는 해당하는 `OPENCODEX_OPENCODE_API_KEY`, `OPENCODEX_HERMES_API_KEY`, `OPENCODEX_OPENCLAW_API_KEY`를 설정하십시오. `OPENCODEX_GAJAE_API_KEY`는 Gajae provider 인증 값을 환경에서 전달하지만 remote admission header를 보낼 수는 없으므로, 생성되는 Gajae 통합은 loopback 전용으로 남습니다. admission key가 어떻게 발급되는지는 [Remote access](/reference/configuration/#remote-access)를 보십시오. upstream provider 자체의 key는 완전히 별개의 것으로, 각 [Providers](/guides/providers/)에 맞게 설정합니다.

같은 payload는 `GET /api/client-config`로 제공되고 dashboard의 API 탭에도 렌더링되므로, CLI, API, GUI가 모두 같은 바이트를 사용합니다.

## 런타임과 설정

### `ocx system <status|settings|startup|diagnostics|sync|update> ...`

헤드리스 런타임 설정, 시작, 동기화, 진단, 업데이트를 관리합니다.

```bash
ocx system settings --stream-mode eager-relay
```

### `ocx config <show|get|set|unset|validate|export|import> ...`

검증된 OpenCodex configuration을 검사하고 안전하게 수정합니다. `show`와 `get`은 비밀 값을 가립니다. import는 쓰기 전에 검증하며 `--yes`가 필요합니다.
