# 010 — PR #145 absorb on `dev`: 403 permission labels with 401 precedence

## 1. Scope and locked inputs

This phase absorbs community PR #145 from immutable source head
`fa4ca861c09eb20f99e189aee65764c151b5de8b` (`codex/source-pr145-fa4ca861`)
onto local `dev`, then lands maintainer repairs for all three Sol P2 findings.
The target is `dev`, **not `main`**. Do not rewrite the immutable source ref and do
not push or write to GitHub in this phase.

Authoritative attribution and source-head rules come from `000_plan.md`:

- contributor reconstruction: author `Wibias <37517432+Wibias@users.noreply.github.com>`,
  maintainer committer;
- maintainer repair/redesign: author `bitkyc08-arch <bitkyc08@gmail.com>` plus
  `Co-authored-by: Wibias <37517432+Wibias@users.noreply.github.com>`;
- every implementation commit body names community PR #145 and exact source head
  `fa4ca861c09eb20f99e189aee65764c151b5de8b`.

### Exclusions

- No change to status handling outside the 401/403 authentication/permission boundary.
- No provider-specific parameter is added to `classifyError`; stronger credential cues
  are sufficient to preserve Kiro/AWS credential failures without treating generic
  `Access denied` as authentication.
- No standalone GUI locale file changes. PR #145 changes only the inline `en`/`ko`/`zh`/`de`
  records in `gui/src/status-codes.ts`; `gui/src/i18n/{en,ko,zh,de}.ts` are untouched.
- No release, version bump, push, PR close, or issue write.

## 2. Current-`dev` evidence and conflict decision

Required comparison:

```bash
git diff dev...codex/source-pr145-fa4ca861 -- src tests gui
```

Observed source delta: six modified files, `+212/-81`:

```text
gui/src/status-codes.ts
src/lib/errors.ts
src/server/request-log.ts
tests/error-fidelity.test.ts
tests/errors-adapter-failure.test.ts
tests/request-log.test.ts
```

The PR is a single contributor commit. `git merge-tree --write-tree dev
codex/source-pr145-fa4ca861` produced tree
`58e2472d615aaffa02e143e8fe671ebdaaeefa30` with no conflict records. Since the
PR base, current `dev` changed only `src/server/request-log.ts`: it added
`requestedModel` persistence and the tail-only `clearRequestLogsForTests()` helper.
Neither overlaps PR #145's import, `requestLogErrorCode`, or `addFinalRequestLog`
hunks. There is therefore **no content conflict with current `dev`**.

There is one quality conflict: PR #145 reformats most boolean chains in
`src/lib/errors.ts`, producing a large formatting-only diff around a small behavior
change. Commit 1 preserves the contributor's exact checkpoint; Commit 2 restores
`src/lib/errors.ts` from current `dev` and re-derives the final focused behavior, so
the final two-commit range does not retain that churn.

| File | State | Landing decision |
|---|---|---|
| `gui/src/status-codes.ts` | MODIFY | CHERRY-PICK the exact 403 locale hunk from `fa4ca861`. |
| `src/server/request-log.ts` | MODIFY | CHERRY-PICK the three non-overlapping semantic hunks from `fa4ca861`; preserve current-`dev` `requestedModel` and `clearRequestLogsForTests()`. |
| `src/lib/errors.ts` | MODIFY | CHERRY-PICK exact source in Commit 1; in Commit 2 restore this file from pre-absorb current `dev` and RE-DERIVE the final focused behavior, removing PR formatting churn. |
| `tests/error-fidelity.test.ts` | MODIFY | CHERRY-PICK contributor assertions in Commit 1, then RE-DERIVE/expand negative 401/context cases in Commit 2. |
| `tests/errors-adapter-failure.test.ts` | MODIFY | CHERRY-PICK contributor assertions in Commit 1, then RE-DERIVE/expand the adapter-message matrix in Commit 2. |
| `tests/request-log.test.ts` | MODIFY | CHERRY-PICK contributor assertions in Commit 1, then RE-DERIVE/expand request-log and terminal-status negatives in Commit 2. |
| `tests/server-403-permission-e2e.test.ts` | NEW | Maintainer-authored real-HTTP integration coverage; no source file exists to cherry-pick. |

The real path grounded by the new integration test is current `dev`:
`src/server/responses.ts:995-1008` builds/fetches via the selected adapter,
`src/server/responses.ts:1122-1127` reads a non-2xx body and calls
`formatErrorResponse`, and `src/bridge.ts:917-920` invokes `classifyError`.
The deferred JSON log path then runs through `src/server/relay.ts:214-241` and
`src/server/request-log.ts:371-416`.

## 3. Final behavior contract

1. Authoritative status `401` or explicit `type === "authentication_error"` wins
   over subscription/permission wording.
2. `subscription_required` is emitted only when the context is HTTP 403 or an
   explicit permission error; a 400 carrying subscription words remains a 400
   invalid request.
3. Generic `Access denied` / `AccessDeniedException` is permission evidence. It is
   authentication evidence only when accompanied by a credential cue such as
   authentication, credential, API key, token, or signature text.
4. HTTP 403, permission text, and subscription text map to `permission_error` and
   terminal/log status 403. HTTP 401 remains `authentication_error` and log status
   401 even if the body asks the user to upgrade.
5. Request logs use `permission_denied` for a body-less/bare 403 and
   `subscription_required` for a classified subscription gate.
6. GUI status 403 keeps the existing localized labels and explains that plan,
   organization, or model access can be the cause and that the API key is not
   necessarily bad.

## 4. Diff-level implementation

All **before** snippets below are from current `dev`, not PR-head line numbers.
The **after** snippets are the required final state after both commits.

### 4.1 `src/lib/errors.ts` — MODIFY — CHERRY-PICK checkpoint, then RE-DERIVE final

#### A. Add focused message predicates after `OcxErrorPayload`

Before:

```ts
export interface OcxErrorPayload {
  message: string;
  type: string;
  code: string | null;
}

export function classifyError(status: number, type: string, message: string): OcxErrorPayload {
```

After:

```ts
export interface OcxErrorPayload {
  message: string;
  type: string;
  code: string | null;
}

function isSubscriptionGateMessage(text: string): boolean {
  return (
    text.includes("requires a subscription") ||
    text.includes("requires subscription") ||
    text.includes("subscription required") ||
    text.includes("upgrade for access") ||
    text.includes("upgrade to pro") ||
    text.includes("pro subscription") ||
    text.includes("ollama.com/upgrade") ||
    (text.includes("upgrade") && text.includes("subscription"))
  );
}

function isAuthenticationMessage(text: string): boolean {
  const accessDeniedWithCredentialCue = (
    text.includes("access denied") ||
    text.includes("accessdeniedexception")
  ) && (
    text.includes("authentication") ||
    text.includes("credential") ||
    text.includes("api key") ||
    text.includes("token") ||
    text.includes("signature")
  );
  return (
    text.includes("authentication failed") ||
    text.includes("invalid_api_key") ||
    text.includes("invalid api key") ||
    text.includes("invalid token") ||
    text.includes("unauthorizedexception") ||
    text.includes("unrecognizedclientexception") ||
    text.includes("unrecognizedclient") ||
    text.includes("expired token") ||
    text.includes("expiredtoken") ||
    text.includes("unauthenticated") ||
    text.includes("unauthorized") ||
    accessDeniedWithCredentialCue
  );
}

function isPermissionMessage(text: string): boolean {
  return (
    text.includes("permission_denied") ||
    text.includes("permission denied") ||
    text.includes("forbidden") ||
    text.includes("access denied") ||
    text.includes("accessdeniedexception") ||
    text.includes("not allowed to use") ||
    text.includes("model access")
  );
}

export function classifyError(status: number, type: string, message: string): OcxErrorPayload {
```

Do not export these predicates and do not add a provider argument. The credential-cue
conjunction is the Kiro/AWS exception boundary: a bare access-denied phrase cannot
enter the authentication branch.

#### B. Replace the current combined 401/403 block

Before (`src/lib/errors.ts:43-56` on current `dev`):

```ts
  if (
    status === 401 ||
    status === 403 ||
    type === "authentication_error" ||
    text.includes("authentication failed") ||
    text.includes("access denied") ||
    text.includes("unauthorizedexception") ||
    text.includes("unrecognizedclientexception") ||
    text.includes("unrecognizedclient") ||
    text.includes("expired token") ||
    text.includes("expiredtoken")
  ) {
    return { message, type: "authentication_error", code: "invalid_api_key" };
  }
```

After, in this exact order (after the existing `origin_rejected` branch and before
the 503 branch):

```ts
  // HTTP 401 and explicit auth failures are authoritative even when provider text
  // also advertises an upgrade or subscription.
  if (
    status === 401 ||
    type === "authentication_error" ||
    isAuthenticationMessage(text)
  ) {
    return { message, type: "authentication_error", code: "invalid_api_key" };
  }
  // Subscription labels are valid only in a known permission context.
  if (
    (status === 403 || type === "permission_error") &&
    isSubscriptionGateMessage(text)
  ) {
    return { message, type: "permission_error", code: "subscription_required" };
  }
  if (
    status === 403 ||
    type === "permission_error" ||
    isPermissionMessage(text)
  ) {
    return { message, type: "permission_error", code: "permission_denied" };
  }
```

Leave context-length, quota, rate-limit, `origin_rejected`, overload, validation,
generic 5xx, and generic 400 branches otherwise byte-for-byte in current-`dev` style.

#### C. Replace the authentication inference block

Before (`src/lib/errors.ts:114-124` on current `dev`):

```ts
  if (
    lower.includes("unauthenticated") ||
    lower.includes("unauthorized") ||
    lower.includes("permission_denied") ||
    lower.includes("permission denied") ||
    lower.includes("forbidden") ||
    lower.includes("invalid token") ||
    lower.includes("expired token") ||
    lower.includes("authentication") ||
    lower.includes("access denied")
  ) return 401;
```

After:

```ts
  // Strong authentication signals win when a message contains mixed auth and
  // subscription/permission wording.
  if (isAuthenticationMessage(lower)) return 401;
  if (isSubscriptionGateMessage(lower) || isPermissionMessage(lower)) return 403;
```

This intentionally changes an unqualified adapter message `Access denied` from 401
to 403. A Kiro/AWS message containing `expired token`, `credential`, `api key`, or
another listed credential cue remains 401.

#### D. Add the 403 adapter type and terminal mappings

Before (`adapterFailureFromMessage`):

```ts
  const errorType = httpStatus === 429
    ? "rate_limit_error"
    : httpStatus === 401
      ? "authentication_error"
      : httpStatus === 503 || httpStatus === 504
        ? "server_error"
        : httpStatus === 400
          ? "invalid_request_error"
          : "upstream_error";
```

After:

```ts
  const errorType = httpStatus === 429
    ? "rate_limit_error"
    : httpStatus === 401
      ? "authentication_error"
      : httpStatus === 403
        ? "permission_error"
        : httpStatus === 503 || httpStatus === 504
          ? "server_error"
          : httpStatus === 400
            ? "invalid_request_error"
            : "upstream_error";
```

Before (`httpStatusFromTerminalError`):

```ts
  if (error.type === "rate_limit_error" || error.code === "rate_limit_exceeded") return 429;
  if (error.type === "authentication_error" || error.code === "invalid_api_key") return 401;
  if (error.type === "insufficient_quota" || error.code === "insufficient_quota") return 429;
```

After:

```ts
  if (error.type === "rate_limit_error" || error.code === "rate_limit_exceeded") return 429;
  if (error.type === "authentication_error" || error.code === "invalid_api_key") return 401;
  if (
    error.type === "permission_error" ||
    error.code === "permission_denied" ||
    error.code === "subscription_required"
  ) return 403;
  if (error.type === "insufficient_quota" || error.code === "insufficient_quota") return 429;
```

Authentication remains above permission so a malformed mixed terminal object with
`type: "authentication_error"` and `code: "subscription_required"` stays 401.

### 4.2 `src/server/request-log.ts` — MODIFY — CHERRY-PICK semantic hunks

Preserve all unrelated current-`dev` changes. Apply only these three transformations.

Import before:

```ts
import { httpStatusFromTerminalError as httpStatusFromClassifiedTerminalError } from "../lib/errors";
```

Import after:

```ts
import {
  classifyError,
  httpStatusFromTerminalError as httpStatusFromClassifiedTerminalError,
} from "../lib/errors";
```

Function before (`src/server/request-log.ts:123-132` on current `dev`):

```ts
export function requestLogErrorCode(status: number): string | undefined {
  if (status >= 200 && status < 400) return undefined;
  if (status === 400 || status === 409) return "invalid_request_error";
  if (status === 401 || status === 403) return "invalid_api_key";
  if (status === 429) return "rate_limit_exceeded";
  if (status === 499) return "client_closed_request";
  if (status === 503) return "server_is_overloaded";
  if (status >= 500) return "upstream_server_error";
  return `http_${status}`;
}
```

Function after:

```ts
export function requestLogErrorCode(status: number, upstreamError?: string): string | undefined {
  if (status >= 200 && status < 400) return undefined;
  if (status === 400 || status === 409) return "invalid_request_error";
  if (status === 401) return "invalid_api_key";
  if (status === 403) {
    if (upstreamError?.trim()) {
      const code = classifyError(403, "upstream_error", upstreamError).code;
      if (code) return code;
    }
    return "permission_denied";
  }
  if (status === 429) return "rate_limit_exceeded";
  if (status === 499) return "client_closed_request";
  if (status === 503) return "server_is_overloaded";
  if (status >= 500) return "upstream_server_error";
  return `http_${status}`;
}
```

Call site before:

```ts
  const errorCode = requestLogErrorCode(status);
```

Call site after:

```ts
  const errorCode = requestLogErrorCode(status, logCtx.upstreamError);
```

Do not modify the current-`dev` `requestedModel` persistence or
`clearRequestLogsForTests()` tail helper.

### 4.3 `gui/src/status-codes.ts` — MODIFY — CHERRY-PICK exact hunk

Before (`gui/src/status-codes.ts:25-30` on current `dev`):

```ts
  403: {
    en: { label: "Forbidden", description: "The account is authenticated but not allowed to use this model or operation. Check provider permissions, org access, and policy restrictions." },
    ko: { label: "권한 없음", description: "계정 인증은 되었지만 이 모델 또는 작업을 사용할 권한이 없습니다. 제공자 권한, 조직 접근, 정책 제한을 확인해야 합니다." },
    zh: { label: "禁止访问", description: "账号已认证，但无权使用此模型或操作。请检查提供商权限、组织访问权限和策略限制。" },
    de: { label: "Verboten", description: "Das Konto ist authentifiziert, darf dieses Modell oder diese Operation aber nicht nutzen. Prüfe Anbieterberechtigungen, Organisationszugriff und Richtlinien." },
  },
```

After (exact contributor text):

```ts
  403: {
    en: { label: "Forbidden", description: "The account is authenticated but not allowed to use this model or operation. Often a plan/subscription gate (e.g. Ollama Cloud Pro), org policy, or model permission — not necessarily a bad API key." },
    ko: { label: "권한 없음", description: "계정 인증은 되었지만 이 모델 또는 작업을 사용할 권한이 없습니다. 플랜/구독 제한(예: Ollama Cloud Pro), 조직 정책, 모델 권한 문제인 경우가 많으며 API 키가 잘못된 것은 아닐 수 있습니다." },
    zh: { label: "禁止访问", description: "账号已认证，但无权使用此模型或操作。常见原因是套餐/订阅限制（例如 Ollama Cloud Pro）、组织策略或模型权限——不一定是 API 密钥无效。" },
    de: { label: "Verboten", description: "Das Konto ist authentifiziert, darf dieses Modell oder diese Operation aber nicht nutzen. Oft Plan-/Abo-Sperre (z. B. Ollama Cloud Pro), Organisationsrichtlinie oder Modellrecht — nicht zwingend ein ungültiger API-Key." },
  },
```

### 4.4 `tests/error-fidelity.test.ts` — MODIFY — CHERRY-PICK, then RE-DERIVE additions

In the existing `classifyError maps Codex-recognized context/quota/rate failures`
test, retain all current assertions and add this matrix after the existing
`origin_rejected` assertion:

Before anchor on current `dev`:

```ts
    expect(classifyError(403, "origin_rejected", "WebSocket upgrade blocked: non-local Origin")).toMatchObject({
      type: "invalid_request_error",
      code: "origin_rejected",
    });
    expect(classifyError(502, "upstream_error", "Kiro rate limit exceeded: ThrottlingException: rate limited")).toMatchObject({
```

After the `origin_rejected` assertion and before the Kiro rate-limit assertion:

```ts
    const subscription = "this model requires a subscription, upgrade for access: https://ollama.com/upgrade";
    expect(classifyError(403, "upstream_error", "Provider error 403")).toMatchObject({
      type: "permission_error",
      code: "permission_denied",
    });
    expect(classifyError(403, "upstream_error", "Access denied")).toMatchObject({
      type: "permission_error",
      code: "permission_denied",
    });
    expect(classifyError(403, "upstream_error", subscription)).toMatchObject({
      type: "permission_error",
      code: "subscription_required",
    });
    expect(classifyError(401, "upstream_error", subscription)).toMatchObject({
      type: "authentication_error",
      code: "invalid_api_key",
    });
    expect(classifyError(403, "authentication_error", subscription)).toMatchObject({
      type: "authentication_error",
      code: "invalid_api_key",
    });
    expect(classifyError(400, "permission_error", subscription)).toMatchObject({
      type: "permission_error",
      code: "subscription_required",
    });
    expect(classifyError(400, "upstream_error", subscription)).toMatchObject({
      type: "invalid_request_error",
      code: "invalid_request_error",
    });
```

Keep the existing Kiro assertion unchanged:

```ts
    expect(classifyError(502, "upstream_error", "Kiro authentication failed: AccessDeniedException: expired token")).toMatchObject({
      type: "authentication_error",
      code: "invalid_api_key",
    });
```

It proves that the stronger credential-cue exception still fires after generic
access denied moves to permission.

### 4.5 `tests/errors-adapter-failure.test.ts` — MODIFY — CHERRY-PICK, then RE-DERIVE additions

Append these tests inside the existing `describe("adapterFailureFromMessage", ...)`:

Before tail on current `dev`:

```ts
  test("maps authentication failures to 401", () => {
    expect(adapterFailureFromMessage("Cursor authentication failed: unauthorized")).toMatchObject({
      httpStatus: 401,
      error: { type: "authentication_error" },
    });
  });
});
```

After: retain that test and insert the following blocks before the final `});`:

```ts
  test("maps forbidden and subscription gates to 403 permission errors", () => {
    expect(adapterFailureFromMessage("Provider stream error: forbidden")).toMatchObject({
      httpStatus: 403,
      error: { type: "permission_error", code: "permission_denied" },
    });
    expect(adapterFailureFromMessage(
      "this model requires a subscription, upgrade for access: https://ollama.com/upgrade",
    )).toMatchObject({
      httpStatus: 403,
      error: { type: "permission_error", code: "subscription_required" },
    });
  });

  test("generic access denied is permission, while credential-qualified access denied is auth", () => {
    expect(adapterFailureFromMessage("Access denied")).toMatchObject({
      httpStatus: 403,
      error: { type: "permission_error", code: "permission_denied" },
    });
    expect(adapterFailureFromMessage("AccessDeniedException: security token expired")).toMatchObject({
      httpStatus: 401,
      error: { type: "authentication_error", code: "invalid_api_key" },
    });
  });

  test("authentication cues win over subscription wording", () => {
    expect(adapterFailureFromMessage(
      "authentication failed: invalid token; upgrade subscription for access",
    )).toMatchObject({
      httpStatus: 401,
      error: { type: "authentication_error", code: "invalid_api_key" },
    });
  });
```

The `security token` phrase activates the access-denied credential-cue conjunction;
the mixed-message test proves inference ordering, not only `classifyError` ordering.

### 4.6 `tests/request-log.test.ts` — MODIFY — CHERRY-PICK, then RE-DERIVE additions

Rename the existing test from `classifies status codes without reading response
bodies` to `classifies status codes with optional upstream error context`.

Before on current `dev`:

```ts
  test("classifies status codes without reading response bodies", () => {
    expect(requestLogErrorCode(200)).toBeUndefined();
    expect(requestLogErrorCode(400)).toBe("invalid_request_error");
    expect(requestLogErrorCode(401)).toBe("invalid_api_key");
    expect(requestLogErrorCode(429)).toBe("rate_limit_exceeded");
    expect(requestLogErrorCode(499)).toBe("client_closed_request");
    expect(requestLogErrorCode(503)).toBe("server_is_overloaded");
    expect(requestLogErrorCode(502)).toBe("upstream_server_error");
    expect(requestLogErrorCode(404)).toBe("http_404");
    expect(requestLogErrorCode(418)).toBe("http_418");
  });
```

After:

```ts
  test("classifies status codes with optional upstream error context", () => {
    expect(requestLogErrorCode(200)).toBeUndefined();
    expect(requestLogErrorCode(400)).toBe("invalid_request_error");
    expect(requestLogErrorCode(401)).toBe("invalid_api_key");
    expect(requestLogErrorCode(403)).toBe("permission_denied");
    expect(requestLogErrorCode(403, "Provider error 403")).toBe("permission_denied");
    expect(requestLogErrorCode(
      403,
      "Provider error 403: this model requires a subscription, upgrade for access: https://ollama.com/upgrade",
    )).toBe("subscription_required");
    expect(requestLogErrorCode(
      401,
      "Provider error 401: this model requires a subscription, upgrade for access",
    )).toBe("invalid_api_key");
    expect(requestLogErrorCode(429)).toBe("rate_limit_exceeded");
    expect(requestLogErrorCode(499)).toBe("client_closed_request");
    expect(requestLogErrorCode(503)).toBe("server_is_overloaded");
    expect(requestLogErrorCode(502)).toBe("upstream_server_error");
    expect(requestLogErrorCode(404)).toBe("http_404");
    expect(requestLogErrorCode(418)).toBe("http_418");
  });
```

Immediately after that status-code test, the current `dev` next-test anchor is:

```ts
  test("maps Codex fast service tier spellings to a display speed label", () => {
```

Insert the contributor's final-log coverage before that anchor:

```ts
  test("final 403 logs use permission/subscription codes instead of invalid_api_key", () => {
    const entries: RequestLogEntry[] = [];
    addFinalRequestLog(
      "ocx-test-403-perm",
      Date.now(),
      {
        model: "kimi-k2.7-code",
        provider: "ollama-cloud",
        upstreamError: "Provider error 403",
      },
      403,
      { closeReason: "non_stream" },
      entry => entries.push(entry),
    );
    expect(entries[0]).toMatchObject({
      status: 403,
      errorCode: "permission_denied",
      upstreamError: "Provider error 403",
    });

    const subEntries: RequestLogEntry[] = [];
    addFinalRequestLog(
      "ocx-test-403-sub",
      Date.now(),
      {
        model: "kimi-k2.7-code",
        provider: "ollama-cloud",
        upstreamError: "Provider error 403: this model requires a subscription, upgrade for access: https://ollama.com/upgrade",
      },
      403,
      { closeReason: "non_stream" },
      entry => subEntries.push(entry),
    );
    expect(subEntries[0]).toMatchObject({
      status: 403,
      errorCode: "subscription_required",
    });
  });
```

After the existing `httpStatusFromTerminalError maps Cursor rate limits to 429`
test, the current before anchor is:

```ts
  test("httpStatusFromTerminalError maps Cursor rate limits to 429", () => {
    expect(httpStatusFromTerminalError({
      type: "rate_limit_error",
      code: "rate_limit_exceeded",
      message: "Cursor rate limit exceeded: Cursor Connect error resource_exhausted: too many requests",
    })).toBe(429);
  });

  test("upstream reason capture redacts secret-shaped error messages", async () => {
```

After: retain the rate-limit test, insert the following block, then retain the
`upstream reason capture...` test:

```ts
  test("httpStatusFromTerminalError preserves auth precedence and permission status", () => {
    expect(httpStatusFromTerminalError({
      type: "authentication_error",
      code: "invalid_api_key",
      message: "upgrade your subscription",
    })).toBe(401);
    expect(httpStatusFromTerminalError({
      type: "permission_error",
      code: "permission_denied",
      message: "Access denied",
    })).toBe(403);
    expect(httpStatusFromTerminalError({
      type: "permission_error",
      code: "subscription_required",
      message: "this model requires a subscription",
    })).toBe(403);
  });
```

### 4.7 `tests/server-403-permission-e2e.test.ts` — NEW — RE-DERIVE

Create the file with this complete content:

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { classifyError } from "../src/lib/errors";
import { startServer } from "../src/server";
import { clearRequestLogsForTests } from "../src/server/request-log";
import type { OcxConfig } from "../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";

const SUBSCRIPTION_MESSAGE =
  "this model requires a subscription, upgrade for access: https://ollama.com/upgrade";

let testDir = "";
let previousHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-403-e2e-codex-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-403-e2e-"));
  process.env.OPENCODEX_HOME = testDir;
  clearRequestLogsForTests();
});

afterEach(() => {
  clearRequestLogsForTests();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (testDir) rmSync(testDir, { recursive: true, force: true });
});

function config(baseUrl: string): OcxConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "ollama-test",
    providers: {
      "ollama-test": {
        adapter: "openai-chat",
        baseUrl,
        allowPrivateNetwork: true,
        authMode: "key",
        apiKey: "ollama-test-key",
        models: ["pro-model"],
        defaultModel: "pro-model",
      },
    },
  } as OcxConfig;
}

async function runUpstreamFailure(status: 401 | 403, body: unknown): Promise<{
  path: string;
  responseStatus: number;
  error: { message?: string; type?: string; code?: string | null };
  log: { status?: number; errorCode?: string; upstreamError?: string };
}> {
  let path = "";
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      path = new URL(req.url).pathname;
      return Response.json(body, { status });
    },
  });
  saveConfig(config(`${upstream.url.toString().replace(/\/$/, "")}/v1`));
  const proxy = startServer(0);
  try {
    const response = await fetch(new URL("/v1/responses", proxy.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "ollama-test/pro-model",
        input: "hello",
        stream: false,
      }),
    });
    const payload = await response.json() as {
      error: { message?: string; type?: string; code?: string | null };
    };
    const logs = await fetch(new URL("/api/logs?tail=1", proxy.url)).then(res => res.json()) as Array<{
      status?: number;
      errorCode?: string;
      upstreamError?: string;
    }>;
    return {
      path,
      responseStatus: response.status,
      error: payload.error,
      log: logs[0] ?? {},
    };
  } finally {
    await proxy.stop(true);
    await upstream.stop(true);
  }
}

describe("upstream 401/403 classification (end-to-end)", () => {
  test("Ollama string error body becomes subscription_required through HTTP, adapter, classifier, and log", async () => {
    const result = await runUpstreamFailure(403, { error: SUBSCRIPTION_MESSAGE });

    expect(result.path).toBe("/v1/chat/completions");
    expect(result.responseStatus).toBe(403);
    expect(result.error).toMatchObject({
      type: "permission_error",
      code: "subscription_required",
    });
    expect(result.error.message).toContain(SUBSCRIPTION_MESSAGE);
    expect(result.log).toMatchObject({
      status: 403,
      errorCode: "subscription_required",
    });
    expect(result.log.upstreamError).toContain(SUBSCRIPTION_MESSAGE);
  });

  test("the same subscription body under authoritative 401 stays invalid_api_key", async () => {
    const result = await runUpstreamFailure(401, { error: SUBSCRIPTION_MESSAGE });

    expect(result.path).toBe("/v1/chat/completions");
    expect(result.responseStatus).toBe(401);
    expect(result.error).toMatchObject({
      type: "authentication_error",
      code: "invalid_api_key",
    });
    expect(result.log).toMatchObject({
      status: 401,
      errorCode: "invalid_api_key",
    });
  });

  test("bare Provider error 403 remains permission_denied", () => {
    expect(classifyError(403, "upstream_error", "Provider error 403")).toMatchObject({
      type: "permission_error",
      code: "permission_denied",
    });
  });
});
```

Why this is integration rather than a hand-injected classifier fixture: the first two
tests start a real local upstream and a real opencodex HTTP server, route a Responses
request through the `openai-chat` adapter (proved by the observed
`/v1/chat/completions` path), feed the actual Ollama body shape
`{"error":"..."}`, consume the classified client response, and inspect the resulting
`/api/logs` row. The separate bare-string case preserves issue #142's observed
transport text without pretending that the full upstream body is always available.

## 5. C-ACTIVATION-GROUNDING-01 matrix

Every new conditional branch must have an activating test and an observable proving
that it fired.

| Branch / decision | Activation | Observable proof |
|---|---|---|
| `status === 401` before subscription | E2E 401 with the same Ollama subscription body; error-fidelity 401 case | Response/log remain 401 + `authentication_error/invalid_api_key`, never 403. |
| `type === "authentication_error"` before subscription | `classifyError(403, "authentication_error", subscription)` | `invalid_api_key` despite HTTP 403 and subscription text. |
| strong access-denied credential cue | Existing Kiro `expired token` assertion and adapter `security token expired` case | Both produce authentication/401. |
| generic access denied is not auth | `classifyError(403, ..., "Access denied")` and adapter bare access-denied case | Permission payload and inferred HTTP 403. |
| subscription under HTTP 403 | Real Ollama-shaped 403 integration | Client and `/api/logs` both expose `subscription_required`. |
| subscription under explicit permission type | `classifyError(400, "permission_error", subscription)` | `subscription_required` proves the type half of the guard. |
| subscription outside permission context rejected | `classifyError(400, "upstream_error", subscription)` | Existing 400 fallback returns `invalid_request_error`. |
| generic HTTP 403 permission branch | Bare `Provider error 403` case | `permission_error/permission_denied`. |
| `inferHttpStatusFromAdapterMessage` auth-before-permission | Mixed `authentication failed` + subscription adapter test | Inferred status is 401. |
| adapter inferred permission/subscription | Forbidden, subscription, and generic access-denied adapter tests | Inferred status is 403 and adapter error type is `permission_error`. |
| `httpStatus === 403` adapter error-type arm | Adapter forbidden/subscription tests | Returned `error.type` is `permission_error`, not `upstream_error`. |
| terminal permission mapping | Three `httpStatusFromTerminalError` expectations | Permission/subscription return 403; mixed auth object returns 401. |
| `requestLogErrorCode` 403 body-aware branch | Request-log subscription assertion and E2E log | `subscription_required`. |
| `requestLogErrorCode` empty/bare fallback | `requestLogErrorCode(403)` and bare text assertion | `permission_denied`. |
| GUI exact 403 lookup entry | GUI TypeScript check plus exact four-locale source diff | The 403 entry type-checks and only its descriptions change. |

## 6. Exact two-commit implementation plan

Implementation starts only on `dev`. Keep unrelated dirty files untouched.

### Commit 1 — contributor behavior reconstruction

- Content: the contributor-owned 403 GUI copy, request-log 403 mapping, core
  permission/subscription behavior, and the three existing test-file additions.
- Landing method: apply the exact six-file source commit to the index/worktree with
  `git cherry-pick --no-commit`; commit it with the attribution/body below. This is a
  temporary contributor checkpoint. Commit 2 removes `errors.ts` formatting-only
  churn from the final range.
- Author: `Wibias <37517432+Wibias@users.noreply.github.com>`.
- Committer: `bitkyc08-arch <bitkyc08@gmail.com>`.
- Subject: `fix: absorb PR #145 403 permission labels`.
- Body:

```text
Apply the contributor-owned 403 permission/subscription labeling checkpoint
unchanged before the separately attributed maintainer repairs.

Source: community PR #145
Source-head: fa4ca861c09eb20f99e189aee65764c151b5de8b
```

Executable apply and commit commands:

```bash
git cherry-pick --no-commit fa4ca861c09eb20f99e189aee65764c151b5de8b
git commit \
  --author='Wibias <37517432+Wibias@users.noreply.github.com>' \
  -m 'fix: absorb PR #145 403 permission labels' \
  -m $'Apply the contributor-owned 403 permission/subscription labeling checkpoint unchanged before the separately attributed maintainer repairs.\n\nSource: community PR #145\nSource-head: fa4ca861c09eb20f99e189aee65764c151b5de8b'
```

Commit 1 is a contributor reconstruction checkpoint. Before committing, run the three
focused pre-repair suites listed in Section 7 and record that known Sol negatives are
still assigned to Commit 2; do not push or stop with only this commit on `dev`.

### Commit 2 — maintainer precedence/access-denied repair + real-path tests

- Content: final auth-before-subscription order, subscription context guard,
  credential-qualified access-denied exception, expanded negative tests, terminal
  mappings, and NEW `tests/server-403-permission-e2e.test.ts`.
- First edit: `git restore --source=dev~1 -- src/lib/errors.ts` restores the exact
  pre-absorb current-`dev` file (Commit 1 is now `dev`, so `dev~1` is its parent).
  Apply Section 4.1's final focused snippets to that restored file. Modify the other
  already-cherry-picked files in place per Sections 4.4-4.7; do not restore
  `src/server/request-log.ts` because its contributor hunk is retained.
- Author/committer: `bitkyc08-arch <bitkyc08@gmail.com>`.
- Co-author trailer: `Co-authored-by: Wibias <37517432+Wibias@users.noreply.github.com>`.
- Subject: `fix: preserve 401 precedence in PR #145 error labels`.
- Body:

```text
Repair auth/permission precedence, scope subscription labels to permission
contexts, and cover the real Ollama HTTP body plus bare-403 behavior.

Source: community PR #145
Source-head: fa4ca861c09eb20f99e189aee65764c151b5de8b

Co-authored-by: Wibias <37517432+Wibias@users.noreply.github.com>
```

Start Commit 2 by restoring the one churned file:

```bash
git restore --source=dev~1 -- src/lib/errors.ts
```

Then apply Sections 4.1 and 4.4-4.7, run Section 7's focused final tests, and
stage/commit exactly the maintainer repair paths:

```bash
git add \
  src/lib/errors.ts \
  tests/error-fidelity.test.ts \
  tests/errors-adapter-failure.test.ts \
  tests/request-log.test.ts \
  tests/server-403-permission-e2e.test.ts
git commit \
  -m 'fix: preserve 401 precedence in PR #145 error labels' \
  -m $'Repair auth/permission precedence, scope subscription labels to permission contexts, and cover the real Ollama HTTP body plus bare-403 behavior.\n\nSource: community PR #145\nSource-head: fa4ca861c09eb20f99e189aee65764c151b5de8b\n\nCo-authored-by: Wibias <37517432+Wibias@users.noreply.github.com>'
```

Do not combine the two commits: Commit 1 preserves contributor authorship; Commit 2
records maintainer design responsibility and co-authorship. Do not create a third
formatting or cleanup commit.

## 7. Verification commands and acceptance

Run from repository root unless the command includes `cd gui`. The implementation is
accepted only when every command exits 0.

Focused tests after Commit 1 reconstruction:

```bash
bun test --isolate \
  ./tests/error-fidelity.test.ts \
  ./tests/errors-adapter-failure.test.ts \
  ./tests/request-log.test.ts
```

Focused final tests after Commit 2:

```bash
bun test --isolate \
  ./tests/error-fidelity.test.ts \
  ./tests/errors-adapter-failure.test.ts \
  ./tests/request-log.test.ts \
  ./tests/server-403-permission-e2e.test.ts
```

Root and GUI type checks:

```bash
bun x tsc --noEmit
cd gui && bun x tsc -p tsconfig.app.json --noEmit
```

Affected/full regression gate:

```bash
bun test --isolate ./tests/
```

Diff and attribution gates:

```bash
git diff --check dev~2..dev
git show --format=fuller --stat dev~1
git show --format=fuller --stat dev
git diff --name-status dev~2..dev
git status --short
```

Expected final implementation path set (excluding this roadmap document and unrelated
pre-existing worktree changes):

```text
M  gui/src/status-codes.ts
M  src/lib/errors.ts
M  src/server/request-log.ts
M  tests/error-fidelity.test.ts
M  tests/errors-adapter-failure.test.ts
M  tests/request-log.test.ts
A  tests/server-403-permission-e2e.test.ts
```

Acceptance observations:

- E2E output records upstream path `/v1/chat/completions`.
- Ollama 403 body yields response and log code `subscription_required`.
- The same body under 401 yields response/log `invalid_api_key` and status 401.
- Bare `Provider error 403` and generic `Access denied` yield `permission_denied`.
- Existing Kiro `AccessDeniedException: expired token` remains authentication.
- No standalone `gui/src/i18n/*` file changes.
- No conflict markers, formatting-only `errors.ts` rewrite, or unrelated staged paths.

## 8. Rollback

Rollback is commit-based and non-destructive. If these commits have been shared,
revert in reverse order:

```bash
git revert --no-edit <commit-2-maintainer-repair-sha>
git revert --no-edit <commit-1-pr145-absorb-sha>
```

Then rerun:

```bash
bun test --isolate \
  ./tests/error-fidelity.test.ts \
  ./tests/errors-adapter-failure.test.ts \
  ./tests/request-log.test.ts
bun x tsc --noEmit
```

Commit 2's revert removes the new E2E file and maintainer negatives; Commit 1's revert
restores current-`dev` 401/403 behavior and GUI copy. Do not revert only Commit 2 and
leave Commit 1 deployed: that recreates the three known Sol defects. Do not use
`git reset --hard`, rewrite `codex/source-pr145-fa4ca861`, or touch unrelated dirty
worktree files.

## 9. Sol finding closure map

| Sol finding | Closed by |
|---|---|
| P2-1: subscription check precedes authoritative 401, causing permission/subscription payload and logged 403 | Sections 3.1-3.2 behavior contract; 4.1B auth-before-subscription order; 4.1D terminal precedence; 4.4 negative 401/type tests; 4.6 request-log terminal tests; 4.7 real HTTP 401 negative; activation rows 1-2 and terminal row. |
| P2-2: generic `Access denied` enters authentication before the 403 branch | Sections 3.3; 4.1A credential-cue conjunction; 4.1B/4.1C permission ordering; 4.4 generic-vs-Kiro assertions; 4.5 adapter inference matrix; activation rows for strong and generic access denied. |
| P2-3: tests manually inject desired text instead of exercising issue #142's transport/body shape | Section 4.7 NEW real-HTTP integration test and its path assertion/log inspection; Section 5 integration and bare-string activation rows; Section 7 E2E acceptance observations. |

All three findings must be closed in Commit 2 before this phase can be considered
complete.

## Audit fold-back round 2 (2026-07-18, pre-build gate)

- Blocker (Medium): the proposed `isAuthenticationMessage` narrowing dropped the
  standalone `text.includes("authentication")` cue, regressing adapter messages
  like `"Authentication required"` from 401/authentication_error to inferred
  502/upstream_error (reached via bridge.ts:635 streaming failures).
  FIX (binding for B): Commit 2 preserves a standalone authentication cue —
  keep `text.includes("authentication")` in `isAuthenticationMessage` (scoped so
  bare "access denied" at 403 still classifies as permission) — and the adapter
  matrix adds a regression: `adapterFailureFromMessage("Authentication required")`
  → 401/authentication_error/invalid_api_key. Rebuttal: none.
- Cherry-pick safety confirmed in throwaway worktree (fa4ca861 onto b6281b7a,
  clean apply, 6 files). Baseline focused suites 30/30 pass.
