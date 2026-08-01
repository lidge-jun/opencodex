# 070 — PR #544 Codex 리뷰 P2 2건 (wp1)

`chatgpt-codex-connector`가 `171885ec29`에 남긴 인라인 지적 둘. 둘 다
`useCopyFeedback` 도입으로 **새로 생긴** 결함이라 머지 전에 닫는다.

## P2-1 — 기기 코드 복사가 스코프를 안 쓴다

`gui/src/components/provider-workspace/ProviderAuthPanel.tsx`

```tsx
const deviceCodeCopy = useCopyFeedback();          // K = void
const deviceCodeOutcome = deviceCodeCopy.outcomeFor(undefined);
onClick={() => deviceCodeCopy.copy(hintForThis.deviceCode ?? "", undefined)}
```

훅은 "피드백이 자기 스코프를 들고 다녀 스코프가 바뀌면 idle로 읽힌다"는
계약으로 만들었는데, 세 소비처 중 여기만 그 계약을 쓰지 않는다. URL은
`url`을, doctor는 `account.id`를 스코프로 넘긴다. 기기 코드만 `undefined`다.

### 재현

1. 기기 코드 A가 뜬 상태에서 복사 → 라벨이 "코드 복사됨".
2. 2.5초 안에 취소를 누른다. `cancelLoginOAuth`가
   `setLoginInfo(current => current?.provider === provider ? null : current)`
   로 힌트만 비운다(`use-providers-oauth.ts:53`). **패널은 언마운트되지 않는다** —
   `busy && hintForThis` 블록만 사라진다.
3. 다시 로그인하면 `loginOAuth`가 새 코드 B로 `setLoginInfo`한다(`:84`).
   같은 컴포넌트 인스턴스, 같은 `undefined` 스코프.
4. 코드 B 위에 A의 "복사됨"이 남는다. 클립보드에는 A가 들어 있다.

`Providers.tsx:210`의 `key={item.name}`은 프로바이더가 바뀔 때만 리마운트하므로
같은 프로바이더 재로그인에서는 보호가 없다. 이건 `LoginUrlBlock`이 이미
막아둔 것과 **동일한 거짓 성공**이다.

### 수정

```tsx
const deviceCodeCopy = useCopyFeedback<string>();
const deviceCode = hintForThis?.deviceCode ?? "";
const deviceCodeOutcome = deviceCodeCopy.outcomeFor(deviceCode);
onClick={() => deviceCodeCopy.copy(deviceCode, deviceCode)}
```

복사 대상 문자열이 곧 스코프다 — URL 복사와 같은 형태(`copy(url, url)`).

## P2-2 — 겹친 복사에서 오래된 완료가 최신 결과를 덮어쓴다

`gui/src/components/use-copy-feedback.ts:38-47`

```ts
void copyTextToClipboard(text).then((ok) => {
  clearTimer();
  setFeedback({ scope, outcome: ok ? "copied" : "unavailable" });
  timerRef.current = setTimeout(...);
});
```

`copyTextToClipboard`는 async다. `navigator.clipboard.writeText`가 권한
프롬프트나 포커스 대기로 지연되면 첫 시도가 둘째보다 늦게 resolve될 수 있다.
그때 첫 시도의 `.then`이 무조건 상태와 타이머를 덮어쓴다.

- 스코프가 다르면(예: 코드 A→B) 현재 버튼이 남의 스코프 피드백을 받아 idle이 된다.
- 스코프가 같으면 오래된 결과를 최신인 양 보고한다(A 실패→B 성공이면 "사용 불가").
- 타이머도 늦은 쪽이 다시 걸어 피드백 수명이 어긋난다.

`clearTimer`는 이 경합을 못 막는다. 순서 문제이지 타이머 문제가 아니다.

### 수정

요청 세대 카운터를 둔다.

```ts
const generationRef = useRef(0);

const copy = useCallback((text: string, scope: Scope) => {
  const generation = ++generationRef.current;
  void copyTextToClipboard(text).then((ok) => {
    if (generationRef.current !== generation) return;   // 스테일 완료는 버린다
    clearTimer();
    setFeedback({ scope, outcome: ok ? "copied" : "unavailable" });
    timerRef.current = setTimeout(() => { ... }, FEEDBACK_MS);
  });
}, [clearTimer]);
```

만료 타이머도 자기 세대를 확인하게 해, 늦게 도착한 클릭이 앞 타이머의
만료로 지워지지 않도록 한다. 이 저장소의 다른 경합 가드와 같은 방식이다
(`use-providers-oauth.ts`의 `oauthLoginGenerationRef`,
`use-add-codex-account-oauth.ts`의 `pollSession`).

## 회귀 테스트

### `gui/tests/use-copy-feedback-race.test.tsx` (신규)

클립보드 `writeText`를 테스트가 붙잡았다 놓는 스텁으로 순서를 고정한다.

1. **늦게 끝난 오래된 시도는 무시된다.** A를 클릭(보류) → B를 클릭(즉시 성공)
   → A를 성공으로 해제. 라벨은 B의 결과를 유지한다.
2. **결과가 갈려도 마찬가지.** A는 실패, B는 성공으로 두고 A를 나중에 해제해도
   "복사됨"이 남는다.
3. **정상 순서는 그대로 동작한다.** 겹치지 않으면 마지막 클릭 결과가 뜬다.

### `gui/tests/provider-auth-device-code-copy.test.tsx` (기존에 추가)

1. **기기 코드가 바뀌면 라벨이 초기화된다.** 코드 A 복사 → 같은 패널에
   코드 B로 리렌더 → 라벨이 `prov.copyCode`로 돌아온다.

## 검증

- `bun run typecheck` exit 0, `cd gui && bun x tsc -b` exit 0
- `cd gui && bun run lint` / `lint:i18n` exit 0
- `cd gui && bun test tests` 전건 통과
- `bun run test` (루트) 신규 실패 0, `bun run privacy:scan` 통과
- 스코프를 `undefined`로 되돌리면 기기 코드 테스트가, 세대 가드를 지우면 경합 테스트가 실패한다
