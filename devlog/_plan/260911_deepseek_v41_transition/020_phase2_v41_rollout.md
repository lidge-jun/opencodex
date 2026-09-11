# 020 — wp3: V4.1-Flash 전개

## id 분기

| 대상 | 추가할 id | 근거 |
| --- | --- | --- |
| `deepseek` 1st-party 프리셋 | `deepseek-flash` | DeepSeek 공식 API id |
| Zen 계열(`opencode-go`/`-zen`/`-free`), `command-code`, `cline-pass`, `orcarouter`, `codebuddy`, `qoder` | `deepseek-v4.1-flash` (프로바이더 접두어 규칙 그대로) | #4253 / PR #4258이 확인한 라이브 로스터 철자 |

## 파일 변경 지도

| 파일 | 변경 |
| --- | --- |
| `src/providers/registry.ts:619` | `DEEPSEEK_THINKING_MODELS`에 V4.1 항목 추가. 이 상수가 Zen 3종 프리셋의 사다리·맵·replay·noVision을 동시에 먹인다 |
| `src/providers/registry.ts:2038-2078` | `deepseek` 프리셋에 `deepseek-flash` 컨텍스트 창·wire default·terminal repair 추가 |
| `src/providers/registry.ts:1180-1199` | orcarouter/cline-pass 계열 접두어 id 추가 |
| `src/providers/codebuddy-models.ts`, `src/providers/qoder-models.ts` | 로스터에 V4.1 항목 추가 |
| `src/providers/command-code-efforts.ts` | #4258이 이미 추가한다. **중복 추가 금지** |
| `tests/providers/provider-registry-parity.test.ts` | 분기 고정: 네이티브는 `deepseek-flash`, 게이트웨이는 `deepseek-v4.1-flash` |

`isDeepseekFlashModel`(`registry.ts:718`)은 substring `includes("flash")`라 `deepseek-flash`와 `deepseek-v4.1-flash` 둘 다 Flash 사다리로 분류한다. 시드 루프에서만 호출되므로 목록에 넣기만 하면 사다리가 따라온다.

## 수용 기준

1. `deepseek` 프로바이더를 라우팅하면 `deepseek-flash`가 Flash 사다리와 replay 목록을 갖는다.
2. `opencode-go`를 라우팅하면 `deepseek-v4.1-flash`가 같은 대우를 받는다.
3. 반대 증거: `deepseek` 프리셋에는 `deepseek-v4.1-flash`가, 게이트웨이 프리셋에는 `deepseek-flash`가 **없다**. 분기가 실재함을 관측한다.
4. 기존 `deepseek-v4-flash` 별칭 처리는 이 단계에서 건드리지 않는다 (wp4에서 함께 판단).

## 검증

```
bun test tests/providers/provider-registry-parity.test.ts
bun test tests/providers/opencode-go-deepseek.test.ts
bun test tests/providers/deepseek-reasoning-replay.test.ts
bun run typecheck
```
