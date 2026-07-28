# 020 — Codex 계정 추가/재인증 모달 채택 (wp2)

이 루프의 본체다. 사용자가 보고한 증상("계정 추가할 때 복사 버튼 관련")이
바로 이 표면이다.

## 변경 1 — `gui/src/components/add-codex-account-waiting-step.tsx`

현재:

```tsx
<button ... onClick={onCopyLoginLink} disabled={!authUrl} ...>
  <IconLink width={14} /> {copied ? t("codexAuth.loginLinkCopied") : t("codexAuth.copyLoginLink")}
</button>
```

변경 후: 위 버튼을 `<LoginUrlBlock url={authUrl} />` 하나로 교체한다.

**빈 URL 구간의 거동 변화(A 감사 #5).** 지금은 `disabled={!authUrl}` 버튼이
회색으로 자리를 지킨다. 블록은 `url=""`이면 `null`을 반환하므로 그 자리가 빈다.
재인증 진입은 `initialAddCodexAccountUiState`가 곧바로 `step: "oauth-waiting"`을
주므로(`AddCodexAccountModal.tsx:20`) `startOAuth` 응답 전 첫 렌더가 실제로 그 상태다.
받아들인다 — 대기 화면에는 이미 스피너와 `codexAuth.oauthWaiting` 문구가 있어
"준비 중"이라는 신호가 중복으로 존재하고, 눌리지 않는 버튼보다 아무것도 없는 쪽이
거짓 어포던스를 만들지 않는다. `cancelLogin`이 `authUrl`을 비우면 블록이 사라지는
것도 같은 이유로 옳다.

- `copied` prop 제거. `onCopyLoginLink` prop 제거.
- import에서 `IconLink` 제거(더 이상 이 파일이 아이콘을 직접 쓰지 않는다).
- 배치: `<p className="modal-desc">` 바로 아래, 수동 코드 입력 블록 위.
  대기 화면의 읽기 순서는 "기다리는 중이다 → URL은 여기 있다 → 안 되면 코드를
  붙여넣어라"가 되어야 한다. 지금은 복사 버튼이 full-width로 떠 있어 위계가 없다.
- 모달 폭이 440px(`AddCodexAccountModal.tsx`)이고 OAuth URL은 길다.
  `.pwi-auth-url`이 `overflow-wrap: anywhere`를 이미 갖고 있어 그대로 통한다.

## 변경 2 — `gui/src/components/use-add-codex-account-oauth.ts`

`copyLoginLink`(253-273, 닫는 `};` 포함) 전체를 삭제한다.

- `document.execCommand("copy")` 수동 textarea 폴백 삭제. 저장소 공용 래퍼
  `copyTextToClipboard`가 비보안 컨텍스트에서 `false`를 돌려주는 계약이고,
  그 실패를 3-상태 라벨로 보여주는 것이 이제 컴포넌트 책임이다.
- 복사 실패 시 `set-error` 디스패치 제거. 로그인 에러 채널을 복사 실패가
  오염하던 문제가 여기서 사라진다.
- 반환 객체에서 `copyLoginLink` 제거(`:311`).
- 훅의 `ui` 파라미터 타입(`:20-26`)에는 `copied`가 없다. 시그니처 변경은 없다.

## 변경 3 — `gui/src/components/add-codex-account-reducer.ts`

- `AddCodexAccountUiState`에서 `copied: boolean` 필드 제거.
- `initialAddCodexAccountUiState`에서 `copied: false` 제거.
- 액션 유니온에서 `{ type: "set-copied"; copied: boolean }` 제거.
- reducer의 `case "set-copied"` 제거.

이 상태는 이제 컴포넌트 지역 상태다. 모달 reducer가 복사 피드백 같은
순간적 UI 상태를 들고 있을 이유가 없다.

## 변경 4 — `gui/src/components/AddCodexAccountModal.tsx`

- `oauth` 구조분해에서 `copyLoginLink` 제거.
- `<AddCodexAccountWaitingStep>`에서 `copied={ui.copied}` /
  `onCopyLoginLink={...}` prop 제거.

## i18n

새 키는 필요 없다. 표면 C가 `prov.copyLink` / `prov.linkCopied` /
`prov.linkCopyUnavailable` / `prov.didntOpen`을 쓰게 된다.

`codexAuth.copyLoginLink` / `codexAuth.loginLinkCopied` /
`codexAuth.loginLinkCopyFailed` 3개 키는 소비처가 0이 된다. 6개 로케일에서
삭제한다 — 죽은 키를 남기면 다음 사람이 이 표면에 별도 규약이 있다고 오해한다.
(5919779d 조사에서 "i18n 키는 살아 있고 소비처만 0건"이 오히려 혼란의 근거였다.)

**반드시 6개 파일을 같은 커밋에서 함께 지운다(A 감사 blocker #2).**
삭제 위치: `en.ts:1006-1008`, `ko.ts:707-709`, `zh.ts:707-709`,
`ja.ts:960-962`, `de.ts:690-692`, `ru.ts:1005-1007`.
정합 게이트는 `lint:i18n`이 **아니다** — `gui/eslint.config.js:12`가
`src/i18n/**`를 globalIgnores에 넣어 로케일 키에 대해 아무 의견이 없다.
실제 게이트는 두 개다: `gui/tests/claude-desktop-locale.test.ts`의
"locale key sets stay identical to the English source"(텍스트 파싱 집합 비교)와,
`en.ts:1361`의 `TKey = keyof typeof en` 때문에 발생하는 `tsc` 오류.

## 신규 테스트 — `gui/tests/add-codex-account-login-url.test.tsx`

기존 `gui/tests/add-codex-account-oauth.test.tsx`의 fetch 스텁 하네스를 따른다.
`/api/codex-auth/login`이 `{ url, flowId }`를 반환하도록 하고 모달을 마운트한다.

1. 대기 단계에서 인증 URL 전문이 DOM에 렌더된다(현재는 렌더되지 않음 → 실패해야 함).
2. `prov.didntOpen` 외부 링크가 그 URL을 가리킨다.
3. 복사 클릭 시 클립보드에 URL이 들어가고 라벨이 `prov.linkCopied`로 바뀐다.
4. 클립보드 부재 시 라벨이 `prov.linkCopyUnavailable`이 되고,
   **에러 notice(`.notice-err`)는 뜨지 않는다** — 복사 실패의 에러 채널 오염 금지.
5. 재인증 진입(`reauthAccountId` 지정)에서도 같은 블록이 렌더된다.
   **`startOAuth` 응답을 명시적으로 `act`로 기다린 뒤 단언한다** — 첫 렌더는
   `authUrl: ""`이라 기다리지 않으면 flaky다(A 감사 #5).

## 완료 기준

- `cd gui && bun x tsc -b` exit 0
- `cd gui && bun test tests` 전건 통과(기존 `add-codex-account-oauth.test.tsx`,
  `claude-desktop-locale.test.ts` 포함)
- `bun test tests/codex-auth-modal-status.test.ts` (루트) 통과 — 이 테스트가
  `add-codex-account-waiting-step.tsx`의 `aria-live="polite"`와 수동 코드
  disabled 조건을 소스 텍스트로 고정하고 있으므로 대기 화면 편집 시 함께 본다.
- 변경을 되돌리면 신규 테스트가 실패한다
- `rg "copyLoginLink|set-copied|loginLinkCopyFailed|loginLinkCopied" gui/src` → 0건
  (`loginLinkCopied`를 빼면 로케일 잔존을 놓친다 — A 감사 #9)
