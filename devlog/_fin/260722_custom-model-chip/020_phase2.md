# Phase 2: 프론트엔드 — 헤더+버튼 + 모달 + 행 + 호버팝업 + CSS

## 1. gui/src/pages/Models.tsx 변경

### 1.1 ModelRow 인터페이스 확장

```ts
interface ModelRow {
  // ... 기존 필드 유지
  custom?: boolean;        // 커스텀 모델 여부
  customId?: string;       // 커스텀 모델 UUID
  displayName?: string;    // 커스텀 표시명
  inputModalities?: string[];
}
```

### 1.2 상태 추가

```ts
// 커스텀 모델 모달 상태
const [customModalOpen, setCustomModalOpen] = useState(false);
const [customModalMode, setCustomModalMode] = useState<"add" | "edit">("add");
const [customModalProvider, setCustomModalProvider] = useState("");
const [customModalId, setCustomModalId] = useState("");       // 편집 시 customId
const [customFormModelId, setCustomFormModelId] = useState("");
const [customFormDisplayName, setCustomFormDisplayName] = useState("");
const [customFormContextWindow, setCustomFormContextWindow] = useState("");
const [customFormShowCustomCtx, setCustomFormShowCustomCtx] = useState(false);
const [customFormModalities, setCustomFormModalities] = useState<string[]>(["text"]);
const [customSaving, setCustomSaving] = useState(false);
const [customError, setCustomError] = useState("");

// 호버 팝업 상태
const [hoveredModel, setHoveredModel] = useState<string | null>(null);
const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
```

### 1.3 호버 핸들러

```ts
const onRowEnter = (namespaced: string) => {
  if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
  hoverTimerRef.current = setTimeout(() => setHoveredModel(namespaced), 300);
};
const onRowLeave = () => {
  if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
  setHoveredModel(null);
};
```

### 1.4 CRUD API 호출 함수

```ts
const addCustomModel = async (provider: string, modelId: string, displayName?: string, contextWindow?: number, inputModalities?: string[]) => {
  setCustomSaving(true); setCustomError("");
  try {
    const r = await fetch(`${apiBase}/api/custom-models`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider, modelId, displayName, contextWindow, inputModalities }),
    });
    if (r.ok) {
      setCustomModalOpen(false);
      setOk(true); setStatus(t("models.customAdded"));
      await load();
    } else {
      const data = await r.json().catch(() => null) as { error?: string } | null;
      setCustomError(data?.error ?? t("models.customSaveFailed"));
    }
  } catch { setCustomError(t("models.networkError")); }
  finally { setCustomSaving(false); }
};

const updateCustomModel = async (id: string, patch: Record<string, unknown>) => {
  setCustomSaving(true); setCustomError("");
  try {
    const r = await fetch(`${apiBase}/api/custom-models/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (r.ok) {
      setCustomModalOpen(false);
      setOk(true); setStatus(t("models.customUpdated"));
      await load();
    } else {
      const data = await r.json().catch(() => null) as { error?: string } | null;
      setCustomError(data?.error ?? t("models.customSaveFailed"));
    }
  } catch { setCustomError(t("models.networkError")); }
  finally { setCustomSaving(false); }
};

const deleteCustomModel = async (id: string) => {
  try {
    const r = await fetch(`${apiBase}/api/custom-models/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (r.ok) { setOk(true); setStatus(t("models.customDeleted")); await load(); }
    else { setOk(false); setStatus(t("models.customSaveFailed")); }
  } catch { setOk(false); setStatus(t("models.networkError")); }
};
```

### 1.5 프로바이더 헤더 "+" 버튼

`isNative`가 false인 프로바이더 그룹의 헤더 우측 컨트롤 클러스터 맨 앞에 추가:

```tsx
{!isNative && (
  <button
    type="button"
    className="btn btn-ghost btn-sm text-caption"
    style={{ padding: "2px 8px" }}
    onClick={(e) => {
      e.stopPropagation();
      setCustomModalMode("add");
      setCustomModalProvider(provider);
      setCustomFormModelId("");
      setCustomFormDisplayName("");
      setCustomFormContextWindow("");
      setCustomFormShowCustomCtx(false);
      setCustomFormModalities(["text"]);
      setCustomError("");
      setCustomModalOpen(true);
    }}
    aria-label={t("models.customAdd")}
  >+</button>
)}
```

### 1.6 커스텀 모델 행 렌더링

visible.map 내부에서 `m.custom`일 때 행 우측에 pill + 편집/삭제 버튼 추가:

```tsx
{m.custom && (
  <>
    <span className="muted mono text-caption" style={{ padding: "1px 6px", border: "1px solid var(--border)", borderRadius: "var(--radius-pill)" }}>
      {t("models.customBadge")}
    </span>
  </>
)}
```

### 1.7 호버 팝업 JSX

각 모델 행을 `<div className="model-row-wrap">` 로 감싸고, `hoveredModel === m.namespaced` 일 때 팝업 렌더:

```tsx
<div
  key={m.namespaced}
  className="model-row-wrap"
  onMouseEnter={() => onRowEnter(m.namespaced)}
  onMouseLeave={onRowLeave}
  onFocus={() => setHoveredModel(m.namespaced)}
  onBlur={() => setHoveredModel(null)}
>
  <div className="row" style={{ padding: "5px 0" }}>
    {/* 기존 Switch + code + pill */}
  </div>
  {hoveredModel === m.namespaced && (
    <div className={`model-tip${m.custom ? " has-actions" : ""}`} role="tooltip">
      <div className="model-tip-id">{m.native ? m.id : m.namespaced}</div>
      {m.displayName && <div className="model-tip-display">{m.displayName}</div>}
      {m.custom && (
        <span className="muted mono text-caption" style={{ padding: "1px 6px", border: "1px solid var(--border)", borderRadius: "var(--radius-pill)", display: "inline-block", marginBottom: 4 }}>
          {t("models.customBadge")}
        </span>
      )}
      <div className="model-tip-grid">
        <span className="model-tip-key">{t("models.tipProvider")}</span>
        <span className="model-tip-val">{m.provider}</span>
        {(m.contextWindow || m.contextCap) && (
          <>
            <span className="model-tip-key">{t("models.tipContext")}</span>
            <span className="model-tip-val">{fmtK(m.contextWindow ?? m.contextCap ?? 0)}</span>
          </>
        )}
        {m.inputModalities && m.inputModalities.length > 0 && (
          <>
            <span className="model-tip-key">{t("models.tipModalities")}</span>
            <span className="model-tip-val">{m.inputModalities.join(", ")}</span>
          </>
        )}
        <span className="model-tip-key">{t("models.tipStatus")}</span>
        <span className="model-tip-val">{off ? t("models.tipDisabled") : t("models.tipActive")}</span>
      </div>
      {m.custom && m.customId && (
        <div className="model-tip-actions">
          <button type="button" className="btn btn-ghost btn-sm text-caption" onClick={() => {
            setCustomModalMode("edit");
            setCustomModalProvider(m.provider);
            setCustomModalId(m.customId!);
            setCustomFormModelId(m.id);
            setCustomFormDisplayName(m.displayName ?? "");
            setCustomFormContextWindow(m.contextWindow ? String(m.contextWindow) : "");
            setCustomFormShowCustomCtx(false);
            setCustomFormModalities(m.inputModalities ?? ["text"]);
            setCustomError("");
            setCustomModalOpen(true);
            setHoveredModel(null);
          }}>{t("models.customEdit")}</button>
          <button type="button" className="btn btn-ghost btn-sm text-caption" style={{ color: "var(--red)" }} onClick={() => {
            if (window.confirm(t("models.customDeleteConfirm", { name: m.displayName ?? m.id }))) {
              void deleteCustomModel(m.customId!);
            }
            setHoveredModel(null);
          }}>{t("models.customDelete")}</button>
        </div>
      )}
    </div>
  )}
</div>
```

### 1.8 상단 요약 칩

컨텍스트 제한 행 아래, orderHint 위에:

```tsx
{(() => {
  const customCount = models.filter(m => m.custom).length;
  if (customCount === 0) return null;
  return (
    <div className="row muted text-label" style={{ gap: 6, marginBottom: 8 }}>
      <span className="mono text-caption" style={{ padding: "1px 6px", border: "1px solid var(--border)", borderRadius: "var(--radius-pill)" }}>
        {t("models.customSummary", { count: customCount })}
      </span>
    </div>
  );
})()}
```

### 1.9 커스텀 모델 모달 JSX

v2HelpOpen 모달 패턴 재사용:

```tsx
{customModalOpen && (
  <div className="modal-overlay" role="dialog" aria-modal="true" aria-label={t("models.customAdd")}
    onClick={() => !customSaving && setCustomModalOpen(false)}
    onKeyDown={e => { if (e.key === "Escape" && !customSaving) setCustomModalOpen(false); }}>
    <div className="modal-card" onClick={e => e.stopPropagation()}>
      <div className="modal-head">
        <h3>{customModalMode === "add"
          ? t("models.customAddTitle", { provider: customModalProvider })
          : t("models.customEditTitle", { provider: customModalProvider })}</h3>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setCustomModalOpen(false)} disabled={customSaving}>&times;</button>
      </div>

      {customError && <Notice tone="err">{customError}</Notice>}

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {/* 모델 ID */}
        <label className="text-label" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {t("models.customFieldModelId")}
          <input className="input" value={customFormModelId}
            onChange={e => setCustomFormModelId(e.target.value)}
            disabled={customSaving}
            placeholder={t("models.customFieldModelIdPlaceholder")} />
        </label>

        {/* 표시명 */}
        <label className="text-label" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {t("models.customFieldDisplayName")}
          <input className="input" value={customFormDisplayName}
            onChange={e => setCustomFormDisplayName(e.target.value)}
            disabled={customSaving}
            placeholder={t("models.customFieldDisplayNamePlaceholder")} />
        </label>

        {/* 컨텍스트 윈도우 */}
        <label className="text-label" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {t("models.customFieldContext")}
          <div className="row" style={{ gap: 6 }}>
            <Select
              value={customFormShowCustomCtx ? "custom" : (customFormContextWindow || "")}
              options={[
                { value: "", label: "—" },
                { value: "100000", label: "100k" },
                { value: "128000", label: "128k" },
                { value: "200000", label: "200k" },
                { value: "256000", label: "256k" },
                { value: "352000", label: "352k" },
                { value: "500000", label: "500k" },
                { value: "1000000", label: "1M" },
                { value: "custom", label: t("models.custom") },
              ]}
              onChange={v => {
                if (v === "custom") { setCustomFormShowCustomCtx(true); return; }
                setCustomFormShowCustomCtx(false);
                setCustomFormContextWindow(v);
              }}
              disabled={customSaving}
              label={t("models.customFieldContext")}
            />
            {customFormShowCustomCtx && (
              <input className="input" style={{ width: 120 }} inputMode="numeric"
                value={customFormContextWindow}
                onChange={e => setCustomFormContextWindow(e.target.value)}
                disabled={customSaving}
                placeholder={t("models.customPlaceholder")} />
            )}
          </div>
        </label>

        {/* 입력 모달리티 */}
        <div className="text-label" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {t("models.customFieldModalities")}
          <div className="row" style={{ gap: 8 }}>
            {(["text", "image", "audio"] as const).map(mod => (
              <label key={mod} className="row" style={{ gap: 4, cursor: "pointer" }}>
                <input type="checkbox"
                  checked={customFormModalities.includes(mod)}
                  onChange={e => {
                    setCustomFormModalities(prev =>
                      e.target.checked ? [...prev, mod] : prev.filter(m => m !== mod)
                    );
                  }}
                  disabled={customSaving} />
                <span className="text-control">{mod}</span>
              </label>
            ))}
          </div>
        </div>
      </div>

      <div className="modal-actions">
        <button type="button" className="btn btn-ghost" onClick={() => setCustomModalOpen(false)} disabled={customSaving}>
          {t("common.cancel")}
        </button>
        <button type="button" className="btn btn-primary" disabled={customSaving || !customFormModelId.trim()}
          onClick={() => {
            const modelId = customFormModelId.trim();
            const displayName = customFormDisplayName.trim() || undefined;
            const ctxVal = customFormContextWindow ? Number(customFormContextWindow.replace(/[_,\s]/g, "")) : undefined;
            const contextWindow = ctxVal && ctxVal > 0 ? Math.floor(ctxVal) : undefined;
            const inputModalities = customFormModalities.length > 0 ? customFormModalities : undefined;
            if (customModalMode === "add") {
              void addCustomModel(customModalProvider, modelId, displayName, contextWindow, inputModalities);
            } else {
              void updateCustomModel(customModalId, { modelId, displayName, contextWindow, inputModalities });
            }
          }}>
          {customSaving ? t("models.customSaving") : (customModalMode === "add" ? t("models.customAddBtn") : t("models.customEditBtn"))}
        </button>
      </div>
    </div>
  </div>
)}
```

## 2. gui/src/styles.css 변경

```css
/* ---- model row hover tooltip ---- */
.model-row-wrap { position: relative; }
.model-tip {
  position: absolute; z-index: 10; top: calc(100% + 4px); left: 24px;
  background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-sm);
  padding: 8px 12px; min-width: 220px; max-width: 320px;
  box-shadow: 0 6px 20px rgba(0,0,0,0.35); pointer-events: none;
  font-size: var(--text-label); line-height: var(--leading-relaxed); white-space: nowrap;
}
.model-tip.flip-up { top: auto; bottom: calc(100% + 4px); }
.model-tip.has-actions { pointer-events: auto; }
.model-tip-id { font-family: var(--mono); font-weight: var(--weight-semibold); color: var(--text); margin-bottom: 2px; white-space: normal; word-break: break-all; }
.model-tip-display { color: var(--muted); margin-bottom: 6px; }
.model-tip-grid { display: grid; grid-template-columns: auto 1fr; gap: 2px 12px; margin-bottom: 6px; }
.model-tip-key { color: var(--muted); }
.model-tip-val { color: var(--text); font-family: var(--mono); font-size: var(--text-caption); }
.model-tip-actions { display: flex; gap: 6px; margin-top: 6px; padding-top: 6px; border-top: 1px solid var(--border-soft); }
```

## 3. 검증

- `cd gui && npx vite build` — 빌드 성공
- 수동: 대시보드에서 + 버튼 → 모달 → 추가 → 행 표시 → 호버 팝업 → 편집/삭제

## 4. 리뷰어 Goodall FAIL 3건 수정

### 4.1 i18n 키 목록 (WP3에서 구현, 여기서 명세)

WP2 JSX가 참조하는 모든 새 키:

```
models.customAdd: "커스텀 모델 추가"
models.customAddTitle: "커스텀 모델 추가 — {provider}"
models.customEditTitle: "커스텀 모델 편집 — {provider}"
models.customAdded: "커스텀 모델 추가됨"
models.customUpdated: "커스텀 모델 수정됨"
models.customDeleted: "커스텀 모델 삭제됨"
models.customSaveFailed: "커스텀 모델 저장 실패"
models.customSaving: "저장 중…"
models.customAddBtn: "추가"
models.customEditBtn: "수정"
models.customEdit: "편집"
models.customDelete: "삭제"
models.customDeleteConfirm: "{name} 모델을 삭제하시겠습니까?"
models.customBadge: "커스텀"
models.customSummary: "커스텀 {count}개"
models.customFieldModelId: "모델 ID (엔드포인트 슬러그)"
models.customFieldModelIdPlaceholder: "예: qwen4-max-preview"
models.customFieldDisplayName: "표시명 (선택)"
models.customFieldDisplayNamePlaceholder: "예: Qwen 4 Max Preview"
models.customFieldContext: "컨텍스트 윈도우"
models.customFieldModalities: "입력 모달리티"
models.tipProvider: "프로바이더"
models.tipContext: "컨텍스트"
models.tipModalities: "모달리티"
models.tipStatus: "상태"
models.tipActive: "활성"
models.tipDisabled: "비활성"
```

### 4.2 overflow: hidden 클리핑 해결

프로바이더 카드의 `overflow: "hidden"` 을 제거하지 않고,
호버 팝업을 `position: fixed`로 전환. 기존 `.heatmap-tip` 패턴과 동일.

**상태 변경**: `hoveredModel`을 `string | null`에서
`{ namespaced: string; rect: DOMRect } | null`로 확장.

```ts
const [hoveredModel, setHoveredModel] = useState<{ namespaced: string; rect: DOMRect } | null>(null);
```

**onRowEnter 변경**: 행 요소의 `getBoundingClientRect()`를 캡처.

```ts
const onRowEnter = (namespaced: string, el: HTMLElement) => {
  if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
  hoverTimerRef.current = setTimeout(() => {
    const rect = el.getBoundingClientRect();
    setHoveredModel({ namespaced, rect });
  }, 300);
};
```

**JSX 변경**: `onMouseEnter`에 `e.currentTarget` 전달.

```tsx
onMouseEnter={(e) => onRowEnter(m.namespaced, e.currentTarget as HTMLElement)}
```

**팝업 위치 계산**: `position: fixed` + rect 기반.

```tsx
{hoveredModel?.namespaced === m.namespaced && (() => {
  const r = hoveredModel.rect;
  const tipTop = r.bottom + 4;
  const flipUp = tipTop + 200 > window.innerHeight; // 200px = 대략적 팝업 높이
  return (
    <div
      className={`model-tip${m.custom ? " has-actions" : ""}${flipUp ? " flip-up" : ""}`}
      role="tooltip"
      style={{
        position: "fixed",
        left: r.left + 24,
        ...(flipUp
          ? { bottom: window.innerHeight - r.top + 4 }
          : { top: tipTop }),
      }}
    >
      {/* 팝업 내용 */}
    </div>
  );
})()}
```

### 4.3 CSS 수정

`.model-tip`에서 `position: absolute` 제거 (JSX inline style이 `position: fixed` 설정).
`top`/`left`도 CSS에서 제거 (JSX inline style이 계산값 설정).

```css
.model-tip {
  /* position, top, left는 JSX inline style에서 설정 */
  z-index: 10;
  background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-sm);
  padding: 8px 12px; min-width: 220px; max-width: 320px;
  box-shadow: 0 6px 20px rgba(0,0,0,0.35); pointer-events: none;
  font-size: var(--text-label); line-height: var(--leading-relaxed); white-space: nowrap;
}
.model-tip.has-actions { pointer-events: auto; }
/* flip-up은 JSX inline style이 bottom을 설정하므로 CSS 클래스 불필요 */
```
