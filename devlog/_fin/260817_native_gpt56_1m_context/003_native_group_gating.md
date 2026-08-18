# 003 — openai 그룹에 컨텍스트/커스텀 버튼이 없는 진짜 이유

사용자 질문: "이런 버튼도 만들고 openai쪽에 왜 없는거야".

## 표면적 원인

`gui/src/pages/Models.tsx:1069, 1077`의 `{!isNative && ...}` 가드 하나가 컨텍스트 윈도우 버튼,
커스텀 추가(+) 버튼, provider cap 스위치를 동시에 숨긴다.

`isNative`는 provider id가 아니라 **그 그룹의 모든 행이 `native: true`인가**로 계산된다
(`gui/src/models-groups.ts:44-65`, `Models.tsx:1012-1018`).

## 실제 원인 — 버튼을 노출해도 동작하지 않는다

1. **서버가 저장을 거부한다.** 컨텍스트 모달의 저장은
   `PATCH /api/providers?name=openai` (`Models.tsx:480-542`)인데,
   `providerManagementConfigError` (`src/server/auth-cors.ts:511-528`)는 `openai`를
   registry seed와 **정확히 같은 key set**인지 검사한다. 현재 예외로 허용되는 overlay는
   `responsesSnapshotRepair`, `modelCosts`, `requestPacing` 세 개뿐이다.
   `contextWindow` / `modelContextWindows`를 담아 보내면
   "provider openai must equal the canonical built-in provider seed" 400이 돌아온다.
2. **저장되어도 네이티브 카탈로그가 읽지 않는다.** `nativeModelRows`
   (`src/codex/catalog/metadata.ts:253-260`)와 `applyNativeOpenAiContextOverride`
   (`src/codex/catalog/parsing.ts:269-297`)는 `NATIVE_OPENAI_CONTEXT_OVERRIDES`와
   `providerContextCaps.openai`만 본다. provider의 `contextWindow`/`modelContextWindows`는
   인자로 전달되지도 않는다.
3. **정책 라우팅은 이미 읽고 있다.** `src/routing/capability.ts:153-172`는
   `openai.modelContextWindows[model] → openai.contextWindow → registry/catalog/native` 순으로
   읽는다. 즉 저장만 허용하면 **정책 증거와 광고 카탈로그가 서로 다른 값**을 갖게 된다.
   이 불일치를 만들지 않으려면 네이티브 소비 경로도 같은 순서로 연결해야 한다.

## 커스텀 추가(+) 버튼

서버 API는 이미 `openai`를 막지 않는다 (`src/server/management/model-routes.ts:374-415`).
다만 결과는 bare 네이티브가 아니라 `openai/<slug>` **라우팅 selector**다
(`src/providers/slug-codec.ts`, `src/router.ts:609-636`).

주의할 부작용: 커스텀 행이 하나 추가되면 그룹의 `rows.every(native)`가 false가 되어
네이티브 배지/힌트가 사라지고 숨겨져 있던 컨트롤이 갑자기 나타난다
(`gui/src/models-groups.ts:54-65`). 가드만 제거하면 첫 저장 후 카드 의미가 뒤집힌다.
따라서 "모든 행이 네이티브인가"와 "이 그룹이 네이티브 forward provider인가"를 분리해야 한다.

## 최소 변경 방향

- `providerManagementConfigError`의 `openai` 분기에서 `contextWindow`/`modelContextWindows`를
  user-owned overlay로 인정한다 (`modelCosts`와 같은 취급).
- config를 아는 네이티브 window resolver를 하나 만들고 순서를 고정한다:
  네이티브 권위값 → 사용자 `modelContextWindows[slug] ?? contextWindow`를 **상한으로만** 적용
  → `providerContextCaps.openai`를 최종 상한으로 적용.
  사용자 값이 권위 최대치를 **올리지는** 못한다 (#1430 계약 유지).
- GUI는 `allRowsNative`와 `nativeProviderGroup`을 분리해 커스텀 행 추가 후에도 카드가 뒤집히지 않게 한다.

