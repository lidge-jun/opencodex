# 260725 #422 — API-key openai-responses에서 remote compaction v2 fatal (조사 · 근거 · 제약)

단일 work-phase 유닛. 구현 계약은 `010_capability_gate.md`.
외부 근거는 `../260725_bug_sweep/001_external_evidence.md` §OpenAI Compaction.

## 증상

`authMode: "key"`인 `openai-responses` provider로 라우팅하면 Codex의 remote compaction v2가
fatal로 끝난다. 프록시는 HTTP 200을 보지만 Codex가 요구하는 `compaction` item이 0개다.

```
remote compaction v2 expected exactly one compaction output item, got 0 from N output items
```

## 근본 원인 (코드 확인 완료)

`openai-responses`라는 **wire format**을 `compaction_trigger`를 처리할 수 있는
**capability**로 잘못 간주한다.

### v2 경로 — `src/server/responses/core.ts:990`

```ts
const routedCompaction = parsed._compactionRequest === true && !("passthrough" in adapter && adapter.passthrough);
```

API-key `openai-responses`도 passthrough adapter이므로 `routedCompaction === false`가 되어
synthetic 경로가 꺼지고, raw body(trigger 포함)가 그대로 upstream으로 간다. upstream은
`compaction_trigger`를 모르므로 평범한 message를 돌려주고 Codex가 fatal을 낸다.

### v1 경로 — `src/server/responses/compact.ts:206`

```ts
if (route.provider.adapter === "openai-responses") {
```

adapter 이름만 보고 native `/responses/compact`를 호출한다. 그 엔드포인트를 지원하지 않는
호환 게이트웨이도 native로 오분류된다.

## 정확한 판정자는 이미 존재한다

`src/providers/openai-tiers.ts:32`:

```ts
export function isCanonicalOpenAiForwardProvider(provider: OcxProviderConfig): boolean {
  return provider.adapter === "openai-responses"
    && provider.authMode === "forward"
    && normalizedBaseUrl(provider.baseUrl) === CODEX_FORWARD_BASE_URL;
}
```

`authMode === "forward"`만 보면 부족하다. 수동 설정 파일은 임의 baseUrl에 forward를 쓸 수
있고 그런 custom 게이트웨이는 ChatGPT backend가 아니다. baseUrl까지 검사하는 이 함수가
정확한 기준이며, **`core.ts`와 `compact.ts` 양쪽에 이미 import되어 있다**(각각 65행, 63행).

## 기존 인프라 확인 (새로 만들 것이 적다)

- `src/responses/compaction.ts`: `COMPACT_PROMPT`, `SUMMARY_PREFIX`,
  `encodeCompactionSummary()`, `decodeCompactionSummary()`, `buildCompactV1Output()`
- `src/bridge.ts:652`: `options.compaction`이 참이면 정확히 하나의 `compaction` item을 생성
- `src/adapters/openai-responses.ts:127` `scrubOcxCompactionItems()`: 우리가 만든 compaction
  item을 다음 턴에 되돌리는 로직이 이미 있다
- `compact.ts:307` 이하: routed 모델용 v1 synthetic 경로가 이미 구현되어 있다

이 인프라 덕분에 compaction item 생성·인코딩·되돌리기 로직은 새로 만들 필요가 없다.

**다만 capability gate만으로는 부족하다.** A-gate 조사에서 확인된 사실:

1. passthrough adapter의 `buildRequest`(`openai-responses.ts:564`)는 `parsed._rawBody`를 쓴다.
   `core.ts`가 `parsed.context`에 넣은 `COMPACT_PROMPT`는 wire에 도달하지 않고,
   `compaction_trigger`와 tools는 raw body에 그대로 남는다. → raw body rewrite가 필요하다.
2. v1 경로(`compact.ts:311`)는 내부 요청을 `stream: false`로 만들고, `core.ts:1844`는
   `parseResponse`가 없으면 400을 낸다. → `parseStream`과 `parseResponse` 둘 다 필요하다.
3. `compact.ts:325`는 `response.ok`만 보고 내부 실패를 `"(no summary available)"` 성공으로
   포장한다. → 내부 상태 검사가 필요하다.

정확한 계약은 `010_capability_gate.md`가 단일 기준이다. 이 문서와 충돌하면 010을 따른다.

## 제약

- canonical ChatGPT forward의 native passthrough 동작은 그대로 유지해야 한다.
- 공식 `openai-apikey`(api.openai.com)는 `/responses/compact`를 실제로 지원하므로 v1 native
  경로를 유지한다. `001_external_evidence.md` 참조.
- `compact.ts:311`의 내부 요청은 `stream: false`다. routed 경로가 non-stream을 처리할 수
  있어야 v1이 동작한다 — 현재 routed 경로가 이미 그렇게 쓰이고 있으므로 B에서 확인한다.
