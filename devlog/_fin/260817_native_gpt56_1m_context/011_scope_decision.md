# 011 — 범위 결정 (에이전트 판단, 사용자 위임)

009가 사용자 결정 2건을 요청했으나, 사용자가 "계속 너가 판단해서 진행해"로 판단을 위임했다.
아래가 그 결정과 근거다.

## 결정 1 → **A: cap 배관 봉합을 포함한다**

근거: 010이 권위값을 1.05M으로 올리면 cap 미전달 경로가 곧바로 눈에 보이는 버그가 된다.
1M 승격만 내고 배관을 미루면 "cap 272k를 걸었는데 Claude가 1.05M을 광고"하는 회귀를
사용자에게 배송하는 셈이다. 두 작업은 분리 불가능하므로 함께 낸다.

## 결정 2 → **A: cap 셀렉트로 대체한다**

근거: 그 버튼이 여는 모달의 저장 경로는 canonical `openai`에서 400이다. 버튼을 만들려면
`auth-cors` canonical seed 검증을 열어 **두 번째 컨텍스트 채널**을 만들어야 하고,
R3#3/R5가 보여줬듯 같은 배관 문제를 처음부터 다시 만든다.
사용자 요청의 의도("openai에서도 컨텍스트를 지정하고 싶다")는 cap 셀렉트가 충족한다.

## 확정된 work-phase 맵

| WP | 내용 | 문서 |
| --- | --- | --- |
| wp1 | 네이티브 권위값 1,050,000 / 입력 상한 922,000 (정적 상수 + 파생 지점) | 010 |
| wp1b | cap 배관 봉합 — Claude/Grok/Desktop/management 7곳 | 010 §7a + 이 문서 |
| wp2 | GUI 가드 제거 (커스텀 추가 + cap 컨트롤), `nativeProviderGroup` 분리 | 020 |
| wp3 | `NATIVE_CAP_OPTIONS` 272k/372k/1.05M + `fmtK` 1.05M 표기 | 030 |
| wp4 | 릴리스 | 040 |

## wp1b 상세 — cap 배관 (R7#1/#2 반영)

R7이 확인한 대로 아래 함수들은 **config를 인자로 갖지 않는다.** 따라서 호출자까지 배관한다.

| 함수 | 파일 | 조치 |
| --- | --- | --- |
| `buildClaudeContextWindows` | `claude/context-windows.ts:89` | `contextCap?: number` 파라미터 추가, 호출자가 전달 |
| `buildAnthropicModelInfos` | `claude/model-info.ts:105` | 동일 |
| Desktop collect→generate→write | `claude/desktop-3p.ts:190,550` | 체인 전체에 `contextCap` 전달 |
| `syncGrokConfig` 모델 목록 | `grok/sync.ts:43` | `config` 보유 — 인자만 추가 |
| `fetchGrokCandidateModels` | `management/shared.ts:198` | `config` 보유 — 인자만 추가 |
| `buildClaudeDesktopState` | `management/shared.ts:231` | `config` 보유 — 인자만 추가 |
| Grok enable 경로 | `management/native-integration-routes.ts:509` | `config` 보유 — 인자만 추가 |

`nativeOpenAiMaxInputTokens`도 `(slug, contextCap?)` 시그니처로 만들어 같은 취급을 받게 한다
(R7#1 후단: cap 상태에서 입력 상한이 922k로 남는 문제).

## wp3 상세 — 셀렉트 옵션 로직 (R7#3 반영)

`Models.tsx:1113-1115`의 삽입 조건이 `CAP_OPTION_SET` 하드코딩이다. 네이티브 그룹이
다른 목록을 쓰면 저장된 350k가 옵션에서 사라진다.

수정: 그룹별로 `options`와 `optionSet`을 함께 고른 뒤, 삽입 조건을 그 `optionSet` 기준으로
판단한다. "추가 로직 없음"이라는 030의 문장을 이 내용으로 대체한다.

