# 호버 팝업 설계 — 모델 행 툴팁

> 2026-07-22 · 세션 019f86f8-f5d9-72a3-b968-e0d69b180c4f
> 메인 devlog: [001-design-investigation.md](./001-design-investigation.md)

## 1. 목적

모델 행에 마우스를 올리면 행 아래에 플로팅 팝업이 나타난다.
모델의 메타데이터(컨텍스트 윈도우, 모달리티, 출처, 상태)를
행 자체를 clutter하지 않으면서 확인할 수 있게 한다.
커스텀 모델의 경우 편집/삭제 버튼도 팝업 안에 배치하여
행 레이아웃을 깔끔하게 유지.

## 2. 기존 패턴 재사용

Usage 페이지의 `.heatmap-tip` / `.daybar-tip` 패턴을 그대로 따른다.

| 속성 | 값 | 출처 |
|------|-----|------|
| position | `absolute` (행 기준) | `.daybar-tip` |
| z-index | 10 | `.heatmap-tip` |
| background | `var(--surface)` | 공통 |
| border | `1px solid var(--border)` | 공통 |
| border-radius | `var(--radius-sm)` (8px) | 공통 |
| box-shadow | `0 6px 20px rgba(0,0,0,0.35)` | 공통 |
| pointer-events | `none` (기본) | `.heatmap-tip` |
| font-size | `var(--text-label)` (12px) | 공통 |

## 3. 팝업 레이아웃

### 3.1 일반 모델 (라우팅 + 네이티브)

```
┌─────────────────────────────────────────┐
│  qwen3.8-max-preview                    │  ← 모델 ID (mono, semibold)
│  Qwen 3.8 Max Preview                   │  ← displayName (있을 때만, muted)
│                                          │
│  프로바이더    alibaba-token-plan-intl    │  ← provider (mono)
│  컨텍스트      352k                       │  ← contextWindow 또는 contextCap
│  모달리티      text, image                │  ← inputModalities (없으면 숨김)
│  상태          활성                       │  ← disabled ? "비활성" : "활성"
└─────────────────────────────────────────┘
```

### 3.2 커스텀 모델 (추가 정보 + 액션)

```
┌─────────────────────────────────────────┐
│  qwen4-max-preview                      │  ← 모델 ID (mono, semibold)
│  Qwen 4 Max Preview                     │  ← displayName
│  [커스텀]                                │  ← pill 뱃지
│                                          │
│  프로바이더    alibaba-token-plan-intl    │
│  컨텍스트      200k                       │
│  모달리티      text                       │
│  추가일        2026-07-22                 │  ← addedAt
│  상태          활성                       │
│                                          │
│  [편집]  [삭제]                           │  ← ghost 버튼 (pointer-events: auto)
└─────────────────────────────────────────┘
```

## 4. 동작 명세

### 4.1 표시/숨김 타이밍

- `onMouseEnter` → **300ms 딜레이** 후 팝업 표시
  (실수로 행을 스칠 때 팝업이 깜빡이지 않도록)
- `onMouseLeave` → **즉시** 숨김 (딜레이 없음)
- `onFocus` (키보드) → 즉시 표시
- `onBlur` (키보드) → 즉시 숨김

### 4.2 위치

- 행의 `position: relative` 컨테이너 기준 `position: absolute`
- 기본: 행 아래쪽 (`top: calc(100% + 4px)`, `left: 24px`)
  — 토글 스위치 오른쪽부터 시작하여 모델 ID와 정렬
- 뷰포트 하단 경계 충돌 시: 위쪽으로 플립 (`bottom: calc(100% + 4px)`)
  — `getBoundingClientRect()`로 경계 체크

### 4.3 pointer-events 전환

- 기본: `pointer-events: none` (팝업이 마우스 이벤트를 가로채지 않음)
- 커스텀 모델 팝업: `pointer-events: auto`
  (편집/삭제 버튼을 클릭할 수 있도록)
- `pointer-events: auto`일 때 팝업 자체에도 `onMouseLeave` 핸들러를 달아
  팝업에서 마우스가 나가면 숨김

### 4.4 상태 관리

```ts
// Models.tsx 내부
const [hoveredModel, setHoveredModel] = useState<string | null>(null);
const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

const onRowEnter = (namespaced: string) => {
  if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
  hoverTimerRef.current = setTimeout(() => setHoveredModel(namespaced), 300);
};

const onRowLeave = () => {
  if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
  setHoveredModel(null);
};
```

## 5. CSS

```css
/* 모델 행 호버 팝업 — .daybar-tip 패턴 상속 */
.model-row-wrap { position: relative; }

.model-tip {
  position: absolute;
  z-index: 10;
  top: calc(100% + 4px);
  left: 24px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 8px 12px;
  min-width: 220px;
  max-width: 320px;
  box-shadow: 0 6px 20px rgba(0,0,0,0.35);
  pointer-events: none;
  font-size: var(--text-label);
  line-height: var(--leading-relaxed);
  white-space: nowrap;
}

.model-tip.flip-up {
  top: auto;
  bottom: calc(100% + 4px);
}

.model-tip.has-actions {
  pointer-events: auto;
}

.model-tip-id {
  font-family: var(--mono);
  font-weight: var(--weight-semibold);
  color: var(--text);
  margin-bottom: 2px;
  white-space: normal;
  word-break: break-all;
}

.model-tip-display {
  color: var(--muted);
  margin-bottom: 6px;
}

.model-tip-grid {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 2px 12px;
  margin-bottom: 6px;
}

.model-tip-key {
  color: var(--muted);
}

.model-tip-val {
  color: var(--text);
  font-family: var(--mono);
  font-size: var(--text-caption);
}

.model-tip-actions {
  display: flex;
  gap: 6px;
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px solid var(--border-soft);
}
```

## 6. 접근성

- 팝업 컨테이너: `role="tooltip"`
- 행: `aria-describedby={tipId}` (팝업이 열려 있을 때만)
- 키보드: Tab으로 행 포커스 시 팝업 표시, Escape로 닫기
- `prefers-reduced-motion`: 딜레이 없이 즉시 표시/숨김

## 7. 구현 파일

| 파일 | 변경 |
|------|------|
| `gui/src/pages/Models.tsx` | `hoveredModel` 상태 + `onRowEnter`/`onRowLeave` + 팝업 JSX |
| `gui/src/styles.css` | `.model-tip*` 클래스 추가 |
| `gui/src/i18n/*.ts` | 팝업 라벨 키 추가 (프로바이더, 컨텍스트, 모달리티, 상태, 추가일) |
