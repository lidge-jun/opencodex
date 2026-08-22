# 007 — 2차 재계획: 새 overlay를 만들지 않는다

라운드 5까지 FAIL. 실패 모드는 매번 같았다.

| 라운드 | 설계 | 실패 |
| --- | --- | --- |
| R2-R4 | 소비 지점마다 resolver 배관 | 전수표에서 소비자가 계속 빠짐 |
| R5 | accessor 내부 모듈 전역 상태 | `grok/sync.ts`는 서버 밖 `ocx ensure` 프로세스에서 실행되어 주입이 닿지 않음. `parsing.ts`는 accessor가 아니라 상수를 직접 읽음. `capability.ts`는 overlay가 있으면 accessor를 아예 호출 안 함 |

두 설계 모두 **"네이티브 컨텍스트를 낮추는 새 사용자 채널"** 을 만들려다 실패했다.

## 이미 그 채널이 존재한다

`providerContextCaps.openai`가 정확히 그 일을 한다.

- `src/providers/context-cap.ts:24-27` — `applyProviderContextCap`은 `min(window, cap)`.
- `src/codex/catalog/parsing.ts:284-297` — 네이티브 행에 cap을 적용하고
  context / max_context / auto_compact를 함께 낮춘다.
- `src/codex/catalog/sync.ts:1427` — 온디스크 sync가 `providerContextCaps.openai`를 전달.
- `src/codex/catalog/metadata.ts:255-259` — `nativeModelRows`가 cap을 반영.
- `src/routing/capability.ts:168-170` — 라우팅 증거도 네이티브에 cap을 적용 (#1430).
- `src/server/index.ts:977-988` — 라이브 모델 엔드포인트에도 cap 전달.
- 관리 API: `PUT /api/provider-context-caps` (`provider-routes.ts:872-881`)가 이미 존재.
- GUI: cap 스위치 + 값 셀렉트가 이미 구현되어 있다 (`Models.tsx:1104-1140`).
  **단지 `!isNative` 뒤에 숨어 있을 뿐이다.**

즉 사용자가 요청한 "프리셋으로 컨텍스트를 272k/372k로 지정" 은 **이미 있는 기능**이고,
openai 그룹에서만 UI가 가려져 있었다. 003이 찾은 것과 같은 가드다.

## 새 계약 (범위 축소)

| 사용자 요청 | 구현 |
| --- | --- |
| 컨텍스트 윈도우 버튼이 openai에 없다 | 가드 제거 + cap 스위치/셀렉트 노출 |
| 프리셋 272k / 372k / 1.05M 드롭다운 | 기존 cap 셀렉트의 `CAP_OPTIONS`에 값 추가 |
| 1M 버튼, 되는 것만 | cap **해제** = 권위값(1.05M) 그대로. 010이 권위값을 1.05M으로 올린다 |
| 커스텀 모델 추가 버튼 | 가드 제거 (서버 API는 이미 허용) |

**새 overlay 필드를 만들지 않는다.** `providers.openai.contextWindow` /
`modelContextWindows`를 canonical seed에서 허용할 필요도 없어진다 → 020의 auth-cors 변경,
R3#3의 null 문제, R5의 주입 시점 문제가 전부 사라진다.

## 남는 것

1. **010 (WP1)** — 그대로. 네이티브 권위값 1,050,000 / 입력 상한 922,000. 정적 상수 변경.
2. **020 (WP2)** — GUI 가드 제거 + `nativeProviderGroup` 분리 + 커스텀 추가 힌트.
   서버 변경 없음.
3. **030 (WP3)** — `CAP_OPTIONS`에 272,000 / 372,000 / 1,050,000 추가, `fmtK` 1.05M 표기 수정.
   "1M" 은 cap off를 의미한다.
4. cap이 Claude/Grok 경로에 전달되지 않는 **기존 결함**(002에서 확인)은 이 유닛의 범위 밖이다.
   별도 work-phase로 append한다 (LOOP-UNIT-CHAIN-01). 이번 유닛은 그 결함을 넓히지 않는다 —
   새 채널을 만들지 않기 때문이다.

## 왜 이게 옳은가

- 새 코드 경로가 없으므로 "소비자 전수표" 문제 자체가 발생하지 않는다.
- cap은 낮추기만 하므로 사용자가 권위값을 올릴 수 없다 (#1430 계약 유지).
- `grok/sync.ts`가 서버 밖에서 돌아도 config 파일에서 cap을 읽는 기존 경로 그대로다.
- 프리셋의 의미가 명확해진다: **cap 값 선택**이지 임의 window 지정이 아니다.

