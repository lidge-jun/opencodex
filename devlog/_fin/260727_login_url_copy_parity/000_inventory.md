# 000 — 로그인 URL 복사 어포던스 인벤토리 (조사)

세 개의 OAuth 로그인 대기 표면이 서로 다른 수준의 어포던스를 들고 있다.
5919779d가 둘을 고쳤고 하나는 그대로 남았다. 아래는 조사 시점(dev @ f327db1e)의
실측이다.

## 표면 A — Provider Workspace 설정 패널

`gui/src/components/provider-workspace/ProviderAuthPanel.tsx:150-172`

- URL 전문: `<code className="pwi-auth-url">{hintForThis.url}</code>` — 있음
- 복사 버튼: 3-상태(`idle` / `copied` / `unavailable`), `copyTextToClipboard` 사용
- 타이머: `linkCopyTimer` ref + 언마운트 `clearTimeout`
- 외부 링크: `prov.didntOpen` 있음
- a11y: 라벨 span에 `aria-live="polite"`
- 기기 코드 복사(`prov.copyCode`)는 `navigator.clipboard.writeText` 직접 호출 —
  같은 파일 안에서 규약이 갈린다(복사 실패 시 라벨 변화 없음).

## 표면 B — 프로바이더 추가 모달

`gui/src/components/add-provider-oauth-pane.tsx:38-93`

표면 A와 동일한 블록을 **복제**해서 들고 있다. 상태 이름(`linkCopyState`),
타이머 ref, 렌더 트리, 클래스명까지 같다. 즉 이미 2벌 중복이다.

## 표면 C — Codex/ChatGPT 계정 추가·재인증 모달 (구멍)

`gui/src/components/add-codex-account-waiting-step.tsx:41-43`
`gui/src/components/use-add-codex-account-oauth.ts:253-273`

- URL 전문: **없음**. `ui.authUrl`은 상태에 있지만 화면에 렌더되지 않는다.
  복사 버튼이 듣지 않는 환경(비보안 컨텍스트)에서 URL을 얻을 방법이 0이다.
- 복사 피드백: 2-상태(`copied` boolean)뿐. 실패는
  `dispatch({type:"set-error"})`로 **에러 notice**에 섞인다
  (`codexAuth.loginLinkCopyFailed`). 복사 실패와 로그인 실패가 같은 자리에
  같은 톤으로 뜬다.
- 복사 구현: `navigator.clipboard?.writeText` → 실패 시 `document.execCommand("copy")`
  수동 textarea 폴백. 저장소 공용 래퍼(`oauth-health-display.ts:126`
  `copyTextToClipboard`)를 쓰지 않는 유일한 경로다.
- 타이머: `setTimeout` 2.5초, ref 없음. 연속 클릭 시 앞 타이머가 뒤 라벨을
  지운다 — 5919779d 감사에서 이미 잡혔던 회귀가 이 파일에만 남았다.
- 외부 링크(`prov.didntOpen`): **없음**.

`AddCodexAccountModal`은 계정 추가와 재인증 두 진입점을 모두 이 대기 화면으로
보낸다(`AddCodexAccountModal.tsx:66-84`, `CodexAccountPool.tsx` `openReauth`).
즉 ChatGPT 계정을 추가하는 모든 사용자가 구식 표면을 만난다.

## 데이터 경로

| 표면 | URL 출처 | 상태 보관 |
|------|----------|-----------|
| A | `POST /api/oauth/login` → `loginInfo.url` (`use-providers-oauth.ts:84`) | `Providers.tsx` useState |
| B | 같은 엔드포인트 → `oauthUrl` + `oauthUrlProvider` | `add-provider-modal-reducer.ts` |
| C | `POST /api/codex-auth/login` → `data.url` (`use-add-codex-account-oauth.ts:157`) | `add-codex-account-reducer.ts` `authUrl` |

서버는 세 경로 모두 URL을 이미 내려주고, 브라우저 열기까지 서버가 이미 시도한다
(`src/server/management/oauth-account-routes.ts:100-106`,
`src/codex/auth-api.ts:759-761`). 서버 변경은 필요 없다. 이 사실이 블록의
성격을 결정한다 — 이 블록은 기본 경로가 아니라 **자동 열기 실패 뒤의 복구 경로**다.

## i18n 현황

`prov.copyLink` / `prov.linkCopied` / `prov.linkCopyUnavailable` /
`prov.didntOpen`은 6개 로케일(en/ko/ja/zh/de/ru)에 모두 있다.
`codexAuth.copyLoginLink` / `codexAuth.loginLinkCopied` /
`codexAuth.loginLinkCopyFailed`도 6개 로케일에 있으나 표면 C 전용이다.

## CSS 현황

`gui/src/styles/provider-workspace-settings.css:36-39`에
`.pwi-auth-open-link` / `.pwi-auth-url-wrap` / `.pwi-auth-url` /
`.pwi-auth-url-actions`가 이미 정의돼 있고 표면 A·B가 공유한다.
접두사 `pwi-`(provider workspace item)가 모달에서도 쓰이는 상태라
이름과 소속이 어긋난다.

## 문제 정의

1. 표면 C에 URL 전문·외부 링크가 없어 "브라우저가 안 열림" 상황에서 막힌다.
2. 표면 C의 복사 실패가 에러로 오분류되고 3-상태 피드백이 없다.
3. 표면 C의 타이머가 ref로 보호되지 않는다.
4. 표면 A·B가 같은 블록을 2벌 복제해 다음 회귀가 다시 갈라질 준비를 하고 있다.

## 결론 — 작업 분해

- wp1: 공용 컴포넌트 신설(3벌 중복의 단일 소유자) + 단위 테스트.
- wp2: 표면 C 채택 + 복사 규약 통일 + 타이머 하드닝 + 회귀 테스트.
- wp3: 표면 A·B 이관, i18n 정합, 전체 검증.
