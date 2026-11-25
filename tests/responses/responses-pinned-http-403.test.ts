import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCodexAccountRecord, saveCodexAccountCredential } from "../../src/codex/account-store";
import { clearAccountNeedsReauth, clearAccountQuota, isAccountNeedsReauth } from "../../src/codex/auth-api";
import { clearCodexUpstreamHealth, clearThreadAccountMap } from "../../src/codex/routing";
import { handleResponses } from "../../src/server/responses";
import type { RequestLogContext } from "../../src/server/request-log";
import type { OcxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { installHarness, restorePool401Fetch } from "../helpers/pool-401-fetch";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const ACCOUNT_ID = "work";
const OTHER_ACCOUNT_ID = "other";
const config = {
  defaultProvider: "openai",
  activeCodexAccountId: OTHER_ACCOUNT_ID,
  autoSwitchThreshold: 0,
  providers: {
    openai: {
      adapter: "openai-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      authMode: "forward",
      codexAccountMode: "pool",
      upstreamWebsocket: false,
    },
  },
  codexAccounts: [
    { id: ACCOUNT_ID, chatgptAccountId: "acc-work", isMain: false },
    { id: OTHER_ACCOUNT_ID, chatgptAccountId: "acc-other", isMain: false },
  ],
  codexAccountNamespaces: { work: ACCOUNT_ID },
} as OcxConfig;

function credential(accessToken: string, refreshToken: string, chatgptAccountId: string) {
  return { accessToken, refreshToken, chatgptAccountId, expiresAt: Date.now() + 3_600_000 };
}

let home: string;
let priorOcxHome: string | undefined;
let priorCodexHome: string | undefined;
let releaseSpendHome: (() => void) | undefined;
let initialGeneration: number;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-pinned-http-refusal-"));
  priorOcxHome = process.env.OPENCODEX_HOME;
  priorCodexHome = process.env.CODEX_HOME;
  process.env.OPENCODEX_HOME = home;
  process.env.CODEX_HOME = home;
  releaseSpendHome = acquireOwnedSpendHome();
  initialGeneration = saveCodexAccountCredential(ACCOUNT_ID, credential("rejected-access", "refresh-grant", "acc-work"));
  saveCodexAccountCredential(OTHER_ACCOUNT_ID, credential("other-access", "other-grant", "acc-other"));
});

afterEach(() => {
  restorePool401Fetch();
  releaseSpendHome?.();
  releaseSpendHome = undefined;
  clearAccountNeedsReauth(ACCOUNT_ID);
  clearAccountNeedsReauth(OTHER_ACCOUNT_ID);
  clearAccountQuota();
  clearCodexUpstreamHealth();
  clearThreadAccountMap();
  if (priorOcxHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = priorOcxHome;
  if (priorCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = priorCodexHome;
  removeTreeWithRetry(home);
});

describe("pre-stream HTTP 403 on an exact Codex account selector", () => {
  function sendPinned(): Promise<Response> {
    return handleResponses(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "work/gpt-5.5", input: "hello", stream: true }),
      }),
      config,
      { model: "", provider: "" } as RequestLogContext,
    );
  }

  test.each([
    ["empty", null],
    ["HTML", "<html>Forbidden</html>"],
    ["unknown code", '{"error":{"code":"permission_denied","message":"fixture refusal"}}'],
    ["duplicate auth code", '{"error":{"code":"token_invalidated","code":"token_invalidated"}}'],
    ["conflicting codes", '{"code":"token_invalidated","error":{"code":"workspace_access_denied"}}'],
    ["workspace denial", '{"detail":{"code":"workspace_access_denied"}}'],
    ["entitlement denial", '{"error":{"code":"entitlement_missing"}}'],
  ] as const)("%s stays a per-request refusal and the pin serves the next turn", async (_case, body) => {
    const harness = installHarness({
      responseForSend: (_bearer, sendNumber) => sendNumber === 1
        ? new Response(body, {
          status: 403,
          headers: { "content-type": body?.startsWith("<") ? "text/html" : "application/json" },
        })
        : Response.json({ id: "resp_after_refusal", object: "response", status: "completed", output: [] }),
    });

    const refused = await sendPinned();
    expect(refused.status).toBe(403);
    const refusalBody = await refused.text();
    if (body?.includes("fixture refusal")) expect(refusalBody).toContain("fixture refusal");
    expect(harness.sends).toEqual(["Bearer rejected-access"]);
    expect(harness.refreshes).toEqual([]);

    const next = await sendPinned();
    expect(next.status).toBe(200);
    expect(harness.sends).toEqual(["Bearer rejected-access", "Bearer rejected-access"]);
    expect(isAccountNeedsReauth(ACCOUNT_ID)).toBe(false);
    expect(isAccountNeedsReauth(OTHER_ACCOUNT_ID)).toBe(false);
    await next.text();
  });

  test.each([false, true])("explicit token_invalidated respects the sent generation (replaced=%s)", async replaced => {
    const harness = installHarness({
      responseForSend() {
        if (replaced) {
          saveCodexAccountCredential(ACCOUNT_ID, credential("refreshed-access", "rotated-refresh", "acc-work"));
        }
        return Response.json({ error: { code: "token_invalidated" } }, { status: 403 });
      },
    });

    const refused = await sendPinned();
    expect(refused.status).toBe(403);
    expect(harness.sends).toEqual(["Bearer rejected-access"]);
    expect(harness.refreshes).toEqual([]);
    expect(readCodexAccountRecord(ACCOUNT_ID)?.generation).toBe(initialGeneration + Number(replaced));
    expect(isAccountNeedsReauth(ACCOUNT_ID)).toBe(!replaced);
    expect(isAccountNeedsReauth(OTHER_ACCOUNT_ID)).toBe(false);
    await refused.text();
  });
});
