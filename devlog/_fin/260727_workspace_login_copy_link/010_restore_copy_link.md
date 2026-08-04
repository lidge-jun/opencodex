# 010 — Workspace 로그인 URL 복사 버튼 복원

## 문제

Provider Workspace(Settings 탭)에서 OAuth 로그인을 시작하면 대기 패널이
"안 열렸나요? 여기를 클릭하세요" 링크만 보여주고, **로그인 URL 자체와
복사 버튼이 없다**. 브라우저가 자동으로 열리지 않거나 다른 브라우저/기기에서
로그인해야 하는 경우 사용자가 URL을 얻을 방법이 없다.

## 원인 (git 근거) — A 단계 감사로 정정됨

초안은 `9d016eb27`를 지목했으나 리뷰어가 반증했고, 직접 재확인한 결과 틀렸다.
실제 소실 지점은 두 갈래다.

- **Classic 경로 철거 `fa1af1b2`** ("feat(gui): Classic 뷰 경로 철거 (WP5)").
  `git grep -l OAuthPanel fa1af1b2^ -- gui/src` → `OAuthPanel.tsx` + `Providers.tsx`,
  `git grep -l OAuthPanel fa1af1b2 -- gui/src` → `OAuthPanel.tsx`만. 즉 렌더 지점이
  여기서 사라졌다.
- **Workspace 패널 신설 `df010cf3`**. `ProviderAuthPanel.tsx`는 태어날 때부터
  copy-link가 없었다 — Workspace 사용자는 이 버튼을 가진 적이 없다.
- `9d016eb27`는 이미 고아가 된 파일을 지운 후속 청소일 뿐이다
  (`git grep -l OAuthPanel 9d016eb27^ -- gui/src` → 자기 자신 1건).

어느 쪽이든 결론은 같다: 이건 이관 누락이고, i18n 키
(`prov.copyLink` / `prov.linkCopied`)는 6개 로케일에 그대로 살아 있다.

## 변경 계획 (diff-level)

### 1. `gui/src/components/provider-workspace/ProviderAuthPanel.tsx`

- import에 `IconLink` 추가 (`../../icons`에 이미 존재, line 38).
- 상태 추가: `const [linkCopyState, setLinkCopyState] = useState<"idle"|"copied"|"unavailable">("idle")`.
  - 3-상태인 이유: 기존 `copyTextToClipboard`(`oauth-health-display.ts:126`)는
    비보안 컨텍스트에서 throw 대신 `false`를 반환한다. 실패를 조용히 삼키면
    사용자는 복사됐다고 오인한다 → `unavailable` 라벨을 별도로 표시.
- `hintForThis.url &&` 블록을 링크 하나에서 다음 구조로 교체:
  - `<code className="pwi-auth-url">{hintForThis.url}</code>` — URL 전문 노출
    (`user-select: all`로 수동 드래그 복사도 가능).
  - 복사 버튼: `copyTextToClipboard(hintForThis.url)` → 2.5초 후 라벨 복귀.
    기존 device-code 복사와 동일한 타이밍 규약.
  - 기존 `prov.didntOpen` 외부 링크는 그대로 유지 (제거 금지).
- `navigator.clipboard.writeText` 직접 호출 대신 `copyTextToClipboard` 사용:
  같은 파일이 이미 doctor 복사에서 쓰는 안전 래퍼.

### 2. i18n — 6개 로케일 (`en/ko/ja/zh/de/ru`)

- 신규 키 1개만 추가: `"prov.linkCopyUnavailable"`.
  `prov.copyLink` / `prov.linkCopied`는 이미 존재하므로 재사용.
- 삽입 위치는 각 로케일의 `"prov.linkCopied"` 바로 다음 줄(인접 그룹 유지).

### 3. `gui/src/styles/provider-workspace-settings.css`

- `.pwi-auth-url-wrap` (세로 스택), `.pwi-auth-url`
  (`overflow-wrap: anywhere` — OAuth URL은 매우 길다, `user-select: all`),
  `.pwi-auth-url-actions` (버튼 + 링크 가로 배치, wrap 허용).
- 기존 `.pwi-auth-open-link` 정의 직후에 추가하여 인접성 유지.

### 4. 신규 프로바이더 추가 모달 (감사 반영으로 승격)

- `add-provider-modal-reducer.ts`: 상태에 `oauthUrl: string` + 액션
  `set-oauth-url`. `choose-preset` / `back` / `use-api-key-instead`에서
  `oauthMsg`와 함께 초기화한다(스테일 URL 잔존 금지).
- `use-add-provider-oauth.ts`: `setOauthUrl(url, providerId)` 시그니처로
  로그인 시작 시 초기화하고 응답의 `data.url`을 프로바이더 신원과 함께 보존.
- `choose-preset` / `back` / `use-api-key-instead`는 `oauthBusy`도 함께
  내린다. 안 내리면 A의 in-flight 상태가 B의 패널에서 렌더 조건을
  만족시키고, B의 로그인 버튼도 계속 disabled로 남는다.
- `AddProviderModal.tsx`: `oauthSetters`에 `setOauthUrl` 추가, 팬에 prop 전달.
- `add-provider-oauth-pane.tsx`: `oauthBusy && oauthUrl`일 때 동일한
  `.pwi-auth-url-wrap` 블록 렌더 (CSS 재사용).

### 5. 회귀 테스트 (신규 2파일)

#### `gui/tests/provider-auth-login-copy-link.test.tsx`

`gui/tests/codex-auth-recovery-interaction.test.tsx`의 happy-dom + react act
하네스를 따른다.

- `ProviderAuthPanel`을 `LanguageProvider`로 감싸 마운트,
  `busy=true`, `loginHint={{ provider, url }}`, `surface`가 oauth-accounts가
  아닌 provider item 사용.
- 단언 1: URL 텍스트가 DOM에 렌더된다.
- 단언 2: 복사 버튼 클릭 시 `navigator.clipboard.writeText`가 그 URL로 호출되고
  라벨이 `prov.linkCopied`로 바뀐다.
- 단언 3: clipboard API 부재 시 라벨이 `prov.linkCopyUnavailable`로 바뀐다
  (조용한 실패 금지).
- 단언 4: 2.5초 창 안에서 재클릭해도 뒤 클릭의 피드백이 제 수명을 다한다
  (타이머 가드 회귀).
- 단언 5: `prov.didntOpen` 외부 링크가 살아있다(제거 금지 조항의 집행).
- 단언 6: `loginHint.provider !== item.name`이면 아무것도 렌더하지 않는다.

버튼은 영어 라벨이 아니라 `.pwi-auth-url-actions button`으로 구조 조회한다
(라벨이 상태에 따라 바뀌므로).

#### `gui/tests/add-provider-oauth-url-leak.test.tsx`

모달 표면의 고유 위험은 복사 동작이 아니라 **비동기 응답과 프리셋 전환의
경쟁**이다. `/api/oauth/login` 응답을 테스트가 직접 붙잡았다 놓는 스텁으로
세 가지를 고정한다.

- 프리셋을 A→B로 바꾼 뒤 A의 URL이 도착해도 렌더되지 않는다.
- 진행 중인 프로바이더 자신의 URL은 정상 렌더된다.
- **A·B 로그인이 겹친 상태에서 B가 먼저 응답하고 A가 늦게 도착해도
  B의 URL이 지워지지 않는다.**

세 번째 케이스가 reducer 가드를 요구했다: 렌더 시점 필터
(`oauthUrlProvider === preset.oauthProvider`)만으로는 스테일 응답이 상태를
덮어써서 **맞는 URL이 사라진다**. `set-oauth-url`에서
`state.preset?.oauthProvider !== action.providerId`면 상태를 그대로 반환한다.
두 가드 모두 되돌려서 테스트가 실패하는 것을 확인했다.

## 범위 밖

- `AddCodexAccountModal` / `add-codex-account-waiting-step.tsx`의 복사 버튼:
  이미 정상 동작(`codexAuth.copyLoginLink`). 건드리지 않는다.
- 서버/`src/` 변경 없음. OAuth 프로토콜 변경 없음.

## A 단계 감사 반영 (GO-WITH-FIXES, blockers=3)

리뷰어 판정 `GO-WITH-FIXES (blockers=3)`, Critical/High 0건. 처리 내역:

1. **[M] 원인 오귀속** → 위 "원인" 절과 테스트 헤더 주석을 `fa1af1b2` +
   `df010cf3`로 정정. (folded)
2. **[M] 복사 피드백 타이머 미보호** → 리뷰어가 제안한 functional update
   (`current === outcome ? "idle" : current`)는 **불충분했고 테스트가 이를
   증명했다**: 같은 outcome으로 두 번 누르면 앞 타이머가 뒤 클릭의 라벨을
   여전히 지운다. ref에 타이머 id를 들고 재클릭·언마운트 시 `clearTimeout`
   하는 방식으로 교체했다. 두 표면 모두 동일. (folded, 제안보다 강화)
3. **[M] 신규 프로바이더 추가 모달에는 여전히 URL 없음** — "브라우저가 안 열림"이
   가장 잘 일어나는 표면이라는 지적이 타당해 **범위 밖에서 범위 안으로 승격**.
   `use-add-provider-oauth.ts`가 버리던 `data.url`을 reducer 상태
   (`oauthUrl`)로 보존하고 `add-provider-oauth-pane.tsx`가 같은
   `<code>` + 복사 블록을 재사용한다. (folded)
4. **[L] 스크린리더 미고지** → 라벨 span에 `aria-live="polite"`. (folded)
5. **[L] 중복 `title` 툴팁** → 제거. (folded)
6. **[L] 테스트 공백 3건** → didntOpen 링크 생존, provider 불일치 가드,
   더블클릭 케이스 추가. (folded)
7. **[L] 무관한 goalplan ledger가 같은 트리에 dirty** → 커밋 시 경로를 명시
   스테이징한다. `git commit -a` 금지. (수용)

## 검증 (실측)

- `bun run typecheck` → exit 0
- `cd gui && bun x tsc -b` → exit 0
- `cd gui && bun test tests` → 301 pass / 0 fail (변경 전 기준선 대비 신규 9건)
- `bun run lint:gui` → exit 0
- `bun run test` (루트) → 4954 pass / 5 fail. 실패 5건은 전부
  `tests/management-provider-validation.test.ts`이며 `gui/` 변경과 무관하다.
  단독 실행 시 34/34 통과(2회 재현) — 병렬 실행 시 포트 경합 flake로 판정.
- 가드 검증: 수정을 stash하면 신규 테스트가 실패한다(회귀 방지 실효 확인).
