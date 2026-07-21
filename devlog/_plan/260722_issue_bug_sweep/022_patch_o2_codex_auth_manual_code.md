# 022 — 패치 계획 O-2: codex-auth 수동 리다이렉트 URL/코드 입력 (#183)

- 소스 RCA: `004_rca_o_oauth_persistence_manual_code.md` O-2 절 (리뷰어 검증 완료)
- 위험도: 높음/C4 (인증 코드를 받는 신규 API 표면) — 020(Anthropic 지속성)과 별도 위협 모델이라 분리된 단위.
- 선행 조건: 없음.
- **구현 완료 (2026-07-22)**: auth-api.ts:766 `POST /api/codex-auth/login/code`(pending flowId 결속 + 4096자 제한 + `submitManualLoginCode("chatgpt")` 위임, 자체 교환 없음); AddCodexAccountModal.tsx 수동 붙여넣기 입력(autoComplete off, 제출/취소/만료/unmount 시 클리어, Enter 제출); 붙여넣은 값 무로깅, chatgpt는 isPublicOAuthProvider 제외 유지, raw-import 403 게이트(:141) 불변; 기존 prov.paste* i18n 재사용. 검증: codex-auth-api+oauth-manual-code 72 pass, `bun x tsc --noEmit` exit 0. 커밋: WP-impl-5.

## 목표와 비목표

헤드리스/원격 환경에서 Codex 계정 추가를 완료할 수 있도록 provider OAuth 모달과 동등한
수동 붙여넣기 경로를 codex-auth 표면에 추가한다. 공유 수동 코드 큐와 state 검증은 이미
`src/oauth/index.ts:512-562` 및 `src/oauth/callback-server.ts:239-247`에 있으므로 신규 코드 교환
로직을 만들지 않고 그 경로만 호출한다.

- generic `POST /api/oauth/login/code`는 재사용하지 않는다. 이 라우트는
  `isPublicOAuthProvider()`를 요구하고, `src/oauth/index.ts:124`는 `chatgpt`를 명시적으로 제외한다.
- `isPublicOAuthProvider()`의 chatgpt 제외를 변경하지 않는다.
- raw access/refresh token import를 허용하거나 환경변수 게이트를 완화하지 않는다.
- 붙여넣은 redirect URL/code를 저장·기록·응답 반사하지 않는다.

## 파일 변경 맵

| 파일 | 작업 | 내용 |
|------|------|------|
| `src/codex/auth-api.ts` | MODIFY | 동일 dispatcher에 `POST /api/codex-auth/login/code` sibling route 추가, pending `flowId` 결속 및 4096자 제한 |
| `gui/src/components/AddCodexAccountModal.tsx` | MODIFY | `oauth-waiting` 뷰에 수동 redirect URL/code 입력·제출 UI 및 secret 정리 수명주기 추가 |
| `tests/codex-auth-api.test.ts` | MODIFY | 신규 codex-auth endpoint의 성공·입력 경계·flow race·정책 회귀 케이스 추가 |
| `tests/oauth-manual-code.test.ts` | VERIFY ONLY | shared manual-code/state 검증 precedent 회귀 확인; 파일 수정은 기본 범위 아님 |

신규 i18n 파일은 만들지 않는다. UI 문구는 이미 provider 모달이 사용하는 `prov.pasteRedirectHint`,
`prov.pasteRedirect`, `prov.pasteSubmit`, `prov.pasteSubmitting`, `prov.pasteOk`, `prov.pasteFail`을 재사용한다.

## Diff 1 — `src/codex/auth-api.ts:766` dispatcher sibling route

로그인 시작점은 현재 `src/codex/auth-api.ts:566-588`이며, 서버가 생성한
`flow-${Date.now()}-...` 값을 `codexAuthLoginState`에 pending으로 기록한 뒤 GUI에 반환한다.

```ts
  if (url.pathname === "/api/codex-auth/login" && req.method === "POST") {
    // ...
    const flowId = `flow-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      const { startLoginFlow, getLoginStatus } = await import("../oauth");
      const result = await startLoginFlow("chatgpt", { forceLogin: true });
```

Before (현행 삽입 앵커, `src/codex/auth-api.ts:766-772`):

```ts
  if (url.pathname === "/api/codex-auth/login/cancel" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as { flowId?: string };
    const { cancelLoginFlow } = await import("../oauth");
    const cancelled = cancelLoginFlow("chatgpt");
    expireCodexAuthFlow(body.flowId ?? null);
    return jsonResponse({ ok: true, cancelled });
  }
```

After (cancel block 바로 앞에 새 sibling block 삽입):

```ts
  if (url.pathname === "/api/codex-auth/login/code" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as { flowId?: unknown; input?: unknown };
    const flowId = typeof body.flowId === "string" ? body.flowId.trim() : "";
    const input = typeof body.input === "string" ? body.input : "";
    if (!flowId) return jsonResponse({ error: "flowId required" }, 400);
    if (input.length > 4096) return jsonResponse({ error: "input too long" }, 400);

    // Import may yield; validate only after it completes so cancel/replace cannot race
    // a stale flow through this endpoint.
    const { submitManualLoginCode } = await import("../oauth");
    const flow = codexAuthLoginState.get(flowId);
    if (!flow) return jsonResponse({ error: "login flow expired or unknown" }, 404);
    if (flow.status !== "pending") return jsonResponse({ error: "login flow is not pending" }, 409);

    const result = submitManualLoginCode("chatgpt", input);
    if (!result.ok) return jsonResponse({ error: result.error }, 409);
    return jsonResponse({ ok: true });
  }

  if (url.pathname === "/api/codex-auth/login/cancel" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as { flowId?: string };
    const { cancelLoginFlow } = await import("../oauth");
    const cancelled = cancelLoginFlow("chatgpt");
    expireCodexAuthFlow(body.flowId ?? null);
    return jsonResponse({ ok: true, cancelled });
  }
```

계약은 `{ flowId, input }`만 받는다. 빈 입력과 “진행 중 로그인 없음” 판정은
`submitManualLoginCode("chatgpt", input)`의 기존 fail-closed 결과(`empty code`,
`no login in progress`)를 409로 전달한다. URL/query 형태의 state 누락·불일치도
`src/oauth/index.ts:553-557`에서 동기 거부하며, callback 대기 루프의
`src/oauth/callback-server.ts:239-247` 재검증을 우회하지 않는다. 성공은 `{ ok: true }` 200이고,
완료 여부는 기존 `GET /api/codex-auth/login-status?flowId=...` 폴링으로 관찰한다.

## Diff 2 — `gui/src/components/AddCodexAccountModal.tsx` 제출 동작과 secret 수명

`startOAuth`는 현행 `:82-108`에서 `POST /api/codex-auth/login` 응답의 `flowId`를
`flowRef.current`에 저장한다. 이 값 외의 “최신 플로우 추정”이나 legacy status fallback은
수동 제출에 사용하지 않는다.

After (기존 state/ref 선언과 `copyLoginLink` 다음에 추가할 구체 형상):

```tsx
  const [manualCode, setManualCode] = useState("");
  const [manualCodeBusy, setManualCodeBusy] = useState(false);

  const clearManualCode = useCallback(() => {
    setManualCode("");
    setManualCodeBusy(false);
  }, []);

  const submitManualCode = useCallback(async () => {
    const flowId = flowRef.current;
    const input = manualCode.trim();
    if (!flowId || !input || manualCodeBusy) return;
    setManualCodeBusy(true);
    setManualCode(""); // request 시작 전에 React state에서 bearer-like secret 제거
    try {
      const resp = await fetch(`${apiBase}/api/codex-auth/login/code`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ flowId, input }),
      });
      const data = await resp.json().catch(() => ({})) as { error?: string };
      if (!aliveRef.current) return;
      if (!resp.ok) {
        setError(t("prov.pasteFail", { error: data.error ?? resp.statusText }));
        return;
      }
      setError("");
    } catch {
      if (aliveRef.current) setError(t("modal.networkError"));
    } finally {
      if (aliveRef.current) setManualCodeBusy(false);
    }
  }, [apiBase, manualCode, manualCodeBusy, t]);
```

`clearManualCode()`는 다음 기존 경계에 반드시 연결한다.

- `cancelLogin()` 진입 시(early return 전 포함)
- polling의 `done`, `error`, `expired` 분기에서 `flowRef.current = null`과 함께
- 300초 timeout 분기에서 cancel 전에
- 새 `startOAuth()` 시작 시 이전 플로우 값 폐기와 함께
- unmount cleanup에서 fetch cancel 요청을 보내기 전에

따라서 값은 입력 중에만 transient React state에 있고, 제출 시작·성공·취소·만료·교체·unmount
후에는 남지 않는다. localStorage/sessionStorage/ref/로그로 복제하지 않는다.

## Diff 3 — `gui/src/components/AddCodexAccountModal.tsx:240` waiting-view 삽입

Before (현행 전체 대기 블록, `:240-255`; 링크 복사·오류·spinner·취소만 존재):

```tsx
        {step === "oauth-waiting" && (
          <>
            <h3 style={{ marginBottom: 4 }}>{reauthAccountId ? t("codexAuth.reauthenticate") : t("codexAuth.oauthLogin")}</h3>
            <p className="modal-desc">{t("codexAuth.oauthWaiting")}</p>
            <button className="btn btn-ghost" onClick={copyLoginLink} disabled={!authUrl} style={{ width: "100%", justifyContent: "center", marginTop: 12 }}>
              <IconLink width={14} /> {copied ? t("codexAuth.loginLinkCopied") : t("codexAuth.copyLoginLink")}
            </button>
            {error && <div className="notice notice-err" style={{ marginTop: 12 }}>{error}</div>}
            <div style={{ textAlign: "center", padding: "24px 0" }}>
              <span className="spin" style={{ width: 24, height: 24 }} />
            </div>
            <button className="btn btn-ghost" onClick={closeModal} style={{ width: "100%" }}>
              {t("codexAuth.cancel")}
            </button>
          </>
        )}
```

After (copy-login-link 버튼 다음, error notice 앞에 provider 모달 형상을 삽입):

```tsx
        {step === "oauth-waiting" && (
          <>
            <h3 style={{ marginBottom: 4 }}>{reauthAccountId ? t("codexAuth.reauthenticate") : t("codexAuth.oauthLogin")}</h3>
            <p className="modal-desc">{t("codexAuth.oauthWaiting")}</p>
            <button className="btn btn-ghost" onClick={copyLoginLink} disabled={!authUrl} style={{ width: "100%", justifyContent: "center", marginTop: 12 }}>
              <IconLink width={14} /> {copied ? t("codexAuth.loginLinkCopied") : t("codexAuth.copyLoginLink")}
            </button>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 12 }}>
              <div className="muted text-label">{t("prov.pasteRedirectHint")}</div>
              <div style={{ display: "flex", gap: 8 }}>
                <input
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  value={manualCode}
                  onChange={e => setManualCode(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void submitManualCode();
                    }
                  }}
                  placeholder={t("prov.pasteRedirect")}
                  aria-label={t("prov.pasteRedirect")}
                  disabled={manualCodeBusy}
                  className="input text-label"
                />
                <button
                  className="btn btn-ghost"
                  type="button"
                  disabled={manualCodeBusy || !manualCode.trim() || !flowRef.current}
                  onClick={() => void submitManualCode()}
                >
                  {manualCodeBusy ? t("prov.pasteSubmitting") : t("prov.pasteSubmit")}
                </button>
              </div>
            </div>
            {error && <div className="notice notice-err" style={{ marginTop: 12 }}>{error}</div>}
            <div style={{ textAlign: "center", padding: "24px 0" }}>
              <span className="spin" style={{ width: 24, height: 24 }} />
            </div>
            <button className="btn btn-ghost" onClick={closeModal} style={{ width: "100%" }}>
              {t("codexAuth.cancel")}
            </button>
          </>
        )}
```

## 보안 불변식 체크리스트

- [ ] 붙여넣은 `input`을 서버/GUI 로그, telemetry, error 응답, 예외 메시지에 기록하거나 반사하지 않는다.
- [ ] 입력은 제출 시작 즉시 React state에서 지우고 성공·취소·만료·교체·unmount에서도 재차 지운다. ref 및 local/session storage에 보관하지 않는다.
- [ ] `<input autoComplete="off" spellCheck={false}>`를 유지한다.
- [ ] 서버가 발급하고 현재 `codexAuthLoginState`가 `pending`으로 보유한 정확한 `flowId`만 수용한다. unknown/expired/completed/cancelled/교체된 flow는 fail-closed다.
- [ ] 4096자를 초과한 입력은 shared queue 호출 전에 거부한다. 빈 입력과 “로그인 진행 없음”도 fail-closed다.
- [ ] state 검증은 `src/oauth/index.ts:512,553-557` 및 `src/oauth/callback-server.ts:239-247`의 shared layer에 남긴다. endpoint에서 code exchange/PKCE/state 예외를 새로 구현하지 않는다.
- [ ] URL/query-shaped 응답은 matching state 필수이고, state 예외는 문법적으로 raw인 code가 원 PKCE verifier에 결속된 현재 세션에 제출될 때만 유지한다.
- [ ] raw-token import 정책은 변경하지 않는다: `src/codex/auth-api.ts:134-138`의 환경변수 판정/403 응답과 `:392`의 POST accounts gate는 그대로 유지한다.
- [ ] `src/oauth/index.ts:124`의 `chatgpt` public-provider 제외를 유지한다. generic endpoint 노출 확대로 해결하지 않는다.

## 테스트 변경 — 정확한 파일과 케이스

`tests/codex-auth-api.test.ts`에 `POST /api/codex-auth/login/code` describe/cases를 추가한다.
테스트 fixture는 실제 `POST /api/codex-auth/login`으로 flow를 시작해 반환된 `flowId`를 사용하고,
OAuth module의 수동 제출 결과만 격리한다. private map을 우회하는 production test hook은 추가하지 않는다.

- valid submit: pending flow의 `{ flowId, input }`이 `submitManualLoginCode("chatgpt", input)`에 1회 전달되고 200 `{ ok: true }`; 응답 body에 input 없음.
- missing flowId: 빈 문자열/누락은 400이며 shared submit 미호출.
- unknown/expired flowId: map에 없는 flow는 404이며 shared submit 미호출.
- completed/cancelled flowId: pending이 아닌 flow는 409이며 shared submit 미호출.
- empty input: pending flow라도 409 `empty code`.
- oversized input: 4097자는 400 `input too long`; 4096자 경계는 size gate를 통과.
- no login in progress: codex flow map은 pending이나 shared OAuth login state가 없는 경우 409.
- state mismatch: 다른 시도의 state를 가진 redirect URL은 409; shared `oauth/index.ts` 검증 경유를 증명.
- cancel/replace race: import/submit 직전 기존 flow를 cancel하고 새 flow를 시작한 뒤 늦은 old `flowId` 제출이 409이고 새 flow의 manual slot에 값이 들어가지 않음.
- raw-import policy still gated: `OPENCODEX_ENABLE_UNVERIFIED_CODEX_IMPORT` 미설정 상태의 `POST /api/codex-auth/accounts`가 계속 403 `manual_import_disabled`; 신규 code endpoint가 이 gate를 바꾸지 않음.

`tests/oauth-manual-code.test.ts`는 shared precedent 검증 파일로서 기존 raw-code PKCE 결속,
redirect state mismatch, cancel/no-login-in-progress 케이스가 계속 통과해야 한다. 신규 codex route 전용
케이스는 이 파일에 중복하지 않는다.

## 수용 기준 / 검증

- [ ] `bun test tests/codex-auth-api.test.ts` 통과 (위 신규 10개 경계/레이스 케이스 포함)
- [ ] `bun test tests/oauth-manual-code.test.ts` 통과 (shared manual-code/state 검증 불변)
- [ ] `bun run typecheck` 통과
- [ ] valid submit, missing/unknown/expired flowId, empty/oversized input, no login in progress, state mismatch, cancel/replace race가 각각 독립 테스트 이름으로 존재하고 기대 status/body/call count를 검증
- [ ] raw-import policy 403 gate, `isPublicOAuthProvider("chatgpt") === false`, shared state/PKCE 검증 경로가 변경되지 않음
- [ ] 보안 불변식 체크리스트 전 항목 코드 리뷰 통과
- [ ] 선택적 수동 확인: 로그인 링크 복사 → 다른 브라우저 인증 → redirect URL 붙여넣기/Enter → 기존 status polling으로 계정 추가 완료
