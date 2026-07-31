# 010 — WP1: 콤보 통합 (사이드바 제거 + 모델 페이지 콤보 섹션)

## 파일 변경 맵

| 파일 | 종류 | 내용 |
|------|------|------|
| gui/src/App.tsx | MODIFY | NAV에서 combos 항목 제거, IconShuffle import 제거 |
| gui/src/pages/Models.tsx | MODIFY | 콤보 섹션 추가 (orderHint 다음, groups.map 직전) |
| gui/src/i18n/en.ts | MODIFY | models.combosEmpty / combosSetup / combosAdd / combosActive 키 추가 |
| gui/src/i18n/ko.ts, zh.ts, ru.ts, de.ts | MODIFY | 동일 키 번역 추가 |

## App.tsx diff

```diff
-import { IconGrid, IconServer, IconBoxes, IconShuffle, IconBot, ... } from "./icons";
+import { IconGrid, IconServer, IconBoxes, IconBot, ... } from "./icons";   // IconShuffle 제거 (다른 사용처 없을 때만)

 const NAV: ... = [
   { id: "dashboard", ... },
   { id: "providers", ... },
   { id: "models", ... },
-  { id: "combos", tkey: "nav.combos", Icon: IconShuffle },   // App.tsx:65 제거
   { id: "subagents", ... },
```

유지(변경 금지): `Combos` import(:5), Page 타입의 "combos"(:21), VALID_PAGES(:24),
`main-inner--combos`(:319), `page === "combos"` 렌더 분기(:323), i18n `nav.combos`(ComboWorkspace 제목이 사용).

## Models.tsx diff (핵심)

### 1) import + state (감사 반영: 에러 상태 분리 — blocker #2)

```diff
+import { type ComboItem, parseComboList } from "../combo-workspace-data";
+import { IconShuffle } from "../icons";  // 섹션 헤더 아이콘 (App에서 빠진 아이콘 재활용)

 // 컴포넌트 내부
+const [combos, setCombos] = useState<ComboItem[] | null>(null); // null = 로딩 전/실패
+const [combosError, setCombosError] = useState(false);
+const [combosOpen, setCombosOpen] = useState(() => {
+  try { return localStorage.getItem("ocx-models-combos-open") === "1"; } catch { return false; }
+});
```

접힘 기본값: 접힘(false). localStorage 키는 프로바이더 접힘 배열(`ocx-models-collapsed`)과
분리된 `ocx-models-combos-open` 사용 (001 함정 #2).

### 2) 로드 — 기존 load()에 병합하지 않고 별도 effect (10초 폴링에 /api/combos 편승 안 함)

```tsx
useEffect(() => {
  let cancelled = false;
  fetch(`${apiBase}/api/combos`)
    .then(r => r.ok ? r.json() : Promise.reject(new Error(String(r.status))))
    .then(j => { if (!cancelled) { setCombos(parseComboList(j)); setCombosError(false); } })
    .catch(() => { if (!cancelled) { setCombos(null); setCombosError(true); } });
  return () => { cancelled = true; };
}, [apiBase]);
```

감사 반영(blocker #2): API 실패 시 `combos`를 빈 배열로 두지 않는다. `combosError=true`면
콤보 섹션 전체를 렌더하지 않는다(실패를 "0개"로 오인 금지). 0개 분기는 성공 응답의
`parseComboList()` 결과가 빈 배열일 때만 탄다.

### 3) 렌더 — `:529-532` orderHint 다음, `{groups.map(...)}` 직전 삽입

감사 반영(blocker #3): 헤더 토글은 `role="button"` div가 아니라 **실제 `<button>`**으로,
"설정하기" 링크는 버튼의 자식이 아닌 **형제 요소**로 둔다. 행 배치는 flex 컨테이너가 소유.

콤보 0개 (또는 로드 실패):
(정정: 로드 실패 시에는 섹션 미렌더 — 아래는 성공+0개 전용)

```tsx
<div className="card" style={{ marginBottom: 10 }}>
  <div className="row" style={{ padding: "10px 12px", justifyContent: "space-between" }}>
    <div className="row" style={{ gap: 8 }}>
      <IconShuffle width={14} height={14} aria-hidden="true" />
      <strong>{t("nav.combos")}</strong>
      <span className="muted text-label">{t("models.combosEmpty")}</span>
    </div>
    <a className="btn btn-sm" href="#combos">{t("models.combosSetup")}</a>
  </div>
</div>
```

콤보 1개+ (프로바이더 그룹과 동일 시각 언어, 접이식):

```tsx
<div className="card" style={{ marginBottom: 10 }}>
  <div className={`row group-head${combosOpen ? " open" : ""}`} style={{ gap: 8 }}>
    <button type="button" className="row" aria-expanded={combosOpen}
            onClick={toggleCombosOpen}
            style={{ flex: 1, gap: 8, background: "none", border: "none", padding: 0,
                     cursor: "pointer", font: "inherit", color: "inherit", textAlign: "left" }}>
      <IconChevron style={{ transform: combosOpen ? "rotate(90deg)" : undefined, transition: "transform .15s" }} />
      <strong>{t("nav.combos")}</strong>
      <span className="muted mono text-label">{t("models.combosActive", { count: combos.length })}</span>
    </button>
    <a className="btn btn-sm btn-ghost" href="#combos">{t("models.combosSetup")}</a>
  </div>
  {combosOpen && (
    <div>
      {combos.map(c => (
        <div key={c.id} className="row" style={{ padding: "6px 12px 6px 30px", gap: 8 }}>
          <span className="mono">combo/{c.id}</span>
          <span className="muted text-label">{c.strategy} · {c.targets.length} targets</span>
        </div>
      ))}
      <a className="row muted" href="#combos"
         style={{ padding: "8px 12px 10px 30px", gap: 6, textDecoration: "none" }}>
        + {t("models.combosAdd")}
      </a>
    </div>
  )}
</div>
```

- 키보드 접근성: 네이티브 `<button>`이 Enter/Space를 기본 제공. 중첩 interactive 없음.
- 페이지 헤더 카운터(`models.active`)에 콤보 수 합산 금지 (함정 #6).
- `combos === null`(로딩 전 또는 실패)일 때는 섹션 자체를 렌더하지 않음.
- toggleCombosOpen은 state 반전 + localStorage 기록.

## i18n 키 (en 기준, 5로케일 동일 키)

| 키 | en | ko | zh | ru | de |
|----|----|----|----|----|-----|
| models.combosEmpty | No combos configured yet | 아직 설정된 콤보가 없습니다 | 尚未配置组合 | Комбо ещё не настроены | Noch keine Kombos konfiguriert |
| models.combosSetup | Set up | 설정하기 | 设置 | Настроить | Einrichten |
| models.combosAdd | Add combo | 콤보 추가하기 | 添加组合 | Добавить комбо | Kombo hinzufügen |
| models.combosActive | {count} active | {count}개 활성 | {count} 个已启用 | Активно: {count} | {count} aktiv |

`t()` 보간 형식은 기존 `models.active` 키의 `{active}/{total}` 패턴을 따른다.

## 검증 게이트 (감사 반영 — blocker #5, 정확한 명령)

```
bun run typecheck            # 루트 tsc --noEmit
cd gui && bun run build      # tsc -b && vite build
cd gui && bun run lint:i18n  # i18n 하드코딩 lint
bun run test                 # 루트 bun test (서버 계약 회귀)
```

브라우저 검증(명령 게이트와 분리): 콤보 0개/1개+ 분기, 설정하기/+추가하기 → #combos 이동.

## 수용 기준 (C에서 검증)

1. 사이드바에 콤보 항목 없음, #combos 직접 진입 시 기존 워크스페이스 렌더.
2. 콤보 0개: 한 줄 + 설정하기 버튼 → 클릭 시 #combos.
3. 콤보 1개+: 접힌 헤더(개수 표기), 펼치면 목록 + "+ 콤보 추가하기" → #combos.
4. 키보드로 헤더 토글 가능(Enter/Space).
5. tsc/빌드 통과, 미사용 import 없음.
6. 브라우저 스크린샷 2종(빈 상태는 combos 임시 비우기 어려우면 fetch 차단이 아닌 실제 상태 기준 — 현재 서버에 콤보가 있으면 1개+ 상태 스크린샷 + 0개 상태는 로컬 dev 서버/목으로 검증).

검증 활성화 시나리오(C-ACTIVATION-GROUNDING-01):

- 0개 분기: `/api/combos`가 빈 목록을 반환하는 상태(콤보 임시 삭제 또는 dev 목)로 실렌더 확인.
- 실패 분기: fetch 실패를 유도(dev 서버에서 라우트 차단 등)해 섹션이 미렌더되는지 확인 —
  코드 리뷰 수준 확인도 허용(단순 조건 분기).
