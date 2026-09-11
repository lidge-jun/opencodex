# 020 — wp3: V4.1-Flash 전개 (감사 후 재설계)

## 초안이 틀렸던 지점

초안은 `DEEPSEEK_THINKING_MODELS`(`registry.ts:619`)에 V4.1을 얹으려 했다. 그 상수는 `deepseek` 1st-party 프리셋의 `models:` 배열 자체를 포함해 6개 프리셋 21곳이 소비한다(002 참조). 게이트웨이 철자가 네이티브 프리셋으로 새고, "게이트웨이에만 넣는다"는 수용기준이 같은 커밋 안에서 깨진다.

또 `isDeepseekFlashModel`(`724`)이 시드 루프에서만 호출된다는 서술도 틀렸다. `1187`, `1190`(orcarouter), `2865`, `2868`, `2903-2908`(alibaba)이 리터럴 id로 직접 호출한다. 목록에 넣는 것만으로 사다리가 따라오지 않는다.

## 재설계: 상수를 쪼갠다

```ts
// 기존 상수는 레거시 V4 id 전용으로 남는다
const DEEPSEEK_THINKING_MODELS = ["deepseek-v4-pro", "deepseek-v4-flash"];
// 신규
const DEEPSEEK_NATIVE_V41_MODELS = ["deepseek-flash"];
const DEEPSEEK_GATEWAY_V41_MODELS = ["deepseek-v4.1-flash"];
```

## 어디에 넣는가 — 근거가 있는 곳만

| 대상 | 추가 id | 근거 |
| --- | --- | --- |
| `deepseek` 1st-party | `deepseek-flash` | DeepSeek 공식 API id (001) |
| `opencode-go` / `-zen` / `-free` | `deepseek-v4.1-flash` | 게이트웨이가 서빙한다는 사용자 보고. 저장소 내부로는 미확인이므로 PR 본문에 출처를 밝힌다 |
| `command-code` / `commandcode` | — | **PR #4258이 이미 추가한다. 중복 금지** |
| alibaba, volcengine, ollama, nim, baseten, orcarouter, cline-pass, codebuddy, qoder | — | 해당 벤더가 V4.1을 서빙한다는 근거가 없다. 넣지 않는다 |

## 파일 변경 지도

| 파일 | 변경 |
| --- | --- |
| `src/providers/registry.ts:619` 부근 | 신규 상수 2개 선언 |
| `registry.ts` `deepseek` 프리셋 (2038-2121) | `models:`에 `deepseek-flash`, `modelContextWindows`·`modelWireDefaults`·`modelResponsesTerminalRepair`·사다리·맵·replay 에 항목 추가 |
| `registry.ts` Zen 3종 (1760-1813, 3047-3064, 3108) | `deepseek-v4.1-flash`를 사다리·맵·replay·noVision·noJsonSchemaModels 에 추가 |
| `src/providers/default-aliases.ts:54` | `{ match: /^deepseek-v4/, alias: "ds4" }`가 `deepseek-flash`를 못 잡는다. 네이티브 신규 id용 규칙을 추가한다 |
| `tests/providers/provider-registry-parity.test.ts` | 분기 고정 |

## 수용 기준

1. `deepseek` 프리셋의 `models:`에 `deepseek-flash`가 있고 Flash 사다리·replay를 갖는다.
2. `opencode-go` 라우팅 시 `deepseek-v4.1-flash`가 같은 대우를 받는다.
3. **반대 증거**: `deepseek` 프리셋에 `deepseek-v4.1-flash`가 없고, Zen 프리셋에 `deepseek-flash`가 없다. 상수 분리가 실재함을 관측한다.
4. `deepseek-flash`가 별칭을 얻는다(`ds4` 계열 규칙에 걸린다).
5. `deepseek-v4-flash` 별칭은 그대로 남는다 — DeepSeek이 이름을 유지한다고 명시했다.

## 검증

```
bun test tests/providers/provider-registry-parity.test.ts
bun test tests/providers/opencode-go-deepseek.test.ts
bun test tests/providers/deepseek-reasoning-replay.test.ts
bun test tests/codex-integration/slug-codec.test.ts
bun run typecheck
```
