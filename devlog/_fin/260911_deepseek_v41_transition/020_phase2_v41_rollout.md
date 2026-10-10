# 020 — wp3: V4.1-Flash 전개 (2차 감사 후 재설계)

## 두 번 틀렸던 지점

**1차 초안**: `DEEPSEEK_THINKING_MODELS`에 V4.1을 그냥 얹으려 했다. 그 상수는 `deepseek` 1st-party 프리셋의 `models:`를 포함해 6개 프리셋이 공유하므로, 게이트웨이 철자가 네이티브로 샌다.

**2차 초안**: 그래서 상수를 레거시 전용으로 고정하고 신규 id를 따로 넣으려 했다. 감사가 `fail`을 냈고 이유가 맞다 — `deepseek` 프리셋의 모델별 맵 **다섯 개**가 전부 그 상수에서 파생된다(`registry.ts:2121-2124, 2128`). 상수를 레거시로 묶으면 `deepseek-flash`는 사다리·요약·`reasoning_content` 리플레이·비전 차단을 **전부** 잃고 #78형 400이 재발한다.

## 확정 설계: 상수를 세 갈래로 파생시킨다

```ts
// 업스트림이 호환 별칭으로 유지하는 레거시 V4 id
const DEEPSEEK_V4_LEGACY_MODELS = ["deepseek-v4-pro", "deepseek-v4-flash"];
// DeepSeek 1st-party: 공식 id는 deepseek-flash
const DEEPSEEK_NATIVE_THINKING_MODELS = ["deepseek-flash", ...DEEPSEEK_V4_LEGACY_MODELS];
// Zen 게이트웨이가 노출하는 철자
const DEEPSEEK_GATEWAY_THINKING_MODELS = ["deepseek-v4.1-flash", ...DEEPSEEK_V4_LEGACY_MODELS];
```

기존 이름 `DEEPSEEK_THINKING_MODELS`는 `DEEPSEEK_V4_LEGACY_MODELS`로 바뀐다. 벤더 호스팅 프리셋(volcengine 플랜, alibaba)은 그 레거시 상수를 계속 쓴다 — 그쪽은 V4 스냅샷을 자기 일정으로 서빙한다.

## 파일 변경 지도

| 위치 | 변경 |
| --- | --- |
| `registry.ts:619` | 상수 3개로 재구성 |
| `registry.ts:2121-2124, 2128` (deepseek 프리셋) | 다섯 맵을 `DEEPSEEK_NATIVE_THINKING_MODELS`로 전환 |
| `registry.ts:2049` (`models:`) | 같은 상수로 전환 |
| `registry.ts:2053` | `defaultModel`을 `deepseek-flash`로 |
| `registry.ts:2062, 2078` | `modelContextWindows`·`modelWireDefaults`·`modelResponsesTerminalRepair`에 `deepseek-flash` 항목 추가 |
| `registry.ts:1760, 1768, 1776, 1803, 1813` (opencode-go) | `DEEPSEEK_GATEWAY_THINKING_MODELS`로 전환 |
| `registry.ts:1791` (go `noVisionModels`, 리터럴) | `deepseek-v4.1-flash` 추가 |
| `registry.ts:3053-3071` (opencode-zen) | 게이트웨이 상수로 전환. 이 프리셋엔 `modelSupportsReasoningSummaries` 필드 자체가 없다 — 새로 만들지 않는다 |
| `registry.ts:3115` (opencode-free `noJsonSchemaModels`) | 게이트웨이 상수로 전환 |
| `src/providers/default-aliases.ts:54` 앞 | `/^deepseek-v4\.1/ → "ds41"` 을 `/^deepseek-v4/` **앞**에 둔다(첫 매치 승리). `/^deepseek-flash/ → "dsf"` 는 위치 무관 |

**건드리지 않는 것**: `opencode-free`의 `noVisionModels`(`3111`)는 `OPENCODE_ZEN_TEXT_ONLY_MODELS` 참조라 여기에 넣으면 zen까지 오염된다. free는 원래 DeepSeek id를 이 목록에 갖고 있지 않으므로 그대로 둔다. `command-code`는 PR #4258 소유. 벤더 호스팅 9곳은 V4.1 서빙 근거가 없어 제외.

## 수용 기준

1. `deepseek` 프리셋에서 `deepseek-flash`가 사다리·효율맵·요약·replay·noVision **다섯 곳 모두**에 나타난다. 이게 2차 감사가 잡은 실패 지점이므로 테스트로 직접 관측한다.
2. `opencode-go`에서 `deepseek-v4.1-flash`가 같은 대우를 받는다.
3. **반대 증거**: `deepseek` 프리셋에 `deepseek-v4.1-flash`가 없고, Zen 프리셋에 `deepseek-flash`가 없다.
4. 벤더 호스팅 프리셋(volcengine coding plan)의 DeepSeek 목록은 변하지 않는다.
5. `deepseek` `defaultModel`이 `deepseek-flash`다.

## 갱신해야 하는 기존 테스트 (감사 열거)

`tests/providers/provider-registry-parity.test.ts`: `197`(deepseek preserveReasoningContentModels `toEqual`), `199-201`(deepseek noVisionModels `toEqual`), `309`(defaultModel), `73-80`(go noVision `toEqual`), `86-92`(3종 noJsonSchema `toEqual`), `1421-1453`(DeepSeek id 열거). `tests/providers/opencode-go-deepseek.test.ts:159-160`(noJsonSchema `toEqual`). `tests/codex-integration/reasoning-effort.test.ts:274`(동일 `toEqual`).

`parity:184`는 `toContain`이라 안전하고, `model-metadata-sync.test.ts`는 `scripts/model-metadata.source.json`만 입력으로 재생성·바이트 비교하므로 레지스트리 추가로 깨지지 않는다.

## 기록해 두는 부수 사실

`scripts/model-metadata.source.json`에 `deepseek-flash`와 `deepseek-v4.1-flash` 행이 모두 없어 두 id의 비용 추정이 빈다. 생성 파일은 손대지 않는 방침(002)이므로 다음 메타데이터 생성에서 채워진다. PR 본문에 명시한다.

`opencode-free`는 `liveModels: true`인데 게이트웨이 상수 전환이 `noJsonSchemaModels` 한 곳뿐이라 `deepseek-v4.1-flash`가 사다리와 replay를 받지 못한다. 기존 `deepseek-v4-pro`/`-flash`도 같은 비대칭이므로 신규 결함은 아니다. PR 본문에 한 줄 남긴다.

## 검증

```
bun test tests/providers/provider-registry-parity.test.ts
bun test tests/providers/opencode-go-deepseek.test.ts
bun test tests/providers/deepseek-reasoning-replay.test.ts
bun test tests/codex-integration/slug-codec.test.ts
bun run typecheck
```
