# 000 — Kiro 사용량 행이 누적 컨텍스트와 캐시 분해를 잃어버리는 이유

## 증상

GUI Logs에서 `kiro` / `claude-opus-5` 행은 `~100`, `~369`, `~1992`, `~6492` 같은
작은 토큰 수와 `캐시 미보고` 라벨만 보여준다. 같은 화면의 `anthropic`(claude-fable-5)과
`kimi`(k3[1m]) 행은 `3.5만 / c 3.5만 / w 652`, `12.7만 / c 12.5만`처럼 누적 컨텍스트와
캐시 읽기(c) / 쓰기(w) 분해를 보여준다.

## 실측 증거

`/Users/jun/.opencodex/usage.jsonl` (2026-07-30 기준):

| 측정 | 값 |
|------|-----|
| `"provider":"kiro"` 행 수 | 5202 |
| 그중 `cacheReadInputTokens` 포함 | 0 |
| 그중 `contextTotalTokens` 포함 | 0 |
| 파일 전체에서 `contextTotalTokens` 포함 | 0 |

대표적인 행 모양:

```json
{"provider":"kiro","model":"claude-opus-5","usageStatus":"estimated",
 "usage":{"inputTokens":220,"outputTokens":252,"estimated":true},"totalTokens":472}
```

`contextTotalTokens`가 **어떤 프로바이더에서도** 한 번도 기록되지 않았다는 점이 핵심이다.
이건 Kiro 전용 결함이 아니라 지속(persist) 계층의 스키마 누락이다.

## 코드 경로 추적

어댑터 계층은 이미 올바르다.

- `parseTokenUsage()`가 `uncachedInputTokens + cacheReadInputTokens + cacheWriteInputTokens`를
  inclusive `inputTokens`로 합치고 `cachedInputTokens` / `cacheReadInputTokens` /
  `cacheCreationInputTokens`를 채운다 — `src/adapters/kiro-events.ts:64`.
- `metadataEvent`가 그 객체를 `ev.usage`로 노출 — `src/adapters/kiro-events.ts:157`.
- 스트림 루프가 `authoritativeUsage`에 그대로 대입 — `src/adapters/kiro.ts:988`.
- `usage()` 클로저가 authoritative 객체를 spread하고 `contextTotalTokens`만 덧붙인다 —
  `src/adapters/kiro.ts:774-790`.
- fallback 병합도 캐시 필드를 버리지 않고 합산 — `src/adapters/kiro.ts:617-655`.

기존 회귀 테스트가 터미널 이벤트 모양을 정확히 못 박고 있고 통과한다:
`tests/kiro-stream.test.ts:1245` — `inputTokens: 15, contextTotalTokens: 204,
cacheReadInputTokens: 3, cacheCreationInputTokens: 2, totalTokens: 19`.

즉 **어댑터가 아니라 그 뒤가 문제다.**

## 끊긴 링크 두 개

### 링크 1 — `contextTotalTokens`가 지속 계층에서 소실 (확정)

`normalizeUsageValue()`가 기록 시점에 필드를 화이트리스트로 복사하는데
`contextTotalTokens`가 목록에 없다 — `src/usage/log.ts:126-138`.
복사되는 필드: `inputTokens`, `outputTokens`, `totalTokens`, `cachedInputTokens`,
`cacheReadInputTokens`, `cacheCreationInputTokens`, `reasoningOutputTokens`, `estimated`.

`PersistedUsageEntry.usage`는 `OcxUsage` 타입이라 스키마상으론 담을 수 있는데
(`src/usage/log.ts:68`), 직렬화 함수가 조용히 떨어뜨린다.

### 두 커밋의 상호작용 — 이것이 결정적 원인이다

`commit fc5170049 fix(kiro): report context pressure for compaction` (2026-07-26)은
누적 checkpoint를 어댑터 → 브리지 직렬화까지 관통시키고, **자기 회귀 테스트로
지속까지 증명했다.** `tests/request-log.test.ts`에 추가된
`deferred logging preserves a bridged Kiro absolute context checkpoint`는
`contextTotalTokens: 50_000`을 넣고 기록된 행이
`usage: { inputTokens: 49_900, outputTokens: 100, totalTokens: 50_000 }`가 되는 것을
확인한다. 즉 그 시점에는 실제로 동작했다.

동작한 이유는 그 테스트가 **브리지가 만든 SSE wire를 다시 파싱하는 경로**를 타기
때문이다. `responsesUsage()`가 `contextTotalTokens`를 `input_tokens =
contextTotalTokens - outputTokens`, `total_tokens = contextTotalTokens`로 투영하므로
(`src/bridge.ts:34-41`) 누적값이 `inputTokens`/`totalTokens`라는 **일반 필드에 녹아든
상태로** 기록된다. `contextTotalTokens` 자체는 필요 없었다.

그런데 `commit 0422ce193 fix(usage): preserve raw adapter usage provenance via bridge
onUsage callback` (2026-07-23 작성, dev에는 fc5170049보다 **나중에** 들어옴 —
`git rev-list --count 0422ce193..fc5170049` = 0, 역방향 = 14)이 그 경로를 끊었다.
이 커밋의 목적 자체는 타당하다: `responsesUsage()`가 strict 클라이언트를 위해 항상
zero-default detail 객체를 내보내므로, wire를 재파싱하면 synthetic zero가 실측
캐시값으로 오독되어 `cache_detail_missing`이 잘못 억제됐다.

해결책으로 브리지가 **정규화 전 raw adapter usage**를 `onUsage` 콜백으로 보고하고,
`applyResponseLogMetadata`는 `usageFromBridge`가 켜지면 wire 재파싱을 건너뛴다
(`src/server/request-log.ts:433-437`). 프로덕션 스트리밍 경로는
`src/server/responses/core.ts:2473`에서 이 콜백을 배선한다.

**결과**: 기록되는 usage가 "브리지가 투영한 누적값"에서 "어댑터의 raw per-attempt
usage"로 바뀌었다. raw 객체에는 누적값이 `contextTotalTokens`라는 **별도 필드**로만
들어 있는데, `normalizeUsageValue()`가 그 필드를 화이트리스트에서 빼고 있으므로
지속 시점에 소실된다. 두 커밋 각각은 옳았지만 결합에서 누적 보고가 죽었다.

fc5170049의 회귀 테스트는 이 퇴행을 잡지 못한다. `usageFromBridge`를 켜지 않고
wire 재파싱 경로를 직접 호출하기 때문에, 프로덕션이 실제로 타는 분기를 재현하지
않는다. 프로덕션 경로를 덮는 테스트가 없다 — 이것이 회귀가 조용히 통과한 이유다.

또한 GUI 쪽 `UsageBreakdown` 인터페이스에도 `contextTotalTokens`가 없어서
(`gui/src/pages/Logs.tsx:16-25`) 설령 기록돼도 표시 경로가 없다.

### 링크 2 — 상류가 `tokenUsage`를 실제로 보내지 않는다 (강한 정황)

`normalizeUsageValue()`는 캐시 필드 3개를 **명시적으로 보존한다**. 그런데 실측에서
5202행 중 0행이 캐시 필드를 갖는다. 직렬화가 보존하는데 결과가 0이면, 그 값이 애초에
도착하지 않았다는 뜻이다.

따라서 현재 CodeWhisperer 스트림에는 유효한 `tokenUsage` 프레임이 없거나, 있어도
우리가 파싱하는 위치에 없다. 정적 fixture는 상류의 실제 발신 여부를 증명할 수 없다.
`usageForFinalLog()`가 kiro/cursor를 `estimated: true`로 강제 라벨링하지만
(`src/usage/log.ts:110-118`) 이건 라벨일 뿐 캐시 detail을 벗기지 않는다.

## 부수 결함 — inputTokens 정합성 붕괴

`finalizedUsage()`가 `Math.max(finalUsage.inputTokens, estimate)`로 authoritative
`inputTokens`를 추정치로 올려버릴 수 있는데, `cacheReadInputTokens` /
`cacheCreationInputTokens` / `totalTokens`는 손대지 않는다 —
`src/server/request-log.ts:772-799`. 그러면 canonical 규약
(`inputTokens == uncached + read + write`, `src/types.ts:309-317`)이 깨진다.

## 목표 모양

anthropic은 상류의 exclusive input을 inclusive `inputTokens`로 정규화하면서 read/write를
보존한다(`src/adapters/anthropic.ts` 부근, native passthrough는
`src/server/claude-messages.ts`). kimi는 `openai-chat`을 타고 누적 `prompt_tokens`와
`cached_tokens`(읽기만)를 매핑한다.

GUI가 c/w를 그리려면 `cacheReadInputTokens` / `cacheCreationInputTokens`가 필요하고
(`cachedInputTokens`는 읽기 fallback), 누적 총합은 `inputTokens + outputTokens` 또는
`totalTokens`에서 온다 — `gui/src/pages/Logs.tsx:138-168`.

## 사용자 기대와의 대조

사용자는 "누적으로 패치되도록 패치된 상태"라고 기억한다. 실제로 그 패치(fc5170049)는
존재하지만 **브리지 wire까지만** 누적을 전달하고 로그 지속에는 닿지 않았다. 그래서
Codex 클라이언트 쪽 컨텍스트 표시는 개선됐어도 GUI Logs 표는 그대로였다.
캐시 c/w는 별개 문제로, 상류 미보고가 원인일 가능성이 높다.

## 판정

- 누적 컨텍스트 미표시: **우리 쪽 결함, 수정 가능** (링크 1).
- 캐시 c/w 미표시: **상류 미보고 정황**. 정직한 라벨 유지가 맞고, 상류가 보내기
  시작하면 자동으로 표시되도록 경로를 열어두는 것이 수정 범위다.
