# 050 — 기기 코드 복사를 공용 복사 규약으로 (wp1)

040의 "남은 항목" 두 건 중 첫째. wp3 감사에서 범위 이탈로 뺐던 항목을
독립 사이클로 되가져온다.

## 문제

`gui/src/components/provider-workspace/ProviderAuthPanel.tsx:133-138`

```tsx
<button ... onClick={() => {
  navigator.clipboard.writeText(hintForThis.deviceCode ?? "").then(() => {
    setDeviceCodeCopied(true);
    setTimeout(() => setDeviceCodeCopied(false), 2500);
  }).catch(() => {});
}}>{deviceCodeCopied ? t("prov.codeCopied") : t("prov.copyCode")}</button>
```

같은 대기 패널 안에서 규약이 둘로 갈린다.

| | 기기 코드 복사 | 로그인 URL 복사 |
|---|---|---|
| 구현 | `navigator.clipboard.writeText` 직접 | `copyTextToClipboard` |
| 비보안 컨텍스트 | **TypeError로 즉시 죽음** | execCommand 폴백 |
| 실패 처리 | `.catch(() => {})` 침묵 | `unavailable` 라벨 |
| 타이머 | ref 없는 `setTimeout` | ref + clearTimeout |

비보안 컨텍스트 문제가 특히 나쁘다. `navigator.clipboard`가 `undefined`면
`.writeText`를 읽는 순간 TypeError가 나고, `.catch()`는 **Promise 거부만**
잡으므로 이 동기 예외를 못 잡는다. LAN 바인딩(`hostname: 0.0.0.0`, 평문 HTTP)에서
기기 코드 복사 버튼을 누르면 아무 일도 일어나지 않고 콘솔에만 예외가 남는다.
a19ce5dd가 URL 복사에 대해 고친 바로 그 문제가 여기 그대로 있다.

## A 감사가 바꾼 방향 — 훅으로 규약을 실제로 공유한다

초안은 기기 코드에 3-상태를 손으로 한 벌 더 짜는 계획이었다. 감사가
정확히 반박했다: "공유하는 것은 복사 규약"이라 써놓고 규약을 공유하지 않으면
같은 프로토콜의 손수 구현이 **셋**이 된다.

| 표면 | 상태 모양 | 라벨 | 타이머 |
|------|-----------|------|--------|
| `LoginUrlBlock` | `{url, outcome} \| null` | 인라인 삼항 | `timerRef` |
| 기기 코드 (초안대로면) | `"idle"\|"copied"\|"unavailable"` | 인라인 삼항 | 또 다른 ref |
| doctor 복사 | `DoctorCopyFeedback{accountId, outcome}` | `doctorCopyButtonLabel` | ref 없는 `setTimeout` |

게다가 doctor 복사(`ProviderAuthPanel.tsx:182`)에는 **URL 복사가 이미 겪은
타이머 회귀가 그대로 남아 있다**. functional update로 `accountId`+`outcome`을
비교해 완화했지만, 같은 계정을 같은 결과로 연속 클릭하면 앞 타이머가 뒤
피드백을 지운다. 5919779d 감사가 "functional update 가드는 불충분하다"고
결론 낸 바로 그 형태다.

세 번째 손수 구현을 추가하는 대신 훅을 뽑는다. 셋 다 이미 스코프 키를 갖고
있다 — URL, (없음), accountId. 하나의 추상이 자연스럽게 맞는다.

### 신규 `gui/src/components/use-copy-feedback.ts`

```ts
export type CopyOutcome = "copied" | "unavailable";

export function useCopyFeedback<K = void>(): {
  outcomeFor: (scope: K) => CopyOutcome | null;
  copy: (text: string, scope: K) => void;
};
```

- 피드백을 `{ scope, outcome }`로 들고, 읽을 때 스코프가 일치할 때만 결과를
  돌려준다. `LoginUrlBlock`이 url 변경 시 자동으로 idle이 되는 그 방식과 동일하다
  (`react-hooks/set-state-in-effect`가 effect 리셋을 금지하므로 파생이 유일한 길).
- 타이머는 훅이 ref로 소유한다. 재클릭 시 `clearTimeout`, 언마운트 시 정리.
- `copyTextToClipboard`를 부른다 — execCommand 폴백이 세 표면 모두에 붙는다.
- 스코프가 없는 표면은 `K = void`로 쓴다.

### 세 소비처 이관

- `LoginUrlBlock`: 지역 `useState`/`timerRef`/`copy`를 훅 호출로 교체. 스코프는 `url`.
- 기기 코드: 훅 호출. 스코프 없음. 라벨은 아래 표.
- doctor 복사: `copiedDoctorFor`/`setTimeout`을 훅으로 교체. 스코프는 `accountId`.
  `doctorCopyButtonLabel`은 `DoctorCopyFeedback` 대신 `CopyOutcome | null`을 받도록
  좁힌다 — 스코프 비교는 이제 훅이 한다.
  `CodexAccountPool.tsx`와 `codex-account-pool-cards.tsx`도 같은 시그니처로 따라간다.

## 변경 — `ProviderAuthPanel.tsx`

기기 코드 복사도 URL 복사와 같은 3-상태를 갖는다. 코드 전문이 `<code>`에
이미 보이므로 `unavailable`은 dead-end가 아니다 — `.pwi-device-code`가
`user-select: all`이라 수동 선택 경로가 화면에 남아 있다(css:33).

- `deviceCodeCopied: boolean` 상태와 인라인 `setTimeout` 제거 → `useCopyFeedback()`.
- 타이머·폴백·스코프는 전부 훅이 소유한다.
- 라벨: `idle` → `prov.copyCode`, `copied` → `prov.codeCopied`,
  `unavailable` → `prov.linkCopyUnavailable` 재사용.
  새 i18n 키를 만들지 않는다. "클립보드를 사용할 수 없음"은 복사 대상이
  링크든 코드든 같은 사실을 말하고, 6개 로케일 문안도 대상 중립적이다
  (en "Clipboard unavailable", ko "클립보드를 사용할 수 없음").
- 라벨 span에 `aria-live="polite"`. URL 복사와 같은 고지 규약.

`LoginUrlBlock`으로 흡수하지 않는다. 그 컴포넌트는 URL이라는 하나의 대상에
묶인 URL 전문 + 외부 열기 링크를 함께 소유한다. 기기 코드는 외부 링크가 없고
표시 형태(`.pwi-device-code`, 큰 자간 강조)도 다르다. 억지로 합치면 props가
분기되어 소유의 이점이 사라진다. 공유하는 것은 **복사 규약**이고, 그 규약은
위 훅이 소유한다 — 렌더가 아니라 동작을 공유하는 것이 이 분리의 요점이다.

## i18n — ja 미번역 3건 (A 감사 #2)

`gui/src/i18n/ja.ts:1310-1312`의 `prov.deviceCode` / `prov.copyCode` /
`prov.codeCopied`가 영어 그대로다. `sync-locale-keys.mjs`가 키를 채울 때
영문을 붙여두고 파일 맨 아래에 남긴 것으로, `prov.*` 블록에서도 떨어져 있다.
이 사이클이 기기 코드 복사 라벨을 건드리므로 함께 번역한다.

- `"prov.deviceCode": "デバイスコード"`
- `"prov.copyCode": "コードをコピー"`
- `"prov.codeCopied": "コードをコピーしました"`

위치도 `prov.*` 인접 블록(`ja.ts:248` 근처)으로 옮겨 다른 로케일과 같은 배치로
맞춘다. 어떤 게이트도 이걸 잡지 못한다 — `lint:i18n`은 `src/i18n/**`를
globalIgnores로 빼고, `claude-desktop-locale.test.ts`는 키 **집합**만 보지
번역 여부는 보지 않는다. 사람이 보지 않으면 영원히 영어로 남는다.

`prov.linkCopyUnavailable`은 6개 로케일 전부 대상 중립적이라
(en "Clipboard unavailable", ja "クリップボードを使用できません",
de "Zwischenablage nicht verfügbar") 코드 복사에 재사용해도 어색하지 않다.
감사가 6개 전부 확인했다.

## 회귀 테스트 — `gui/tests/provider-auth-device-code-copy.test.tsx`

`provider-auth-login-copy-link.test.tsx`의 하네스를 그대로 쓴다
(`loginHint`에 `deviceCode`를 넣으면 같은 대기 패널이 렌더된다).

마운트 조건(감사가 실측): `busy`가 참이고 `loginHint.provider === item.name`,
`item.authMode === "oauth"`. `url`은 선택이므로 `deviceCode`만 주면 기기 코드
블록만 렌더된다.

**하네스를 그대로 복사하면 안 된다(A 감사 blocker #4).** happy-dom에는
`document.execCommand`가 없다(`typeof`가 `undefined`). 클립보드 스텁만 있는
기존 하네스를 복사하면 폴백 케이스가 조용히 unavailable 경로를 타고 **틀린
이유로 통과한다**. `gui/tests/clipboard-fallback.test.ts:20`처럼
`Object.defineProperty(win.document, "execCommand", ...)` 헬퍼를 함께 둔다.

1. 기기 코드 전문이 렌더되고 복사 버튼이 그 코드를 클립보드에 넣는다.
2. 클립보드 API 부재 + execCommand 스텁 → 폴백으로 복사되고 라벨이
   `prov.codeCopied`가 된다.
3. 둘 다 부재 → 라벨이 `prov.linkCopyUnavailable`이 된다.
   **`expect(() => click()).not.toThrow()`로 쓰지 않는다** — React 19가 동기
   예외를 dev 에러 경로로 흘려보내 happy-dom과 섞이면 단언이 불안정하다.
   "라벨이 unavailable이 된다"는 긍정 단언이 오늘 도달 불가능하므로 그것으로
   충분한 가드다.
4. 2.5초 창 안에서 재클릭해도 뒤 클릭 피드백이 제 수명을 다한다(훅 타이머).
5. doctor 복사도 같은 재클릭 회귀를 갖지 않는다 — 같은 계정·같은 결과로
   연속 클릭해도 뒤 피드백이 살아남는다(훅 이관의 실질 이득).

버튼은 `.pwi-device-code-wrap button`으로 구조 조회한다.

## 검증

- `bun run typecheck` exit 0 (루트 — AGENTS.md 요구)
- `cd gui && bun x tsc -b` exit 0, `bun run lint:gui` exit 0
- `cd gui && bun test tests` 전건 통과
- `bun run test` (루트) 신규 실패 0 — `tests/provider-workspace-auth.test.ts:160`은
  `pwi-device-code` 부분 문자열 매치라 이 사이클이 바꾸는 것을 제약하지 않는다
  (감사 #5: 게이트가 아니라 무영향)
- `bun run privacy:scan` 통과
- 변경을 되돌리면 신규 테스트 3·4·5번이 실패한다
