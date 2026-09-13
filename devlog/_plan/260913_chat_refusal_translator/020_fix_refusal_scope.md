# 020 — wp2: 거절 장부를 거절에만 건다

## MODIFY: src/chat/outbound.ts — snapshotRefusalItem 조기 return

```ts
// before
    // Unrelated sparse text messages historically need no position metadata.
    if (outputIndex === undefined && (!Array.isArray(item.content)
      || !item.content.some(part => isRec(part) && part.type === "refusal"))) return;
    const known = refusalItem(outputIndex, item, "id");

// after
    // Only items that actually carry refusal content belong in the refusal ledger.
    // The position guard used to be the only exit, so any message with an index was
    // enrolled — including ordinary text — and the id/index consistency checks in
    // refusalItem() then applied to streams that contain no refusal at all. A bridge
    // that legitimately reuses one output_index for an open message and a hidden
    // reasoning envelope was enough to fail a healthy turn with invalid_refusal.
    // The non-streaming collector below already scopes itself this way.
    const hasRefusalPart = Array.isArray(item.content)
      && item.content.some(part => isRec(part) && part.type === "refusal");
    if (!existing && !hasRefusalPart) return;
    const known = refusalItem(outputIndex, item, "id");
```

`existing`이 있으면 이미 진짜 거절이 등록된 index이므로 계속 검사한다. 그래야
"거절이 시작된 뒤의 모순"을 잡는 기존 계약이 유지된다.

## MODIFY: src/chat/outbound.ts — output_item 이벤트의 item_id 시드

```ts
// :578 before
              if (Object.hasOwn(data, "item_id")) refusalItem(data.output_index, data, "item_id");
// :578 after
              if (Object.hasOwn(data, "item_id") && refusalItems.has(position(data.output_index))) {
                refusalItem(data.output_index, data, "item_id");
              }
```

`:624`도 같은 형태로 바꾼다. 이미 거절 장부에 오른 index에만 id 일관성을 요구한다.

## 유지

`:297-300`의 희소 스냅샷 ID 검사는 그대로 둔다. 거기는 `existing`이나
`refusalIndexById.has(item.id)`가 이미 참일 때만 동작하므로 원래부터 거절 스코프다.

`:302`, `:315`, `:269`, `:273`, `:278`, `:570`도 그대로. 전부 거절 증거가 있을 때만
도달하는 지점이다.

## 회귀 테스트

010의 표 그대로. 특히 아래 세 개는 수정 후에도 반드시 던져야 한다.

- 실제 거절 델타 뒤 같은 id가 다른 index
- 실제 거절 뒤 한 index에 다른 거절 id
- 거절 스냅샷이 누적 델타의 접두사가 아님

## PR

- base `dev`, 템플릿 3개 절 모두 채움
- 로컬 제품 스위트/typecheck/build/install은 **NOT RUN**으로 명시
- exact-final-head hosted CI가 유일한 머지 증거
- MAINTAINERS.md maintainer-integration 경로로 `dev`에만, 결정과 CI 증거를 PR에 기록

## 범위 밖 (후속)

`src/bridge.ts` `flushHiddenReasoningEnvelope`가 열린 message와 같은 `output_index`에
reasoning을 emit하는 것. 프로토콜상 한 index에 한 아이템이 맞지만, 고치면 reasoning
표시 순서와 Codex 쪽 렌더링까지 영향이 가므로 별도 단위로 둔다. 이번 수정만으로도
사용자에게 보이는 오류는 사라진다.

