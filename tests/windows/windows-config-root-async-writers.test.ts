import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { handleConfigCommand } from "../../src/cli/config-command";
import { handleEffortCommand } from "../../src/cli/effort";
import { handleModels } from "../../src/cli/models";
import { handleProviderCommand } from "../../src/cli/provider";
import { handleAdvisorRoutes } from "../../src/server/management/advisor-routes";
import type { OcxConfig } from "../../src/types";
import * as paths from "../../src/config/paths";
import { resetHardenedStateForTests, setAsyncIcaclsBeltSchedulerForTests, setAsyncIcaclsRunnerForTests,
  setIcaclsRunnerForTests, setNowForTests, setPlatformForTests, windowsSecretAclReapPendingForPath,
  type IcaclsResult } from "../../src/lib/windows-secret-acl";
import { setSyntheticWindowsPrincipalForTests } from "../../src/lib/windows-user-principal";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const success: IcaclsResult = { success: true, exitCode: 0, timedOut: false, stdout: "" };
const turn = () => new Promise<void>(done => setImmediate(done));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const keys = ["OPENCODEX_HOME", "OPENCODEX_ACL_TIMEOUT_MS", "OPENCODEX_ACL_VERIFY_EXISTING"] as const;
let root: string, original: string;
let previous: (string | undefined)[];
let restores: Array<() => void>;
let advisorConfig: OcxConfig | undefined;
const fixture = () => ({ port: 10100, defaultProvider: "mock", effortCap: "low", providers: {
  mock: { adapter: "openai-chat", baseUrl: "https://mock.example/v1", models: ["test-model"] },
  second: { adapter: "openai-chat", baseUrl: "https://second.example/v1", models: ["second-model"] },
}, customModels: [{ id: "fixture-model", provider: "mock", modelId: "custom-before", addedAt: "2026-01-01T00:00:00.000Z" }] });
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ocx-cli-writer-admission-"));
  previous = keys.map(key => process.env[key]);
  process.env.OPENCODEX_HOME = root; process.env.OPENCODEX_ACL_TIMEOUT_MS = "1000";
  delete process.env.OPENCODEX_ACL_VERIFY_EXISTING;
  original = JSON.stringify(fixture());
  writeFileSync(join(root, "config.json"), original);
  writeFileSync(join(root, "input.json"), JSON.stringify({ ...fixture(), effortCap: "high" }));
  restores = [];
  advisorConfig = undefined;
  for (const method of ["log", "error", "warn"] as const) {
    const hook = spyOn(console, method).mockImplementation(() => {}); restores.push(() => hook.mockRestore());
  }
  resetHardenedStateForTests(); setPlatformForTests("win32");
  setSyntheticWindowsPrincipalForTests("*S-1-5-21-1-2-3-1001"); setIcaclsRunnerForTests(() => success);
});
afterEach(async () => {
  await paths.flushConfigDirHardeningAndReaps(root);
  for (const restore of restores.reverse()) restore();
  setAsyncIcaclsRunnerForTests(null); setAsyncIcaclsBeltSchedulerForTests(null);
  setNowForTests(null); setIcaclsRunnerForTests(null); setPlatformForTests(null);
  setSyntheticWindowsPrincipalForTests(null); resetHardenedStateForTests();
  keys.forEach((key, index) => {
    if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index];
  });
  removeTreeWithRetry(root);
});
function clock() {
  let now = 0;
  const timers = new Map<() => void, number>();
  setNowForTests(() => now);
  setAsyncIcaclsBeltSchedulerForTests((callback, milliseconds) => {
    timers.set(callback, now + milliseconds); return () => { timers.delete(callback); };
  });
  return { advance(milliseconds: number) {
    now += milliseconds;
    for (const [callback, deadline] of timers) if (deadline <= now) { timers.delete(callback); callback(); }
  } };
}
function holdParent() {
  const entered = deferred(), released = deferred(), reached = deferred();
  let held = true;
  const descendants: string[] = [];
  setAsyncIcaclsRunnerForTests(async () => { entered.resolve(); await released.promise; return success; });
  setIcaclsRunnerForTests(args => {
    if (held && args[0]?.startsWith(root + sep)) { descendants.push(args[0]); reached.resolve(); }
    return success;
  });
  const barrier = paths.withConfigDirHardeningSettled;
  const hook = spyOn(paths, "withConfigDirHardeningSettled").mockImplementation(<T>(dir: string, mutate: () => T) => {
    const result = barrier(dir, mutate); reached.resolve(); return result;
  });
  restores.push(() => hook.mockRestore()); paths.hardenConfigDir();
  return { entered: entered.promise, reached: reached.promise, arrive: reached.resolve, descendants,
    release() { held = false; released.resolve(); } };
}
const operations = ["set", "unset", "import", "effort", "model-add", "model-remove", "provider-add", "provider-remove", "provider-default", "advisor"] as const;
function run(operation: typeof operations[number]) {
  if (operation === "advisor") {
    const url = new URL("http://localhost/api/advisor/settings");
    advisorConfig = fixture() as OcxConfig;
    return handleAdvisorRoutes({ url, req: new Request(url, { method: "PUT", body: JSON.stringify({ enabled: true }) }),
      config: advisorConfig, deps: {}, version: "test", trustedLoopbackIngress: false, guiSessionIssuance: null,
      convergeCodexCatalog: async () => ({ status: "skipped", reason: "not-requested", retryable: false }),
      syncClaudeAgentDefsBestEffort: async () => {},
    }).then(async response => {
      if (response?.status === 500) { expect(await response.json()).toEqual({ error: { code: "write_failed", message: "The configuration could not be saved." } }); return 1; }
      expect(response?.status).toBe(200); return 0;
    });
  }
  if (operation === "effort") return handleEffortCommand(["high", "--json"], { findLiveProxy: async () => null });
  if (operation.startsWith("model-") || operation.startsWith("provider-")) {
    const work = operation === "model-add" ? handleModels(["add", "mock", "custom-after", "--json"], { findLiveProxy: async () => null })
      : operation === "model-remove" ? handleModels(["remove", "fixture-model", "--yes", "--json"], { findLiveProxy: async () => null })
      : handleProviderCommand(operation === "provider-add" ? ["add", "third", "--adapter", "openai-chat", "--base-url", "https://third.example/v1", "--json"]
        : operation === "provider-remove" ? ["remove", "second", "--json"] : ["set-default", "second", "--json"]);
    return work.then(() => 0, error => { if (error.code !== "ETIMEDOUT") throw error; expect(error.code).toBe("ETIMEDOUT"); return 1; });
  }
  return handleConfigCommand(operation === "import" ? ["import", join(root, "input.json"), "--yes", "--json"]
    : operation === "set" ? ["set", "effortCap", "high", "--json"] : ["unset", "effortCap", "--json"]);
}
for (const operation of operations) {
  test.each([false, true])(`${operation} waits for parent ACL admission (timeout=%s)`, async timeout => {
    const time = clock(), parent = holdParent(); await parent.entered;
    let settled = false;
    const work = run(operation).then(value => { settled = true; return value; });
    void work.finally(parent.arrive);
    try {
      await parent.reached; await turn();
      expect(parent.descendants).toEqual([]); expect(settled).toBe(false);
      if (operation === "advisor") expect(advisorConfig?.advisor).toBeUndefined();
      expect(readFileSync(join(root, "config.json"), "utf8")).toBe(original);
      expect(existsSync(join(root, "config-mutation.sqlite"))).toBe(false);
      if (timeout) {
        time.advance(999); await turn(); expect(settled).toBe(false); time.advance(1);
        expect(await work).toBe(1);
        expect(readFileSync(join(root, "config.json"), "utf8")).toBe(original);
        expect(parent.descendants).toEqual([]);
        if (operation === "advisor") expect(advisorConfig?.advisor).toBeUndefined();
        expect(existsSync(join(root, "config-mutation.sqlite"))).toBe(false);
        time.advance(100_000); await paths.flushConfigDirHardening(root);
        expect(windowsSecretAclReapPendingForPath(root)).toBe(true);
      } else if (operation === "import") {
        writeFileSync(join(root, "input.json"), JSON.stringify({ ...fixture(), effortCap: "high", subagentEffortCap: "medium" }));
      } else {
        writeFileSync(join(root, "config.json"), JSON.stringify({ ...fixture(), subagentEffortCap: "medium" }));
      }
    } finally { parent.release(); await work; }
    if (!timeout) {
      expect(await work).toBe(0);
      const saved = JSON.parse(readFileSync(join(root, "config.json"), "utf8"));
      if (["set", "unset", "import", "effort"].includes(operation)) expect(saved.effortCap).toBe(operation === "unset" ? undefined : "high");
      if (operation === "model-add") expect(saved.customModels.map((row: { modelId: string }) => row.modelId)).toEqual(["custom-before", "custom-after"]);
      if (operation === "model-remove") expect(saved.customModels).toBeUndefined();
      if (operation === "provider-add") expect(saved.providers.third.baseUrl).toBe("https://third.example/v1");
      if (operation === "provider-remove") expect(saved.providers.second).toBeUndefined();
      if (operation === "provider-default") expect(saved.defaultProvider).toBe("second");
      if (operation === "advisor") expect(saved.advisor.enabled).toBe(true);
      expect(saved.subagentEffortCap).toBe("medium");
    }
  });
}

test.each(["changed", "removed"])("custom-model removal refuses a %s confirmed row after admission", async change => {
  const exit = new Error("fixture CLI exit");
  const hook = spyOn(process, "exit").mockImplementation(() => { throw exit; });
  restores.push(() => hook.mockRestore());
  const parent = holdParent(); await parent.entered;
  const work = handleModels(["remove", "fixture-model", "--yes", "--json"], { findLiveProxy: async () => null })
    .then(() => undefined, error => error);
  try {
    await parent.reached; await turn();
    expect(parent.descendants).toEqual([]);
    const fresh = fixture();
    if (change === "changed") fresh.customModels[0]!.modelId = "concurrent-edit";
    else fresh.customModels = [];
    const bytes = JSON.stringify(fresh);
    writeFileSync(join(root, "config.json"), bytes);
    parent.release();
    expect(await work).toBe(exit);
    expect(readFileSync(join(root, "config.json"), "utf8")).toBe(bytes);
    expect(existsSync(join(root, "config-mutation.sqlite"))).toBe(false);
  } finally { parent.release(); await work; }
});
