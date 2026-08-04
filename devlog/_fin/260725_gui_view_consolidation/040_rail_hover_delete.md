# 040 — Providers 레일 행 호버 삭제 (WP4)

> 상위: [`000_plan.md`](./000_plan.md) · 기준 `origin/dev` @ `3f2098d0`
> 사용자가 브라우저에서 직접 지목한 지점: "이런곳 호버했을때 바로 휴지통 버튼
> 뜨도록 (휴지통이 초록불 위에 호버)"

## 목적

Providers workspace 레일에서 프로바이더 행에 마우스를 올리면 우측 상태 표시등
자리에 휴지통이 나타나고, 확인 모달을 거쳐 삭제된다. 지금은 행을 선택해서 상세로
들어간 뒤 헤더의 휴지통을 눌러야 한다.

## 현재 상태

### 삭제 핸들러는 이미 있다 — 다만 레일까지 전달되지 않는다

```text
Providers.tsx:397-399     removeProvider(name) → setRemoveConfirmName(name)  (모달만 연다)
Providers.tsx:401-405     confirmRemoveProvider() → 실제 DELETE 수행
Providers.tsx:653-659     {removeConfirmName && <RemoveConfirmDialog .../>}
Providers.tsx:623         onRemoveProvider={removeProvider}  ← ProviderDetails 에만 전달됨
ProviderDetails.tsx:151-160   그 콜백을 받아 IconTrash 버튼을 그린다
```

**중요:** `removeProvider`는 이미 확인 모달을 여는 함수다. 즉시 삭제가 아니다.
따라서 레일에서 그대로 호출해도 `RemoveConfirmDialog`를 거친다 — 별도 확인 로직을
만들 필요가 없다.

다만 `ProviderWorkspaceShell`은 현재 이 콜백을 **받지 않는다**. 레일은 shell 안에
있으므로 prop 전달 경로를 새로 뚫어야 한다:

```text
Providers.tsx  →  ProviderWorkspaceShell (신규 prop)  →  RailRow 래퍼
```

### 행의 DOM 구조가 제약이다

```text
ProviderRail.tsx:86-90    <button role="option" aria-selected className="providers-workspace-rail-row">
ProviderRail.tsx:118-131  마지막 자식이 <span className="providers-workspace-rail-trail">
                          그 안에 pwi-default-star(조건부) + railStatusCls 상태점
ProviderWorkspaceShell.tsx:417-429  items.map(item => <RailRow ... />) — 행 래퍼가 없다
                                    (RailRow 요소가 :418-429 를 차지한다)
```

CSS도 제약을 건다:

```text
provider-workspace-shell.css:209-227
  .providers-workspace-rail-row {
    display: grid;
    grid-template-columns: var(--icon-lg) minmax(0,1fr) max-content;
    overflow: hidden;        <- 넘치는 자식이 잘린다
  }
  (position 속성 없음)
```

### 000_plan.md의 초기 서술은 틀렸다

계획서 WP4는 "형제 요소로 배치하고 행은 `position: relative`로 잡는다"고 적었는데,
**형제는 형제를 기준으로 절대 배치되지 않는다.** 게다가 행을 감싸는 래퍼가 아예
없어서 형제를 만들 자리 자체가 없다. 이 문서가 그 서술을 대체한다.

### 행 안에 버튼을 넣으면 깨지는 것들

| 문제 | 근거 |
| --- | --- |
| `<button>` 안의 `<button>`은 유효하지 않은 HTML | `ProviderRail.tsx:86` |
| `role="option"` 안의 인터랙티브 자손은 접근성 위반 | 같은 곳 |
| 클릭 버블링으로 삭제와 선택이 동시에 일어남 | `onClick={onClick}` (`:88`) |
| 키보드 탐색이 어긋남 — `el.contains(active)`가 삭제 버튼 포커스를 행 포커스로 취급 | `ProviderWorkspaceShell.tsx:392` |
| 호버 전용 노출은 키보드/터치 사용자에게 보이지 않음 | 설계 문제 |

## 변경 계획

### 1. 행 래퍼 도입 (`ProviderWorkspaceShell.tsx`)

`items.map`이 `RailRow`를 직접 뱉는 대신 래퍼로 감싼다.

```text
before:  {items.map(item => <RailRow key={item.name} item={item} ... />)}

after:   {items.map(item => (
           <div key={item.name} className="pws-rail-row-wrap">
             <RailRow item={item} ... />
             {onRemoveProvider && (
               <button
                 type="button"
                 className="pws-rail-row-remove"
                 tabIndex={-1}
                 aria-hidden="true"
                 onClick={e => { e.stopPropagation(); onRemoveProvider(item.name); }}
                 title={t("pws.removeConfirmTitle")}
               >
                 <IconTrash />
               </button>
             )}
           </div>
         ))}
```

**`tabIndex={-1}` + `aria-hidden`인 이유:** 이 버튼은 마우스 사용자를 위한
가속 경로일 뿐이고, 키보드/스크린리더 사용자에게는 이미
`ProviderDetails.tsx:151-160`의 접근 가능한 삭제 버튼이 있다. 레일 버튼을 탭 순서에
넣으면 `listbox` 옵션 탐색이 흐트러진다(`ProviderWorkspaceShell.tsx:389-392`).
접근 경로를 새로 만드는 게 아니라 기존 경로의 단축키를 더하는 것이므로, 보조기술에
중복 노출하지 않는 편이 낫다.

> 대안으로 `tabIndex={0}`을 주고 `listbox` 키보드 핸들러에서 제외하는 방법도
> 있지만, `options.findIndex(el => el === active || el.contains(active))`가
> 래퍼 기준으로 다시 계산돼야 해서 회귀 위험이 크다. B단계에서 첫 번째 안으로
> 구현하고, 실제 스크린리더 확인 후 필요하면 승격한다.

### 2. 래퍼 CSS (`provider-workspace-shell.css`)

```css
.pws-rail-row-wrap { position: relative; }

.pws-rail-row-remove {
  position: absolute;
  right: var(--space-2);
  top: 50%;
  transform: translateY(-50%);
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--motion-fast);
  /* 나머지는 btn-ghost btn-icon-only 규약 재사용 */
}

.pws-rail-row-wrap:hover .pws-rail-row-remove,
.pws-rail-row-wrap:focus-within .pws-rail-row-remove {
  opacity: 1;
  pointer-events: auto;
}

@media (hover: none) {
  /* 터치 기기에서는 호버가 없다 — 노출하지 않고 상세 화면 경로를 쓴다 */
  .pws-rail-row-remove { display: none; }
}
```

행의 `overflow: hidden`(`:225`)은 그대로 둔다. 휴지통이 래퍼 기준 절대배치라
행 내부 클리핑 대상이 아니다.

### 3. 상태점과의 겹침

사용자 요구는 "휴지통이 초록불 위에 호버"다. 상태점은
`providers-workspace-rail-trail` 안에 있고(`ProviderRail.tsx:118-131`), 래퍼 절대배치
휴지통이 그 위를 덮는다. 별도 처리 없이 z축으로 겹친다 — 다만 상태점이 비쳐
보이지 않도록 휴지통 버튼에 배경(`background: var(--surface)`)을 준다.

### 4. prop 경로 (확정 — B단계로 미루지 않는다)

`ProviderWorkspaceShell`의 prop 계약에 추가한다:

```text
// ProviderWorkspaceShell.tsx — props 인터페이스
+ onRemoveProvider?: (name: string) => void;

// Providers.tsx — shell 호출부
// 현재 onRemoveProvider 는 ProviderDetails 렌더 함수 안(:623)에서만 쓰인다.
// shell 자체에도 같은 함수를 넘긴다.
  <ProviderWorkspaceShell
    ...
+   onRemoveProvider={removeProvider}
  />
```

`ProviderWorkspaceShell.tsx`에 `IconTrash` import를 추가한다 (현재 없다).

호출 시 동작 흐름:

```text
레일 휴지통 클릭
  → removeProvider(name)              Providers.tsx:397-399
  → setRemoveConfirmName(name)
  → <RemoveConfirmDialog>             Providers.tsx:653-659
  → 사용자 확인 → confirmRemoveProvider()  Providers.tsx:401-405
```

**확인 모달은 자동으로 경유된다.** 별도 구현이 필요 없다.

## 검증

```bash
bun run typecheck
bun run lint:gui
bun run test                      # 루트 스위트 (./tests/)
(cd gui && bun test tests)        # GUI 스위트 — 루트 test 는 gui/tests 를 돌리지 않는다
bun run privacy:scan
bun run build:gui
git diff --check
```

> **주의:** 저장소 루트에서 `bun test gui/tests/foo.test.ts` 는 경로가 아니라
> **필터**로 해석되어 아무 파일도 매칭하지 않고 조용히 통과한다.
> `scripts/test.ts:38-41` 의 기본값은 `./tests/` 뿐이다. GUI 테스트는 반드시
> `cd gui && bun test tests` 형태로 돌린다
> (`gui/package.json:10`, `.github/workflows/ci.yml:75-76` 과 동일한 방식).

브라우저(로컬 Vite 5199):

1. `#providers/workspace`에서 레일 행에 마우스 올리기 → 휴지통 노출 스크린샷
2. 휴지통 클릭 → 확인 모달 스크린샷
3. 모달 취소 → 프로바이더가 남아있는지 확인
4. 레일에 포커스 두고 ArrowDown/ArrowUp/Home/End → 행 사이 이동이 정상인지 확인
   (회귀 확인 — `ProviderWorkspaceShell.tsx:389-401`)

## 위험

- **키보드 탐색 회귀.** 래퍼 도입으로 `options` 쿼리 결과가 바뀌지 않아야 한다.
  `querySelectorAll('[role="option"]')`는 여전히 `RailRow`만 잡으므로 이론상 안전하지만
  실제 확인이 필요하다.
- **실수 삭제.** 호버만으로 파괴 버튼이 나타나므로 확인 모달이 유일한 방어선이다.
  모달 없이 즉시 삭제되면 안 된다.
- **선택 상태와의 상호작용.** 선택된 행은 배경이 다르다(`:230-234`). 휴지통 배경이
  그 위에서도 읽히는지 확인한다.
