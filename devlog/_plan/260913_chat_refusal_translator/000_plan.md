# 000 — Chat 번역기가 거절 없는 턴을 거절 오류로 죽인다

- 단위: `260913_chat_refusal_translator`
- 세션: `01a0985e-ce1a-7d12-81b9-c2e93a2bce67` (HOTL, cxc-loop)
- 기준: `origin/dev` `2df82f412`

## 증상

Aside가 `/v1/chat/completions`로 `devin-cli/swe-2`를 호출한 턴이 정상 스트리밍 중에 죽었다.

```text
There was an error in Opencodex server
upstream refusal representations are inconsistent
```

로그 2건 (`ocx-a89175137a2c5faccc95adc49c9d99b6`, `ocx-5b3270175913077e00d2a3fe1ddc4e83`):

| 항목 | 값 |
|---|---|
| provider / model | `devin-cli` / `swe-2` |
| inboundProtocol | `chat` |
| firstOutputMs | 17148 / 14874 |
| outputTokens | 1057 / 865 |
| durationMs | 30989 / 29088 |
| status | 499 `client_closed_request`, `closeReason: client_cancel` |

모델은 이미 900~1000 토큰을 내보내고 있었다. 번역기가 in-band 오류 프레임을 뱉고
Aside가 그걸 표시한 뒤 연결을 끊은 모양이라 서버 쪽에는 499로 남는다.

**이 턴에는 거절(refusal)이 하나도 없었다.** 그게 이 버그의 핵심이다.

## 근본 원인 — 두 결함의 합

### 1) 번역기가 거절 없는 메시지까지 거절 장부에 올린다

`src/chat/outbound.ts` `snapshotRefusalItem`:

```ts
    // Unrelated sparse text messages historically need no position metadata.
    if (outputIndex === undefined && (!Array.isArray(item.content)
      || !item.content.some(part => isRec(part) && part.type === "refusal"))) return;
    const known = refusalItem(outputIndex, item, "id");   // :308
```

조기 return 조건이 `outputIndex === undefined`로 묶여 있다. 즉 **index가 있기만 하면**
거절 파트가 하나도 없는 평범한 텍스트 메시지도 :308을 지나 `refusalItem()`을 부르고,
그 함수는 `refusalItems[index]`를 만들고 `refusalIndexById[item.id] = index`를 등록한다.

그 뒤 `refusalItem`의 일관성 검사가 일반 텍스트에 적용된다.

```ts
      const knownIndex = refusalIndexById.get(candidate);
      if (knownIndex !== undefined && knownIndex !== index) throw refusalTranslationError();  // :248
      if (item.id !== undefined && item.id !== candidate) throw refusalTranslationError();    // :249
```

비대칭이 증거다. 같은 파일의 **비스트리밍 수집 경로(:788-820)는 이미**
`part.type === "refusal"`로 좁혀져 있고 맵을 시드하지 않는다. 스트리밍 쪽만 넓다.

### 2) bridge가 열린 메시지와 같은 output_index에 reasoning을 끼워 넣는다

`src/bridge.ts` `flushHiddenReasoningEnvelope`(:514-517)는 `currentMsg`를 닫지 않은 채
현재 `outputIndex`로 reasoning 아이템의 `added`/`done`을 emit한다. 그래서 한 index에
서로 다른 두 아이템 id가 실린다.

평소에는 무해하다 — 아무도 index별 id 유일성을 요구하지 않으니까. 결함 1이
그 요구를 거절과 무관한 아이템에까지 걸면서 치명적이 된다.

### 왜 하필 Devin + Aside인가

Devin 어댑터는 proto #9를 `kind: reasoning`으로 낸다. inbound가 `chat`이고 summary가
없으면 `hideThinkingSummary = true`가 되어 숨김 reasoning flush 경로를 탄다. 두 조건이
겹치는 조합이 바로 이것이다.

## 최소 재현 (거절 내용 0건)

| # | event | output_index | item.id | item.type |
|---|---|---|---|---|
| 1 | `response.output_item.added` | 0 | `msg_1` | `message` |
| 2 | `response.output_item.done` | 0 | `rs_1` | `reasoning` |

1이 :308에서 `msg_1`을 심고, 2가 :623 → :299 → :249에서 던진다.

## 고칠 것과 안 고칠 것

**고친다 (wp2):** 번역기가 거절 파트가 실제로 있는 아이템에만 장부를 쓰게 한다.
사용자에게 잘못된 오류를 보내는 쪽이 여기다.

**고치지 않는다 (후속):** bridge의 index 재사용은 그 자체로 Responses 프로토콜상
깔끔하지 않지만, 이번 범위에서 건드리면 reasoning 표시 동작까지 회귀 위험이 생긴다.
별도 단위로 남기고 010에 증거를 기록한다.

## 보존해야 할 계약

`tests/responses/chat-refusal.test.ts`가 유일한 계약 파일이다. 실제 `refusalDelta` 이후의
모순을 요구하는 18개 케이스(165-182, 루프 185)는 수정 후에도 그대로 던져야 한다.

| throw | 언제 의미 있나 |
|---|---|
| :227 :239 :248 :249 | 지금은 일반 텍스트에도 발화 — 좁혀야 함 |
| :269 :273 :278 :302 :315 :570 | 거절 내용이 있을 때만 의미 있음 — 유지 |

## 작업 단계

| wp | 문서 | 산출물 |
|---|---|---|
| wp0 | 이 문서 + 010 + 020 | 로드맵 |
| wp1 | `010_rootcause_evidence.md` | 재현 테스트로 원인 증명 |
| wp2 | `020_fix_refusal_scope.md` | 수정 + PR + merge |

## 완료 기준

`c-1`~`c-5`는 goalplan에 등록돼 있다. 요약하면: 로드맵 존재, 원인 증명, 거절 없는
스트림이 성공, 진짜 거절 모순은 여전히 실패, exact-head hosted CI 성공.

