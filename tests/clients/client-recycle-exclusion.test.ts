import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { getDefaultConfig, saveConfig } from "../../src/config";
import { prepareConfigMutationDatabasePathForWrite } from "../../src/config/mutation-lock";
import { LinkApplyBusyError, withLinkApply } from "../../src/client/link-home";
import { readDesktopDisconnectReceipt } from "../../src/claude/desktop-remote-store";
import { markClientConnectPending } from "../../src/client/state";
import { runClientRecycleWithAdmission } from "../../src/client/runtime-recycle";
import type { OcxClientConnectionConfig } from "../../src/types";
import { createTempHome, type TempHome } from "../helpers/temp-home";

const served: OcxClientConnectionConfig = {
  serverUrl: "http://127.0.0.1:34567", managementUrl: "http://127.0.0.1:34567", managementTransport: "direct", transport: "link",
  link: { tunnelPort: 34567, linkId: "lnk_0123456789abcdef" }, selectedClients: [], tokenEnv: "OPENCODEX_API_AUTH_TOKEN",
  apiKeyId: "fixture-client", tokenFingerprint: "c".repeat(64), protocolVersion: 1, connectedAt: "2026-10-01T00:00:00.000Z",
};
let home: TempHome;
beforeEach(() => { home = createTempHome("recycle-exclusion-"); saveConfig(getDefaultConfig()); });
afterEach(() => home.remove());

test("an in-flight Link apply refuses recycle before any teardown", async () => {
  let stopped = 0;
  await withLinkApply(async () => {
    expect(await runClientRecycleWithAdmission(served, () => true, async () => { stopped++; })).toBe(false);
  });
  expect(stopped).toBe(0);
});

test("recycle retains apply exclusion through every teardown await", async () => {
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  let admissions = 0, completed = false;
  const flight = runClientRecycleWithAdmission(served, () => { admissions++; return true; }, async () => {
    entered(); await held;
    await expect(withLinkApply(async () => {})).rejects.toBeInstanceOf(LinkApplyBusyError);
    completed = true;
  });
  await ready;
  try { await expect(withLinkApply(async () => {})).rejects.toBeInstanceOf(LinkApplyBusyError); }
  finally { release(); }
  expect(await flight).toBe(true);
  expect({ admissions, completed }).toEqual({ admissions: 1, completed: true });
  await withLinkApply(async () => {});
});

for (const state of ["same-connection", "unreadable", "pending-connect", "stop-refused", "config-busy"] as const) {
  test("recycle rechecks " + state + " inside apply exclusion", async () => {
    let stopped = 0;
    let lock: Database | undefined;
    if (state === "same-connection") {
      const config = getDefaultConfig(); config.runtimeRole = "client"; config.client = served; saveConfig(config);
    }
    if (state === "unreadable") writeFileSync(home.path("config.json"), "{");
    if (state === "pending-connect") markClientConnectPending("d".repeat(64));
    if (state === "config-busy") { lock = new Database(prepareConfigMutationDatabasePathForWrite()); lock.exec("BEGIN IMMEDIATE"); }
    try {
      expect(await runClientRecycleWithAdmission(served, () => state !== "stop-refused", async () => { stopped++; })).toBe(false);
      expect(stopped).toBe(0);
    } finally { lock?.close(); }
  });
}

test("a failure after teardown begins is propagated instead of reported as an admission refusal", async () => {
  await expect(runClientRecycleWithAdmission(served, () => true, async () => { throw new LinkApplyBusyError(); },
    { current: () => true, sleep: () => { throw new Error("unexpected retry after teardown"); } }))
    .rejects.toBeInstanceOf(LinkApplyBusyError);
});

for (const change of ["none", "new-connection", "new-receipt", "same-receipt", "pending", "stopping", "new-generation", "expired"] as const) {
  test("deferred disconnect rechecks authority after apply contention: " + change, async () => {
    let release!: () => void;
    const held = withLinkApply(() => new Promise<void>(resolve => { release = resolve; }));
    let stop = false, current = true, clock = 0, teardowns = 0;
    const delays: number[] = [];
    const next = { ...served, apiKeyId: "new-client", tokenFingerprint: "d".repeat(64) };
    try {
      const result = await runClientRecycleWithAdmission(served, () => !stop, async () => { teardowns++; }, {
        current: () => current, now: () => clock,
        sleep: async delay => {
          delays.push(delay);
          release(); await held;
          if (change === "new-connection") saveConfig({ ...getDefaultConfig(), runtimeRole: "client", client: next });
          if (change === "new-receipt" || change === "same-receipt") {
            const owner = change === "same-receipt" ? served : next;
            mkdirSync(home.path("desktop-remote"), { recursive: true, mode: 0o700 });
            writeFileSync(home.path("desktop-remote", "disconnect.json"), JSON.stringify({
              version: 1, owner: { serverUrl: owner.serverUrl, apiKeyId: owner.apiKeyId, connectedAt: owner.connectedAt },
              phase: "complete", tokenFingerprint: owner.tokenFingerprint, keepCatalog: false,
            }), { mode: 0o600 });
            expect(readDesktopDisconnectReceipt().kind).toBe("valid");
          }
          if (change === "pending") markClientConnectPending(next.tokenFingerprint);
          stop = change === "stopping";
          current = change !== "new-generation";
          clock += change === "expired" ? 60_000 : delay;
        },
      });
      expect(delays).toEqual([50]);
      const canFinish = change === "none" || change === "same-receipt";
      expect(result).toBe(canFinish);
      expect(teardowns).toBe(canFinish ? 1 : 0);
    } finally { release(); await held; }
  });
}

test("a scheduled disconnect waits for a busy config transaction without tearing down twice", async () => {
  const lock = new Database(prepareConfigMutationDatabasePathForWrite());
  lock.exec("BEGIN IMMEDIATE");
  let teardowns = 0;
  const delays: number[] = [];
  try {
    expect(await runClientRecycleWithAdmission(served, () => true, async () => { teardowns++; }, {
      current: () => true,
      sleep: async delay => {
        delays.push(delay);
        if (delays.length === 2) lock.exec("ROLLBACK");
      },
    })).toBe(true);
    expect(delays).toEqual([50, 100]);
    expect(teardowns).toBe(1);
  } finally { lock.close(); }
});
