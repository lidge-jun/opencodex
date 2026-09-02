import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExportModel } from "../src/clients/config-export";
import { INTEGRATION_CLIENTS } from "../src/integrations/registry";
import { createIntegrationStateStore, type IntegrationStateStore } from "../src/integrations/store";
import {
  applyIntegrationCoordinated,
  disableIntegrationCoordinated,
  restoreIntegrationCoordinated,
  type IntegrationWriteInput,
} from "../src/integrations/writer";
import {
  IntegrationWriterLockBusyError,
  IntegrationWriterLockIOError,
  withIntegrationWriterLock,
  type IntegrationWriterLockSeams,
} from "../src/integrations/writer-lock";
import type { OcxConfig } from "../src/types";
import { removeTreeWithRetry } from "./helpers/remove-tree";

function eexist(): Error & { code: string } {
  return Object.assign(new Error("exists"), { code: "EEXIST" });
}

describe("DSH sibling writer lock", () => {
  test("uses wx, 0600, the PID line, bounded backoff, and releases only its own lock", async () => {
    let now = 0;
    const attempts: Array<{ path: string; payload: string; flag: string; mode: number }> = [];
    const delays: number[] = [];
    const removed: string[] = [];
    const seams: IntegrationWriterLockSeams = {
      writeFile: async (path, payload, options) => {
        attempts.push({ path, payload, flag: options.flag, mode: options.mode });
        if (attempts.length < 4) throw eexist();
      },
      removeFile: async path => { removed.push(path); },
      now: () => now,
      delay: async ms => { delays.push(ms); now += ms; },
      pid: 4242,
    };

    await expect(withIntegrationWriterLock("/tmp/settings.yaml", async () => "ok", seams)).resolves.toBe("ok");
    expect(attempts.every(item => item.path === "/tmp/settings.yaml.lock")).toBe(true);
    expect(attempts.every(item => item.payload === "4242\n" && item.flag === "wx" && item.mode === 0o600)).toBe(true);
    expect(delays).toEqual([20, 40, 80]);
    expect(removed).toEqual(["/tmp/settings.yaml.lock"]);
  });

  test("times out as typed busy without deleting a contender", async () => {
    let now = 0;
    let removes = 0;
    const delays: number[] = [];
    const seams: IntegrationWriterLockSeams = {
      writeFile: async () => { throw eexist(); },
      removeFile: async () => { removes += 1; },
      now: () => now,
      delay: async ms => { delays.push(ms); now += ms; },
      pid: 7,
    };
    await expect(withIntegrationWriterLock("/tmp/settings.yaml", async () => undefined, seams))
      .rejects.toBeInstanceOf(IntegrationWriterLockBusyError);
    expect(now).toBe(2_000);
    expect(delays.at(-1)).toBe(100);
    expect(Math.max(...delays)).toBe(200);
    expect(removes).toBe(0);
  });

  test("non-EEXIST acquisition and release failures are typed internal errors", async () => {
    const acquire: IntegrationWriterLockSeams = {
      writeFile: async () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); },
      removeFile: async () => {}, now: () => 0, delay: async () => {}, pid: 1,
    };
    await expect(withIntegrationWriterLock("/tmp/settings.yaml", async () => undefined, acquire))
      .rejects.toBeInstanceOf(IntegrationWriterLockIOError);

    const release = { ...acquire,
      writeFile: async () => {},
      removeFile: async () => { throw new Error("release failed"); },
    };
    await expect(withIntegrationWriterLock("/tmp/settings.yaml", async () => undefined, release))
      .rejects.toBeInstanceOf(IntegrationWriterLockIOError);
  });

  test("releases after the protected operation throws", async () => {
    let removes = 0;
    const seams: IntegrationWriterLockSeams = {
      writeFile: async () => {}, removeFile: async () => { removes += 1; },
      now: () => 0, delay: async () => {}, pid: 1,
    };
    await expect(withIntegrationWriterLock("/tmp/settings.yaml", async () => { throw new Error("boom"); }, seams))
      .rejects.toThrow("boom");
    expect(removes).toBe(1);
  });

  test("keeps the protected operation error when release also fails", async () => {
    const boom = new Error("boom");
    const seams: IntegrationWriterLockSeams = {
      writeFile: async () => {},
      removeFile: async () => { throw new Error("release failed"); },
      now: () => 0,
      delay: async () => {},
      pid: 1,
    };
    await expect(withIntegrationWriterLock("/tmp/settings.yaml", async () => { throw boom; }, seams))
      .rejects.toBe(boom);
  });
});

const MODELS: ExportModel[] = [
  { namespaced: "openai/gpt-5.5", provider: "openai", id: "gpt-5.5", contextWindow: 400_000 },
];
const CONFIG = {
  port: 10100,
  hostname: "127.0.0.1",
  defaultProvider: "mock",
  providers: { mock: { adapter: "openai-chat", baseUrl: "http://127.0.0.1/v1" } },
} as OcxConfig;

let root: string;
let home: string;
let store: IntegrationStateStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ocx-dsh-lock-"));
  home = join(root, "home");
  mkdirSync(home, { recursive: true });
  store = createIntegrationStateStore(join(root, "state", "integrations"));
});

afterEach(() => {
  removeTreeWithRetry(root);
});

function writeInput(env: NodeJS.ProcessEnv = {}): IntegrationWriteInput {
  return { clientId: "dsh", models: MODELS, config: CONFIG, port: 10100, env, home, store };
}

function immediateLock(onWrite?: (path: string) => void): IntegrationWriterLockSeams {
  return {
    writeFile: async path => { onWrite?.(path); },
    removeFile: async () => {},
    now: () => 0,
    delay: async () => {},
    pid: 123,
  };
}

describe("DSH coordinated mutations", () => {
  test("missing home apply/disable do not create a directory or lock", async () => {
    let acquisitions = 0;
    const seams = immediateLock(() => { acquisitions += 1; });
    const applied = await applyIntegrationCoordinated(writeInput(), { lockSeams: seams });
    expect(applied.ok).toBe(false);
    if (!applied.ok) expect(applied.reason).toBe("not_installed");
    const disabled = await disableIntegrationCoordinated(writeInput(), { lockSeams: seams });
    expect(disabled).toMatchObject({ ok: true, changed: false, state: "absent" });
    expect(acquisitions).toBe(0);
    expect(existsSync(INTEGRATION_CLIENTS.dsh.detectDir({}, home))).toBe(false);
  });

  test("an installed home with no settings locks, creates owner-only settings, and locks an apply no-op", async () => {
    const dshHome = INTEGRATION_CLIENTS.dsh.detectDir({}, home);
    mkdirSync(dshHome, { recursive: true });
    let acquisitions = 0;
    const seams = immediateLock(() => { acquisitions += 1; });
    expect((await applyIntegrationCoordinated(writeInput(), { lockSeams: seams })).ok).toBe(true);
    const configPath = INTEGRATION_CLIENTS.dsh.configPath({}, home);
    // The file must exist either way; only the POSIX bits are platform-specific,
    // because Windows synthesizes mode from the read-only attribute and reports 0o666
    // no matter what the writer requested.
    expect(existsSync(configPath)).toBe(true);
    if (process.platform !== "win32") expect(statSync(configPath).mode & 0o777).toBe(0o600);
    const second = await applyIntegrationCoordinated(writeInput(), { lockSeams: seams });
    expect(second).toMatchObject({ ok: true, changed: false, state: "current" });
    expect(acquisitions).toBe(2);
  });

  test("a real settings.yaml.lock contender becomes the typed coordinated busy error", async () => {
    const dshHome = INTEGRATION_CLIENTS.dsh.detectDir({}, home);
    mkdirSync(dshHome, { recursive: true });
    const configPath = INTEGRATION_CLIENTS.dsh.configPath({}, home);
    const lockPath = `${configPath}.lock`;
    writeFileSync(lockPath, "1\n", { mode: 0o600 });
    let clockReads = 0;
    const seams: IntegrationWriterLockSeams = {
      writeFile: async (path, payload, options) => { await writeFile(path, payload, options); },
      removeFile: async path => { await rm(path); },
      now: () => clockReads++ === 0 ? 0 : 2_001,
      delay: async () => {},
      pid: 123,
    };

    await expect(applyIntegrationCoordinated(writeInput(), { lockSeams: seams }))
      .rejects.toBeInstanceOf(IntegrationWriterLockBusyError);
    expect(readFileSync(lockPath, "utf8")).toBe("1\n");
    expect(existsSync(configPath)).toBe(false);
  });

  test("freezes environment and path before awaiting lock acquisition", async () => {
    const first = join(root, "first-dsh-home");
    const second = join(root, "second-dsh-home");
    mkdirSync(first, { recursive: true });
    mkdirSync(second, { recursive: true });
    const env = { DSH_HOME: first } as NodeJS.ProcessEnv;
    let lockPath = "";
    const seams = immediateLock(path => {
      lockPath = path;
      env.DSH_HOME = second;
    });
    expect((await applyIntegrationCoordinated(writeInput(env), { lockSeams: seams })).ok).toBe(true);
    expect(lockPath).toBe(join(first, "settings.yaml.lock"));
    expect(existsSync(join(first, "settings.yaml"))).toBe(true);
    expect(existsSync(join(second, "settings.yaml"))).toBe(false);
  });

  test("restore refuses a missing parent without recreating or locking it", async () => {
    const dshHome = INTEGRATION_CLIENTS.dsh.detectDir({}, home);
    mkdirSync(dshHome, { recursive: true });
    expect((await applyIntegrationCoordinated(writeInput(), { lockSeams: immediateLock() })).ok).toBe(true);
    const opId = store.listOperations("dsh")[0]!.opId;
    removeTreeWithRetry(dshHome);
    let acquisitions = 0;
    const restored = await restoreIntegrationCoordinated(
      { ...writeInput(), opId },
      { lockSeams: immediateLock(() => { acquisitions += 1; }) },
    );
    expect(restored).toMatchObject({ ok: false, reason: "unsafe" });
    expect(acquisitions).toBe(0);
    expect(existsSync(dshHome)).toBe(false);
  });
});
