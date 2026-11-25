import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
import { getDefaultConfig, saveConfig } from "../../src/config";
import { prepareConfigMutationDatabasePathForWrite } from "../../src/config/mutation-lock";
import { LinkApplyBusyError, withLinkApply } from "../../src/client/link-home";
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
  await expect(runClientRecycleWithAdmission(served, () => true, async () => { throw new LinkApplyBusyError(); }))
    .rejects.toBeInstanceOf(LinkApplyBusyError);
});
