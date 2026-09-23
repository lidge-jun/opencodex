---
title: 연동
description: 대시보드에서 OpenCode, Pi, OMP, Hermes, OpenClaw, Kimi Code, gjc, DeepSeek Harness, MiniMax Code, ZCode, Prime Agent, Aside, Raycast, omo, Cline CLI를 opencodex에 연결합니다. 클라이언트마다 스위치가 하나씩 있으며 기록 전마다 백업합니다.
---

**Integrations** 탭은 클라이언트의 설정 파일에 opencodex 프로바이더 블록을 쓰고 다시 제거합니다. 다음 15개 클라이언트는 각각 스위치로 관리합니다.

| 클라이언트 | 설정 파일 | 형식 | 변경 적용 시점 | 자격 증명 |
|---|---|---|---|---|
| OpenCode | `~/.config/opencode/opencode.json` | JSON | 다음 직접 실행 시 | `OPENCODEX_OPENCODE_API_KEY` |
| Pi | `~/.pi/agent/models.json` | JSON | 새 세션에서 | 루프백 자리표시자 |
| OMP | `~/.omp/agent/models.yml` | YAML | OMP 재시작 후 | `opencodex-loopback` 자리표시자 |
| Hermes | `~/.hermes/config.yaml` | YAML | 새 세션에서 | `OPENCODEX_HERMES_API_KEY` |
| OpenClaw | `~/.openclaw/openclaw.json` | JSON5 | 실행 중인 게이트웨이에 즉시 | `OPENCODEX_OPENCLAW_API_KEY` |
| Kimi Code | `~/.kimi-code/config.toml` | TOML | 재시작 또는 `/reload` 시 | 루프백 자리표시자 |
| gjc | `~/.gjc/agent/models.yml` | YAML | 새 세션 또는 `/model` 열 때 | 비밀 정보가 아닌 루프백 자리표시자 |
| DeepSeek Harness (DSH) | `$DSH_HOME/settings.yaml` (기본값 `~/.dsh/settings.yaml`) | YAML | 즉시 다시 읽음 | 비밀 정보가 아닌 루프백 bearer 자리표시자 |
| MiniMax Code | `~/.minimax/config.yaml` | YAML | 새 세션 또는 모델 선택기 열 때 | 루프백 자리표시자 |
| Prime Agent | `~/.prime/agent/models.json` | JSON | 새 세션에서 | 루프백 자리표시자 |
| ZCode | `~/.zcode/v2/config.json` | JSON | 재시작 시 | 루프백 자리표시자 |
| Aside | `~/.aside/u/<account>/models.json` | JSON | Aside를 완전히 종료하고 다시 열 때 | 루프백 자리표시자 |
| Raycast | `~/.config/raycast/ai/providers.yaml` | YAML | 저장 즉시 — Raycast가 파일을 감시함 | 없음 — 루프백 전용 |
| omo | `~/.omo/agent/models.json` | JSON | 새 세션에서 | 루프백 자리표시자 |
| Cline CLI | `~/.cline/data/settings/providers.json` 및 같은 위치의 `models.json` | JSON 파일 쌍 | Cline을 중지하고 다시 시작한 뒤 | 루프백 자리표시자 |

생성된 카탈로그에는 각 프로바이더 선택에서 활성화된 모델만 들어갑니다. Pi와 Aside를 포함한 다운로드와 관리형 연동 모두에 적용됩니다. 관리 모델 목록에는 전체 모델이 계속 표시되어 추가 모델을 활성화할 수 있습니다.

Gajae 기본 제공 프리셋에서는 라우팅 선택을 `~/.gjc/agent/config.yml`에 유지하세요.

```yaml
modelProfile:
  proxyProvider: opencodex
  proxyMode: always
```

일반 `gjc` 시작 시 적용할 `modelProfile.default`는 원하는 값으로 유지하세요. 관리형 연동은 `models.yml`의 `providers.opencodex`만 소유합니다. 이 프로바이더를 새로 고치거나 비활성화해도 프리셋 선택은 다시 쓰지 않습니다. 내보낼 모델 선택을 바꾼 뒤 연동을 새로 고치세요.

관리형 OpenCode 연동은 `provider.opencodex`(opencode V1)와 `providers.opencodex`(opencode V2) 두 조각을 소유합니다. 모델별 추론 강도 변형은 V2 블록에만 있으므로 둘 다 기록하고 동기화합니다. 두 블록은 같은 프로바이더와 모델 ID를 가리키고 opencode V2는 이를 프로바이더 항목 하나로 병합합니다. Apply, Refresh, Disable, Restore는 두 조각 모두에 작용하며 다른 프로바이더, 에이전트, 단축키, MCP 항목은 유지됩니다.

관리형 DSH 지원의 최저 호환 버전은 **DSH 0.1.0-rc.6**입니다. opencodex는 `llm-pi-ai.providers.opencodex`만 소유합니다. Apply와 Refresh는 해당 조각을 교체하고, Disable은 그 조각만 제거하며, Restore는 기록된 스냅샷을 되돌립니다. DSH는 프로바이더 변경을 즉시 다시 읽습니다. 이 작업은 사용자의 기본 모델이나 네이티브 `deepseek-official` 프로바이더를 바꾸지 않습니다. 관리형 DSH 연동은 현재 루프백 전용이며 실제 자격 증명을 기록하지 않습니다.

MiniMax Code는 `MINIMAX_DATA_DIR`, 다음으로 `MAVIS_DATA_DIR`를 확인한 뒤 기본값 `~/.minimax`를 사용합니다. 관리형 블록은 `custom_provider.opencodex`만 소유합니다. `defaultModel`, 선택된 MiniMax 자격 증명 출처, MiniMax 로그인은 바꾸지 않습니다. 연결 후 MCode에서 `custom_provider:opencodex/<provider/model>` 항목을 선택하세요. 연동을 새로 고치면 모델별로 신뢰할 수 있는 컨텍스트 창과 추론 강도 선택지도 갱신합니다. 알 수 없는 기능은 생략하고 MCode 세션이 소유한 현재 강도는 유지합니다.

Prime Agent는 `PRIME_AGENT_CODING_AGENT_DIR`를 먼저 확인하고 없으면 `~/.prime/agent`를 사용합니다. 프록시와 에이전트가 서로 다른 파일을 가리키지 않도록 상대 경로는 거부합니다. 관리형 블록은 `providers.opencodex`만 소유하므로 다른 프로바이더와 사용자가 설정한 `modelOverrides`는 유지됩니다. Prime Agent는 세션 시작 시 `models.json`을 읽으므로 연결 후 새 세션을 시작하세요.

Aside는 로컬 프로필을 포함해 등록된 프로필마다 별도 모델 카탈로그를 유지합니다. opencodex는 로컬 프로필까지 모두 나열하고, 함께 동기화하거나 프로필별로 제어할 수 있습니다. 연동을 전환해도 Aside의 활성 계정은 바뀌지 않습니다. 이전에 Aside를 연결했다면 모든 프로필이 기본으로 활성화되며 개별 제외 설정은 이후 동기화에서도 유지됩니다.

Aside만의 주의 사항이 있습니다. 실행 중인 앱이 `models.json`을 직접 다시 쓰므로 적용 후에는 Claude Desktop을 재시작할 때처럼 Aside를 완전히 종료하고 다시 여세요. Aside 블록은 루프백 전용이며 실제 자격 증명을 담지 않습니다.

관리형 Raycast 연동은 **macOS와 Windows**를 지원합니다. Custom Providers는 **Raycast Pro** 기능입니다. 무료 플랜에서도 파일은 쓰지만 Raycast가 읽지 않으므로 `ocx integration client status --client raycast`와 Integrations 페이지에 경고가 표시됩니다. macOS나 Windows에서 Raycast → Settings → AI → **Reveal Providers Config**를 한 번 열어 `ai` 폴더를 만드세요. 지원 플랫폼에서 opencodex는 이 폴더로 설치 여부를 판단하며 폴더가 생기기 전에는 미설치로 보고합니다. 폴더가 있어도 Linux는 지원하지 않습니다.

상태 필드 `aiDirPresent`는 Raycast 앱 설치 여부나 플랫폼 지원 여부와 관계없이 `~/.config/raycast/ai`의 존재만 알려줍니다. Raycast를 설치했거나 사용할 수 있다는 증거는 아닙니다. CLI는 `plan`을 별도 줄에 출력하고 `aiDirPresent`가 false이면 macOS/Windows 설정 안내를 추가합니다. `--json`은 중첩된 `raycast` 블록을 포함한 원시 상태를 유지합니다. Raycast는 macOS와 Windows 모두에서 `~/.config/raycast/ai/providers.yaml`을 읽고 `XDG_CONFIG_HOME`은 따르지 않으므로 이 경로를 옮길 수 없습니다.

관리형 블록은 파일의 `providers` 배열에 있는 `id: opencodex` 항목 하나입니다. `name: OpenCodex`, `base_url: http://<host>:<port>/v1`, 그리고 각각 `abilities`를 가진 모든 라우팅 모델을 포함합니다. 내보내기는 클라이언트 규약에 따라 `tools`와 `system_message`를 `true`로 설정합니다. `vision`은 카탈로그의 입력 모달리티를 따르고, 모델에 추론 강도 단계가 있으면 `reasoning_effort`를 설정하며, 추론 모델에서는 `temperature`를 끕니다. 다른 프로바이더는 유지되고 Disable은 opencodex 항목만 제거합니다. 파일이 저장되면 Raycast가 즉시 변경을 읽어 재시작이 필요하지 않습니다. 모델은 Raycast의 모델 선택기에서 **OpenCodex** 그룹에 표시됩니다. Raycast는 선택적 `api_keys`를 지원하지만 opencodex는 의도적으로 생략하고 루프백 밖이나 수용 인증이 필요한 목적지는 거부합니다. 이 연동은 opencodex가 요구하는 수용 헤더를 제공할 수 없습니다.

macOS 비공개 환경설정은 Pro 여부를 알려주는 참고 정보일 뿐입니다. Windows는 이를 읽지 않고 플랜을 알 수 없음으로 보고합니다. 플랜 감지 결과로 쓰기를 허용하거나 막지 않습니다. 내보내기 메타데이터에는 신뢰할 수 있는 도구 지원 플래그가 없으므로 `tools: true`가 모든 라우팅 모델의 도구 지원을 입증하지는 않습니다. 비전과 강도 플래그는 카탈로그 메타데이터를 따르고, 강도 단계가 있는 모델의 temperature를 끄는 것은 보수적인 내보내기 동작입니다. 프로바이더 값은 유지되지만 YAML 형식과 주석의 보존은 보장하지 않습니다. 형식은 [Raycast 사용자 설명서](https://manual.raycast.com/ai/custom-providers)에 문서화되어 있습니다.

Raycast CLI 내보내기와 대시보드 다운로드는 설정된 비인증 루프백 리스너를 포함해 실행 중인 서버의 목적지와 수용 정책을 사용합니다. `ocx ensure`는 저장된 설정 스냅샷에서 Raycast를 새로 고치지 않습니다. 스냅샷은 실행 중인 서버와 다를 수 있기 때문입니다. 서버 시작과 명시적 동기화가 카탈로그 갱신 경로입니다.

Cursor에는 탭이 있지만 이 스위치들에는 속하지 않습니다. 일반 Cursor는 자체 백엔드에서 사용자 지정 엔드포인트를 호출하므로 공개 터널이 없으면 루프백 프록시에 닿지 않습니다. 별도의 Cursor Private Inference 빌드는 Cursor 안에서 설정합니다. **Cursor** 탭은 읽기 전용이며 설치된 빌드를 감지하고 Cursor에 붙여넣을 Base URL과 API Key, Cursor가 프록시로 보낸 마지막 요청을 보여줍니다. 자세한 내용은 [Cursor Private Inference](/ko/guides/cursor-private-inference/)를 참고하세요.

경로는 클라이언트가 제공하는 환경 오버라이드를 따릅니다. OMP에서는 `OMP_PROFILE`이 명시적으로 비어 있어도 존재하기만 하면 `PI_PROFILE`보다 우선합니다. 이름이 있는 프로필은 `PI_CONFIG_DIR`을 사용자 홈 기준 디렉터리 이름으로 사용하고 `PI_CODING_AGENT_DIR`은 무시합니다. 이름이 있는 프로필이 없으면 `PI_CODING_AGENT_DIR`이 우선합니다. OMP는 프로바이더 수준 헤더를 지원하지만 첫 연동은 의도적으로 루프백 전용입니다. 원격 `x-opencodex-api-key` 연결은 추후 작업입니다. 옮겨진 `HERMES_HOME`, `KIMI_CODE_HOME`, `XDG_CONFIG_HOME` 경로도 추측하지 않고 따릅니다. 표에는 클라이언트별 기본값을 표시했습니다.

네이티브 OpenAI 모델에서 생성된 OMP 블록은 모델 수준 Responses API를 선택해 이미지 입력과 추론 강도 제어를 유지합니다. 라우팅 모델은 기존 어댑터와 호환되도록 프로바이더의 Chat Completions 방식을 유지합니다.

OpenClaw에는 역할이 서로 다른 여러 설정이 있습니다. `OPENCLAW_CONFIG_PATH`는 파일을 선택합니다. `OPENCLAW_STATE_DIR`, `OPENCLAW_PROFILE`, `OPENCLAW_HOME`은 상태 디렉터리를 선택하며 탐지도 이 위치를 봅니다. 따라서 프로필이나 이동한 홈은 설치된 것으로 인식하고 설정 파일 경로 오버라이드는 파일만 옮깁니다. 이전 `.clawdbot` 구조도 찾습니다. 최신 디렉터리가 있으면 우선하고, 없을 때만 이전 디렉터리를 사용합니다.

이 경로들은 **절대 경로**이거나 `~`로 시작해야 합니다. 상대 경로는 각 프로세스가 시작한 디렉터리에 따라 달라지므로 해석하지 않고 거부합니다. 백업에도 경로를 저장하므로 다음 날에도 같은 파일을 가리켜야 합니다.

opencodex는 자체 환경에서 이 값을 읽습니다. 게이트웨이가 프로필이나 옮겨진 홈에서 실행된다면 opencodex도 같은 변수를 설정해 시작하세요. 그렇지 않으면 다른 설치를 올바르게 따라가게 됩니다.

## 스위치가 아닌 다른 다섯 서피스

**API Keys**는 클라이언트가 아니라 opencodex 자체 자격 증명을 관리합니다. **Codex CLI**는 프록시 서비스가 직접 연결합니다. opencodex를 시작하면 적용되고 멈추면 네이티브 라우팅이 복원되므로 파일별 스위치가 없습니다. **Claude**는 자체 활성화 플래그와 Desktop의 Save/Apply 흐름을 유지하고, **Grok Build**는 모델을 선택한 뒤 적용하는 경계를 유지합니다. 모두 이 기능보다 먼저 있던 동작이며 바뀌지 않았습니다. **Cursor**는 아무 파일도 쓰지 않습니다. 탭에서 탐지 결과, 게이트웨이 값, 마지막 요청을 보여주고 나머지는 Cursor Private Inference 안에서 처리합니다.

## 롤백

쓰기 성공 전마다 파일 스냅샷을 먼저 남기므로 이전 상태를 복구할 수 있습니다.

- **Undo**는 파일이 아직 opencodex가 기록한 내용과 같을 때 최신 작업에 표시됩니다.
- **Restore this point…**는 오래된 작업이나 작업 이후 파일이 바뀌었을 때 표시됩니다. 이후 변경을 넘어서 복원하려면 최신 편집을 교체하기 전에 다시 확인합니다. 그 편집도 백업하므로 복원 작업 자체를 되돌릴 수 있습니다.
- 클라이언트마다 백업 열 개를 보관합니다. 이를 넘으면 가장 오래된 스냅샷 파일을 제거하고 해당 기록 행에 **Backup expired**를 표시합니다.

Disable은 opencodex가 소유한다고 기록한 항목만 제거합니다. 이후 파일이 바뀌었다면 opencodex 항목이 온전한지와 파일 형식에 따라 동작이 달라집니다. 엄격한 JSON 설정(OpenCode, Pi)에서는 블록 **옆에** MCP 서버나 자체 프로바이더를 추가하면 **Update needed**가 표시됩니다. 새로 고칠 때 사용자 항목을 유지하며 병합하지만 형식이 정규화될 수 있습니다. 예외는 JSON이 정확히 다시 쓸 수 없는 값입니다. `1e999` 같은 유한하지 않은 수, 다시 쓰면 반올림되는 수(아주 큰 정수나 0으로 사라질 만큼 작은 수), `-0`, 같은 객체에 중복된 키, 1000단계보다 깊은 중첩이 있으면 내용을 조용히 바꾸거나 버리지 않도록 스위치를 잠급니다. **OMP, DSH and Hermes**도 주변 편집의 영향을 받지 않습니다. 이들의 기록기는 소유한 프로바이더 범위만 바이트 단위로 수정해 나머지 파일을 다시 쓰지 않기 때문입니다. 주석을 담을 수 있는 나머지 형식(OpenClaw, Kimi Code, gjc, MiniMax Code, Raycast: 문서 전체를 기록하는 JSON5와 TOML 또는 원본 보존 기능이 없는 일반 YAML)이나 opencodex 항목 자체가 수정된 경우에는 어떤 편집이 사용자 것인지 추측하지 않고 스위치를 잠그고 Disable을 거부합니다.

잠겨도 해결 방법이 있습니다. 충돌한 클라이언트는 개요 카드와 클라이언트 페이지의 스위치 옆에 **Replace**를 표시합니다. opencodex 설정을 담은 부분을 새 블록으로 교체하기 전에 확인을 요청합니다. 대화 상자에 파일 이름, 잃게 될 내용, 되돌릴 수 있게 해 주는 스냅샷이 나옵니다. 스위치는 어떤 편집을 유지할지 판단할 수 없으므로 잠긴 채로 둡니다. 그 결정은 사용자가 해야 합니다. 그 밖의 거부 조건은 완화하지 않습니다. 파싱할 수 없거나 구조를 판단할 수 없는 파일은 여전히 거부합니다.

## 변경 미리 보기와 확인

Apply, Replace, Disable, Restore는 미리 보기로 시작합니다. 대화 상자는 제한된 변경 경로와 각 값의 추가·갱신·삭제 여부를 포함해 어떤 관리 설정이 바뀔지 정확히 보여줍니다. 확인하기 전에 계획을 검토하세요.

계획에 변경이 없다면 관리 대상 클라이언트 문서가 이미 요청한 상태라는 뜻입니다. Aside 프로필을 선택했다면 관리 문서가 바뀌지 않아도 확인 시 그 프로필의 동기화 기본 설정을 저장할 수 있습니다.

검토 후 파일이 바뀌면 오래된 계획으로 판단해 쓰기를 거부합니다. 대화 상자가 갱신된 계획을 보여주고 다시 확인을 요청하며, 자동으로 쓰기를 재시도하지 않습니다. 미리 보기를 일시적으로 사용할 수 없다면 페이지를 일반적으로 새로고침하고 작업을 다시 시작하세요.

Aside는 선택한 프로필 하나에 같은 미리 보기와 확인 흐름을 사용합니다. **Sync all profiles**는 별도 일괄 작업이며 하나의 통합 미리 보기에 묶이지 않습니다.

## 실제로 예상해야 할 동작

**형식은 대체로 보존되지 않습니다.** 적용 과정에서 설정을 파싱하고 다시 기록하므로 JSON, JSON5, TOML의 형식이 달라질 수 있고 JSON5나 TOML의 주석은 사라집니다. OMP, DSH, Hermes는 예외입니다. 이들의 YAML 기록기는 각각 `providers.opencodex`와 `llm-pi-ai.providers.opencodex`만 수정하며 다른 프로바이더의 주석과 형식을 바이트 단위로 보존합니다. 정확한 원본 범위를 안전하게 찾을 수 없으면 작업을 거부합니다. 다른 클라이언트에서 이전 파일 바이트가 필요하면 Restore를 사용하세요. 스냅샷은 원본 그대로의 사본입니다.

**값을 충실히 다시 쓸 수 없다면 스위치가 거부합니다.** 왕복 변환은 이 형식에서 실제로 쓰는 값 종류를 지원합니다. 예를 들어 사용 가능한 파서가 정확히 다시 읽을 수 없는 `inf` 또는 `nan`을 사용한 TOML 파일은 변경된 값을 성공으로 간주해 기록하지 않고 적용을 멈추며 이유를 알립니다. 파일 이름이 표시되고 디스크는 바뀌지 않습니다. 파일을 직접 편집하는 것은 계속 가능하며 자동 재작성만 거부합니다.

TOML 날짜와 시간도 관리형 재작성을 거부합니다. 병합 과정에서 유형이 있는 값이 따옴표로 묶인 문자열이 되기 때문입니다. 배열과 인라인 표 안의 값도 포함됩니다. 따옴표가 있는 날짜 문자열은 계속 지원합니다. 따옴표가 없는 날짜는 설정을 직접 편집해 보존해야 합니다.

**Pi, Kimi Code, gjc, MiniMax Code, Prime Agent, Aside, Raycast, omo와 관리형 DSH 연동은 루프백 바인딩에서만 작동합니다.** 처음 네 클라이언트에는 루프백 밖의 바인딩에 필요한 `x-opencodex-api-key` 헤더를 설정할 필드가 없습니다. DSH에는 일반 헤더 맵이 있지만 rc.6은 전용 수용 헤더를 지원하는 연동 계약으로 문서화하지 않아 관리형 기록기가 추측하지 않고 안전하게 실패합니다. Prime Agent 프로바이더 블록은 헤더를 받지만 첫 연동에서 원격 자격 증명 연결은 미뤘습니다. SSH 터널이나 헤더를 추가하는 로컬 포워더로 루프백 접근을 제공하세요.

**생성된 OMP 연동도 의도적으로 루프백 전용입니다.** OMP는 프로바이더 수준 헤더를 지원하지만 첫 연동은 원격 `x-opencodex-api-key` 자격 증명 연결을 내보내지 않습니다. 수동 원격 OMP 설정은 현재 관리형 연동 범위 밖입니다.

**Kimi Code는 환경 변수 참조를 담을 수 없어** 설정에 키 대신 `opencodex-loopback` 자리표시자를 넣습니다. 어느 클라이언트 설정에도 실제 자격 증명을 기록하지 않습니다.

**`ocx opencode`에서는 런처의 프로바이더 블록이 우선합니다.** 런처는 `OPENCODE_CONFIG_CONTENT`를 통해 `provider.opencodex`와 `providers.opencodex`를 주입합니다. 디스크의 같은 항목보다 우선하지만 opencode 설정의 나머지는 평소처럼 적용됩니다. 여기의 스위치는 `opencode`를 직접 실행할 때 중요합니다.

## 터미널에서 사용하기

같은 작업을 화면 없이 실행할 수 있습니다.

```bash
ocx integration client status
ocx integration client enable --client hermes
ocx integration client disable --client hermes
ocx integration client history --client hermes
ocx integration client restore --op <opId> [--confirm-drift]
```

`--overwrite-conflict`는 **Replace**의 터미널 명령입니다.

```bash
ocx integration client enable --client zcode --overwrite-conflict
```

`--confirm-drift`와 마찬가지로 자동 적용되지 않습니다. 옵션이 없으면 충돌을 계속 거부합니다. `enable`에만 적용됩니다. 충돌한 상태에서 강제로 *disable*하면 opencodex가 기록하지 않은 블록을 지울 수 있으므로 그 조합은 거부합니다.

MiniMax Code는 프로바이더를 한 번 연결하고 검증을 거치는 래퍼로 실행하세요.

```bash
ocx integration client enable --client mcode
ocx mcode
```

연결 후 `ocx sync`와 `POST /api/sync`는 소유한 MCode, Pi, Aside, Raycast, omo 카탈로그를 현재 모델 선택, 컨텍스트 창, 추론 강도 단계로 갱신합니다. 프록시 시작 시 소유한 Raycast 카탈로그도 갱신합니다. 모델 표시 여부, 프로바이더 선택, 프리셋이 바뀌어도 연결된 Pi, Aside, Raycast, omo 카탈로그를 갱신합니다. 누락되거나 외부에서 수정되었거나 안전하지 않은 블록, 그리고 이전에 소유했지만 사용자가 직접 삭제한 블록은 그대로 둡니다. 활성화된 Aside 프로필은 일반적인 소유 블록만 갱신하는 규칙의 예외입니다. 계정 디렉터리가 있고 소유 블록이 생긴 적이 없다면 해당 슬롯이 비어 있을 때 동기화로 첫 블록을 만들 수 있습니다. 이전 Aside 연결이 있으면 이 동작이 기본적으로 등록된 모든 프로필에 적용됩니다. 동기화는 없는 계정 디렉터리를 만들거나 수동 블록을 교체하지 않습니다. 거부되거나 겹친 갱신은 클라이언트마다 따로 보고합니다. 갱신 파일을 읽으려면 새 Pi 세션을 시작하거나 Aside를 완전히 종료하고 다시 여세요. Aside 갱신에는 [호환되는 실행 중 프록시](#aside-프로필-제어)가 필요합니다.

Models에 **“Model selection saved”**와 클라이언트 갱신 경고가 함께 표시되면 선택 자체는 저장되었지만 클라이언트 파일 하나 이상을 갱신하지 못한 상태입니다. 경고는 해당 클라이언트와, 필요하면 Aside 프로필을 알려주고 거부 이유를 설명합니다. 새 세션을 시작하기 전에 **Integrations**에서 해당 클라이언트나 프로필을 확인하세요. 문제를 해결한 뒤 `ocx sync`를 다시 실행합니다. 겹친 작업은 먼저 끝나야 합니다. 경고에 백업 경로가 있거나 복구가 완료되지 않았다고 나오면 재시도 전 복구 상태를 확인하세요. 선택 저장 성공만으로 클라이언트 파일 복구까지 확인된 것은 아닙니다.

별도의 MiniMax 플랫폼 CLI(`mmx`)는 파일 스위치 연동이 아닙니다. 텍스트 명령은 MiniMax의 Anthropic 호환 엔드포인트를 사용하므로 opencodex가 자격 증명을 분리한 루프백 전용 런처를 제공합니다.

```bash
ocx mmx text chat --model anthropic/claude-opus-5 --message "Hello"
ocx mmx text repl --model openai/gpt-5.6-sol
```

`mmx text chat`과 `mmx text repl`만 프록시합니다. MiniMax 자체 이미지, 동영상, 음성, 음악, 비전, 검색, 할당량, 인증, 설정, 파일, 업데이트 명령에는 일반 `mmx`를 사용하세요. 래퍼는 비밀 정보가 아닌 루프백 자리표시자만 넣은 임시 설정을 사용합니다. 사용자의 `~/.mmx` OAuth나 API 키 자격 증명을 읽지 않고 `--api-key`, `--base-url`, `--region` 오버라이드도 거부합니다. 전체 절차와 제한은 [MiniMax 클라이언트](/ko/guides/minimax/)를 참고하세요.

`--confirm-drift`는 자동 적용되지 않습니다. 복원하려는 작업 뒤에 파일이 바뀌었다면 명령은 거부하고 이유를 알려줍니다. 최신 편집을 교체할지는 사용자가 결정해야 하기 때문입니다.

클라이언트별 세부 사항은 각 프로젝트의 설정 형식과 대조해 검증했습니다. 확인 항목과 시점은 `devlog/_fin/260802_client_toggle_api/002_client_toggle_matrix.md`의 조사 기록을 참고하세요.

## Aside 프로필 제어

Aside 프로필 제어와 `ocx sync`의 Aside 갱신에는 Aside 프로필 API를 지원하는 실행 중 ocx 프록시가 필요합니다. CLI만 업데이트해도 이미 실행 중인 프록시가 업데이트되지는 않습니다. 프록시가 없거나 너무 오래된 경우 Aside 작업을 완료할 수 없으며 CLI가 로컬 Aside 프로필 파일을 대신 기록하지 않습니다.

프록시에서 사용하는 ocx 설치를 업그레이드한 뒤 프록시를 다시 시작하거나, 멈춰 있다면 시작하세요. `ocx sync` 또는 프로필 명령을 다시 실행합니다. 프로필 파일이 성공적으로 갱신된 뒤에는 Aside를 완전히 종료하고 다시 열어 새 카탈로그를 불러오세요.

```bash
ocx integration client status --client aside --json
ocx integration client enable --client aside
ocx integration client disable --client aside --profile 1
ocx integration client history --client aside --profile 1
ocx integration client restore --client aside --profile 1 --op <opId>
```

프로필 번호는 상태 명령에 표시된 계정 ID입니다. Aside 스위치에서 `--profile`을 생략하면 원하는 상태를 등록된 모든 프로필에 적용합니다. 프로필별 변경은 다른 프로필에 영향을 주지 않습니다. 원하는 동기화 설정은 파일 변경 전에 저장되며 실제 상태와 거부 사유는 프로필마다 보고합니다. 일괄 작업이 부분 성공했다고 전체 적용 성공은 아닙니다. CLI도 0이 아닌 코드로 종료합니다. Undo는 선택한 프로필의 파일과 동기화 의도를 함께 복원하므로 나중에 동기화해도 Undo가 조용히 뒤집히지 않습니다.

[프로필 API](/reference/management-api/#aside-profile-controls)는 일괄 작업이 모두 성공하면 HTTP 200을, 프로필 하나라도 거부하면 `ok: false`와 함께 HTTP 207을 반환합니다. `results`의 각 항목을 확인하세요. 다른 프로필이 실패해도 성공한 프로필은 롤백되지 않습니다. 원하는 설정은 저장되므로 전체 변경이 실패했다고 가정하지 말고 영향을 받은 프로필 문제를 해결한 뒤 재시도하세요. 설정 저장 자체에 실패하면 프로필 파일은 변경되지 않습니다.

프로필마다 소유권과 기록은 별개입니다. 기존 사용자 편집, 안전하지 않은 경로, 링크된 카탈로그는 거부하며 명시적인 덮어쓰기와 변경 확인 옵션은 계속 사용할 수 있습니다. 변경된 모델 파일을 읽으려면 Aside를 완전히 종료하고 다시 여세요.

## ZCode 3.14 이상

ZCode 3.14는 사용자 정의 프로바이더를 `~/.zcode/v2/provider_config.json`으로 옮겼습니다. `~/.zcode/v2/config.json`은 새 파일이 없을 때 한 번 실행되는 가져오기 경로로만 남았습니다. ZCode를 처음 실행하면 새 파일을 만들므로 한 번이라도 실행한 설치에서는 가져오기 기회가 이미 지나갔고 `config.json`에 써도 반영되지 않습니다.

opencodex는 가능할 때 `provider_config.json`에 직접 기록합니다. 연동을 활성화하면 그 파일에 `opencodex` 프로바이더 규칙을 추가하고, 카탈로그 갱신 시 이를 갱신하며, 비활성화하면 opencodex가 넣은 내용만 제거합니다. opencodex 아래에도 있는 모델 ID를 다른 프로바이더가 규칙으로 사용하더라도 파일의 다른 모든 규칙은 유지됩니다. opencodex가 기록하지 않은 `opencodex` ID 규칙은 가져오지 않고 충돌로 처리합니다. ZCode에서 해결하거나 명시적 덮어쓰기를 사용하세요.

읽을 수 없거나 파일이 아닌 프로바이더 저장소도 쓰기를 거부합니다. 이전 형식 가져오기를 허용하는 빈 저장소로 취급하지 않습니다.

그 밖에도 두 경우에는 기록하지 않고 거부합니다. ZCode 저장소가 이동하기 전에 opencodex가 적용한 블록은 연동을 `config.json`에 유지합니다. 먼저 거기서 비활성화한 뒤 다시 활성화해 새 저장소에 기록하세요. 또 opencodex가 관측하지 못한 `schemaVersion`을 가진 `provider_config.json`은 병합하지 않고 보고합니다. 이 파일에는 ZCode의 모든 프로바이더가 들어 있으므로 알 수 없는 구조에 값을 쓰면 조용한 미반영을 조용한 손실로 바꿀 수 있습니다. 연동이 기록하지 않는 경우 상태에는 ZCode가 읽는 파일 이름이 표시됩니다.

두 번째 경우에는 ZCode 자체 설정에서 프로바이더를 추가하세요. 기본 URL은 `http://127.0.0.1:10100/v1`(바인딩 포트에 맞게 조정), 키는 비어 있지 않은 임의의 값, 모델 ID는 `ocx export --client zcode` 출력에서 가져옵니다. ZCode 가져오기를 다시 실행하려고 `provider_config.json`을 삭제하는 방법은 지원하지 않습니다. 그 파일의 모든 프로바이더를 버리기 때문입니다.

## Cline CLI

이 연동은 네이티브 스키마가 `version: 1`인 현재 Cline CLI/공유 SDK 프로바이더 저장소를 대상으로 합니다. 예전 VS Code 확장의 `globalState`/비밀 저장소는 이 연동으로 이전하거나 탐지하지 않습니다. Cline을 한 번 실행해 설정 디렉터리를 초기화하세요.

**연동을 활성화하거나 동기화하거나 비활성화하거나 복원하기 전에 Cline을 중지하세요.** opencodex는 `providers.json`과 옆의 `models.json` 둘 다에 `providers.opencodex`를 기록합니다. 첫 파일에는 비밀 정보가 아닌 루프백 자리표시자를 사용한 OpenAI Responses 연결이, 두 번째에는 사용 가능한 컨텍스트 및 이미지 메타데이터를 포함하는 필터링된 라우팅 모델 카탈로그가 들어갑니다. 기존 프로바이더 항목과 기본 프로바이더 선택은 유지됩니다.

```bash
ocx integration client list --json
ocx integration client enable --client cline
ocx integration client history --client cline
ocx integration client restore --op <operation-id>
```

활성화 후 Cline을 다시 시작하고 OpenCodex를 선택하거나 `cline --provider opencodex --model <provider/model>`로 실행하세요. 외부 카탈로그 변경은 Cline 재시작 시 읽습니다. Cline은 자동 카탈로그 갱신 대상에서 제외됩니다. 라우팅 모델 선택을 바꾼 뒤에는 Cline을 중지하고 `ocx sync`를 실행하거나 연동을 다시 활성화해 갱신하세요. 선택된 모델이 계속 라우팅되면 유지하고 내보낸 카탈로그에서 사라지면 선택을 해제합니다.

`CLINE_PROVIDER_SETTINGS_PATH`는 기본 파일 경로를 덮어씁니다. 그렇지 않으면 `CLINE_DATA_DIR`이 데이터 디렉터리를, 다음으로 `CLINE_DIR`이 루트를 선택하며, 마지막 기본값은 `~/.cline`입니다. 모델 파일은 언제나 선택된 프로바이더 파일 옆의 `models.json`입니다. 오버라이드는 절대 경로이거나 `~`로 시작해야 합니다. Cline 명령의 `--config` 경로를 사용할 때는 opencodex 시작 시 `CLINE_PROVIDER_SETTINGS_PATH`로 같은 경로를 지정하세요. 파일 두 개가 달라야 하므로 기본 파일 이름이 `models.json`이면 거부합니다.

각 파일은 원자적으로 교체하지만 두 파일을 동시에 교체하는 파일 시스템 작업은 없습니다. 저널 작업 하나가 원본 파일 둘을 스냅샷으로 남기며 쓰기나 장부 기록이 실패하면 둘 다 보정합니다. 중단된 작업은 비공개 복구 기록을 남깁니다. 상태는 완료되지 않은 복구를 안전하지 않다고 보고하고, 다음 명시적 변경 시 두 파일과 소유권 모두에 관련 없는 편집이 없을 때만 복구합니다. 복구가 거부되면 파일과 작업에서 알려준 복구 경로를 보존하고 충돌을 해결한 뒤 재시도하세요.

Undo는 원래 없던 파일까지 포함해 **두 원본 바이트 문자열 모두** 복원합니다. 작업 후 편집된 내용이 있으면 기존의 명시적 `--confirm-drift`가 필요하며 편집된 파일 쌍도 먼저 백업합니다. 이미 차지된 OpenCodex 항목에는 기존 `--overwrite-conflict` 동의가 필요합니다. Disable은 관리형 항목 두 개를 제거하며 이전 외부 항목을 복원하지는 않습니다. 그럴 때는 Undo를 사용하세요. 스냅샷 보관과 만료에는 다른 연동과 같은 규칙이 적용됩니다.

다운로드되는 `cline-config-bundle.json`에는 두 네이티브 문서 구성 요소가 있습니다. `providers.json`용 `settings`와 `models.json`용 `catalog`입니다. 번들 자체가 Cline 설정 파일은 아닙니다. 저널을 남기는 병합과 롤백에는 연동 명령을 권장합니다. 생성된 연동은 원격 수용 연결을 지원하지 않으며 인증이 없는 루프백 접근이 필요합니다.

## GitHub Copilot 앱

GitHub Copilot 데스크톱 앱에서 opencodex를 OpenAI 호환 모델 프로바이더로 사용할 수 있습니다. Integrations 탭의 스위치가 없는 수동 클라이언트 설정이며, opencodex의 백엔드로 Copilot 구독을 사용하는 upstream `github-copilot` 프로바이더와는 별개입니다.

1. opencodex를 시작하고 응답하는지 확인하세요.

   ```bash
   curl http://127.0.0.1:10100/healthz
   curl http://127.0.0.1:10100/v1/models
   ```

2. Copilot 앱에서 **Settings → Model providers → Add provider**를 열고 다음 값을 입력하세요.

   | 항목 | 값 |
   |---|---|
   | 이름 | 원하는 라벨(예: `OpenCodex`) |
   | Base URL | `http://127.0.0.1:10100/v1`(바인딩 포트에 맞게 조정) |
   | API key | 루프백 연결이면 비워 둠 |

3. 엔드포인트에서 모델을 동기화하거나 `provider/model` ID로 직접 추가한 뒤 선택하세요.

앱은 모델 검색에 `GET /v1/models`, 요청 처리에 `POST /v1/chat/completions`를 사용합니다. 요청은 opencodex의 일반 모델 라우팅을 거치므로 다른 클라이언트와 마찬가지로 프로바이더 자격 증명, OAuth 계정, 콤보가 적용됩니다. 허용되는 요청 필드는 [프록시 형식 레퍼런스](/reference/proxy-formats/)를 확인하세요.

모델이 없다고 표시되면 Base URL이 `/v1/chat/completions`가 아니라 `/v1`로 끝나는지, `/v1/models`가 비어 있지 않은 `data` 배열을 반환하는지 확인하세요. opencodex가 루프백이 아닌 주소에서 수신 대기한다면 앱의 API key 입력란에 데이터 수용 키([원격 액세스](/reference/configuration/server/#remote-access)에 설명된 토큰 또는 대시보드에서 생성한 `ocx_…` 키)를 입력하세요. 앱은 이를 `Authorization: Bearer`로 전송하며, `/v1/chat/completions`는 프록시 수용 인증에만 사용하고 upstream으로 전달하지 않습니다. 자세한 내용은 [인증 매트릭스](/reference/proxy-formats/#authentication-matrix)를 확인하세요.
