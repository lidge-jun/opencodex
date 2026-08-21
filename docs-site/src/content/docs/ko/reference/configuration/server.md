---
title: 서버 및 런타임 구성
description: 리스너, 원격 접근, admission 키, 타임아웃, 저장소, 사이드카, 섀도 호출, 시작 동작.
---

서버 설정은 로컬 프록시가 어떻게 수신하고, 원격 트래픽을 어떻게 보호하며, 리소스를 어떻게 관리하고, provider 요청과 함께 돌아가는 보조 기능을 어떻게 실행할지 제어합니다.

## Server fields

| 필드 | 형식 | 기본값 | 의미 |
| --- | --- | --- | --- |
| `port` | `number` | `10100` | 프록시 수신 포트입니다. |
| `hostname?` | `string` | `"127.0.0.1"` | 바인드 주소입니다. 루프백이 아닌 바인드에는 `OPENCODEX_API_AUTH_TOKEN`이 필요합니다. |
| `proxy?` | `string` | — | 송신용 HTTP(S) 프록시 URL 또는 `${ENV_VAR}`입니다. 해당 변수가 비어 있을 때만 `HTTP_PROXY` / `HTTPS_PROXY`에 적용되며, 루프백은 `NO_PROXY`에 그대로 남습니다. |
| `emptyCompletionRetry?` | `boolean` | `false` | 텍스트나 도구 호출 없이 완료된 Responses 요청을 한 번 동일하게 재시도하도록 선택합니다. 재시도에는 비용이 발생할 수 있습니다. `OCX_EMPTY_COMPLETION_RETRY=0`은 설정을 바꾸지 않고 비활성화하며, combo 및 routed-compaction turn은 제외됩니다. |
| `stallTimeoutSec?` | `number` | `300` | 업스트림 데이터가 없을 때 `response.incomplete`가 되기까지의 초 수입니다. 최소 1입니다. |
| `connectTimeoutMs?` | `number` | `200000` | 시도별 DNS/TCP/TLS/최종 헤더 기한입니다. 본문 생성 전에 끝납니다. |
| `shutdownTimeoutMs?` | `number` | `5000` | 진행 중인 turn을 중단하기 전에 허용하는 정상 종료 드레인 기한입니다. |
| `websockets?` | `boolean` | `false` | 클라이언트용 Responses WebSocket 경로를 광고하고 허용합니다. `false`이면 클라이언트는 HTTP/SSE를 사용하며, 적격 canonical ChatGPT 업스트림 WS 최적화는 비활성화하지 않습니다. |
| `corsAllowOrigins?` | `string[]` | `[]` | CORS에서 추가로 허용할 정확한 origin입니다. 루프백 origin은 항상 허용됩니다. `chrome-extension://<extension-id>` 같은 authority 기반 브라우저 확장 origin을 지원하며, `*`는 와일드카드가 아닙니다. Firefox와 Safari는 확장 UUID를 (설치/브라우저 실행 때마다) 새로 만드므로 origin이 바뀌면 항목을 갱신하세요. |
| `apiKeys?` | `OcxApiKey[]` | `[]` | 비루프백 바인드에서 관리 API와 데이터 플레인 인증이 허용하는 생성된 `ocx_…` 자격 증명입니다. 대시보드에서 관리합니다. |
| `storageCleanupPolicy?` | `StorageCleanupPolicy` | disabled | 선택적으로 활성화하는 보관 세션 정리 정책입니다. 절대 암묵적으로 활성화되지 않습니다. |
| `appOwnedMemoryBudgetMb?` | `number` | `256` | 제거 가능한 앱 소유 로그, 캐시, blob, continuation payload에 대한 MiB 단위 상한입니다. 범위는 64–4096이며 RSS 상한은 아닙니다. |
| `codexAutoStart?` | `boolean` | `true` | Codex shim이 Codex를 실행하기 전에 `ocx ensure`를 돌리도록 허용합니다. `false`이면 ensure는 아무 작업도 하지 않습니다. |
| `codexShimAutoRestore?` | `boolean` | `true` | 완료된 외부 Codex 업데이트가 설치된 shim을 교체한 뒤 복원합니다. 환경 변수로 끌 수 있습니다: `OPENCODEX_CODEX_SHIM_AUTO_RESTORE=0`. |
| `syncResumeHistory?` | `boolean` | `true` | 되돌릴 수 있는 Codex App history 호환성입니다. 원래 메타데이터는 `ocx stop` / `ocx restore`가 백업하고 복원합니다. |
| `shadowCallIntercept?` | `{ enabled?: boolean; model?: string; sourceModels?: string[] }` | off | 인식된 Codex 보조/섀도 호출을 선택한 모델로 낮은 노력 수준에서 다시 보냅니다. 기본 source prefix는 `gpt-5.6-luna`입니다. 0.144.x 이하의 이전 클라이언트는 `gpt-5.4-mini`를 사용했으며 `sourceModels`로 복원할 수 있습니다. |
| `webSearchSidecar?` | `OcxWebSearchSidecarConfig` | on when usable | 웹 검색 사이드카 옵션입니다. |
| `visionSidecar?` | `OcxVisionSidecarConfig` | on when usable | 이미지 설명 사이드카 옵션입니다. |
| `images?` | `OcxImagesConfig` | automatic OpenAI selection | Codex `image_gen`용 독립형 Images 릴레이 옵션입니다. |

오래된 개발 빌드가 백업 지원이 생기기 전에 resume-history 메타데이터를 바꿨다면, native-provider 복구를 강제로 수행하려면 `ocx recover-history --legacy-openai`를 실행합니다.

## Remote access

기본 `127.0.0.1` 바인드는 루프백 전용입니다. `0.0.0.0` 같은 루프백이 아닌 주소는 `/api/*`와 데이터 플레인 모두에서 토큰 인증이 필요합니다. 시작하기 전에 토큰을 내보냅니다:

```bash
export OPENCODEX_API_AUTH_TOKEN="your-secret-token"
ocx start
```

이 변수가 없으면 프록시는 원격 바인드를 거부합니다. 백그라운드 서비스라면 `ocx service install` 전에 내보내서 launchd, systemd, 또는 Task Scheduler가 이를 받도록 합니다. 클라이언트는 다음을 보내야 합니다:

```text
x-opencodex-api-key: your-secret-token
```

| 엔드포인트 | `Authorization: Bearer` | `x-opencodex-api-key` | `x-api-key` |
| --- | --- | --- | --- |
| `/v1/responses` | 허용되지 않음 | **필수** | 허용되지 않음 |
| `/v1/chat/completions` | 허용되지 않음 | **필수** | 허용되지 않음 |
| `/v1/messages` | 허용됨 | 허용됨 | 허용됨 |
| `/v1/messages/count_tokens` | 허용됨 | 허용됨 | 허용됨 |
| `/v1/models` | 허용됨 | 허용됨 | 허용됨 |

Responses와 Chat Completions는 `Authorization`을 향후 Codex Direct 패스스루 용도로 예약해 두므로, 여기서는 전용 admission 헤더만 허용됩니다. 대시보드에서 생성한 `apiKeys`는 시작 후 환경 토큰을 대체할 수 있으며, 후보 값은 상수 시간으로 비교합니다.

Messages와 `count_tokens`는 라우팅 클라이언트 호환성을 위해 세 admission 형식을 계속 허용합니다. 하지만 비루프백
바인드의 네이티브 Anthropic 패스스루는 프록시 admission을 `x-opencodex-api-key`로만 받고,
`Authorization`과 `x-api-key`를 Anthropic 자격 증명용으로 예약합니다. 이 provider 헤더에 들어간
프록시 admission secret은 upstream 전달 전에 제거됩니다.

:::caution[LAN exposure]
`0.0.0.0` 바인드는 프록시와 설정된 provider 접근을 LAN에 노출합니다. 신뢰할 수 있는 네트워크에서 강한 토큰과 함께만 사용합니다.
:::

### SSH port forwarding

원격 사용에 원격 바인드는 필요하지 않습니다. 루프백으로 유지한 채 포워딩하면 됩니다:

```bash
ssh -L 20100:localhost:10100 you@remote
```

로컬 포트는 무엇이든 사용할 수 있습니다. Host가 `localhost`, `127.0.0.1`, 또는 `::1`로 해석되는 요청은 포트와 무관하게 루프백으로 유지되므로 `http://localhost:20100/v1`이 동작합니다. 클라이언트에 그 base URL을 설정하십시오. `ocx`는 관리되는 클라이언트 config에 기본 로컬 `127.0.0.1` 주소만 기록합니다.

provider OAuth 콜백은 고정된 원격 포트에서 수신합니다. 원격 머신에서 로그인하거나 그 포트도 함께 포워딩합니다:

```bash
ssh -L 20100:localhost:10100 -L 1455:localhost:1455 you@remote
```

:::caution[Forwarded loopback is unauthenticated]
일반 `ssh -L`은 로컬 루프백에서만 수신하므로 기본 비인증 바인드에는 안전합니다. `ssh -g -L`, 광범위한 컨테이너 퍼블리싱, 또는 클라이언트 쪽을 `0.0.0.0`에 노출하는 포워딩 모드는 사용하지 마십시오. 확신이 없으면 `ssh -L 127.0.0.1:20100:localhost:10100`처럼 명시적으로 바인드합니다.
:::

## Storage cleanup

`storageCleanupPolicy`는 기본적으로 비활성화되어 있습니다. 활성화하면 아카이브된 바이트가 `trigger.archivedBytesOver`를 넘은 뒤 `startup`, `daily`, `weekly`, 또는 `manual` 시점에 실행됩니다. 가장 오래된 아카이브를 골라 `target.reduceToBytes` 또는 `target.removeOldestPercent` 방향으로 줄입니다. `mode`의 기본값은 `quarantine`이며, `permanent`는 명시적인 파괴적 선택으로만 사용합니다. 이 정책은 `lastRun`과 `nextRun`을 저장합니다. Storage 페이지에서 또는 `GET`/`PUT /api/storage/cleanup-policy`로 설정할 수 있으며, 수동 실행은 `POST /api/storage/cleanup-policy/run`으로 트리거합니다.

## Claude Code (`claudeCode`)

이 설정은 `/v1/messages`, `/v1/messages/count_tokens`, `ocx claude` 실행기, 그리고 Claude 대시보드 페이지를 제어합니다.

| 키 | 형식 | 기본값 | 설명 |
| --- | --- | --- | --- |
| `claudeCode.bodyStallSec?` | `number` | `90` | 읽기가 대기 중일 때의 native-passthrough 본문 비활성 시간 한도입니다. 전체 지속 시간이 아니라는 점에 유의합니다. 최소 1이며, 정확히 `0`이면 비활성화됩니다. |
| `claudeCode.bodyMaxBytes?` | `number` | `67108864` | 스트리밍 및 버퍼링된 응답에 대한 누적 native-passthrough 본문 상한입니다. 정확히 `0`이면 비활성화됩니다. |
| `claudeCode.authMode?` | `"proxy" \| "subscription"` | auto | 실행 시 `ANTHROPIC_AUTH_TOKEN`을 어떻게 다룰지입니다. 자동은 매 실행마다 인증을 감지하며, 명시 값은 절대 덮어쓰지 않습니다. |
| `claudeCode.authModeMigratedAt?` | `string` | unset | 내부적인 일회성 업그레이드 마커입니다. 수동으로 설정하지 마십시오. |
| `claudeCode.subagentEffort?` | `"low" \| "medium" \| "high" \| "xhigh" \| "max"` | inherit | 생성된 `~/.claude/agents/ocx-*.md`에 쓰이는 노력 수준입니다. Codex 지침과 프록시 상한과는 별개입니다. 다시 생성하려면 `ocx claude`로 재시작합니다. |

자동 인증은 저장된 Claude 인증이 있으면 subscription을, 없으면 proxy를 선택합니다. 감지가 불명확할 때는 경고와 함께 subscription을 선택합니다. [Claude Code 인증 모드](/guides/claude-code/#auth-mode)를 보십시오.

## Shadow calls

Codex는 제목과 커밋 메시지 같은 작업에 작은 보조 모델을 사용합니다. 인식된 source-model prefix를 다른 구성된 모델로 돌리려면 `shadowCallIntercept`를 활성화합니다. 대체 호출은 낮은 노력 수준으로 실행됩니다. 클라이언트가 다른 helper id를 사용할 때만 `sourceModels`를 설정합니다.

```json
{
  "shadowCallIntercept": {
    "enabled": true,
    "model": "gpt-5.5",
    "sourceModels": ["gpt-5.6-luna"]
  }
}
```

## Sidecars

### `images` (`OcxImagesConfig`)

| 필드 | 형식 | 기본값 | 의미 |
| --- | --- | --- | --- |
| `provider?` | `string` | automatic OpenAI selection | `/v1/images/generations`와 `/v1/images/edits`에 사용하는 명시적인 custom API-key `openai-responses` provider입니다. registry-managed ids는 거부됩니다. |
| `timeoutMs?` | `number` | `300000` | 단일 standalone Images 요청 하나에 대한 전체 요청 제한 시간입니다. |

명시적으로 선택하면 provider가 없거나, 비활성화되어 있거나, 호환되지 않거나, 사용할 수 있는 키가 없을 때는 닫힌 상태로 실패하며, 다른 유료 업스트림으로 절대 폴백하지 않습니다. 이 엔드포인트는 Codex가 기대하는 OpenAI Images API 경로와 응답 형식을 구현해야 합니다.

### `webSearchSidecar` (`OcxWebSearchSidecarConfig`)

| 필드 | 형식 | 기본값 | 의미 |
| --- | --- | --- | --- |
| `enabled?` | `boolean` | on when usable | 주 스위치입니다. |
| `backend?` | `"openai" \| "anthropic" \| "xai" \| "gemini" \| "exa"` | `openai` | 명시값이 우선입니다. 생략하면 항상 `openai`입니다. `anthropic`과 `xai`는 명시적으로 설정할 때만 실행되며, `gemini`와 `exa`는 executor가 제공될 때까지 예약 상태입니다. |
| `model?` | `string` | backend-dependent | OpenAI는 `gpt-5.6-luna`, Anthropic은 `claude-sonnet-5`, xAI는 `grok-4.6`입니다. 레거시로 명시된 `gpt-5.4-mini`는 시작 시 마이그레이션됩니다. |
| `exaApiKey?` | `string` | 없음 | `exa` 백엔드용 운영자 키입니다. 쓰기 전용이며 관리 API 조회에서는 저장된 값을 반환하지 않습니다. |
| `xSearch?` | `object` | 생략 | xAI 전용 `x_search` opt-in입니다. `enabled`, 서로 배타적인 `allowedXHandles` / `excludedXHandles` 배열(최대 20개), ISO `fromDate` / `toDate`(`YYYY-MM-DD`)를 지원합니다. |
| `reasoning?` | `string` | `low` | 사이드카 노력 수준입니다. `minimal`은 web search와 함께 거부됩니다. |
| `maxSearchesPerTurn?` | `number` | `3` | 메인 모델 턴당 허용되는 실제 검색 수입니다. |
| `routedModelStallTimeoutMs?` | `number` | `200000` | 설정 파일 전용 routed-model 원시 본문 비활성 기한입니다. 정수 1–2147483647이며, 비어 있지 않은 모든 청크가 이를 다시 시작합니다. |
| `timeoutMs?` | `number` | `60000` | 한 번의 hosted search에 대한 기한입니다. |

OpenAI 백엔드는 ChatGPT 로그인과 활성화된 ChatGPT `forward` provider를 요구합니다. Claude-inbound routed replay는 메인 ChatGPT 인증을 내부 요청에 주입합니다. Anthropic 백엔드는 활성화된 Anthropic OAuth provider에서 현재 저장된 자격 증명을 사용합니다. 명시적으로 선택한 Anthropic 백엔드에 사용할 수 있는 계정이 없으면 폴백하지 않고 닫힌 상태로 실패합니다. Anthropic 실행기는 자체 `web_search_20250305` 도구를 사용합니다. xAI 백엔드는 사용 가능한 저장된 Grok OAuth 계정을 요구하고 hosted `web_search`를 사용하며, `xSearch.enabled`가 true이면 hosted `x_search`를 추가합니다. 잘못된 `xSearch` 관리 입력은 `400`을 반환하고, 잘못 저장된 블록은 계획 단계에서 닫힌 상태로 실패합니다. `gemini`와 `exa`는 자격 증명 탐색이나 폴백으로 절대 활성화되지 않으며 운영자가 명시적으로 선택해야 합니다. `exaApiKey`는 쓰기에서 허용되지만 관리 응답에서는 생략됩니다.

검색에는 네 가지 시계가 작동합니다: 기본 `stallTimeoutSec`, `connectTimeoutMs`, routed-model 비활성 시간, 그리고 hosted-search 제한 시간입니다. 실제 bridge watchdog은 이들 중 최댓값에 30초를 더한 값입니다. Routed stall은 비활성 가드이지, 전체 생성 기한이 아닙니다.

### `visionSidecar` (`OcxVisionSidecarConfig`)

| 필드 | 형식 | 기본값 | 의미 |
| --- | --- | --- | --- |
| `enabled?` | `boolean` | on when usable | 주 이미지 설명 스위치입니다. |
| `backend?` | `"openai" \| "anthropic"` | auto | 명시값이 우선하며, 미설정 시 사용 가능한 저장된 Anthropic OAuth 자격 증명을 우선하고 없으면 `openai`를 사용합니다. |
| `model?` | `string` | backend-dependent | OpenAI는 `gpt-5.4-mini`, Anthropic은 `claude-sonnet-5`입니다. |
| `reasoning?` | `"low" \| "medium" \| "high" \| "xhigh" \| "max"` | `"low"` | OpenAI Responses 추론 강도입니다. Anthropic은 무시합니다. |
| `maxDescriptionsPerTurn?` | `number` | `8` | 메인 턴당 허용되는 새 설명 캐시 미스 수입니다. `0`이면 호출이 비활성화되며, 잘못된 값은 기본값을 사용합니다. |
| `timeoutMs?` | `number` | `45000` | 사이드카 fetch 제한 시간입니다. 정수 1–2147483647. |

지원되는 수준은 업스트림 제공자의 역량과 선택한 모델이 공개한 추론 사다리에 따라 제한됩니다. Vision은 provider의 `noVisionModels`에 속한 모델로 보낸 이미지에만 활성화됩니다. OpenAI는 검색과 같은 로그인/forward 요건을 갖고 있으며, 명시적으로 선택한 Anthropic은 사용할 수 있는 자격 증명이 없으면 닫힌 상태로 실패합니다. 성공한 `data:` 설명은 backend, model, detail, image bytes, 그리고 정규화된 메시지 컨텍스트를 키로 하는 bounded cache를 사용합니다. OpenAI 키에는 reasoning effort도 포함됩니다(Anthropic 키에는 없습니다). 히트와 같은 턴의 중복은 한도를 소모하지 않습니다. 원격 `https:` 이미지와 실패했거나 비어 있는 설명은 캐시하지 않습니다.

Anthropic OAuth 사이드카는 opencodex의 기존 Claude Code OAuth fingerprint를 재사용합니다. 의도한 계정과 워크로드로 소크 테스트를 수행합니다.
