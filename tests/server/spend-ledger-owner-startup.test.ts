/** startServer owns and releases the shared spend journal lease (#5123). */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { flushConfigDirHardeningForTests } from "../../src/config/paths";
import { flushNativeMainStartupReleases } from "../../src/codex/native-profile-startup";
import {
  SPEND_LEDGER_JOURNAL_FILENAME,
  SPEND_LEDGER_SALT_FILENAME,
  resetSharedSpendLedgerForTest,
} from "../../src/lib/spend-reservation-ledger";
import { acquireSpendLedgerOwner, spendLedgerOwnerSnapshot } from "../../src/lib/spend-ledger-owner";
import { startServer } from "../../src/server";
import type { OcxConfig } from "../../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let home = "";
let previousHome: string | undefined;
let codexHome: IsolatedCodexHome | null = null;

function config(): OcxConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "kimi",
    providers: { kimi: { adapter: "openai-chat", baseUrl: "https://kimi.test/v1", models: ["k3"] } },
  };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-spend-owner-startup-"));
  previousHome = process.env.OPENCODEX_HOME;
  process.env.OPENCODEX_HOME = home;
  codexHome = installIsolatedCodexHome("ocx-spend-owner-codex-");
  resetSharedSpendLedgerForTest();
  saveConfig(config());
});

afterEach(async () => {
  await flushNativeMainStartupReleases();
  await flushConfigDirHardeningForTests();
  resetSharedSpendLedgerForTest();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  codexHome?.restore();
  codexHome = null;
  removeTreeWithRetry(home);
});

test("startServer acquires before serving and final stop releases", async () => {
  const server = startServer(0);
  expect(spendLedgerOwnerSnapshot().ownership).toBe("held");
  try {
    const adminToken = readFileSync(join(home, "admin-api-token"), "utf8").trim();
    const liveness = await fetch(new URL("/healthz", server.url));
    expect(await liveness.json()).not.toHaveProperty("spendLedger");
    const health = await fetch(new URL("/api/system/health", server.url), {
      headers: { "x-opencodex-api-key": adminToken },
    });
    expect(await health.json()).toMatchObject({
      spendLedger: {
        ownership: "held",
        initialized: false,
        configured: false,
        degraded: false,
        persistFailures: 0,
        corruptRecords: 0,
      },
    });
    expect(existsSync(join(home, SPEND_LEDGER_JOURNAL_FILENAME))).toBe(false);
    expect(existsSync(join(home, SPEND_LEDGER_SALT_FILENAME))).toBe(false);
  } finally {
    await server.stop(true);
  }
  expect(spendLedgerOwnerSnapshot().ownership).toBe("unheld");
});

test("a partial start that bound public before an auxiliary failure releases ownership", () => {
  const blocker = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("blocked") });
  try {
    const candidate = config();
    candidate.unauthenticatedLoopbackListener = { enabled: true, port: blocker.port };
    saveConfig(candidate);
    expect(() => startServer(0)).toThrow();
    expect(spendLedgerOwnerSnapshot().ownership).toBe("unheld");
    const next = acquireSpendLedgerOwner();
    next.release();
  } finally {
    blocker.stop(true);
  }
});
