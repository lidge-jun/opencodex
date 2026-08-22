# 020 — WP2: 네이티브 그룹 컨트롤 노출 (가드 제거)

의존: 010. 설계 근거: **007_replan_use_existing_cap.md** (새 overlay를 만들지 않는다).

## 목표

openai 네이티브 그룹 헤더에서 이미 구현되어 있으나 `!isNative` 가드에 가려진
컨트롤 세 개를 노출한다: 컨텍스트 cap 스위치/셀렉트, 커스텀 모델 추가(+), 컨텍스트 윈도우 버튼.

**서버 변경 없음.** `PUT /api/provider-context-caps`와 `POST /api/custom-models`는
이미 `openai`를 허용한다. auth-cors canonical seed 검증도 건드리지 않는다 —
`providerContextCaps`는 provider 객체가 아니라 config 최상위에 산다.

## 파일 변경 맵

### 1. `gui/src/models-groups.ts` (MODIFY)

그룹에 `nativeProviderGroup: boolean` 추가 — provider id가 네이티브 forward provider인지.
기존 `native`(= `rows.every(r => r.native)`)는 `allRowsNative`로 이름과 의미를 좁힌다.

이유: 커스텀 행이 하나 추가되면 `rows.every(native)`가 false가 되어 네이티브 배지와 힌트가
사라진다(003 §커스텀 추가 버튼). 카드 정체성은 provider id가 소유해야 한다.

### 2. `gui/src/pages/Models.tsx` (MODIFY)

소유권 표:

| UI 요소 | 소유 필드 |
| --- | --- |
| 네이티브 배지, 네이티브 힌트 | `nativeProviderGroup` |
| 커스텀 추가(+) / cap 스위치·셀렉트 | 가드 제거 — 네이티브 그룹에도 노출 |
| 컨텍스트 윈도우 버튼 | 네이티브 그룹에는 **렌더하지 않음** (R6#2) — cap 셀렉트가 그 역할 |
| 행 단위 토글의 native 플래그 | 각 행의 `native` |

- :1069 `{!isNative && ...}` (컨텍스트 윈도우 버튼) → **가드 유지**. 이 모달의
  `PATCH /api/providers`는 canonical `openai`에서 400이다(`auth-cors.ts:511-528`).
- :1077 `{!isNative && ...}` (커스텀 추가) → 가드 제거.
- :1103 `{!isNative && <>...}` (cap 스위치 + 셀렉트) → 가드 제거.
- :1056 네이티브 배지, :1146 네이티브 힌트 → `nativeProviderGroup` 사용.

커스텀 추가 모달: 네이티브 그룹일 때 "`openai/<model>` 라우팅 selector로 추가된다"는
설명을 보여준다 (i18n 키 신규).

### 3. 컨텍스트 윈도우 버튼은 네이티브에서 계속 숨긴다 (R6#2 확정)

이 버튼이 여는 모달은 `PATCH /api/providers`로 `contextWindow` /
`modelContextWindows`를 저장하는데, canonical `openai`에서는 400이 돌아온다
(`auth-cors.ts:511-528`, 003 §실제 원인 1). 007에 따라 그 경계를 열지 않는다.

따라서 네이티브 그룹에서 이 버튼은 **렌더하지 않는다**. 사용자 질문
("openai쪽에 왜 없는거야")의 답은 "네이티브는 cap 컨트롤이 그 역할이고, 그게 이제 보인다"이다.
네이티브 힌트 문구로 이를 설명한다 (`models.nativeCapHint`).

### 4. `gui/src/i18n/*.ts` (MODIFY)

`models.customAddNativeHint`, `models.nativeCapHint` 신규 키를 모든 로케일에 추가.

## 테스트

- `gui/tests/models-provider-head.test.ts`:
  - openai 네이티브 그룹 헤더에 cap 스위치/셀렉트와 커스텀 추가 버튼이 렌더된다.
  - 커스텀 행 추가 후에도 네이티브 배지가 유지된다 (`nativeProviderGroup`).
- cap 토글 → `PUT /api/provider-context-caps` 호출 바디 확인.
- 렌더 관찰: 로컬 대시보드 `#models` 스크린샷 (C-RENDER-GROUNDING-01).

## 수용 기준

- openai 그룹에 cap 컨트롤과 커스텀 추가 버튼이 보이고 실제로 동작한다.
- 커스텀 추가 후에도 openai 카드가 네이티브 카드로 남는다.
- 서버 코드 변경 0줄.
