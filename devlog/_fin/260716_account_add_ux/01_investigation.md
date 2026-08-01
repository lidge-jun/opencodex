 # 계정 추가 UX 조사 — "링크 가기" + 아이콘 오버사이즈 (2026-07-16)
 
 ## 요약
 
 Codex 인앱 브라우저에서 계정 추가 시 두 가지 UX 문제가 있다.
 
 1. **"링크 가기" 문제**: `window.open(..., "_blank")` 호출이 인앱 브라우저에서
    차단/중재되어 "링크 가기" 앱 레벨 프롬프트가 뜬다. 유저는 링크 복사를 원한다.
 2. **아이콘 오버사이즈**: `Providers.tsx`의 OAuth 로그인 힌트에서 `IconExternal`이
    명시적 width/height 없이 렌더링되어 비정상적으로 크게 표시된다.
 
 ---
 
 ## 이슈 1: "링크 가기" → "링크 복사하기"
 
 ### 원인
 
 `AddCodexAccountModal.tsx` (CodexAuth 페이지)에서 OAuth 로그인 버튼 클릭 시:
 
 ```
 [line 113] const resp = await fetch(`${apiBase}/api/codex-auth/login`, { ... });
 [line 114] const data = await resp.json();
   ...
 [line 116] popupRef.current = window.open(data.url, "_blank");
 ```
 
 `await fetch()` 이후에 `window.open`이 호출되므로 원래 클릭 이벤트의 사용자 활성화
 (user activation)가 이미 소실된 상태다. 일반 브라우저에서도 팝업 차단 대상이 되며,
 Codex 인앱 브라우저에서는 "링크 가기"라는 앱 레벨 프롬프트로 중재된다.
 
 "링크 가기"는 opencodex i18n 문자열이 아님 — ko.ts에 해당 문구 없음.
 Codex 앱의 WebView가 `_blank` 탐색 요청을 인터셉트하면서 자체 UI로 보여주는 것.
 
 ### 근본 불일치: 서버측 openUrl 패턴의 미적용
 
 Providers 페이지의 `/api/oauth/login`에서는 이미 이 문제를 해결해놓았다:
 
 ```
 [management-api.ts:1039-1044]
 // 서버가 직접 시스템 브라우저를 연다 (macOS에서 `open` 명령)
 const { openUrl } = await import("../lib/open-url");
 openUrl(authUrl);
 ```
 
 반면 `/api/codex-auth/login`은 URL만 반환하고 서버측 브라우저 오픈을 하지 않는다
 (auth-api.ts:557, :680). 클라이언트가 `window.open`으로 열어야 하는데,
 await 이후라 팝업 차단에 걸린다.
 
 ### 현재 코드 상태
 
 `AddCodexAccountModal.tsx`에는 이미 복사 기능이 구현되어 있다:
 
 - `oauth-waiting` 단계에서 "로그인 링크 복사" 버튼 (line 175)
 - `copyLoginLink()`: `navigator.clipboard.writeText` + `execCommand("copy")` 폴백
 - 복사 성공 시 2.5초간 "로그인 링크를 복사했습니다" 표시
 
 문제는 `window.open`이 먼저 실행되어 인앱 브라우저가 "링크 가기"를 먼저 보여주는 것.
 `window.open`이 `null`을 반환해도 별도 오류/안내 없이 `oauth-waiting`으로 전환됨.
 
 ### window.open 전수 조사 (GUI 전체)
 
 | 파일 | 행 | 반환값 체크 | 팝업차단 처리 |
 |---|---|---|---|
 | `AddCodexAccountModal.tsx` | 116 | popupRef에 저장 | ✗ (null이면 무시) |
 | `AddProviderModal.tsx` | 177 | ✗ (반환값 버림) | ✗ |
 
 `target="_blank"` 앵커 7개 — App.tsx, Providers.tsx, Dashboard.tsx, Models.tsx,
 AddProviderModal.tsx (2개). 모두 `rel="noreferrer"`.
 
 ### 영향 범위
 
 | 페이지 | 파일 | window.open | 서버측 openUrl | 복사 버튼 |
 |---|---|---|---|---|
 | CodexAuth (`#codex-auth`) | `AddCodexAccountModal.tsx:116` | ✓ | ✗ | ✓ (대기 화면) |
 | Providers (`#providers`) | `Providers.tsx` loginOAuth() | ✗ | ✓ | ✗ |
 | Add Provider 모달 | `AddProviderModal.tsx:177` | ✓ | ✓ (서버도 열음) | ✗ |
 
 ### 수정 방향
 
 **A안 — 서버측 openUrl 통일 + window.open 제거 (권장)**
 
 1. `/api/codex-auth/login`에 서버측 `openUrl(authUrl)` 추가 (oauth/login과 동일 패턴)
 2. `AddCodexAccountModal.tsx:116`의 `window.open` 제거
 3. "로그인 링크 복사" 버튼을 주 동작으로 배치 + 안내 문구 조정
 4. `AddProviderModal.tsx:177`의 `window.open`도 제거 (서버가 이미 열므로 중복)
 
 **B안 — window.open 유지 + 실패 감지**
 
 1. `window.open` 반환값 null 시 "새 창을 열 수 없습니다" 안내
 2. 인앱 브라우저에서는 "링크 가기" 프롬프트가 여전히 뜸 → A안보다 불완전
 
 **C안 — Providers 페이지도 복사 버튼 추가**
 
 Providers.tsx의 `loginInfo` 힌트에도 `<a href>` 외에 복사 버튼 추가.
 `AddCodexAccountModal`의 `copyLoginLink()` 패턴 재사용.
 
 ---
 
 ## 이슈 2: 아이콘 오버사이즈
 
 ### 원인
 
 전체 GUI 아이콘 감사 결과, **1건의 oversized-icon 버그** 발견:
 
 | 파일 | 아이콘 | 부모 요소 | CSS 크기 제약 |
 |---|---|---|---|
 | `Providers.tsx:425` | `IconExternal` | `<a className="link-btn">` | **없음** |
 
 `icons.tsx`의 SVG는 `viewBox="0 0 24 24"` 설정하지만 기본 width/height 없음.
 `.btn svg { width: 15px; height: 15px; }` 규칙이 있지만 `.link-btn`은 `.btn`이 아님.
 `.link-btn` CSS(styles.css:702)는 타이포/색상/패딩만 지정 — SVG 크기 규칙 없음.
 
 ### 안전한 사용 확인
 
 - `AddCodexAccountModal.tsx`: `IconGlobe width={20}`, `IconLink width={14}` — 정상
 - 나머지 GUI 전체: 모든 아이콘이 `.btn` 내부(CSS 제약) 또는 명시적 width/height 지정
 - CSS 미제약 + 명시적 크기 미지정은 `Providers.tsx:425`가 **유일**
 
 ### 수정 방향
 
 **즉시 수정**: `<IconExternal width={13} height={13} />`
 **구조적 수정**: `.link-btn svg { width: 14px; height: 14px; }` CSS 규칙 추가
 
 ---
 
 ## 파일 맵
 
 ```
 gui/src/
 ├── components/
 │   ├── AddCodexAccountModal.tsx   ← 이슈1 주 대상 (window.open + copy)
 │   └── AddProviderModal.tsx       ← 이슈1 부 대상 (window.open 중복)
 ├── pages/
 │   ├── CodexAuth.tsx              ← AddCodexAccountModal 호출
 │   └── Providers.tsx              ← 이슈1 부 대상 (link-btn) + 이슈2 (IconExternal)
 ├── icons.tsx                      ← SVG 아이콘 (viewBox only, no default size)
 ├── i18n/
 │   ├── en.ts                      ← "Didn't open? Click here", "Copy login link"
 │   └── ko.ts                      ← "안 열렸나요?", "로그인 링크 복사"
 └── styles.css                     ← .btn svg (15px), .link-btn (크기 규칙 없음)
 
 src/
 ├── server/management-api.ts:1039  ← /api/oauth/login — 서버측 openUrl ✓
 ├── lib/open-url.ts                ← macOS `open` 명령 래퍼
 └── codex/auth-api.ts:557,:680     ← /api/codex-auth/login — URL만 반환, openUrl ✗
 ```
 
 ## 조사 방법
 
 - Sol 서브에이전트 3개 병렬 (priority 티어)
   - Carver: 전체 GUI 아이콘 크기 감사 → `Providers.tsx:425` 1건 발견
   - Avicenna: 한국어 i18n 전수 확인 + AddCodexAccountModal UX 흐름 분석
   - Kuhn: window.open / target="_blank" 전수 조사 + 서버측 openUrl 불일치 발견
 - 메인 에이전트: 코드 직접 탐색 + 종합 + devlog 작성
 
 ## 상태
 
 조사 완료. 패치 미적용 (유저 지시: OAuth 패치 보류).
