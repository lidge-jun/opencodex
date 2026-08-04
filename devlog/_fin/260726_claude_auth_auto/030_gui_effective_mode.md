# 030 — WP3: Claude tab three-state select + effective-mode reason

Depends on WP2 (the GET payload fields). Audit fold-back from `002` §3: the select
itself must become three-state, or every save silently kills auto and there is no way
back.

## MODIFY — the auth-mode select (`gui/src/pages/claude-code-sections.tsx:38-48`)

```diff
           options={[
+            { value: "auto", label: t("claude.authModeAuto") },
             { value: "subscription", label: t("claude.authModeSubscription") },
             { value: "proxy", label: t("claude.authModeProxy") },
           ]}
```

`auto` is FIRST and is what an unset config now reports, so opening the page on a
fresh install shows the truth instead of a coerced "Subscription".

## MODIFY — `gui/src/pages/ClaudeCode.tsx` state type

`authMode` widens to `"auto" | "proxy" | "subscription"` and the mapping at `:42-45`
stops coercing — it takes the server's value verbatim (the coercion is the auto-kill
bug). `ClaudeCodeState` also gains:

```ts
markerMode?: "proxy" | "subscription";
authModeOrigin?: "manual" | "auto-present" | "auto-absent" | "auto-unknown";
authFoundBy?: string;
authDetectionUnknown?: boolean;
admissionKeyActive?: boolean;
```

mapped from the GET payload alongside the `authMode` mapping (`:44`). The save body
(`:95-110`) sends the state's `authMode` unchanged — now that the value round-trips
as `"auto"`, an unrelated edit no longer converts the user to sticky subscription.

## The reason line (same row)

Under the existing select, one muted line that answers "what will actually happen on
the next `ocx claude` run":

- origin manual → `t("claude.effectiveMode.manual", { mode })`
- auto-present → `t("claude.effectiveMode.autoPresent", { source })` with the source
  mapped through `t("claude.authSource." + foundBy)` when known
- auto-absent → `t("claude.effectiveMode.autoAbsent")`
- auto-unknown → `t("claude.effectiveMode.autoUnknown")` rendered with the warning
  tone (amber), because the user should know detection failed.

When `admissionKeyActive` is true, append `t("claude.effectiveMode.admissionKey")` —
a subscription resolution still ships the admission token, and hiding that would make
the badge lie (002 §2).

## Locale keys — NEW (all six)

| Key | en | ko |
|-----|----|----|
| `claude.effectiveMode.label` | `Effective on next launch` | `다음 실행 시 적용` |
| `claude.effectiveMode.manual` | `Manual: {mode}` | `수동: {mode}` |
| `claude.effectiveMode.autoPresent` | `Auto: subscription (Claude auth found via {source})` | `자동: 구독 ({source}에서 인증 발견)` |
| `claude.effectiveMode.autoAbsent` | `Auto: proxy mode (no Claude auth found)` | `자동: 프록시 모드 (인증 없음)` |
| `claude.effectiveMode.autoUnknown` | `Auto: subscription (auth could not be verified)` | `자동: 구독 (인증 확인 불가)` |
| `claude.authSource.claude-json-oauth` | `Claude account` | `Claude 계정` |
| `claude.authSource.claude-credentials-file` | `Claude credentials file` | `Claude 자격 증명 파일` |
| `claude.authSource.macos-keychain` | `macOS Keychain` | `macOS 키체인` |
| `claude.authSource.exported-env` | `environment variable` | `환경 변수` |
| `claude.authModeAuto` | `Auto (detect Claude auth)` | `자동 (Claude 인증 감지)` |
| `claude.effectiveMode.admissionKey` | `API key required by this proxy is still sent` | `이 프록시의 API 키는 계속 전송됩니다` |

ja/zh/de/ru in the same commit.

## TESTS

`gui/tests/claude-auth-mode-badge.test.tsx` (NEW, mounted):

- manual proxy → the manual line renders with the mode name, no auto wording;
- auto-present with foundBy macos-keychain → the subscription line names the keychain;
- auto-absent → the proxy line renders;
- auto-unknown → the warning line renders and carries the warning styling hook;
- **the auto-kill regression (002 §3)**: mount with `authMode: "auto"`, change an
  unrelated control, save → the PUT body carries `authMode: "auto"`, never
  `"subscription"`;
- selecting `Auto` from a stored proxy sends `authMode: "auto"` (return-to-auto path);
- `admissionKeyActive: true` appends the admission note to a subscription reason;
- every new key resolves in all six locales.

## Verification (C)

| Command | Expected |
|---------|----------|
| `cd gui && bun test tests/claude-auth-mode-badge.test.tsx` | pass |
| `cd gui && bun run test` / `lint:i18n` | pass / clean |
