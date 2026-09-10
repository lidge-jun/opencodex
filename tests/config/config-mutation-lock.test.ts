import { afterEach, beforeEach, expect, test } from "bun:test";
import { closeSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ConfigMutationLockError, deleteConfigTopLevelKey, getConfigPath, initializePersistedConfigIfMissing, loadConfig, observeInitialConfigState, readConfigGeneration, saveConfig, withConfigMutationLockSync } from "../../src/config";
import { InitialConfigPublicationError, publishInitialConfigNoReplace } from "../../src/config/initialize";
import { nextAtomicTempSequence } from "../../src/config/atomic-write";
import { CodexCredentialRefreshLockTimeoutError, getCodexAccountCredential, saveCodexAccountCredential } from "../../src/codex/account-store";
import type { OcxConfig } from "../../src/types";
import { ManagementRequest, managementHeaders } from "../helpers/management-auth";
import { watchdogMs } from "../helpers/ci-watchdog";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoPath, repoRoot } from "../helpers/repo-root";

let testRoot = "";
let previousOpencodexHome: string | undefined;

function config(port = 10100): OcxConfig {
  // Initial publication validates the candidate before reaching the filesystem;
  // unlike a replacing save, it cannot accept a dangling default provider.
  return {
    port,
    providers: { openai: { adapter: "openai-chat", baseUrl: "https://example.test/v1" } },
    defaultProvider: "openai",
  };
}

async function waitForOwnedChildReady(child: ReturnType<typeof Bun.spawn>, path: string): Promise<void> {
  // Readiness budget follows the predeclared platform policy: 5 s locally, 30 s on CI,
  // 45 s on Windows CI (watchdogMs), because spawning a Bun child that imports
  // src/config.ts takes real time on a loaded runner — a sibling child in the failing
  // shard needed 8.3 s end to end. The deadline uses elapsed time with a final recheck,
  // and an already-exited child fails fast with its exit code instead of polling the
  // full budget.
  const budgetMs = watchdogMs(5_000);
  const deadline = performance.now() + budgetMs;
  while (performance.now() < deadline) {
    if (existsSync(path)) return;
    const exit = await Promise.race([
      Bun.sleep(10).then(() => null),
      child.exited.then(code => code as number | null),
    ]);
    if (exit !== null) {
      const stderr = await new Response(child.stderr).text().catch(() => "");
      throw new Error(`config-lock child exited ${exit} before writing marker ${path}\nchild stderr: ${stderr}`);
    }
  }
  if (existsSync(path)) return;
  throw new Error(`Timed out waiting ${budgetMs}ms for child marker ${path}`);
}

async function waitForOwnedChild(child: ReturnType<typeof Bun.spawn>): Promise<number> {
  // The child polls for the release marker on a 10 ms sleep, so its exit is bounded by the
  // filesystem noticing that write plus one Bun teardown; a loaded Windows runner needs
  // real room for both. This helper's own kill() fires only after the full budget and
  // throws, so a surfaced exit 143 is never from here — it is the readiness-timeout
  // catch's child.kill(), and the error to read is the readiness failure, not this wait.
  const result = await Promise.race([
    child.exited.then(exitCode => ({ exitCode })),
    Bun.sleep(30_000).then(() => null),
  ]);
  if (result) return result.exitCode;
  child.kill();
  await child.exited;
  throw new Error("Timed out waiting for owned config-lock child after 30s");
}

beforeEach(() => {
  previousOpencodexHome = process.env.OPENCODEX_HOME;
  testRoot = mkdtempSync(join(import.meta.dir, ".tmp-config-mutation-lock-"));
  process.env.OPENCODEX_HOME = testRoot;
});

afterEach(() => {
  if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpencodexHome;
  removeTreeWithRetry(testRoot);
});

test("a live cross-process holder is not stolen and runtime writers fail immediately", async () => {
  saveConfig(config());
  const readyPath = join(testRoot, "holder-ready");
  const releasePath = join(testRoot, "holder-release");
  const configModuleUrl = pathToFileURL(repoPath("src/config.ts")).href;
  const childSource = `
    import { existsSync, writeFileSync } from "node:fs";
    import { withConfigMutationLockSync } from ${JSON.stringify(configModuleUrl)};
    withConfigMutationLockSync(() => {
      writeFileSync(${JSON.stringify(readyPath)}, "ready");
      while (!existsSync(${JSON.stringify(releasePath)})) Bun.sleepSync(10);
    });
  `;
  const child = Bun.spawn([process.execPath, "-e", childSource], {
    cwd: repoRoot(),
    env: { ...process.env, OPENCODEX_HOME: testRoot },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  let childKilled = false;
  try {
    try {
      await waitForOwnedChildReady(child, readyPath);
    } catch (error) {
      childKilled = true;
      child.kill();
      await child.exited;
      const stderr = await new Response(child.stderr).text().catch(() => "");
      throw new Error(`${(error as Error).message}\nchild stderr: ${stderr}`);
    }
    const startedAt = performance.now();
    expect(() => saveConfig(config(20200))).toThrow(ConfigMutationLockError);
    // A busy initializer must not steal the holder even when its target is absent.
    unlinkSync(getConfigPath());
    expect(() => initializePersistedConfigIfMissing(config(20200))).toThrow(ConfigMutationLockError);
    expect(existsSync(getConfigPath())).toBe(false);
    writeFileSync(getConfigPath(), JSON.stringify(config()));
    expect(() => saveCodexAccountCredential("busy-account", {
      accessToken: "busy-access",
      refreshToken: "busy-refresh",
      expiresAt: Date.now() + 60_000,
      chatgptAccountId: "busy-chatgpt-account",
    })).toThrow(CodexCredentialRefreshLockTimeoutError);
    expect(performance.now() - startedAt).toBeLessThan(1_000);
    expect(loadConfig().port).toBe(10100);
    expect(getCodexAccountCredential("busy-account")).toBeNull();
  } finally {
    writeFileSync(releasePath, "release");
    // The readiness-failure path already killed the child; expecting exit 0 here
    // would mask that primary error with a bare 143.
    if (!childKilled) {
      expect(await waitForOwnedChild(child)).toBe(0);
    }
  }

  saveConfig(config(20200));
  saveCodexAccountCredential("busy-account", {
    accessToken: "fresh-access",
    refreshToken: "fresh-refresh",
    expiresAt: Date.now() + 60_000,
    chatgptAccountId: "fresh-chatgpt-account",
  });
  expect(loadConfig().port).toBe(20200);
  expect(getCodexAccountCredential("busy-account")?.accessToken).toBe("fresh-access");
});

test("an abruptly exited holder releases the OS-backed transaction without stale recovery", async () => {
  saveConfig(config());
  const enteredPath = join(testRoot, "crashed-holder-entered");
  const configModuleUrl = pathToFileURL(repoPath("src/config.ts")).href;
  const childSource = `
    import { writeFileSync } from "node:fs";
    import { withConfigMutationLockSync } from ${JSON.stringify(configModuleUrl)};
    withConfigMutationLockSync(() => {
      writeFileSync(${JSON.stringify(enteredPath)}, "entered");
      process.exit(0);
    });
  `;
  const child = Bun.spawn([process.execPath, "-e", childSource], {
    cwd: repoRoot(),
    env: { ...process.env, OPENCODEX_HOME: testRoot },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(await waitForOwnedChild(child)).toBe(0);
  expect(existsSync(enteredPath)).toBe(true);
  expect(() => saveConfig(config(30300))).not.toThrow();
  expect(loadConfig().port).toBe(30300);
});

test("a throwing mutation releases the lock and leaves writers available", () => {
  saveConfig(config());
  expect(() => withConfigMutationLockSync(() => {
    throw new Error("mutation failed");
  })).toThrow("mutation failed");
  expect(() => saveConfig(config(50500))).not.toThrow();
  expect(loadConfig().port).toBe(50500);
});

const initTemps = () => readdirSync(testRoot).filter(name => name.includes(".ocx.") && name.endsWith(".tmp"));

test("initial publication rejects a missing default provider before writing candidate bytes", () => {
  let wrote = false;
  expect(() => initializePersistedConfigIfMissing({ ...config(), providers: {} }, {
    write() { wrote = true; },
  })).toThrow("Initial configuration is invalid.");
  expect(wrote).toBe(false);
  expect(existsSync(getConfigPath())).toBe(false);
});

test("initial creation keeps candidate values and existing bytes; the explicit saver still updates", () => {
  const candidate = { ...config(21001), operatorNote: "keep unknown fields" };
  expect(initializePersistedConfigIfMissing(candidate)).toBe("created");
  expect(JSON.parse(readFileSync(getConfigPath(), "utf8"))).toEqual(candidate);
  if (process.platform !== "win32") expect(lstatSync(getConfigPath()).mode & 0o777).toBe(0o600);
  expect(readConfigGeneration()).toMatchObject({ generation: { value: 1 } });
  const bytes = readFileSync(getConfigPath(), "utf8");
  expect(initializePersistedConfigIfMissing(config(21002))).toBe("exists");
  expect(readFileSync(getConfigPath(), "utf8")).toBe(bytes);
  saveConfig(config(21003));
  expect(loadConfig().port).toBe(21003);
  expect(initTemps()).toEqual([]);
});

test.each(["", "not-json\n", '{"port":"broken"}', '\uFEFF{ "port":21002, "providers":{}, "defaultProvider":"openai", "unknown":42 }\n'])(
  "init preserves occupied bytes without lock or backup creation: %j", bytes => {
    writeFileSync(getConfigPath(), bytes);
    const candidate = config(21001);
    const original = structuredClone(candidate);
    expect(initializePersistedConfigIfMissing(candidate)).toBe(bytes.startsWith("\uFEFF") ? "exists" : "invalid");
    expect(readFileSync(getConfigPath(), "utf8")).toBe(bytes);
    expect(candidate).toEqual(original);
    expect(readdirSync(testRoot)).toEqual(["config.json"]);
  },
);

test("init refuses a directory and a dangling symlink without following either", () => {
  mkdirSync(getConfigPath());
  expect(observeInitialConfigState()).toBe("invalid");
  expect(initializePersistedConfigIfMissing(config())).toBe("invalid");
  removeTreeWithRetry(getConfigPath());
  const absent = join(testRoot, "absent");
  symlinkSync(absent, getConfigPath(), "file");
  expect(initializePersistedConfigIfMissing(config())).toBe("invalid");
  expect(lstatSync(getConfigPath()).isSymbolicLink()).toBe(true);
  expect(existsSync(absent)).toBe(false);
});

test("real link collision preserves the winner and does not advance generation or mutate the candidate", () => {
  withConfigMutationLockSync(() => {});
  const generation = readConfigGeneration();
  const winner = JSON.stringify(config(21002)) + "\n";
  const candidate = config(21001);
  const original = structuredClone(candidate);
  expect(initializePersistedConfigIfMissing(candidate, {
    link(temp, target) {
      writeFileSync(target, winner, { flag: "wx" });
      linkSync(temp, target);
    },
  })).toBe("exists");
  expect(readFileSync(getConfigPath(), "utf8")).toBe(winner);
  expect(readConfigGeneration()).toEqual(generation);
  expect(candidate).toEqual(original);
  expect(initTemps()).toEqual([]);
});

test("exclusive temp collision does not remove or modify somebody else's file", () => {
  const sequence = nextAtomicTempSequence() + 1;
  const occupied = `${getConfigPath()}.ocx.${process.pid}.${sequence}.tmp`;
  writeFileSync(occupied, "other staged bytes", { flag: "wx" });
  expect(() => publishInitialConfigNoReplace(getConfigPath(), "candidate bytes")).toThrow(InitialConfigPublicationError);
  expect(readFileSync(occupied, "utf8")).toBe("other staged bytes");
  expect(existsSync(getConfigPath())).toBe(false);
});

test("failed hardening occurs before candidate bytes are written", () => {
  let wrote = false;
  let linked = false;
  let failure: unknown;
  try {
    initializePersistedConfigIfMissing(config(), {
      harden(_fd, temp) {
        expect(readFileSync(temp, "utf8")).toBe("");
        throw new Error("private ACL failure detail");
      },
      write() { wrote = true; },
      link() { linked = true; },
    });
  } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(InitialConfigPublicationError);
  expect((failure as Error).message).toContain("permissions could not be secured");
  expect((failure as Error).message).toContain("OPENCODEX_HOME");
  expect((failure as Error).message).not.toContain("private ACL failure detail");
  expect(failure).toMatchObject({ publication: "not-published", hardLinkUnavailable: false, residualTemp: false });
  expect(wrote).toBe(false);
  expect(linked).toBe(false);
  expect(existsSync(getConfigPath())).toBe(false);
  expect(initTemps()).toEqual([]);
});

test("partial write failure removes only the unpublished temporary name", () => {
  let failure: unknown;
  try {
    initializePersistedConfigIfMissing(config(), {
      write(fd, bytes) { writeFileSync(fd, bytes.slice(0, 10)); throw new Error("disk full"); },
    });
  } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(InitialConfigPublicationError);
  expect((failure as Error).message).toBe("Initial config publication did not finish.");
  expect(existsSync(getConfigPath())).toBe(false);
  expect(initTemps()).toEqual([]);
});

test.each(["EOPNOTSUPP", "ENOTSUP", "ENOSYS", "EXDEV", "EPERM"])("unsupported/denied link %s never falls back to replacement", code => {
  try {
    initializePersistedConfigIfMissing(config(), {
      link() { throw Object.assign(new Error("do not print raw error"), { code }); },
    });
    throw new Error("expected link refusal");
  } catch (error) {
    expect(error).toBeInstanceOf(InitialConfigPublicationError);
    expect((error as InitialConfigPublicationError).hardLinkUnavailable).toBe(true);
    expect((error as Error).message).toContain("OPENCODEX_HOME");
    expect((error as Error).message).toContain("private file permissions");
    expect((error as Error).message).not.toContain("do not print raw error");
    expect((error as Error).message).not.toContain("permissions could not be secured");
  }
  expect(existsSync(getConfigPath())).toBe(false);
  expect(initTemps()).toEqual([]);
});

test("a syscall error after a real link leaves the entire published candidate intact", () => {
  const bytes = 'complete candidate bytes\n';
  expect(() => publishInitialConfigNoReplace(getConfigPath(), bytes, {
    link(temp, target) { linkSync(temp, target); throw Object.assign(new Error("uncertain completion"), { code: "EIO" }); },
  })).toThrow(InitialConfigPublicationError);
  expect(readFileSync(getConfigPath(), "utf8")).toBe(bytes);
  expect(initTemps()).toEqual([]);
});

test("post-link identity failure cannot remove a concurrent replacement", () => {
  expect(() => initializePersistedConfigIfMissing(config(21001), {
    link(temp, target) {
      linkSync(temp, target);
      const replacement = join(testRoot, "replacement");
      writeFileSync(replacement, "concurrent-winner\n");
      renameSync(replacement, target);
    },
  })).toThrow(InitialConfigPublicationError);
  expect(readFileSync(getConfigPath(), "utf8")).toBe("concurrent-winner\n");
});

test("cleanup failure retains full published/shared bytes and closes the descriptor", () => {
  let closed = false;
  let failure: unknown;
  try {
    publishInitialConfigNoReplace(getConfigPath(), "complete bytes", {
      unlink() { throw new Error("sharing violation"); },
      close(fd) { closed = true; closeSync(fd); },
    });
  } catch (error) { failure = error; }
  expect(failure).toMatchObject({ publication: "published", residualTemp: true });
  expect(closed).toBe(true);
  expect(readFileSync(getConfigPath(), "utf8")).toBe("complete bytes");
  const temps = initTemps();
  expect(temps).toHaveLength(1);
  expect(readFileSync(join(testRoot, temps[0]!), "utf8")).toBe("complete bytes");
});

test("a shared unpublished inode is never scrubbed", () => {
  const otherName = join(testRoot, "shared-candidate");
  expect(() => publishInitialConfigNoReplace(getConfigPath(), "candidate bytes", {
    link(temp) { linkSync(temp, otherName); throw new Error("publication failed"); },
  })).toThrow(InitialConfigPublicationError);
  expect(readFileSync(otherName, "utf8")).toBe("candidate bytes");
  expect(existsSync(getConfigPath())).toBe(false);
  expect(initTemps()).toEqual([]);
});

test("a swapped temporary symlink is neither written through nor removed as our inode", () => {
  const victim = join(testRoot, "victim");
  writeFileSync(victim, "untouched");
  expect(() => publishInitialConfigNoReplace(getConfigPath(), "candidate bytes", {
    harden(_fd, temp) { unlinkSync(temp); symlinkSync(victim, temp, "file"); },
  })).toThrow(InitialConfigPublicationError);
  expect(readFileSync(victim, "utf8")).toBe("untouched");
  expect(existsSync(getConfigPath())).toBe(false);
  expect(lstatSync(join(testRoot, initTemps()[0]!)).isSymbolicLink()).toBe(true);
});

test("descriptor close failure cannot scrub an already published config", () => {
  expect(() => publishInitialConfigNoReplace(getConfigPath(), "complete bytes", {
    close(fd) { closeSync(fd); throw new Error("close failed"); },
  })).toThrow(InitialConfigPublicationError);
  expect(readFileSync(getConfigPath(), "utf8")).toBe("complete bytes");
});

test("successful init adopts deletion provenance before a subsequent explicit save", () => {
  const candidate = config();
  deleteConfigTopLevelKey(candidate, "hostname");
  expect(initializePersistedConfigIfMissing(candidate)).toBe("created");
  expect(candidate.configRebaseProvenance).toEqual({ version: 1, deletedTopLevelKeys: ["hostname"] });
  candidate.hostname = "127.0.0.1";
  saveConfig(candidate);
  expect(JSON.parse(readFileSync(getConfigPath(), "utf8")).hostname).toBe("127.0.0.1");
});

test("management API maps config mutation lock contention to retryable 503", async () => {
  saveConfig(config());
  const readyPath = join(testRoot, "mgmt-holder-ready");
  const releasePath = join(testRoot, "mgmt-holder-release");
  const configModuleUrl = pathToFileURL(repoPath("src/config.ts")).href;
  const childSource = `
    import { existsSync, writeFileSync } from "node:fs";
    import { withConfigMutationLockSync } from ${JSON.stringify(configModuleUrl)};
    withConfigMutationLockSync(() => {
      writeFileSync(${JSON.stringify(readyPath)}, "ready");
      while (!existsSync(${JSON.stringify(releasePath)})) Bun.sleepSync(10);
    });
  `;
  const child = Bun.spawn([process.execPath, "-e", childSource], {
    cwd: repoRoot(),
    env: { ...process.env, OPENCODEX_HOME: testRoot },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  let childKilled = false;
  try {
    try {
      await waitForOwnedChildReady(child, readyPath);
    } catch (error) {
      childKilled = true;
      child.kill();
      await child.exited;
      const stderr = await new Response(child.stderr).text().catch(() => "");
      throw new Error(`${(error as Error).message}\nchild stderr: ${stderr}`);
    }
    const { handleManagementAPI } = await import("../../src/server/management-api");
    const url = new URL("http://localhost/api/codex-auth/auto-switch");
    const response = await handleManagementAPI(
      new ManagementRequest(url, {
        method: "PUT",
        headers: managementHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ threshold: 50 }),
      }),
      url,
      config(),
    );
    expect(response?.status).toBe(503);
    expect(await response!.json()).toMatchObject({
      error: "Configuration is busy; retry shortly",
      code: "CONFIG_MUTATION_LOCK_UNAVAILABLE",
    });
  } finally {
    writeFileSync(releasePath, "release");
    // The readiness-failure path already killed the child; expecting exit 0 here
    // would mask that primary error with a bare 143.
    if (!childKilled) {
      expect(await waitForOwnedChild(child)).toBe(0);
    }
  }
});
