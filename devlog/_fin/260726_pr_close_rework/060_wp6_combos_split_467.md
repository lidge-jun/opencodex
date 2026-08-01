# WP6 — PR #467 Combos 분할

대상: PR #467 (Wibias), head `b3324686`. `git merge-tree` clean (tree `09331ff8`).
현재 3개 OS CI가 전부 빨간 상태이며, 원인은 아래 결함 1이다.

## 범위

```bash
git fetch origin pull/467/head:pr-467
git diff 9c7e922ebea660f9ea7c94e438416fa407983f5e..pr-467 -- \
  gui/src/combo-workspace-data.ts \
  gui/src/components/ComboWorkspace.tsx \
  gui/src/components/combo-workspace-add-modal.tsx \
  gui/src/components/combo-workspace-controls.tsx \
  gui/src/components/combo-workspace-detail-panel.tsx \
  gui/src/components/combo-workspace-dialogs.tsx \
  gui/src/components/combo-workspace-overview-panel.tsx \
  gui/src/components/combo-workspace-types.ts \
  gui/src/components/combo-workspace-utils.ts \
  gui/src/pages/Combos.tsx | git apply -3
```

#468과 파일 겹침이 없어 WP5와 순서 의존이 없다.

## 결함 1 — enumerable `clientKey`가 DTO 계약을 깸 (CI 블로커)

`gui/src/combo-workspace-data.ts:21-28`, `:117`, `gui/src/components/combo-workspace-controls.tsx:88-90`.
`parseComboList`가 모든 파싱 대상에 열거 가능한 `clientKey`를 붙여
`tests/combo-workspace-data.test.ts:83`의 정확 객체 비교가 깨진다. 로컬 재현 16 pass / 1 fail.

before:

```ts
export function newComboTarget(partial: Partial<ComboTarget> = {}): ComboTarget {
  return {
    provider: partial.provider ?? "",
    model: partial.model ?? "",
    ...(partial.weight !== undefined ? { weight: partial.weight } : {}),
    clientKey: partial.clientKey ?? `ct-${++comboTargetKeySeq}`,
  };
}
```

after:

```ts
export function newComboTarget(partial: Partial<ComboTarget> = {}): ComboTarget {
  const target: ComboTarget = {
    provider: partial.provider ?? "",
    model: partial.model ?? "",
    ...(partial.weight !== undefined ? { weight: partial.weight } : {}),
  };
  Object.defineProperty(target, "clientKey", {
    value: partial.clientKey ?? `ct-${++comboTargetKeySeq}`,
    enumerable: false,
  });
  return target;
}
```

`TargetEditor.update`도 함께 고쳐야 한다. 비열거 속성은 spread로 복사되지 않아
편집 후 행 key가 불안정해진다.

before:

```ts
const update = (index: number, patch: Partial<ComboTarget>) => {
  onChange(targets.map((row, i) => (i === index ? { ...row, ...patch } : row)));
};
```

after:

```ts
const update = (index: number, patch: Partial<ComboTarget>) => {
  onChange(targets.map((row, i) => (
    i === index
      ? newComboTarget({ ...row, ...patch, clientKey: row.clientKey })
      : row
  )));
};
```

## 결함 2 — add 모달의 backdrop 닫기 상실

`gui/src/components/combo-workspace-add-modal.tsx:77-84`. 기존 오버레이는 카드 바깥
클릭으로 닫혔는데, native `<dialog>` 전환 후 scrim도 dialog 레벨 클릭 핸들러도 없다.

핸들러 추가:

```ts
const handleBackdropClick = useCallback((e: React.MouseEvent<HTMLDialogElement>) => {
  if (e.target === e.currentTarget) requestClose();
}, [requestClose]);
```

여는 태그에 `onClick={handleBackdropClick}` 추가. 기존 `busy` 가드는 유지한다.

## 결함 3 — remove/unsaved 다이얼로그도 동일 문제

`gui/src/components/combo-workspace-dialogs.tsx:33,75`가 `.modal-scrim` 버튼을 추가하지만
저장소 어디에도 이 클래스를 native dialog backdrop에 배치하는 CSS가 없다. 무동작이다.

`RemoveComboDialog`: 같은 패턴으로 `onCancel` 기반 `handleBackdropClick`을 추가하고
`<dialog>`에 연결한 뒤, 무효한 scrim 버튼을 제거한다.

```tsx
<button type="button" className="modal-scrim" aria-label={t("common.close")} onClick={onCancel} />
```

`UnsavedLeaveDialog`: `onKeep` 기반으로 동일 처리.

## 회귀 테스트 1 — DTO 계약

APPEND: `tests/combo-workspace-data.test.ts` (import에 `newComboTarget` 추가)

```ts
test("newComboTarget exposes a stable non-enumerable UI key without changing the DTO shape", () => {
  const target = newComboTarget({
    provider: "a",
    model: "m1",
    weight: 3,
  });

  expect(target.clientKey).toMatch(/^ct-\d+$/);
  expect(target).toEqual({
    provider: "a",
    model: "m1",
    weight: 3,
  });
  expect(Object.keys(target)).toEqual(["provider", "model", "weight"]);

  const updated = newComboTarget({
    ...target,
    model: "m2",
    clientKey: target.clientKey,
  });

  expect(updated.clientKey).toBe(target.clientKey);
  expect(updated).toEqual({
    provider: "a",
    model: "m2",
    weight: 3,
  });
});
```

RED→GREEN 근거: 수정 전에는 두 정확 비교가 예기치 않은 `clientKey`를 포함해 실패한다.
수정 후에는 속성 접근은 되지만 동등성/직렬화에서 무시된다.
`tests/combo-workspace-data.test.ts:83`의 기존 테스트가 이미 독립적인 RED 신호다.

## 회귀 테스트 1b — TargetEditor 편집 경로 (A-gate blocker 5)

위 테스트는 `newComboTarget`을 직접 두 번 부를 뿐 `TargetEditor`를 렌더하지도,
update 콜백을 호출하지도 않는다. 결함 1의 두 번째 훅(spread가 비열거 속성을 잃는 문제)이
되살아나도 이 테스트는 통과한다. 컴포넌트 레벨 테스트를 추가한다.

NEW: `gui/tests/combo-workspace-target-editor.test.tsx`

실제 시그니처를 `git show pr-467:gui/src/components/combo-workspace-controls.tsx`에서
확인해 확정했다 (A-gate R2 blocker 4). `TargetEditor`는 `strategy`가 필수이고,
`providers`는 `ProviderOption[]`, `models`는 `ModelOption[]`이다. 모델 컨트롤은
`<input>`이 아니라 `aria-label={t("cws.target.model")}`을 가진 `<select>`이고,
이벤트는 `input`이 아니라 `change`다.

```tsx
test("editing a target preserves its original non-enumerable clientKey", async () => {
  const initial = newComboTarget({ provider: "a", model: "m1", weight: 3 });
  const originalKey = initial.clientKey;
  let emitted: ComboTarget[] = [];

  await render(
    <TargetEditor
      targets={[initial]}
      strategy="failover"
      providers={[{ name: "a", disabled: false }]}
      models={[
        { id: "m1", provider: "a" },
        { id: "m2", provider: "a" },
      ]}
      onChange={next => { emitted = next; }}
    />,
  );

  // The model control is a <select> keyed by its accessible name, not a data-role input.
  const modelSelect = container.querySelector<HTMLSelectElement>(
    'select[aria-label="Model"]',
  );
  expect(modelSelect).not.toBeNull();
  expect(modelSelect!.disabled).toBe(false);

  await act(async () => {
    modelSelect!.value = "m2";
    modelSelect!.dispatchEvent(new win.Event("change", { bubbles: true }));
  });

  expect(emitted).toHaveLength(1);
  expect(emitted[0]!.model).toBe("m2");
  expect(emitted[0]!.clientKey).toBe(originalKey);
  expect(Object.keys(emitted[0]!)).toEqual(["provider", "model", "weight"]);
});
```

하네스는 WP5의 `gui/tests/react-doctor-pages.test.tsx`와 동일한 happy-dom 전역 설정을 쓴다
(`LanguageProvider` 래핑 포함).

`aria-label`은 `t("cws.target.model")`의 en-US 렌더 결과다. B 단계에서 로케일 사전의
실제 문자열을 확인해 selector를 확정한다. `ProviderOption`/`ModelOption`의 정확한 필드도
`gui/src/components/combo-workspace-types.ts`에서 대조한다.

`strategy="failover"`를 쓰는 이유: `round-robin`일 때만 weight `<input>`이 렌더되는데,
이 테스트는 model select만 필요하므로 최소 구성을 쓴다.

RED→GREEN 근거: 수정 전 `update`는 `{ ...row, ...patch }`라 비열거 `clientKey`를 잃고
`emitted[0].clientKey`가 `undefined`가 된다.

## 회귀 테스트 2 — backdrop 닫기

NEW: `gui/tests/combo-workspace-add-modal.test.tsx`

`AddComboModal`을 `LanguageProvider`로 감싸 렌더한 뒤 `<dialog>` 자체에
bubbling click을 디스패치해 `onClose`가 정확히 1회 호출되는지 확인한다.

```tsx
const dialog = container.querySelector("dialog");
expect(dialog).not.toBeNull();

await act(async () => {
  dialog!.dispatchEvent(new win.MouseEvent("click", { bubbles: true }) as unknown as MouseEvent);
});

expect(closes).toBe(1);
```

RED→GREEN 근거: PR head에는 dialog 클릭 핸들러가 없어 `closes`가 0이다.

## 활성화 시나리오

새 분기: `Object.defineProperty`로 만든 비열거 속성 경로(테스트 1의 `Object.keys` 비교),
`e.target === e.currentTarget` 자기타겟 판정(테스트 2). 관찰 효과는 각각
DTO 키 목록과 `onClose` 호출 횟수다.

## 커밋

```
refactor(gui): split Combos workspace without leaking UI keys into the DTO (#467)

Co-authored-by: Wibias <37517432+Wibias@users.noreply.github.com>
```

## 검증

```bash
bun test tests/combo-workspace-data.test.ts
cd gui && bun test tests/combo-workspace-add-modal.test.tsx && cd ..
bun run typecheck
bun run lint:gui
```
