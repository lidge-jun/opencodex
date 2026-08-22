# 015 — WP6 close 집행 계획 (사용자 승인 범위)

사용자가 "위양성은 close" 로 명시 승인한 범위다. 착수 직전 각 대상의 상태와
근거를 다시 확인했고, **한 건이 대상에서 빠졌다.**

## 착수 전 상태 재확인

```
PR #1155  OPEN  head=307045c55  updated=2026-08-07T07:19:17Z
PR #1119  OPEN  head=e00ce78be  updated=2026-08-06T12:31:45Z  CONFLICTING
issue #1128 OPEN              updated=2026-08-08T07:09:36Z   ← 방금 갱신됨
```

## #1128 — close 대상에서 제외 (재확인 결과)

`002`/`060` 은 이 이슈를 "해결됨" 으로 분류했다. 그러나 착수 직전 확인에서 두
가지가 드러났다.

1. 다른 사용자의 추가 보고가 있다 — awillheartwu, 2026-08-06: "same here,
   compact failed"
2. **maintainer가 2026-08-08T07:09:36Z에 직접 코멘트를 남기고 열어두었다.**
   요지: 이 보고는 2.10.1/2.10.2에서는 유효했고 `0b8e608c`(v2.11.0)로 전제가
   바뀌었으니 **v2.11.0에서 재시험해달라**, 여전히 실패하면 그 버전의 terminal
   event 시퀀스를 첨부해달라, 그때는 2.10.x의 bounded-JSON 정책 부재가 아니라
   현재 compact 릴레이 버그다. "Leaving this open pending that current-version
   control."

#1176과 정확히 같은 상황이다. 코드 분석("정책이 폐기됐으니 그 경로는 없다")은
맞지만, 그것이 리포터가 겪은 실패가 사라졌다는 증명은 아니다. 같은 날 열어둔
판단을 몇 시간 뒤 뒤집는 것은 근거 없는 번복이다.

**처분 변경: close → tracking 유지.** 리포터 회신 대기.

따라서 **WP6의 이슈 close 대상은 0건**이 된다.

## close 집행 대상 — **0건** (감사에서 둘 다 막힘)

착수 전 감사가 두 close를 모두 기각했다. 근거를 직접 재확인했고 둘 다 타당하다.

### PR #1155 (myrosla) — **close 철회. 도달 가능한 경로였다**

> **우리 판정이 틀렸다.** "도달 불가" 근거는 레지스트리 opt-in이 없다는 것이었고
> 그 부분은 맞다(`modelResponsesUpstreamStreaming` 은 레지스트리 전용이며
> 프로덕션 항목 중 `false` 로 설정한 것이 없다. 유일한 false는 테스트 픽스처
> `tests/deepseek-inbound-wire.test.ts:244-267`).
>
> **그러나 이 PR은 그 힌트만 보존하는 게 아니다.** 핵심 훅은 다음이다:
>
> ```diff
>  const wsResponse = await runWithWebSearch({
>    parsed, adapter,
> +  upstreamStreaming: parsed.stream,
> ```
>
> 사용자 요청이 직접 이 값을 정한다. 공개 Responses API는 `stream` 을
> optional로 받고(`src/responses/schema.ts:133-144` 의 `stream: z.boolean().optional()`),
> 생략/`false` 는 `parsed.stream === false` 로 매핑되며
> (`src/responses/parser.ts:678-686`), `planWebSearch()` 에는 스트림 요건이
> 없다(`src/web-search/index.ts:148-150`).
>
> 즉 **`web_search` 를 켠 채 `stream` 을 생략하거나 `false` 로 보낸 라우팅
> `/v1/responses` 요청**이 정확히 이 PR의 buffered 분기를 활성화한다. PR 자신의
> 새 테스트도 `upstreamStreaming: false` 를 의도적으로 호출한다.
>
> 도달 불가 주장은 철회한다. 이 PR을 닫으면 실제로 도달하는 호환 경로를 버린다.

**처분 변경: close → 열어둔 채 코멘트.** 다만 머지 준비가 된 것도 아니다:
buffered `openai-responses` 경로가 compaction 전용 파서를 호출해 tool-call만
있는 응답에서 오류가 난다(`src/adapters/openai-responses.ts:1271-1293`). 자동
리뷰가 지적한 미해결 사항과 일치한다.

코멘트 내용: (1) 우리가 "도달 불가" 로 판단했다가 철회한다는 사실과 그 이유,
(2) 실제 활성화 경로(`stream` 생략 + `web_search`), (3) tool-call 전용 응답
처리와 retained-event 회계를 보완하거나 분리해달라는 요청.

<details>
<summary>철회된 close 근거 (기록용)</summary>

근거를 현재 dev에서 재확인했다.

`src/providers/registry.ts:1318-1326`:

```
// The #875-era bounded-JSON force (`modelResponsesUpstreamStreaming`) is retired
// for this entry: ... live probes (2026-08-07, including the tool-result replay
// shape that originally stalled) close on the terminal. ... forcing stream:false
// only delayed every byte until generation finished (28-46 s of silence on long
// turns). The registry knob itself remains for providers that need it
```

`src/web-search/loop.ts:364-366` 은 매 반복 `stream: true` 를 강제한다.

즉 이 PR이 보존하려는 buffered upstream 정책은 프로덕션에서 도달하지 않는다.
정책 훅 자체는 남아 있으므로, 실제로 buffered를 요구하는 프로바이더가 생기면
이 작업을 되살리는 것이 맞다.

코멘트 요지: 경로 부재를 코드로 설명하고, 훅이 남아 있으니 필요해지면 재개를
환영한다고 밝힌다. 조사에 감사를 표한다.

</details>

### PR #1119 (본인) — **close 보류. 커버리지 손실이 있다**

> **"완전 흡수" 주장이 틀렸다.** dev에 착지한 계약은
> `tests/codex-catalog.test.ts:2391-2518` 이며 내장 레지스트리 기본값, destination
> enrichment, 명시적 `false`, `modelReasoningSummaryDelivery` 를 덮는다.
>
> 그러나 #1119는 **임의 커스텀 프로바이더의 명시적
> `modelSupportsReasoningSummaries: true` 가 템플릿 경로와 routed-strip 순서를
> 통과하는지**를 추가로 시험한다. 현재 dev 테스트는 그 경로를 덮지 않는다.
> absent-opt-in과 fallback 경로 어서션도 별개다.
>
> 지금 닫으면 최소 한 건의 실제 회귀 케이스를 잃는다.

**처분 변경: 대체 후 close.** 순서를 바꾼다.

1. 세 테스트 케이스를 현재 dev 위에 다시 만든다(또는 개별 동등성을 증명한다)
2. 그 대체본이 착지한 뒤 #1119를 superseded로 닫고 링크를 남긴다

devlog 16개 문서도 현재 dev에 없다. 보존 가치가 있는 것: 25항목 grade matrix,
provenance/isolation 설계, 기여자 attribution/lease 기록. 낡은 기획 묶음을
그대로 머지하지 말고 정정된 이력 문서 유닛으로 큐레이션한다.

<details>
<summary>원래 close 근거 (부분적으로만 유효)</summary>

주장하는 #1100 계약의 **일부**는 이미 dev에 있다. `tests/codex-catalog.test.ts:2391` 부터:

```ts
test("built-in DeepSeek and GLM effort models opt into Codex reasoning propagation (#1100)", ...)
  { slug: "deepseek/deepseek-v4-flash", efforts: ["low", "high", "max", "ultra"] },
  ...
  expect(routed?.supports_reasoning_summaries).toBe(true);
```

GitHub도 CONFLICTING으로 보고한다. 본인 PR이므로 외부 조율이 필요 없다.

devlog 16개 파일은 살릴 가치가 있으면 분리해 재발행한다.

</details>

## 최종 결과 — close 0건

사용자가 승인한 것은 "위양성은 close" 였다. 감사 결과 **위양성이 아니었다.**
승인 범위 안에 있다고 해서 근거 없이 실행하지 않는다.

| 대상 | 초안 | 최종 | 사유 |
|---|---|---|---|
| PR #1155 | close | **열어둠 + 코멘트** | 도달 가능한 경로. 다만 머지 준비 미완 |
| PR #1119 | close | **대체 후 close** | 커버리지 한 건 손실. 대체본 선행 |
| 이슈 #1128 | close | **tracking** | maintainer가 당일 재시험 요청하며 열어둠 |

## 남은 작업 (다음 사이클)

1. #1155에 철회 코멘트 — 우리 판단 오류를 밝히고 보완 요청
2. #1119의 세 테스트 케이스를 현재 dev에 재작성
3. 그 착지 후 #1119를 superseded로 close
4. #1119의 devlog 16문서 중 보존 가치 있는 것 큐레이션

**close 실행은 이번 사이클에서 하지 않는다.**
