# 030 — 표면 A·B 이관 + i18n 정합 + 전체 검증 (wp3)

## 변경 1 — `gui/src/components/provider-workspace/ProviderAuthPanel.tsx`

- `linkCopyState` / `linkCopyTimer` / `copyLoginUrl` / 관련 `useEffect` 정리 훅 삭제.
- `hintForThis.url &&` 블록을 `<LoginUrlBlock url={hintForThis.url} />`로 교체.
  기존 `prov.didntOpen` 링크는 블록이 소유하므로 별도 렌더를 제거한다.
- import 정리(A 감사 #4로 실측 확정): `IconLink`, `IconExternal`, `useEffect`,
  `useRef`가 미사용이 되어 제거 대상이다. **`useState`는 남긴다** —
  `addingKey`/`newKey`/`keyBusy`/`deviceCodeCopied`(`:49-52`)와
  `copiedDoctorFor`(`:68`)가 계속 쓴다.
  `gui/tsconfig.app.json`이 `noUnusedLocals: true`라 틀리면 `tsc`가 즉시 잡는다.
- `copyTextToClipboard`는 doctor 복사에서 계속 쓰므로 import 유지.

### 보류 — 기기 코드 복사 (A 감사 #10으로 범위에서 제외)

같은 파일 147-152의 `prov.copyCode` 버튼이 `navigator.clipboard.writeText`를
직접 부르고 실패를 `.catch(() => {})`로 삼킨다. 실제 결함이다. 그러나 이 루프의
인과 사슬(로그인 URL 어포던스) 밖이고, 테스트가 없는 경로이며, 이 계획이 스스로
내건 "되돌리면 테스트가 실패한다" 보증을 흐린다. **별도 항목으로 남긴다.**

## 변경 2 — `gui/src/components/add-provider-oauth-pane.tsx`

- `linkCopyState` / `linkCopyTimer` / `copyAuthUrl` / 정리 `useEffect` 삭제.
- `oauthBusy && oauthUrl` 블록을 `<LoginUrlBlock url={oauthUrl} />`로 교체
  (렌더 조건 `oauthBusy &&`는 유지 — 스테일 URL 노출 방지 계약).
- import에서 `IconExternal` / `IconLink` / `copyTextToClipboard` /
  `useEffect` / `useRef` / `useState` 중 미사용분 제거.
- **`oauthUrlProvider` 필터와 reducer의 `set-oauth-url` 가드는 건드리지 않는다.**
  A/B 로그인 경쟁 회귀(`add-provider-oauth-url-leak.test.tsx`)를 지키는 계약이다.

## 변경 3 — i18n 6개 로케일

- `codexAuth.copyLoginLink` / `codexAuth.loginLinkCopied` /
  `codexAuth.loginLinkCopyFailed` 삭제(en/ko/ja/zh/de/ru).
- 나머지 키 변경 없음.
- 정합 게이트는 `lint:i18n`이 아니라
  `cd gui && bun test tests/claude-desktop-locale.test.ts`다
  (`gui/eslint.config.js:12`가 `src/i18n/**`를 무시한다 — A 감사 blocker #2).
  `lint:i18n`은 UI 파일의 하드코딩 문자열 규칙용이므로 별도로 계속 돌린다.

## 변경 4 — 기존 테스트 무수정 통과 확인

`gui/tests/provider-auth-login-copy-link.test.tsx`와
`gui/tests/add-provider-oauth-url-leak.test.tsx`는 라벨 텍스트와 구조
(`.pwi-auth-url-actions button`)로 조회하므로 이관 후에도 그대로 통과해야 한다.
**테스트를 고쳐서 통과시키지 않는다.** 통과하지 않으면 이관이 동등하지 않다는 뜻이다.

## 검증 (wp3 종료 조건)

| 명령 | 기대 |
|------|------|
| `bun run typecheck` | exit 0 |
| `cd gui && bun x tsc -b` | exit 0 |
| `cd gui && bun test tests` | 전건 통과 |
| `bun run lint:gui` | exit 0 |
| `cd gui && bun run lint:i18n` | exit 0 (로케일 키 정합은 이 명령이 보지 않는다) |
| `cd gui && bun test tests/claude-desktop-locale.test.ts` | 로케일 키 집합 동일 |
| `bun test tests/codex-auth-modal-status.test.ts` | 대기 화면 소스 계약 유지 |
| `bun run privacy:scan` | exit 0 |
| `bun run test` (루트) | 기준선 대비 신규 실패 0 |

루트 스위트는 착수 전 기준선을 먼저 측정해 비교한다(과거 이 저장소에서
`tests/management-provider-validation.test.ts`가 병렬 포트 경합으로 flake를
낸 전례가 있다 — 기준선 없이 "5건 실패"를 신규로 오판하면 안 된다).

## 소비처 확인

`rg -n "LoginUrlBlock" gui/src` → 표면 A·B·C 3건 + 컴포넌트 정의 1건.
`rg -n "pwi-auth-url-wrap" gui/src --glob '*.tsx'` → 컴포넌트 1건만.

## docs-site

`rg`로 확인한 결과 `docs-site/`에 copy-login-link 어포던스를 언급하는 문장이
0건이다. 표면 C가 URL과 외부 링크를 얻는 것은 사용자에게 보이는 변화지만,
문서가 이 화면의 구성 요소를 열거한 적이 없으므로 모순되는 서술이 생기지 않는다.
**문서 변경 없음 — 근거를 남기고 넘어간다**(A 감사 #11).

## 범위 밖

- `pwi-` 클래스 접두사 리네임(별도 항목).
- `prov.copyCode` 기기 코드 복사 규약 통일(별도 항목).
- 계정 풀/자동 전환 로직.
- push, 배포.
