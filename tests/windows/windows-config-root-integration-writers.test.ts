import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import type { ExportModel } from "../../src/clients/config-export";
import { disconnectClient } from "../../src/client/connect";
import * as paths from "../../src/config/paths";
import { INTEGRATION_CLIENTS } from "../../src/integrations/registry";
import { createIntegrationStateStore, type IntegrationStateStore } from "../../src/integrations/store";
import { applyIntegrationCoordinated, type IntegrationWriteInput } from "../../src/integrations/writer";
import { resetHardenedStateForTests, setAsyncIcaclsBeltSchedulerForTests, setAsyncIcaclsRunnerForTests,
  setIcaclsRunnerForTests, setNowForTests, setPlatformForTests, type IcaclsResult } from "../../src/lib/windows-secret-acl";
import { setSyntheticWindowsPrincipalForTests } from "../../src/lib/windows-user-principal";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

/**
 * #7815: the integrations writer (catalog fan-out, Aside sync and every other coordinated
 * integration write) and the client disconnect write under the config root with required ACLs.
 * On Windows a config load can leave the optional config-root harden in flight; these writers now
 * admit after it, like the #7777/#7826/#7869/#7998 writers, and refuse cleanly on its deadline.
 */
const success: IcaclsResult = { success: true, exitCode: 0, timedOut: false, stdout: "" };
const turn = () => new Promise<void>(done => setImmediate(done));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const keys = ["OPENCODEX_HOME", "OPENCODEX_ACL_TIMEOUT_MS", "OPENCODEX_ACL_VERIFY_EXISTING"] as const;
const models: ExportModel[] = [{ namespaced: "mock/alpha", provider: "mock", id: "alpha", contextWindow: 128_000 }];
const config = { port: 12345, hostname: "127.0.0.1", defaultProvider: "mock",
  providers: { mock: { adapter: "openai-chat", baseUrl: "https://fixture.invalid/v1" } } } as OcxConfig;
let root: string, clientHome: string, store: IntegrationStateStore;
let previous: (string | undefined)[];
let restores: Array<() => void>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ocx-integration-writer-admission-"));
  clientHome = mkdtempSync(join(tmpdir(), "ocx-integration-client-home-"));
  store = createIntegrationStateStore(join(root, "integrations"));
  previous = keys.map(key => process.env[key]);
  process.env.OPENCODEX_HOME = root; process.env.OPENCODEX_ACL_TIMEOUT_MS = "1000";
  delete process.env.OPENCODEX_ACL_VERIFY_EXISTING;
  restores = [];
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
  removeTreeWithRetry(root); removeTreeWithRetry(clientHome);
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

/** Park the optional config-root flight and record any descendant ACL command issued meanwhile. */
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

const writerPaths = ["no-lock", "absent-home", "locked"] as const;
function input(path: typeof writerPaths[number]): IntegrationWriteInput {
  const clientId = path === "no-lock" ? "pi" : "commandcode";
  const spec = INTEGRATION_CLIENTS[clientId];
  if (path !== "absent-home") {
    mkdirSync(spec.detectDir({}, clientHome), { recursive: true });
    mkdirSync(dirname(spec.configPath({}, clientHome)), { recursive: true });
    writeFileSync(spec.configPath({}, clientHome), "{}\n");
  }
  return { clientId, models, config, port: 12345, env: {}, home: clientHome, store };
}
const storeFiles = () => (existsSync(store.root) ? readdirSync(store.root) : []);

for (const path of writerPaths) {
  test.each([false, true])(`integration write on ${path} waits for parent ACL admission (timeout=%p)`, async timeout => {
    const time = clock(), parent = holdParent(); await parent.entered;
    let settled = false;
    const work = applyIntegrationCoordinated(input(path)).then(result => { settled = true; return result; });
    void work.finally(parent.arrive);
    try {
      await parent.reached; await turn();
      expect(parent.descendants).toEqual([]);
      expect(settled).toBe(false);
      expect(storeFiles()).toEqual([]);
      if (timeout) {
        time.advance(999); await turn(); expect(settled).toBe(false); time.advance(1);
        const result = await work;
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toBe("write_failed");
        expect(storeFiles()).toEqual([]);
        expect(parent.descendants).toEqual([]);
      }
    } finally { parent.release(); await work; }
    if (!timeout) {
      const result = await work;
      if (path === "absent-home") expect(result.ok).toBe(false);
      else {
        expect(result.ok).toBe(true);
        expect(storeFiles().length).toBeGreaterThan(0);
      }
    }
  });
}

test.each([false, true])("client disconnect waits for parent ACL admission before its first phase (timeout=%p)", async timeout => {
  const time = clock(), parent = holdParent(); await parent.entered;
  let settled = false;
  const work = disconnectClient({}, { lifecycleLockDeps: { lockPath: join(root, "lifecycle.sqlite") } })
    .then(() => null, (error: Error & { code?: string }) => error)
    .finally(() => { settled = true; });
  void work.finally(parent.arrive);
  try {
    await parent.reached; await turn();
    expect(parent.descendants).toEqual([]);
    expect(settled).toBe(false);
    expect(existsSync(join(root, "lifecycle.sqlite"))).toBe(false);
    if (timeout) {
      time.advance(999); await turn(); expect(settled).toBe(false); time.advance(1);
      expect((await work)?.code).toBe("ETIMEDOUT");
    }
  } finally { parent.release(); await work; }
  if (!timeout) expect((await work)?.message).toContain("disconnect refused");
});
