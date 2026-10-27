import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configSchema } from "../../src/config/schema/config-schema";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import { clearCodexQuotaPrimeState, primeCodexPoolQuotas } from "../../src/codex/auth-api/pool-mode-gate";
import { clearAccountQuota, getAccountQuota, setAccountQuotaFromParsed } from "../../src/codex/quota";
import { resetQuotaQueryBackoffForTests } from "../../src/codex/quota-query-backoff";
import { clearCodexUpstreamHealth, clearThreadAccountMap } from "../../src/codex/routing";
import { clearPoolRotationState } from "../../src/codex/pool-rotation";
import { handleResponses } from "../../src/server/responses";
import { codexWsPool } from "../../src/server/responses/codex-ws-pool";
import { settleBackgroundWork } from "../../src/lib/background-work";
import type { OcxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { completedPayload, drainCompactionResponseState, installCompactionRoutingAclFixture, sseResponse } from "../helpers/compaction-routing-fixtures";
import { removeTreeWithRetry } from "../helpers/remove-tree";

// Real ingress, namespace resolution, auth admission, WHAM parser and terminal-response
// delivery. All upstream I/O uses synthetic credentials and an allowlisted fake transport.
installCompactionRoutingAclFixture();
let previousHome: string | undefined;
let home: string;
let codexHome: IsolatedCodexHome;
let releaseSpendHome: () => void;
let clock: ReturnType<typeof spyOn>;
let now: number;
let config: OcxConfig;
let realFetch: typeof fetch;
let realWebSocket: typeof WebSocket;
let metadataAccounts: string[];
let responseAccounts: string[];
let unexpected: string[];

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-direct-credit-ingress-"));
  process.env.OPENCODEX_HOME = home;
  codexHome = installIsolatedCodexHome("ocx-credit-ingress-native-");
  releaseSpendHome = acquireOwnedSpendHome();
  clearAccountQuota(); clearCodexQuotaPrimeState(); resetQuotaQueryBackoffForTests();
  clearThreadAccountMap(); clearCodexUpstreamHealth(); clearPoolRotationState();
  now = Date.now();
  clock = spyOn(Date, "now").mockImplementation(() => now);
  config = {
    port: 10100, defaultProvider: "openai", providers: { openai: {
      adapter: "openai-responses", authMode: "forward", codexAccountMode: "direct",
      baseUrl: "https://chatgpt.com/backend-api/codex",
    } },
    codexAccounts: [
      { id: "stored-a", email: "a@example.test", isMain: false, plan: "plus" },
      { id: "stored-b", email: "b@example.test", isMain: false, plan: "plus" },
    ],
    codexAccountNamespaces: { subAlias: "stored-a", mainAlias: "@main" },
    creditCodexAccountIds: ["stored-a", "stored-b"],
  } as OcxConfig;
  expect(configSchema.safeParse(config).success).toBe(true);
  for (const id of ["stored-a", "stored-b"]) {
    saveCodexAccountCredential(id, {
      accessToken: `fixture-access-${id}`, refreshToken: `fixture-refresh-${id}`,
      expiresAt: now + 3_600_000, chatgptAccountId: `fixture-account-${id}`,
    });
    setAccountQuotaFromParsed(id, { weeklyPercent: 100, weeklyResetAt: now + 604_800_000,
      credits: { hasCredits: true, balance: 5, allowed: true, observedAt: now } });
  }
  metadataAccounts = []; responseAccounts = []; unexpected = [];
  realFetch = globalThis.fetch; realWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = class {
    constructor() { unexpected.push("WebSocket"); throw new Error("buffered fixture must use HTTP"); }
  } as unknown as typeof WebSocket;
  globalThis.fetch = (async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const headers = new Headers(init?.headers);
    const account = headers.get("chatgpt-account-id") ?? "";
    expect(account).toBe("fixture-account-stored-a");
    expect(headers.get("authorization")).toBe("Bearer fixture-access-stored-a");
    if (url === "https://chatgpt.com/backend-api/wham/usage" && (init?.method ?? "GET") === "GET") {
      metadataAccounts.push(account);
      return Response.json({ plan_type: "plus", rate_limit: { secondary_window: {
        used_percent: 100, reset_at: (now + 604_800_000) / 1000,
      } }, credits: { has_credits: true, balance: 5 }, spend_control: { reached: false } });
    }
    if (url === "https://chatgpt.com/backend-api/codex/responses" && init?.method === "POST") {
      responseAccounts.push(account);
      return sseResponse([{ type: "response.completed", response: completedPayload("fixture completed") }]);
    }
    unexpected.push("unexpected HTTP destination");
    throw new Error("only the fixture metadata and Responses endpoints are permitted");
  }) as typeof fetch;
});

afterEach(async () => {
  await drainCompactionResponseState();
  const drained = await settleBackgroundWork({ timeoutMs: 2000 });
  codexWsPool.dispose(); releaseSpendHome();
  globalThis.fetch = realFetch; globalThis.WebSocket = realWebSocket; clock.mockRestore();
  clearAccountQuota(); clearCodexQuotaPrimeState(); resetQuotaQueryBackoffForTests();
  clearThreadAccountMap(); clearCodexUpstreamHealth(); clearPoolRotationState();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  codexHome.restoreEnvironment();
  if (drained.settled) { removeTreeWithRetry(home); codexHome.removeAfterDrain(); }
  expect(drained.settled).toBe(true);
  expect(unexpected).toEqual([]);
});

async function send() {
  const request = new Request("http://localhost/v1/responses", { method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "subAlias/gpt-5.5", input: "fixture", stream: false, store: false }),
  });
  const response = await handleResponses(request, config, { model: "", provider: "" });
  return { status: response.status, retryAfter: response.headers.get("retry-after"), body: await response.json() };
}

test("same Direct namespace recovers after five-minute credit expiry without fallback or external refresh", async () => {
  const original = structuredClone(config);
  const first = await send();
  expect(first.status).toBe(200);
  expect(first.body.status).toBe("completed");
  now += 360_001;
  const stale = await send();
  expect(stale.status).toBe(429);
  expect(stale.retryAfter).toBe("300");
  expect(responseAccounts).toHaveLength(1);
  expect(metadataAccounts).toEqual([]);
  const noMain = () => { throw new Error("stored-account renewal must never access main"); };
  await primeCodexPoolQuotas(config, "credit-renewal", {
    reconcileMainAccount: noMain, readMainTokens: noMain, fetchMainInfo: noMain,
  });
  const recovered = await send();
  expect(recovered.status).toBe(200);
  expect(recovered.body.status).toBe("completed");
  expect(recovered.body.output[0].content[0].text).toBe("fixture completed");
  expect(metadataAccounts).toEqual(["fixture-account-stored-a"]);
  expect(responseAccounts).toEqual(["fixture-account-stored-a", "fixture-account-stored-a"]);
  expect(getAccountQuota("stored-b")!.credits!.observedAt).toBe(now - 360_001);
  expect(config).toEqual(original);
});
