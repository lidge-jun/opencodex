# 030 — WP3: 컨텍스트 프리셋 (272k / 372k / 1.05M)

의존: 010(권위값), 020(컨트롤 노출). 설계 근거: **007_replan_use_existing_cap.md**.

## 목표

openai 네이티브 그룹의 cap 셀렉트에서 272k / 372k / 1.05M을 고를 수 있게 한다.

사용자 요청: "1m 버튼 만들어서 되는것만 다 1m으로 켜지게" → "뭐 누르면 드롭다운으로
나오게 하던가" → "272k / 372k / 1.05M 이거 세개만 있으면 돼".

## 프리셋의 의미

셀렉트 값은 **`providerContextCaps.openai`** 다. cap은 `min(권위값, cap)`으로만 작동한다.

| 선택 | 결과 |
| --- | --- |
| 272k | 모든 네이티브 행이 272,000 이하로 내려간다 (spark는 100k 유지) |
| 372k | 모든 네이티브 행이 372,000 이하 (gpt-5.5는 272k 유지) |
| 1.05M | 사실상 상한 없음 — 각 모델이 자기 권위값을 그대로 광고 |

"되는 것만 1M" 이 자동으로 성립한다: 010이 sol/terra/luna/Daybreak의 권위값을 1,050,000으로
올리므로, cap을 1.05M(또는 off)으로 두면 그 넷만 1.05M을 광고하고 gpt-5.5는 272k,
spark는 100k에 남는다. **지원 모델 gating 코드가 필요 없다.**

이것이 007 재계획의 핵심 이득이다 — `supportsOneMillionContext` 필드와 그 전체 체인(B7),
지원/미지원 분기(R2), 하향 프리셋의 overlay 덮어쓰기(R3#1)가 전부 불필요해진다.

## 파일 변경 맵

### 1. `gui/src/pages/models-shared.ts` (MODIFY)

- **네이티브 전용 목록을 신설한다 (R6#3).** 기존 `CAP_OPTIONS`(100k..950k, 18개)에
  세 값을 더하면 21개가 되어 "세 개만"이라는 요청과 어긋난다.

  ```ts
  export const NATIVE_CAP_OPTIONS = [272_000, 372_000, 1_050_000] as const;
  ```

  네이티브 그룹의 cap 셀렉트만 이 목록을 쓴다. 라우팅 provider 그룹은 `CAP_OPTIONS` 그대로.
  저장된 cap이 목록에 없으면 기존 로직대로 그 값을 옵션으로 삽입한다(`Models.tsx:1113-1115`).
- **`fmtK` 수정:** 현재 `fmtK(1_050_000)`은 `"1050k"`를 반환한다(:85-88).
  1,000,000 이상은 `M` 단위로 표기한다 → `"1.05M"`. 소수점은 불필요한 0을 떨어뜨린다
  (`1_000_000` → `"1M"`).

### 2. `gui/src/pages/Models.tsx` (MODIFY)

그룹에 따라 옵션 목록을 고른다 (R7#3):

```ts
const capOptions = nativeProviderGroup ? NATIVE_CAP_OPTIONS : CAP_OPTIONS;
const capOptionSet = nativeProviderGroup ? NATIVE_CAP_OPTION_SET : CAP_OPTION_SET;
```

:1113-1115의 "저장된 값이 목록에 없으면 옵션으로 삽입" 조건이 현재 `CAP_OPTION_SET`을
하드코딩한다. 이를 `capOptionSet`으로 바꾼다. 그러지 않으면 네이티브 cap을 기본값 350k로
켰을 때 350k가 선택되어 있는데 옵션 목록에는 없어 트리거가 빈 값을 보인다.
셀렉트는 이미 `CUSTOM_OPTION`으로 임의 값 입력을 지원한다(:1123-1136).

### 3. `gui/src/i18n/*.ts` (MODIFY)

필요한 경우에만 (기존 `models.capValue` 재사용).

## 테스트

- `fmtK` 단위 테스트: 1,050,000 → `"1.05M"`, 1,000,000 → `"1M"`, 372,000 → `"372k"`,
  350,000 → `"350k"`.
- cap 372,000 적용 후 `/api/models`: sol 372,000, gpt-5.5 272,000, spark 100,000
  (하향 프리셋이 낮은 권위값을 올리지 않음).
- cap 1,050,000 적용 후: sol/terra/luna 1,050,000, gpt-5.5 272,000.
- 렌더 관찰: 셀렉트 열림 상태 스크린샷.

## 수용 기준

- cap 셀렉트에 272k / 372k / 1.05M이 보인다.
- 1.05M 선택 시 권위값이 1.05M인 모델만 1.05M을 광고한다.
- `fmtK(1_050_000) === "1.05M"`.
