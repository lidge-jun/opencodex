# 020 — WP2: 로그&디버그 통합 (탭 + #debug 하위호환)

## 라우팅 설계 (방안 A — providers/workspace 선례)

- canonical: `#logs` (로그 탭), `#logs/debug` (디버그 탭)
- 레거시 `#debug` → `#logs/debug` 리다이렉트 (hashchange + 초기 로드 양쪽)
- Page 타입에서 `"debug"` 제거, VALID_PAGES에서 제거, NAV에서 debug 항목 제거
- Debug.tsx 컴포넌트 파일은 유지(탭 패널로 렌더)

## 파일 변경 맵

| 파일 | 종류 | 내용 |
|------|------|------|
| gui/src/App.tsx | MODIFY | Page/VALID_PAGES/NAV에서 debug 제거, 해시 정규화에 logs/debug 지원, 레거시 #debug 리다이렉트, LogsDebug 렌더로 교체, IconTerminal import 정리 |
| gui/src/pages/Logs.tsx | MODIFY | 페이지 상단에 밑줄형 tablist(로그/디버그) 추가, 디버그 탭이면 Debug 컴포넌트 조건부 렌더 |
| gui/src/pages/Debug.tsx | MODIFY | 자체 page-head 제목을 탭 컨텍스트에 맞게 유지/축소 (중복 헤더 제거) |
| gui/src/styles.css | MODIFY | `.page-tabs`/`.page-tab` 밑줄형 탭 클래스 추가 (pws-detail-tab 참조 스타일) |
| gui/src/i18n/en,ko,zh,ru,de.ts | MODIFY | nav.logs 개칭, logs.tabLogs/logs.tabDebug 추가, debug.subtitle 문구 수정 |
| structure/05_gui-and-management-api.md | MODIFY | Debug 독립 페이지(`/#debug`) 서술을 Logs 탭 통합 + 레거시 리다이렉트로 갱신 (감사 blocker #6, SOT-SYNC-01) |

## App.tsx diff

```diff
-type Page = ... | "logs" | "debug" | ...;
+type Page = ... | "logs" | ...;            // "debug" 제거

-const VALID_PAGES = new Set<Page>([..., "logs", "debug", ...]);
+const VALID_PAGES = new Set<Page>([..., "logs", ...]);

 function readPageFromHash(): Page {
   const raw = location.hash.replace(/^#\/?/, "");
   const pageId = raw.split("/")[0] as Page;
+  if (raw === "debug" || raw.startsWith("debug/")) return "logs";   // 레거시 매핑
   return VALID_PAGES.has(pageId) ? pageId : "dashboard";
 }

 function hashBelongsToPage(rawHash: string, page: Page): boolean {
-  return rawHash === page || (page === "providers" && rawHash === "providers/workspace");
+  return rawHash === page
+    || (page === "providers" && rawHash === "providers/workspace")
+    || (page === "logs" && rawHash === "logs/debug");
 }
```

hashchange 핸들러(onHash)와 초기 정규화 effect에 레거시 처리 추가:

```diff
 const onHash = () => {
   const nextPage = readPageFromHash();
   const rawHash = window.location.hash.replace(/^#\/?/, "");
   setNavOpen(false);
+  if (rawHash === "debug" || rawHash.startsWith("debug/")) {
+    window.location.hash = "logs/debug";   // 리다이렉트 → 다음 hashchange에서 정상 처리
+    return;
+  }
   if (!hashBelongsToPage(rawHash, nextPage)) { ... }
```

초기 로드 정규화 effect(`[page]` 의존)에도 동일한 레거시 가드 추가
(초기 hash가 `#debug`인 채 마운트되면 `#logs/debug`로 교체).

NAV:

```diff
-  { id: "logs", tkey: "nav.logs", Icon: IconList },
-  { id: "debug", tkey: "nav.debug", Icon: IconTerminal },
+  { id: "logs", tkey: "nav.logs", Icon: IconList },   // 라벨은 i18n에서 "로그&디버그"로
```

렌더:

```diff
-  {page === "logs" && <Logs apiBase={API_BASE} />}
-  {page === "debug" && <Debug apiBase={API_BASE} />}
+  {page === "logs" && <Logs apiBase={API_BASE} />}    // Logs가 내부에서 탭 처리
```

`Debug` import는 App에서 제거되고 Logs.tsx로 이동. IconTerminal은 다른 사용처 없으면 import 정리.

## Logs.tsx diff (탭 소유)

```tsx
import Debug from "./Debug";

type LogsTab = "logs" | "debug";
function readTabFromHash(): LogsTab {
  return window.location.hash.replace(/^#\/?/, "") === "logs/debug" ? "debug" : "logs";
}

export default function Logs({ apiBase }: { apiBase: string }) {
  const [tab, setTab] = useState<LogsTab>(readTabFromHash);
  useEffect(() => {
    const onHash = () => setTab(readTabFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const selectTab = (next: LogsTab) => {
    window.location.hash = next === "debug" ? "logs/debug" : "logs";  // 해시가 SSOT, hashchange가 setTab
  };
  ...
}
```

렌더 구조 — **확정(감사 blocker #4)**: 별도 LogsPanel 추출 없이 기존 `Logs` 컴포넌트가
탭 상태와 두 패널을 모두 소유한다. 기존 로그 관련 hook(logs/autoRefresh/detail/
surfaceFilter state, 폴링 effect, virtualizer)은 `Logs` 본체에 그대로 남긴다.
React hooks 규칙상 hook은 조기 return 없이 항상 호출되고, 렌더만 `tab`으로 분기한다.
로그 폴링 effect는 `tab !== "logs"`일 때 폴링을 건너뛰도록 조건을 추가한다
(디버그 탭에서 /api/logs 2초 폴링 중단).

```tsx
return (
  <>
    <div className="page-head">
      <h2>{t("nav.logs")}</h2>
      {tab === "logs" && <label ...>자동 새로고침 체크박스 (기존)</label>}
    </div>
    <div className="page-tabs" role="tablist" aria-label={t("nav.logs")}>
      <button role="tab" id="tab-logs" aria-selected={tab === "logs"} aria-controls="panel-logs"
              tabIndex={tab === "logs" ? 0 : -1}
              className={`page-tab${tab === "logs" ? " page-tab--active" : ""}`}
              onClick={() => selectTab("logs")} onKeyDown={onTabKeyDown}>
        {t("logs.tabLogs")}
      </button>
      <button role="tab" id="tab-debug" ... onClick={() => selectTab("debug")}>
        {t("logs.tabDebug")}
      </button>
    </div>
    {tab === "logs"
      ? <div role="tabpanel" id="panel-logs" aria-labelledby="tab-logs">…기존 로그 UI 전부…</div>
      : <div role="tabpanel" id="panel-debug" aria-labelledby="tab-debug"><Debug apiBase={apiBase} embedded /></div>}
  </>
);
```

- 키보드: ArrowLeft/Right + Home/End (ProviderDetails.tsx:114-129 로직 축약 적용, 탭 2개라 간단).
- 조건부 렌더 = 언마운트 → 폴링 자동 정리 (001 검증: Logs/Debug 모두 cleanup 완비, SSE 없음).
- 페이지 탭은 밑줄형 `.page-tab`, 로그 내부 surface pill 세그먼트는 그대로 유지 (계층 구분).
- 기존 Logs page-head는 통합 헤더로 승격: 제목 키는 `nav.logs` 사용.

## Debug.tsx diff — 확정(감사 blocker #4)

- `embedded?: boolean` prop 추가 (Logs가 `<Debug apiBase={apiBase} embedded />`로 렌더).
- embedded일 때 제거: `page-head` 래퍼의 `<h2>{t("debug.title")}</h2>` 제목만.
- embedded일 때 유지: 수동 refresh 버튼, follow 체크박스(제목 없는 `.row`로 재배치),
  subtitle, 플래그 Switch 행, stream 선택, Claude 테이블, 로그 뷰 전부.
- 단독 라우트는 더 이상 없으므로 `embedded` 기본값 false 분기는 사실상 사용되지 않지만
  컴포넌트 재사용성을 위해 유지.
- 나머지 로직(폴링/cleanup) 변경 없음.

## styles.css 추가

```css
.page-tabs { display: flex; gap: 2px; border-bottom: 1px solid var(--border); margin-bottom: 12px; }
.page-tab { appearance: none; background: none; border: none; border-bottom: 2px solid transparent;
  padding: 8px 12px; color: var(--muted); cursor: pointer; font: inherit; }
.page-tab:hover { color: var(--text); }
.page-tab--active { color: var(--text); border-bottom-color: var(--accent); }
.page-tab:focus-visible { outline: 2px solid var(--accent-ring); outline-offset: -2px; }
```

토큰 확정(감사 blocker #1): 이 리포에 `--fg`는 없음. 텍스트는 `--text`, 포커스는
`--accent-ring` 사용 (styles.css:30-39 토큰 정의 기준). B에서 `--accent`/`--accent-ring`
실존만 재확인.

## i18n

| 키 | en | ko | zh | ru | de |
|----|----|----|----|----|-----|
| nav.logs (개칭) | Logs & Debug | 로그&디버그 | 日志与调试 | Логи и отладка | Logs & Debug |
| logs.tabLogs (신규) | Logs | 로그 | 日志 | Логи | Logs |
| logs.tabDebug (신규) | Debug | 디버그 | 调试 | Отладка | Debug |

- `nav.debug`: NAV에서 참조 제거. 키 자체는 TKey 원본(en)에서 제거하면 5로케일 모두 제거 필요 —
  다른 참조 없음을 rg로 확인 후 제거(참조 남으면 유지).
- `debug.subtitle` 5로케일: "Logs 페이지에 표시" 류 표현을 "로그 탭에 표시"로 수정.
  실라인(감사 blocker #7 반영): en:370, ko:364, de:351, ru:372, zh:364 — B에서 rg로 재고정.

## 검증 게이트 (감사 blocker #5 — 정확한 명령)

```
bun run typecheck            # 루트 tsc --noEmit
cd gui && bun run build      # tsc -b && vite build
cd gui && bun run lint:i18n
bun run test
```

브라우저 검증(분리): #logs 기본 탭, 탭 클릭 전환+해시 반영, #debug 리다이렉트,
뒤로가기/새로고침 탭 유지, 디버그→로그 전환 시 디버그 폴링 중단.

## 수용 기준 (C에서 검증)

1. 사이드바: 디버그 항목 없음, "로그&디버그" 표기, 총 10개.
2. #logs 진입 → 로그 탭 기본. 탭 클릭으로 디버그 전환, 해시 #logs/debug 반영.
3. #debug 직접 진입 → #logs/debug로 리다이렉트되어 디버그 탭 표시.
4. 뒤로가기/새로고침에 탭 상태 유지.
5. 디버그 탭에서 로그 탭으로 전환 시 디버그 폴링 중단(네트워크 탭 or 코드 근거).
6. tsc/빌드 통과. 브라우저 스크린샷: 로그 탭, 디버그 탭, #debug 리다이렉트.

활성화 시나리오(C-ACTIVATION-GROUNDING-01): 레거시 `#debug` 리다이렉트 분기는 주소창에
`#debug`를 직접 입력해 실제 리다이렉트 동작을 관찰한다.
