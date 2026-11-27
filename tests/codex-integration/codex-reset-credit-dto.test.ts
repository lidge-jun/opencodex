import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { bindStoredCodexPoolRoutingForTests } from "../helpers/codex-pool-routing";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import { handleCodexAuthAPI } from "../../src/codex/auth-api/routes";
import { createResetCreditWhamClient } from "../../src/codex/auth-api/reset-credit-service";
import { flushConfigDirHardeningForTests } from "../../src/config/paths";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import type { OcxConfig } from "../../src/types";

const config: OcxConfig = { port: 10100, providers: {}, defaultProvider: "openai", codexAccounts: [
  { id: "dto-pool", email: "dto@example.test", isMain: false },
] };
const granted = "2026-11-01T00:00:00Z";
const expires = "2026-12-01T00:00:00Z";
const payload = {
  available_count: 3, total_earned_count: 4, ignored: "private",
  credits: [
    { id: "private-id", granted_at: granted, expires_at: null, reset_type: "weekly", status: "available", title: "x".repeat(205), description: "Reset detail", ignored: "private" },
    { id: "private-id-2", granted_at: granted, expires_at: expires },
    { granted_at: granted, status: 42 },
    { expires_at: expires },
  ],
};

describe("reset-credit safe DTO", () => {
  let home: string;
  let oldHome: string | undefined;
  let originalFetch: typeof fetch;
  beforeEach(() => {
    oldHome = process.env.OPENCODEX_HOME;
    home = mkdtempSync(join(tmpdir(), "ocx-reset-dto-"));
    process.env.OPENCODEX_HOME = home;
    bindStoredCodexPoolRoutingForTests();
    originalFetch = globalThis.fetch;
    saveCodexAccountCredential("dto-pool", { accessToken: "test-access", refreshToken: "test-refresh", expiresAt: Date.now() + 3600_000, chatgptAccountId: "test-account" });
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input) !== "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits") throw new Error("unexpected fetch");
      return Response.json(payload);
    }) as typeof fetch;
  });
  afterEach(async () => {
    globalThis.fetch = originalFetch;
    if (oldHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = oldHome;
    await flushConfigDirHardeningForTests();
    removeTreeWithRetry(home);
  });
  test("route retains non-expiring rows and bounded display fields without ids", async () => {
    const req = new Request("http://localhost/api/codex-auth/reset-credits?accountId=dto-pool");
    const resp = await handleCodexAuthAPI(req, new URL(req.url), config);
    expect(resp?.status).toBe(200);
    expect(await resp?.json()).toEqual({ available_count: 3, total_earned_count: 4, credits: [
      { granted_at: granted, expires_at: null, reset_type: "weekly", status: "available", title: "x".repeat(200), description: "Reset detail" },
      { granted_at: granted, expires_at: expires },
      { granted_at: granted, expires_at: null },
    ] });
  });
  test("auto-redeemer sees every row, non-expiring ones included, without display fields", async () => {
    const result = await createResetCreditWhamClient(config, "dto-pool").inspect();
    expect(result.credits).toEqual([
      { granted_at: granted, expires_at: null },
      { granted_at: granted, expires_at: expires },
      { granted_at: granted, expires_at: null },
      // No usable grant time: passed on as unorderable so the redeemer stands down.
      { granted_at: "", expires_at: expires },
    ]);
  });
});
