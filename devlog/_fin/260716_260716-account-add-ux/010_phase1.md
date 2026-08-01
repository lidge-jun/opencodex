# 010 — 전체 패치: window.open 제거 + 아이콘 수정

## Changes

### 1. gui/src/components/AddCodexAccountModal.tsx (MODIFY)
- DELETE line 17: `const popupRef = useRef<Window | null>(null);`
- DELETE line 116-117: `popupRef.current = window.open(data.url, "_blank"); if (popupRef.current) popupRef.current.opener = null;`
- DELETE line 38: `popupRef.current = null;` (cancelLogin 내부)
- DELETE line 130: `popupRef.current = null;` (done 분기)
- DELETE line 136: `popupRef.current = null;` (error 분기)
- DELETE lines 138-140: `} else if (popupRef.current?.closed) { ... }` (팝업 닫힘 감지 분기 전체)
- KEEP: authUrl state, copyLoginLink(), oauth-waiting 단계의 복사 버튼, 5분 타임아웃

### 2. gui/src/components/AddProviderModal.tsx (MODIFY)
- DELETE line 177: `window.open(data.url, "_blank");`

### 3. src/codex/auth-api.ts (MODIFY)
- ADD after line 575 (startLoginFlow 호출 후, 폴링 시작 전):
  ```ts
  if (result.url) {
    const { openUrl } = await import("../lib/open-url");
    openUrl(result.url);
  }
  ```
- 기존 response 구조 변경 없음 (여전히 url 반환)

### 4. gui/src/pages/Providers.tsx (MODIFY)
- line 425: `<IconExternal />` → `<IconExternal width={14} height={14} />`
  (CSS .link-btn svg와 동일 값으로 통일 — CSS가 구조적 방어, 인라인이 명시적 보장)
- loginInfo 힌트에 복사 버튼 추가 (기존 <a href> 유지 + 복사 버튼 병렬 배치)

### 5. gui/src/styles.css (MODIFY)
- ADD after line 702 (.link-btn): `.link-btn svg { width: 14px; height: 14px; flex-shrink: 0; }`

### 6. gui/src/i18n/en.ts, ko.ts (MODIFY)
- ADD `prov.copyLink`: "Copy link" / "링크 복사"
- ADD `prov.linkCopied`: "Copied" / "복사됨"
