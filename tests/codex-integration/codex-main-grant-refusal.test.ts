import { sharedStateSelectionOptions } from "../../src/codex/routing/selection";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearAccountQuota, clearMainAccountInfoCache, listCodexAuthAccounts,
} from "../../src/codex/auth-api";
import {
  clearAccountNeedsReauth, isAccountNeedsReauth, markAccountNeedsReauth,
} from "../../src/codex/account-runtime-state";
import { codexAccountUnusableReason } from "../../src/codex/account-usability";
import { resetMainCodexAccountIdentityTrackingForTests } from "../../src/codex/account-lifecycle";
import { codexCredentialMutationEpoch } from "../../src/codex/credential-mutation-epoch";
import * as mainAccount from "../../src/codex/main-account";
import {
  forceRefreshMainAccountToken, getValidMainAccountToken, hasMainAccountRefreshGrant,
  isMainAccountCredentialUsable, isMainAccountRefreshGrantRejected, MAIN_CODEX_ACCOUNT_ID,
} from "../../src/codex/main-account";
import { headersForCodexAuthContext, resolveCodexAuthContext } from "../../src/codex/auth-context";
import { codexAccountSelectionForTurn, tryAdmitTurn } from "../../src/server/lifecycle";
import { CODEX_MAIN_SIGN_IN_REQUIRED_MESSAGE, mapCodexAuthContextErrorToResponse } from "../../src/server/responses/codex-auth-error";
import { fakeChatGptJwt } from "../helpers/agent-task-recovery";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const originalFetch = globalThis.fetch;
let root: string;
let home: string;
let previousCodexHome: string | undefined;
let previousOcxHome: string | undefined;
let warnings: string[];
let warnSpy: ReturnType<typeof spyOn>;
const cfg = { providers: {}, codexAccounts: [], activeCodexAccountId: MAIN_CODEX_ACCOUNT_ID } as unknown as OcxConfig;

function writeCredential(grant = "fixture-grant-a", target = home): string {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 86_400 })).toString("base64url");
  const access = `header.${payload}.signature`;
  writeFileSync(join(target, "auth.json"), JSON.stringify({
    tokens: { access_token: access, refresh_token: grant, account_id: "fixture-main" },
  }));
  return access;
}

function mockEndpoint(reply: () => Response | Promise<Response>): string[] {
  const grants: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.href !== "https://auth.openai.com/oauth/token") throw new Error("unexpected mocked endpoint");
    grants.push(new URLSearchParams(String(init?.body)).get("refresh_token") ?? "");
    return reply();
  }) as typeof fetch;
  return grants;
}

function terminalResponse(): Response {
  return Response.json({ error: "invalid_grant", error_description: "private-description-marker" }, { status: 400 });
}

function expectRefused(): void {
  expect(isMainAccountRefreshGrantRejected()).toBe(true);
  expect(hasMainAccountRefreshGrant()).toBe(false);
  expect(isMainAccountCredentialUsable()).toBe(false);
  expect(isAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID)).toBe(false);
  expect(codexAccountUnusableReason(cfg, MAIN_CODEX_ACCOUNT_ID)).toBe("needs_reauth");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ocx-main-grant-refusal-"));
  home = join(root, "codex-a");
  mkdirSync(home);
  mkdirSync(join(root, "ocx"));
  previousCodexHome = process.env.CODEX_HOME;
  previousOcxHome = process.env.OPENCODEX_HOME;
  process.env.CODEX_HOME = home;
  process.env.OPENCODEX_HOME = join(root, "ocx");
  clearAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID);
  clearMainAccountInfoCache();
  clearAccountQuota();
  resetMainCodexAccountIdentityTrackingForTests();
  warnings = [];
  warnSpy = spyOn(console, "warn").mockImplementation((...args: unknown[]) => warnings.push(args.map(String).join(" ")));
  globalThis.fetch = (async () => { throw new Error("unexpected mocked endpoint"); }) as typeof fetch;
});

afterEach(() => {
  warnSpy.mockRestore();
  globalThis.fetch = originalFetch;
  clearAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID);
  clearMainAccountInfoCache();
  clearAccountQuota();
  resetMainCodexAccountIdentityTrackingForTests();
  mainAccount.setMainAccountPlan(null);
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  if (previousOcxHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOcxHome;
  removeTreeWithRetry(root);
});

describe("native main refresh refusal is scoped to the physical path and grant", () => {
  test("a refused fresh JWT and automatic forced retry make no further endpoint call", async () => {
    const access = writeCredential();
    const before = readFileSync(join(home, "auth.json"), "utf8");
    const grants = mockEndpoint(terminalResponse);
    await expect(forceRefreshMainAccountToken(access)).rejects.toMatchObject({ reason: "reauth" });
    expectRefused();
    clearAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID);
    await expect(getValidMainAccountToken()).rejects.toMatchObject({ reason: "reauth" });
    await expect(forceRefreshMainAccountToken(access)).rejects.toMatchObject({ reason: "reauth" });
    expect(grants).toEqual(["fixture-grant-a"]);
    expect(readFileSync(join(home, "auth.json"), "utf8")).toBe(before);
    expectRefused();
  });

  test("successful explicit WHAM clears the generic mark without reviving the refused grant or DTO", async () => {
    const access = writeCredential();
    const grants = mockEndpoint(terminalResponse);
    await expect(forceRefreshMainAccountToken(access)).rejects.toMatchObject({ reason: "reauth" });
    markAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID);
    let whamCalls = 0;
    const refreshFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname.endsWith("/wham/usage")) {
        whamCalls += 1;
        return Response.json({ plan_type: "plus", rate_limit: { primary_window: { used_percent: 10 } } });
      }
      return refreshFetch(input, init);
    }) as typeof fetch;
    const accounts = await listCodexAuthAccounts(cfg, true);
    expect(whamCalls).toBe(1);
    expect(accounts.find(account => account.id === MAIN_CODEX_ACCOUNT_ID))
      .toMatchObject({ hasCredential: true, needsReauth: true });
    expectRefused();
    await expect(getValidMainAccountToken()).rejects.toMatchObject({ reason: "reauth" });
    await expect(forceRefreshMainAccountToken(access)).rejects.toMatchObject({ reason: "reauth" });
    expect(grants).toEqual(["fixture-grant-a"]);
  });

  test("a replacement written during a deferred refusal is not quarantined", async () => {
    const access = writeCredential();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<Response>();
    const grants = mockEndpoint(() => { entered.resolve(); return release.promise; });
    const epoch = codexCredentialMutationEpoch();
    const pending = forceRefreshMainAccountToken(access);
    const outcome = pending.then(value => ({ value }), error => ({ error }));
    try {
      await entered.promise;
      const replacement = writeCredential("fixture-grant-b");
      const replacedBytes = readFileSync(join(home, "auth.json"), "utf8");
      release.resolve(terminalResponse());
      expect(await outcome).toMatchObject({ error: { name: "MainAuthJsonChangedDuringRefreshError" } });
      expect(isMainAccountRefreshGrantRejected()).toBe(false);
      expect(isAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID)).toBe(false);
      expect(isMainAccountCredentialUsable()).toBe(true);
      expect(codexAccountUnusableReason(cfg, MAIN_CODEX_ACCOUNT_ID)).toBeUndefined();
      await expect(getValidMainAccountToken()).resolves.toMatchObject({ accessToken: replacement });
      expect(readFileSync(join(home, "auth.json"), "utf8")).toBe(replacedBytes);
      expect(codexCredentialMutationEpoch()).toBe(epoch);
      expect(grants).toEqual(["fixture-grant-a"]);
      // Returning to the old grant also proves the stale refusal never published a record.
      writeCredential("fixture-grant-a");
      expect(isMainAccountRefreshGrantRejected()).toBe(false);
    } finally {
      release.resolve(terminalResponse());
      await pending.catch(() => {});
    }
  });

  test("a new grant after refusal is eligible and its successful refresh leaves the old refusal intact", async () => {
    const access = writeCredential();
    const grants = mockEndpoint(terminalResponse);
    await expect(forceRefreshMainAccountToken(access)).rejects.toMatchObject({ reason: "reauth" });
    const replacement = writeCredential("fixture-grant-b");
    expect(isMainAccountRefreshGrantRejected()).toBe(false);
    expect(hasMainAccountRefreshGrant()).toBe(true);
    expect(isMainAccountCredentialUsable()).toBe(true);
    await expect(getValidMainAccountToken()).resolves.toMatchObject({ accessToken: replacement });
    expect(grants).toEqual(["fixture-grant-a"]);
    const replacementGrants = mockEndpoint(() => Response.json({
      access_token: "replacement-access", refresh_token: "fixture-grant-b", expires_in: 3600,
    }));
    await expect(forceRefreshMainAccountToken(replacement)).resolves.toMatchObject({ accessToken: "replacement-access" });
    expect(replacementGrants).toEqual(["fixture-grant-b"]);
    writeCredential("fixture-grant-a");
    expectRefused();
    await expect(getValidMainAccountToken()).rejects.toMatchObject({ reason: "reauth" });
    expect(replacementGrants).toEqual(["fixture-grant-b"]);
  });

  test("profile A to B to A remembers A while the same grant bytes at B remain eligible", async () => {
    const access = writeCredential();
    const grants = mockEndpoint(terminalResponse);
    await expect(forceRefreshMainAccountToken(access)).rejects.toMatchObject({ reason: "reauth" });
    const homeB = join(root, "codex-b");
    mkdirSync(homeB);
    const accessB = writeCredential("fixture-grant-a", homeB);
    process.env.CODEX_HOME = homeB;
    expect(isMainAccountRefreshGrantRejected()).toBe(false);
    expect(isMainAccountCredentialUsable()).toBe(true);
    expect(hasMainAccountRefreshGrant()).toBe(true);
    await expect(getValidMainAccountToken()).resolves.toMatchObject({ accessToken: accessB });
    process.env.CODEX_HOME = home;
    expectRefused();
    await expect(getValidMainAccountToken()).rejects.toMatchObject({ reason: "reauth" });
    expect(grants).toEqual(["fixture-grant-a"]);
  });

  test("a caller abort before a deferred terminal response publishes no refusal or credential mutation", async () => {
    const access = writeCredential();
    const before = readFileSync(join(home, "auth.json"), "utf8");
    const epoch = codexCredentialMutationEpoch();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<Response>();
    const grants = mockEndpoint(() => { entered.resolve(); return release.promise; });
    const controller = new AbortController();
    const reason = new Error("fixture caller cancelled");
    const pending = forceRefreshMainAccountToken(access, { signal: controller.signal });
    const outcome = pending.then(value => ({ value }), error => ({ error }));
    try {
      await entered.promise;
      controller.abort(reason);
      release.resolve(terminalResponse());
      expect(await outcome).toEqual({ error: reason });
      expect(isMainAccountRefreshGrantRejected()).toBe(false);
      expect(isAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID)).toBe(false);
      expect(isMainAccountCredentialUsable()).toBe(true);
      expect(readFileSync(join(home, "auth.json"), "utf8")).toBe(before);
      expect(codexCredentialMutationEpoch()).toBe(epoch);
      await expect(getValidMainAccountToken()).resolves.toMatchObject({ accessToken: access });
      expect(grants).toEqual(["fixture-grant-a"]);
    } finally {
      release.resolve(terminalResponse());
      await pending.catch(() => {});
    }
  });

  test.each([
    { nativeMainSelectionOnly: true },
    { requestOwnedMainCredential: true, isMainAccountTokenLive: () => true },
    sharedStateSelectionOptions({ requestOwnedMainCredential: true, isMainAccountTokenLive: () => true,
      modelEligibleAccountIds: new Set(["some-pool-account"]) })!,
  ].flatMap(options => [false, true].map(ordinaryReauth => ({ options, ordinaryReauth }))))(
    "selection fences do not inspect stored refusal: %j", async ({ options, ordinaryReauth }) => {
    const access = writeCredential();
    mockEndpoint(terminalResponse);
    await expect(forceRefreshMainAccountToken(access)).rejects.toMatchObject({ reason: "reauth" });
    if (ordinaryReauth) markAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID);
    const refusalRead = spyOn(mainAccount, "isMainAccountRefreshGrantRejected");
    const grantRead = spyOn(mainAccount, "hasMainAccountRefreshGrant");
    const credentialRead = spyOn(mainAccount, "isMainAccountCredentialUsable");
    const snapshotRead = spyOn(mainAccount, "getMainAccountCredentialStatus");
    try {
      expect(codexAccountUnusableReason(cfg, MAIN_CODEX_ACCOUNT_ID, options)).toBeUndefined();
      expect(refusalRead).not.toHaveBeenCalled();
      expect(grantRead).not.toHaveBeenCalled();
      expect(credentialRead).not.toHaveBeenCalled();
      expect(snapshotRead).not.toHaveBeenCalled();
    } finally {
      refusalRead.mockRestore();
      grantRead.mockRestore();
      credentialRead.mockRestore();
      snapshotRead.mockRestore();
    }
  });
});

describe("default native token endpoint classification and safe diagnostics", () => {
  test.each([
    [400, { error: "invalid_grant" }, "invalid_grant"],
    [401, { error: { code: "token_invalidated", message: "private-message-marker" } }, "token_invalidated"],
    [400, { error: "refresh_token_expired", error_description: { marker: "private-description-marker" } }, "refresh_token_expired"],
    [401, { error: "refresh_token_reused", error_description: 42 }, "refresh_token_reused"],
  ] as const)("terminal %i exposes only its recognized code %j", async (status, body, code) => {
    const access = writeCredential();
    mockEndpoint(() => Response.json(body, { status }));
    await expect(forceRefreshMainAccountToken(access)).rejects.toMatchObject({ reason: "reauth" });
    expectRefused();
    expect(warnings).toContain(`[codex] native main refresh: reauth status=${status} code=${code}`);
    expect(warnings.join("\n")).not.toMatch(/private-(?:message|description)-marker|fixture-grant-a|header\./);
  });

  test.each([
    [429, JSON.stringify({ error: "invalid_grant" })],
    [503, JSON.stringify({ error: "refresh_token_expired", error_description: "private-description-marker" })],
    [400, JSON.stringify({ error_description: 42 })],
    [400, JSON.stringify({ error: "private code marker", error_description: "private-description-marker" })],
    [400, JSON.stringify({ error: "private_token_shaped_marker", error_description: 42 })],
    [400, JSON.stringify({ error_description: { marker: "private-description-marker" } })],
    [400, "malformed-private-body-marker"],
  ] as const)("%i with untrusted body %s remains transient", async (status, body) => {
    const access = writeCredential();
    const grants = mockEndpoint(() => new Response(body, { status }));
    await expect(forceRefreshMainAccountToken(access)).rejects.toMatchObject({ reason: "transient" });
    expect(isMainAccountRefreshGrantRejected()).toBe(false);
    expect(isAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID)).toBe(false);
    expect(hasMainAccountRefreshGrant()).toBe(true);
    expect(isMainAccountCredentialUsable()).toBe(true);
    expect(codexAccountUnusableReason(cfg, MAIN_CODEX_ACCOUNT_ID)).toBeUndefined();
    expect(grants).toEqual(["fixture-grant-a"]);
    expect(warnings.some(line => line.startsWith(`[codex] native main refresh: transient status=${status}`))).toBe(true);
    expect(warnings.join("\n")).not.toMatch(/private|malformed|fixture-grant-a|header\./);
  });

  test.each(["revoked", "expired"])("valid description-only OAuth 400 retains %s compatibility without logging prose", async reason => {
    const access = writeCredential();
    const grants = mockEndpoint(() => Response.json({
      error_description: `refresh token ${reason} private-description-marker`,
    }, { status: 400 }));
    await expect(forceRefreshMainAccountToken(access)).rejects.toMatchObject({ reason: "reauth" });
    expectRefused();
    expect(grants).toEqual(["fixture-grant-a"]);
    expect(warnings).toContain("[codex] native main refresh: reauth status=400 code=none");
    expect(warnings.join("\n")).not.toMatch(/private-description-marker|refresh token|fixture-grant-a|header\./);
  });

  test("a transport error containing terminal prose remains transient without logging its message", async () => {
    const access = writeCredential();
    const grants = mockEndpoint(() => { throw new Error("invalid_grant expired private-transport-marker"); });
    await expect(forceRefreshMainAccountToken(access)).rejects.toMatchObject({ reason: "transient" });
    expect(isMainAccountRefreshGrantRejected()).toBe(false);
    expect(isAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID)).toBe(false);
    expect(isMainAccountCredentialUsable()).toBe(true);
    expect(grants).toEqual(["fixture-grant-a"]);
    expect(warnings.join("\n")).not.toContain("private-transport-marker");
  });
});


describe("explicit account selection after a native endpoint refusal", () => {
  test.each(["main", "missing pool", "paused main"] as const)("fixed %s maps only its own refusal", async selected => {
    const access = writeCredential();
    const grants = mockEndpoint(terminalResponse);
    await expect(forceRefreshMainAccountToken(access)).rejects.toMatchObject({ reason: "reauth" });
    expectRefused();
    const accountId = selected === "missing pool" ? "fixture-missing-pool" : MAIN_CODEX_ACCOUNT_ID;
    const config = {
      ...cfg,
      codexAccounts: selected === "missing pool" ? [{ id: accountId, label: "fixture missing" }] : [],
      ...(selected === "paused main" ? { pausedCodexAccountIds: [MAIN_CODEX_ACCOUNT_ID] } : {}),
    } as OcxConfig;
    const turn = tryAdmitTurn();
    expect(turn).not.toBeNull();
    try {
      const outcome = await resolveCodexAuthContext(new Headers(), config, "pool", {
        accountId, modelId: "gpt-5.5", beginCodexAccountSelection: codexAccountSelectionForTurn(turn!),
      }).then(value => ({ value }), error => ({ error }));
      expect(outcome).toHaveProperty("error");
      if (!("error" in outcome)) throw new Error("fixed unavailable account unexpectedly resolved");
      const response = mapCodexAuthContextErrorToResponse(outcome.error, { accountSelector: selected, now: Date.now() });
      expect(response).toBeDefined();
      expect(response!.status).toBe(401);
      const body = await response!.json() as { error: { message: string } };
      if (selected === "main") expect(body.error.message).toBe(CODEX_MAIN_SIGN_IN_REQUIRED_MESSAGE);
      else expect(body.error.message).not.toBe(CODEX_MAIN_SIGN_IN_REQUIRED_MESSAGE);
      expect(grants).toEqual(["fixture-grant-a"]);
      expect(isAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID)).toBe(false);
    } finally {
      turn?.release();
    }
  });

  test("caller-owned explicit main retains its own credential despite stored refusal", async () => {
    const access = writeCredential();
    const grants = mockEndpoint(terminalResponse);
    await expect(forceRefreshMainAccountToken(access)).rejects.toMatchObject({ reason: "reauth" });
    const caller = fakeChatGptJwt("fixture-caller-account");
    const incoming = new Headers({ authorization: `Bearer ${caller}`, "chatgpt-account-id": "fixture-caller-account" });
    const context = await resolveCodexAuthContext(incoming, cfg, "pool", {
      accountId: MAIN_CODEX_ACCOUNT_ID, modelId: "gpt-5.5", requestScopedMainCredential: true,
    });
    expect(context).toMatchObject({ kind: "main", accountId: null });
    const forwarded = headersForCodexAuthContext(incoming, context);
    expect(forwarded.get("authorization")).toBe(`Bearer ${caller}`);
    expect(forwarded.get("chatgpt-account-id")).toBe("fixture-caller-account");
    expect(grants).toEqual(["fixture-grant-a"]);
    expectRefused();
  });
});

describe("native refresh success diagnostics require a valid credential", () => {
  const canary = "private-success-body-canary";
  test.each([
    ["malformed JSON", `{${canary}`],
    ["missing access token", JSON.stringify({ marker: canary })],
    ["numeric access token", JSON.stringify({ access_token: 42, marker: canary })],
    ["object access token", JSON.stringify({ access_token: { marker: canary } })],
    ["empty access token", JSON.stringify({ access_token: "", marker: canary })],
    ["null body", "null"],
  ] as const)("HTTP 200 with %s is transient without a success verdict or mutation", async (_label, body) => {
    const access = writeCredential();
    const before = readFileSync(join(home, "auth.json"), "utf8");
    const epoch = codexCredentialMutationEpoch();
    const grants = mockEndpoint(() => new Response(body, { status: 200, headers: { "content-type": "application/json" } }));
    await expect(forceRefreshMainAccountToken(access)).rejects.toMatchObject({ reason: "transient" });
    expect(grants).toEqual(["fixture-grant-a"]);
    expect({
      bytes: readFileSync(join(home, "auth.json"), "utf8"), epoch: codexCredentialMutationEpoch(),
      refused: isMainAccountRefreshGrantRejected(), genericReauth: isAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID),
      okLogs: warnings.filter(line => line.startsWith("[codex] native main refresh: ok")),
      leakedBody: warnings.some(line => line.includes(canary)),
    }).toEqual({ bytes: before, epoch, refused: false, genericReauth: false, okLogs: [], leakedBody: false });
  });

  test("a validated HTTP 200 credential publishes once and records one safe success verdict", async () => {
    const access = writeCredential();
    const epoch = codexCredentialMutationEpoch();
    const grants = mockEndpoint(() => Response.json({
      access_token: "fixture-validated-access", refresh_token: "fixture-validated-refresh", expires_in: 3600,
      ignored_extra: canary,
    }));
    await expect(forceRefreshMainAccountToken(access)).resolves.toMatchObject({ accessToken: "fixture-validated-access" });
    expect(grants).toEqual(["fixture-grant-a"]);
    expect(codexCredentialMutationEpoch()).toBe(epoch + 1);
    expect(JSON.parse(readFileSync(join(home, "auth.json"), "utf8")).tokens)
      .toMatchObject({ access_token: "fixture-validated-access", refresh_token: "fixture-validated-refresh" });
    expect(isMainAccountRefreshGrantRejected()).toBe(false);
    expect(warnings.filter(line => line.startsWith("[codex] native main refresh: ok")))
      .toEqual(["[codex] native main refresh: ok status=200 code=none"]);
    expect(warnings.join("\n")).not.toMatch(/private-success-body-canary|fixture-validated-access|fixture-validated-refresh/);
  });
});

test("main usability consumes one coherent physical snapshot under an ordinary reauth mark", () => {
  const access = writeCredential();
  markAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID);
  const originalRead = fs.readFileSync as (...args: unknown[]) => unknown;
  let authReads = 0;
  const readSpy = spyOn(fs, "readFileSync").mockImplementation(((...args: unknown[]) => {
    if (typeof args[0] === "string" && args[0].endsWith("auth.json")) authReads += 1;
    return originalRead(...args);
  }) as typeof fs.readFileSync);
  try {
    expect(isMainAccountCredentialUsable()).toBe(true);
    expect(authReads).toBe(1);
    authReads = 0;
    const reason = codexAccountUnusableReason(cfg, MAIN_CODEX_ACCOUNT_ID);
    expect(reason).toBeUndefined();
    expect(warnings.join("\n")).not.toContain(access);
    expect(warnings.join("\n")).not.toContain("fixture-grant-a");
    expect(authReads).toBe(1);
  } finally {
    readSpy.mockRestore();
  }
});
