# 001 — 현황 조사 (탐색 서브에이전트 2랜 종합)

조사 방법: Sol 탐색 에이전트 2개 병렬 파견 (read-only). 아래는 검증된 인용 요약.

## Models.tsx 렌더 순서 (gui/src/pages/Models.tsx)

1. 로딩 가드 `:397`
2. page-head (제목 + 활성 수) `:400-405`
3. 서브타이틀 `:406`, Notice `:407`
4. 쉐도우 호출 행 `:409-414`
5. 서브에이전트 세그먼트 (v2 있을 때) `:416-491`
6. 컨텍스트 제한 행 `:494-527`
7. 피커 순서 안내(orderHint) `:529-532`
8. 프로바이더 그룹 `groups.map()` `:534-609` — 구조: `.card` > `.row.group-head(.open)` + 조건부 본문
9. 빈 상태 `:610-614`, v2 모달 `:616-635`

- 접힘 상태: localStorage `ocx-models-collapsed` (프로바이더 문자열 배열) `:78-83`, `:238-245`
- 로드: `/api/models` + `/api/provider-context-caps` 병렬, 10초 폴링 `:132-169`
- 핵심 CSS: `.card`(styles.css:370), `.row`(:591), `.group-head`(:445-449)
- 공용 접이식 컴포넌트 없음. ui.tsx는 Switch/Notice/Select/EmptyState만.

## 콤보 데이터

- `GET /api/combos` → `parseComboList()` (combo-workspace-data.ts:71-101) → `ComboItem { id, model, strategy, stickyLimit, defaultEffort, targets[] }` (:18-26)
- Models에서 콤보 개수/목록만 필요하면 `/api/combos` 단독 fetch로 충분 (Combos.tsx:66-86 참조)

## App.tsx 라우팅

- `Page` 타입 `:21`, `VALID_PAGES` `:24`, NAV 배열 `:61-74` (combos `:65`, IconShuffle import `:14`)
- `readPageFromHash` `:26-31`, `hashBelongsToPage` `:33-35` — providers suffix 허용은 `:33-35`,
  `providersHashForPage()`(preference 기반 해시 선택)는 `:57-59` (감사 정정)
- 해시 정규화: hashchange 시 소속 불일치면 페이지 해시로 덮어씀 `:103-130`
- NAV에서 combos만 빼면 #combos 딥링크는 유지됨. 부작용: combos 딥링크 시 사이드바 활성 하이라이트 없음(허용).

## Logs.tsx / Debug.tsx

- Logs: `/api/logs` 2초 폴링(clearInterval cleanup 있음) `:249-260`, surface pill 세그먼트 `:293-310`, TanStack Virtual, 상세 다이얼로그.
- Debug: 모든 지속 리소스는 interval/timeout이고 전부 cleanup 있음(`:84-94`, `:96-107`, `:138-151`, `:159-176`) → **조건부 언마운트 안전**. SSE/WS 없음.
- 언마운트 시 Debug의 stream/follow 상태는 초기화됨(기본 provider/true) — 허용 트레이드오프.
- 탭 UI 선례: ProviderDetails tablist(완전한 ARIA+키보드, provider-workspace/ProviderDetails.tsx:90-197, `.pws-detail-*`), ProviderCatalog 탭(단순), pill segmented(Models/Logs/Usage).

## 라우팅 결정 (탐색 권고 채택)

- **방안 A 채택**: canonical `#logs` / `#logs/debug`, 레거시 `#debug` → `#logs/debug` 리다이렉트.
  providers/workspace suffix 선례를 그대로 따름. 새로고침/북마크/뒤로가기에 탭 상태 보존.

## i18n

- en.ts가 TKey 원본(`TKey = keyof typeof en`), 5로케일 모두 같은 키 필요.
- `nav.combos`는 ComboWorkspace 제목이 재사용하므로 삭제 금지 (ComboWorkspace.tsx:836).
- `debug.subtitle`이 "Logs 별도 페이지" 표현을 포함 → 5로케일 문구 수정 필요.

## 함정 목록 (A-gate 체크 대상)

1. 콤보를 provider `groups`에 가짜 그룹으로 섞지 말 것 — 별도 섹션 렌더.
2. localStorage 접힘 키 네임스페이스 충돌 — 콤보는 별도 키 사용.
3. `#debug → logs` 매핑 시 `hashBelongsToPage` 확장 없으면 즉시 `#logs`로 정규화되어 탭 정보 소실.
4. 미사용 import(IconShuffle, IconTerminal 등) 정리.
5. 페이지 탭과 pill 세그먼트 계층 구분 — 페이지 탭은 밑줄형.
6. 활성 모델 카운터에 콤보 수 합산 금지.
