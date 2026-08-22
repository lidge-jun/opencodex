# 060 — WP8: openai 네이티브 그룹에 모델별 컨텍스트 설정 열기

## 요청

사용자: "openai에 이것도 넣으라고 각 모델마다 설정할수 있게" — 다른 프로바이더 카드에는
있는 "컨텍스트 윈도우" 버튼을 openai 카드에도 달라는 것.

## 왜 지난번에 뺐는가 (020 §3)

이 버튼이 여는 모달은 `PATCH /api/providers?name=openai`로
`contextWindow` / `modelContextWindows`를 저장하는데, canonical `openai`는
`providerManagementConfigError`(`src/server/auth-cors.ts:511-528`)가
**registry seed와 정확히 같은 key set**인지 검사한다. 현재 예외로 허용되는 overlay는
`responsesSnapshotRepair`, `modelCosts`, `requestPacing` 셋뿐이라 400이 돌아온다.

그래서 020은 "cap 셀렉트가 그 역할"이라며 버튼을 렌더하지 않기로 했다. 사용자가 원한 것은
**모델별** 설정인데 cap은 프로바이더 전체에 걸리는 단일 값이라 그 대체가 성립하지 않는다.

## 이번에 여는 것

`modelCosts`와 같은 등급의 user-owned overlay로 두 필드를 인정한다.

### 1. `src/server/auth-cors.ts` (MODIFY)

canonical 비교 전에 `contextWindow` / `modelContextWindows`를 제외하되,
**제외 전에 공통 validator로 검증한다.** 이 함수는 PATCH 밖(POST/reload)에서도 쓰이므로
삭제만 하면 `contextWindow: "bad"`가 디스크에 남는다.

- `contextWindow`: 양의 safe integer. `null`은 full-object 경계에서 **거부**(삭제는 PATCH 전용).
- `modelContextWindows`: plain object, 키는 비어있지 않은 문자열, 값은 양의 safe integer.

### 2. 네이티브 소비 경로 연결 (MODIFY)

저장만 허용하고 네이티브 카탈로그가 안 읽으면 "저장은 되는데 아무 일도 안 일어남"이 된다.
`nativeOpenAiContextWindow`가 이미 `(slug, contextCap?)`를 받으므로, overlay도 같은
자리에서 `min`으로 합류시킨다:

```
권위값(922,000) -> min(overlay.modelContextWindows[slug] ?? overlay.contextWindow) -> min(providerContextCaps.openai)
```

**overlay는 낮추기만 한다.** 사용자가 2,000,000을 넣어도 922,000이 상한이다 — 실측 상한을
넘는 값을 광고하면 이번 유닛이 고친 문제가 그대로 돌아온다.

배관 지점은 013/014에서 이미 정리한 목록과 동일하다(cap이 흐르는 경로와 같은 자리).

### 3. `gui/src/pages/Models.tsx` (MODIFY)

`{!nativeProviderGroup && ...}` 가드를 제거해 네이티브 그룹에도 버튼을 렌더한다.
모달은 기존 것을 그대로 쓴다 — 모델 목록은 `group.rows`에서 오므로 네이티브 slug가 채워진다.

### 4. 테스트

- `tests/management-provider-validation.test.ts`: openai PATCH 200, 잘못된 값 400,
  POST에서 `null` 거부.
- `tests/codex-catalog.test.ts`: overlay 500,000 -> 광고 500,000, overlay 2,000,000 -> 922,000 유지.
- `gui/tests/models-native-group-controls.test.ts`: 버튼 렌더.
- 라이브: 모달로 gpt-5.6-sol만 500k 저장 후 `/api/models`에서 sol만 500,000, terra는 922,000.

## 범위 밖

- API 키/OpenRouter 계약.
- cap 컨트롤 (그대로 둔다 — overlay와 cap은 별개 레버이고 둘 다 낮추기만 한다).

