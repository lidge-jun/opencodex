# 009 — 유닛 상태: NEEDS_HUMAN (감사 7라운드 종료)

## 결론

이 유닛은 **구현 착수 전에 사용자 결정 두 건이 필요**하다. 계획 문서는 완성 상태이며,
실측 증거(001)와 결정 경로 지도(002/003)는 그대로 재사용 가능하다.

## 감사 이력

| 라운드 | 설계 | 판정 | 남긴 것 |
| --- | --- | --- | --- |
| R1 | 소비 지점별 resolver | FAIL (10) | 005 |
| R2 | 접기 검증 | FAIL (3) | 005 |
| R3 | 접기 검증 | FAIL (4) | 005 |
| R4 | 접기 검증 | FAIL (3) | 006 (근본 원인) |
| R5 | accessor 내부 모듈 전역 | FAIL (4) | 007 (2차 재계획) |
| R6 | 기존 cap 재사용 | FAIL (3) | 008 |
| R7 | 접기 검증 | FAIL (4) | 이 문서 |

총 31건. 반박된 blocker는 0건 — 매 라운드가 코드로 확인된 실제 결함을 냈다.

## 무엇이 이 유닛을 어렵게 만드는가

`nativeOpenAiContextWindow`는 **cap을 선택적 인자로 받는다.** 그래서 호출부마다
cap을 넘길 수도, 안 넘길 수도 있고, 실제로 절반 이상이 안 넘긴다:

| 호출부 | cap 전달 | R7 확인 |
| --- | --- | --- |
| `catalog/metadata.ts:258` nativeModelRows | O | |
| `catalog/sync.ts` 4곳 | O | |
| `routing/capability.ts:168` | O | |
| `claude/context-windows.ts:99` | X | 함수에 config 자체가 없음 |
| `claude/model-info.ts` | X | 함수에 config 자체가 없음 |
| `claude/desktop-3p.ts:190,550` | X | collect→generate→write 전 경로에 cap 없음 |
| `grok/sync.ts:43` | X | |
| `management/shared.ts:198,231` | X | |
| `management/native-integration-routes.ts:509` | X | R7이 새로 발견 |

**이것은 이번 유닛이 만든 문제가 아니라 기존 결함이다.** 지금은 권위값(372k)이 낮아서
증상이 가려져 있을 뿐이다. 010이 권위값을 1.05M으로 올리는 순간, cap을 272k로 걸어도
Claude/Grok/Desktop이 1.05M을 광고하는 눈에 보이는 버그가 된다.

즉 **1M 승격과 cap 배관 봉합은 분리할 수 없다.** 그리고 cap 배관은 여러 함수 시그니처를
바꾸는 별도 규모의 작업이다.

## 필요한 사용자 결정

### 결정 1 — cap 배관 봉합을 이 릴리스에 포함할 것인가

- **A. 포함한다.** Claude/Grok/Desktop 경로 6~7곳에 cap을 배관한다. 함수 시그니처가
  바뀌고 호출자까지 타고 올라가야 하므로 별도 work-phase가 하나 더 필요하다.
  1M 승격과 함께 나가야 정합적이다.
- **B. 1M 승격을 미룬다.** GUI 가드 제거(커스텀 추가 버튼 + cap 컨트롤 노출)와
  `fmtK` 표기 수정만 먼저 낸다. 프리셋은 기존 cap 값 목록으로 동작한다.
  권위값은 372k에 그대로 두므로 새 결함이 생기지 않는다. 1M은 배관 봉합 후 별도 릴리스.

### 결정 2 — 네이티브 그룹의 "컨텍스트 윈도우" 버튼

사용자 요청은 "이런 버튼도 만들고 openai쪽에 왜 없는거야"였다. 그런데 그 버튼이 여는 모달의
저장 경로(`PATCH /api/providers`)는 canonical `openai`에서 400이다.

- **A. cap 셀렉트로 대체.** 버튼은 안 만들고, 같은 자리에 프리셋 셀렉트를 노출한다.
  구현이 작고 서버 변경이 없다.
- **B. 진짜로 버튼을 만든다.** `auth-cors.ts`의 canonical seed 검증에
  `contextWindow`/`modelContextWindows`를 user-owned overlay로 허용해야 한다.
  R3#3(null 경계), R5(소비자 전수)에서 드러났듯 이 채널은 cap과 **별개의 두 번째 경로**라
  같은 배관 문제를 다시 만든다. 권장하지 않는다.

## 재사용 가능한 자산

- `001_measurement_evidence.md` — 실측 증거. 어떤 결정에서도 유효하다.
- `002` / `003` — 결정 경로 지도와 게이팅 원인. 재조사 불필요.
- `005` / `008` — 접힌 blocker 31건. 어느 설계를 택하든 이 목록이 체크리스트다.
- `010` — 정적 상수 변경 계약 (1,050,000 / 922,000).

## 터미널 결과

`NEEDS_HUMAN` — 판단이 필요한 것은 기술적 난이도가 아니라 **범위**다.

