# 008 — R6 접기: cap 누수 봉합, 020 모순 제거, 프리셋 목록 교체

R6 blocker 3건. 전부 수용하고 좁은 수정으로 닫는다.

## R6#1 — Claude/Grok가 cap 없이 권위값을 읽음 (High)

### 확인된 사실

아래 네 자리가 `nativeOpenAiContextWindow(id)`를 **cap 인자 없이** 호출한다.
010이 권위값을 1.05M으로 올리면 cap을 272k로 걸어도 이들은 1.05M을 계속 광고한다.

| 위치 | 함수 | config 보유 |
| --- | --- | --- |
| `src/claude/context-windows.ts:99` | 네이티브 selector map | 호출자가 config 보유 |
| `src/grok/sync.ts:43` | Grok 모델 목록 | `config` 인자 있음 |
| `src/server/management/shared.ts:198` | `fetchGrokCandidateModels` | `config` 인자 있음 |
| `src/server/management/shared.ts:231` | `buildClaudeDesktopState` | `config` 인자 있음 |

`src/claude/model-info.ts`와 `src/claude/desktop-3p.ts`도 같은 계열이다.

### 수정

**새 API를 만들지 않는다.** accessor는 이미 두 번째 인자로 cap을 받는다
(`nativeOpenAiContextWindow(slug, contextCap?)`, `metadata.ts:135`).
각 호출부에 `providerContextCap(config, OPENAI_CODEX_PROVIDER_ID)`를 넘긴다.
전부 config를 이미 들고 있으므로 배관이 필요 없다 — 이것이 R5 설계와 결정적으로 다른 점이다.

이 수정은 **기존 결함의 봉합**이기도 하다(002에서 확인). 010이 권위값을 올리기 때문에
이번 유닛에서 반드시 함께 닫아야 한다.

010의 파일 변경 맵에 위 네 지점 + model-info + desktop-3p를 추가한다.

테스트: cap 272,000 적용 후 Claude 컨텍스트 맵 / Claude `/v1/models`(`[1m]` 소멸) /
Grok sync / Grok candidate DTO / Desktop state가 전부 272,000을 보고한다.

## R6#2 — 020 내부 모순 (High)

020 §2가 컨텍스트 윈도우 버튼 가드를 "무조건 제거"라 하고 §3이 "네이티브에는 렌더하지 않음"이라
한다. 전자를 구현하면 `auth-cors.ts:511`에서 400이 난다.

결정: **네이티브 그룹에는 컨텍스트 윈도우 버튼을 렌더하지 않는다.** cap 셀렉트가 그 역할이다.
020 §2의 표와 :1069 항목을 그렇게 고쳐 모순을 제거한다.

## R6#3 — 프리셋이 21개가 됨 (Medium)

`CAP_OPTIONS`는 현재 `100k..950k` 18개다(`models-shared.ts:75`). 여기에 3개를 더하면
21개가 되어 "세 개만 있으면 돼"라는 요청과 다르다.

결정: **네이티브 그룹 전용 프리셋 목록을 쓴다.**

```ts
export const NATIVE_CAP_OPTIONS = [272_000, 372_000, 1_050_000] as const;
```

- 네이티브 그룹의 cap 셀렉트: `NATIVE_CAP_OPTIONS` + `CUSTOM_OPTION`.
- 라우팅 provider 그룹: 기존 `CAP_OPTIONS` 그대로 (변경 없음).
- 저장된 cap이 목록에 없으면 기존 로직대로 그 값을 옵션으로 삽입한다(`Models.tsx:1113-1115`).

030을 이렇게 고친다.

