import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { create, toBinary } from "@bufbuild/protobuf";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearCursorCheckpointsForTests,
  commitCursorCheckpoint,
} from "../src/adapters/cursor/checkpoint-store";
import { ConversationStateStructureSchema } from "../src/adapters/cursor/gen/agent_pb";
import { createCursorRequest } from "../src/adapters/cursor/request-builder";
import {
  getSessionAffinity,
  isAccountInCooldown,
  recordPoolAccountCooldown,
} from "../src/routing/account-pool";
import {
  POOL_KEY_CURSOR,
  bindCursorSessionAffinity,
  clearCursorAccountPoolState,
  cursorSessionKeyFromParts,
  isCursorAccountPoolActive,
  isCursorAccountPoolEnabled,
  recordCursorAccountBillingCooldown,
  resolveCursorAccountForSession,
  rotateCursorAccountOn429,
} from "../src/oauth/cursor-routing";
import { getAccountSet, saveCredential, setActiveAccount } from "../src/oauth/store";
import type { OcxConfig } from "../src/types";

const PROVIDER = "cursor";
const NOW = 1_700_000_000_000;

const originalHome = process.env.OPENCODEX_HOME;
let home: string;

function cfg(enabled: boolean): OcxConfig {
  return {
    port: 0,
    defaultProvider: "cursor",
    providers: {
      cursor: { adapter: "cursor", baseUrl: "https://api2.cursor.sh", authMode: "oauth" },
    },
    cursorAccountPool: { enabled },
  } as OcxConfig;
}

async function seedAccounts(labels: string[], activeLabel: string): Promise<Record<string, string>> {
  const idByLabel = new Map<string, string>();
  for (const label of labels) {
    await saveCredential(PROVIDER, {
      access: `token-${label}`,
      refresh: `refresh-${label}`,
      expires: NOW + 3_600_000,
      accountId: label,
    });
  }
  const set = getAccountSet(PROVIDER)!;
  for (const label of labels) {
    const account = set.accounts.find(entry => entry.credential.accountId === label);
    if (!account) throw new Error(`missing seeded account ${label}`);
    idByLabel.set(label, account.id);
  }
  await setActiveAccount(PROVIDER, idByLabel.get(activeLabel)!);
  return Object.fromEntries(idByLabel);
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-cursor-pool-"));
  process.env.OPENCODEX_HOME = home;
  clearCursorAccountPoolState();
  clearCursorCheckpointsForTests();
});

afterEach(() => {
  clearCursorAccountPoolState();
  clearCursorCheckpointsForTests();
  if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
});

describe("cursor account pool", () => {
  test("default off always returns the active account", async () => {
    const ids = await seedAccounts(["acct-a", "acct-b"], "acct-a");
    expect(isCursorAccountPoolEnabled(cfg(false))).toBe(false);
    expect(isCursorAccountPoolActive(cfg(false))).toBe(false);

    const selection = resolveCursorAccountForSession("thread-1", cfg(false), NOW);

    expect(selection).toEqual({ accountId: ids["acct-a"], reason: "pool-disabled" });
  });

  test("enabled with fewer than two accounts stays inactive", async () => {
    const ids = await seedAccounts(["acct-a"], "acct-a");
    expect(isCursorAccountPoolActive(cfg(true))).toBe(false);

    const selection = resolveCursorAccountForSession("thread-1", cfg(true), NOW);

    expect(selection).toEqual({ accountId: ids["acct-a"], reason: "pool-disabled" });
  });

  test("enabled sticky session keeps the bound account", async () => {
    const ids = await seedAccounts(["acct-a", "acct-b"], "acct-a");
    bindCursorSessionAffinity("thread-2", ids["acct-b"]!, NOW);
    await setActiveAccount(PROVIDER, ids["acct-a"]!);

    const selection = resolveCursorAccountForSession("thread-2", cfg(true), NOW);

    expect(selection).toEqual({ accountId: ids["acct-b"], reason: "affinity" });
    expect(getAccountSet(PROVIDER)?.activeAccountId).toBe(ids["acct-a"]);
    expect(getSessionAffinity(POOL_KEY_CURSOR, "thread-2", NOW)?.accountId).toBe(ids["acct-b"]);
  });

  test("session key uses clientThreadId only", () => {
    expect(cursorSessionKeyFromParts({ clientThreadId: "thread-abc" })).toBe("thread-abc");
    expect(cursorSessionKeyFromParts({ clientThreadId: null })).toBeNull();
  });

  test("429 rotates once and rebinds the session", async () => {
    const ids = await seedAccounts(["acct-a", "acct-b"], "acct-a");
    bindCursorSessionAffinity("thread-a", ids["acct-a"]!, NOW);
    recordPoolAccountCooldown(POOL_KEY_CURSOR, ids["acct-a"]!, "rate_limit", "120", NOW);

    const next = rotateCursorAccountOn429(cfg(true), ids["acct-a"]!, "120", "thread-a", NOW);

    expect(next).toBe(ids["acct-b"]);
    expect(getSessionAffinity(POOL_KEY_CURSOR, "thread-a", NOW)?.accountId).toBe(ids["acct-b"]);
  });

  test("billing cooldown excludes account without entering the 429 carousel", async () => {
    const ids = await seedAccounts(["acct-a", "acct-b"], "acct-a");
    recordCursorAccountBillingCooldown(ids["acct-a"]!, null, NOW);

    expect(isAccountInCooldown(POOL_KEY_CURSOR, ids["acct-a"]!, NOW)?.reason).toBe("billing");

    const selection = resolveCursorAccountForSession("thread-c", cfg(true), NOW);
    expect(selection.accountId).toBe(ids["acct-b"]);
    expect(selection.reason).toBe("failover");
    expect(rotateCursorAccountOn429(cfg(true), ids["acct-b"]!, "60", "thread-b", NOW)).not.toBe(ids["acct-a"]);
  });

  test("checkpoint fails closed on identity_changed across accounts", () => {
    const checkpointBytes = toBinary(ConversationStateStructureSchema, create(ConversationStateStructureSchema, {
      pendingToolCalls: ["pool-identity"],
    }));
    const checkpointRef = commitCursorCheckpoint({
      conversationId: "cursor_stable",
      identityScope: "acct-1",
      modelId: "auto",
      checkpointBytes,
    });
    expect(checkpointRef).toBeDefined();

    const identityChanged = createCursorRequest({
      modelId: "cursor/auto",
      context: {
        messages: [{ role: "user", content: "hello" }],
      },
      options: {},
      _cursorConversationId: "cursor_stable",
      _cursorIdentityScope: "acct-2",
      _providerContinuation: {
        cursor: { conversationId: "cursor_stable", checkpointUsable: true, checkpointRef: checkpointRef! },
      },
    });

    expect(identityChanged.continuationMode).toBe("full-replay");
    expect(identityChanged.checkpointInvalidationReason).toBe("identity_changed");
  });

  test("cursor-routing does not wire CursorCredentialRouter", async () => {
    const [routingSource, coreSource] = await Promise.all([
      Bun.file("src/oauth/cursor-routing.ts").text(),
      Bun.file("src/server/responses/core.ts").text(),
    ]);
    expect(routingSource.includes('from "../providers/cursor-pool"')).toBe(false);
    expect(routingSource.includes("new CursorCredentialRouter")).toBe(false);
    expect(coreSource.includes('from "../../providers/cursor-pool"')).toBe(false);
    expect(coreSource.includes("new CursorCredentialRouter")).toBe(false);
  });
});
