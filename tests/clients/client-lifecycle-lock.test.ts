import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertClientLifecycleHeld, withClientLifecycle, withClientLifecycleSync,
  type ClientLifecycleHeld,
} from "../../src/client/lifecycle-lock";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoPath, repoRoot } from "../helpers/repo-root";

const PROCESS_TIMEOUT = 120_000;
const lockModule = pathToFileURL(repoPath("src/client/lifecycle-lock.ts")).href;
let root = "";
let lockPath = "";
const children = new Set<ReturnType<typeof Bun.spawn>>();

beforeEach(() => {
  root = mkdtempSync(join(import.meta.dir, ".tmp-client-lifecycle-"));
  lockPath = join(root, "lock.sqlite");
});

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
  }
  children.clear();
  removeTreeWithRetry(root);
});

function spawn(source: string, env: Record<string, string | undefined> = {}) {
  const child = Bun.spawn([process.execPath, "-e", source], {
    cwd: repoRoot(), env: { ...process.env, ...env },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  children.add(child);
  return child;
}

async function exited(child: ReturnType<typeof spawn>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      child.exited,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Lifecycle child timed out")); }, 100_000);
      }),
    ]);
  } finally { clearTimeout(timer); }
}

async function ready(child: ReturnType<typeof spawn>, marker: string): Promise<void> {
  const deadline = performance.now() + 100_000;
  while (!existsSync(marker)) {
    if (child.exitCode !== null) throw new Error(`Holder exited: ${await new Response(child.stderr).text()}`);
    if (performance.now() >= deadline) throw new Error("Lifecycle holder did not acquire its lock");
    // Poll the actual acquisition marker, never infer readiness from elapsed time.
    await Bun.sleep(10);
  }
}

function holder(path = lockPath) {
  const marker = join(root, "holder-ready");
  const release = join(root, "holder-release");
  const child = spawn(`
    import { existsSync, writeFileSync } from "node:fs";
    import { withClientLifecycle, assertClientLifecycleHeld } from ${JSON.stringify(lockModule)};
    await withClientLifecycle(async held => {
      assertClientLifecycleHeld(held);
      writeFileSync(${JSON.stringify(marker)}, "held");
      while (!existsSync(${JSON.stringify(release)})) await Bun.sleep(10);
      assertClientLifecycleHeld(held);
    }, { lockPath: ${JSON.stringify(path)} });
  `);
  return { child, marker, release };
}

function contender(path: string, sync: boolean) {
  return spawn(`
    import { withClientLifecycle, withClientLifecycleSync, assertClientLifecycleHeld } from ${JSON.stringify(lockModule)};
    let ran = false;
    try {
      const work = held => { assertClientLifecycleHeld(held); ran = true; };
      ${sync ? "withClientLifecycleSync(work," : "await withClientLifecycle(async held => work(held),"}
        { lockPath: ${JSON.stringify(path)} });
      console.log(JSON.stringify({ ran, acquired: true }));
    } catch (error) { console.log(JSON.stringify({ ran, code: error.code })); }
  `);
}

test("async and sync leases are valid only during their own callback", async () => {
  let asyncLease!: ClientLifecycleHeld;
  const answer = await withClientLifecycle(async held => {
    asyncLease = held;
    assertClientLifecycleHeld(held);
    await Promise.resolve();
    assertClientLifecycleHeld(held);
    expect(() => assertClientLifecycleHeld({ ...held })).toThrow("client_lifecycle_lease_invalid");
    expect(() => assertClientLifecycleHeld(Object.create(held))).toThrow("client_lifecycle_lease_invalid");
    return 42;
  }, { lockPath });
  expect(answer).toBe(42);
  expect(() => assertClientLifecycleHeld(asyncLease)).toThrow("client_lifecycle_lease_invalid");
  let syncLease!: ClientLifecycleHeld;
  expect(withClientLifecycleSync(held => {
    syncLease = held;
    assertClientLifecycleHeld(held);
    expect(() => assertClientLifecycleHeld(asyncLease)).toThrow("client_lifecycle_lease_invalid");
    return "sync";
  }, { lockPath })).toBe("sync");
  expect(() => assertClientLifecycleHeld(syncLease)).toThrow("client_lifecycle_lease_invalid");
  expect(withClientLifecycleSync(() => undefined, { lockPath })).toBeUndefined();
  expect(await withClientLifecycle(async () => undefined, { lockPath })).toBeUndefined();
}, PROCESS_TIMEOUT);

test("forged and non-object lease values fail without creating a lock file", () => {
  for (const value of [{}, Object.freeze({}), null, undefined, true, 1, "held", () => {}]) {
    try {
      assertClientLifecycleHeld(value as ClientLifecycleHeld);
      throw new Error("forged lease accepted");
    } catch (error) {
      expect(error).toMatchObject({ code: "client_lifecycle_lease_invalid", message: "client_lifecycle_lease_invalid" });
    }
  }
  expect(existsSync(lockPath)).toBe(false);
});

test.each([undefined, null, false, 0, "failure", new Error("primary")])(
  "both wrappers preserve thrown value %s and invalidate the lease", async failure => {
    for (const sync of [false, true]) {
      let held!: ClientLifecycleHeld;
      let caught = false;
      try {
        const work = (lease: ClientLifecycleHeld): never => { held = lease; throw failure; };
        if (sync) withClientLifecycleSync(work, { lockPath });
        else await withClientLifecycle(async lease => work(lease), { lockPath });
      } catch (error) { caught = true; expect(error).toBe(failure); }
      expect(caught).toBe(true);
      expect(() => assertClientLifecycleHeld(held)).toThrow("client_lifecycle_lease_invalid");
      expect(withClientLifecycleSync(() => "reacquired", { lockPath })).toBe("reacquired");
    }
  }, PROCESS_TIMEOUT,
);

test("sync rejects object/function thenables without calling them and revokes async continuations", async () => {
  let called = false;
  const then = () => { called = true; };
  for (const value of [{ then }, Object.assign(() => {}, { then })]) {
    let held!: ClientLifecycleHeld;
    expect(() => withClientLifecycleSync(lease => { held = lease; return value; }, { lockPath }))
      .toThrow("client_lifecycle_async_callback");
    expect(() => assertClientLifecycleHeld(held)).toThrow("client_lifecycle_lease_invalid");
  }
  expect(called).toBe(false);
  let continuation!: Promise<void>;
  let refused = false;
  expect(() => withClientLifecycleSync(held => {
    continuation = Promise.resolve().then(() => {
      try { assertClientLifecycleHeld(held); }
      catch { refused = true; }
      throw undefined;
    });
    return continuation;
  }, { lockPath })).toThrow("client_lifecycle_async_callback");
  await continuation.catch(() => undefined);
  expect(refused).toBe(true);
  expect(withClientLifecycleSync(() => true, { lockPath })).toBe(true);
}, PROCESS_TIMEOUT);

test("a throwing then getter preserves its thrown value and revokes the sync lease", () => {
  let held!: ClientLifecycleHeld;
  let caught = false;
  try {
    withClientLifecycleSync(lease => {
      held = lease;
      return { get then(): never { throw undefined; } };
    }, { lockPath });
  } catch (error) { caught = true; expect(error).toBeUndefined(); }
  expect(caught).toBe(true);
  expect(() => assertClientLifecycleHeld(held)).toThrow("client_lifecycle_lease_invalid");
  expect(withClientLifecycleSync(() => true, { lockPath })).toBe(true);
}, PROCESS_TIMEOUT);

test("same-process recursive acquisition is busy and independent namespaces remain usable", async () => {
  await withClientLifecycle(async held => {
    expect(() => withClientLifecycleSync(() => { throw new Error("must not enter"); }, { lockPath }))
      .toThrow("client_lifecycle_busy");
    await expect(withClientLifecycle(async () => { throw new Error("must not enter"); }, { lockPath }))
      .rejects.toMatchObject({ code: "client_lifecycle_busy" });
    assertClientLifecycleHeld(held);
    expect(withClientLifecycleSync(inner => { assertClientLifecycleHeld(inner); return 9; }, {
      lockPath: join(root, "independent.sqlite"),
    })).toBe(9);
  }, { lockPath });
}, PROCESS_TIMEOUT);

test("real contender processes cannot enter a held async SQLite transaction", async () => {
  const held = holder();
  await ready(held.child, held.marker);
  try {
    for (const sync of [false, true]) {
      const child = contender(lockPath, sync);
      expect(await exited(child)).toBe(0);
      expect(JSON.parse(await new Response(child.stdout).text())).toEqual({ ran: false, code: "client_lifecycle_busy" });
    }
    const independent = contender(join(root, "other.sqlite"), false);
    expect(await exited(independent)).toBe(0);
    expect(JSON.parse(await new Response(independent.stdout).text())).toEqual({ ran: true, acquired: true });
  } finally {
    writeFileSync(held.release, "release");
    expect(await exited(held.child)).toBe(0);
  }
  const after = contender(lockPath, true);
  expect(await exited(after)).toBe(0);
  expect(JSON.parse(await new Response(after.stdout).text())).toEqual({ ran: true, acquired: true });
}, PROCESS_TIMEOUT);

test("SIGKILL releases the OS lock without deleting or reclaiming the database", async () => {
  const held = holder();
  await ready(held.child, held.marker);
  const before = lstatSync(lockPath, { bigint: true });
  held.child.kill("SIGKILL");
  await exited(held.child);
  expect(existsSync(lockPath)).toBe(true);
  const after = contender(lockPath, false);
  expect(await exited(after)).toBe(0);
  expect(JSON.parse(await new Response(after.stdout).text())).toEqual({ ran: true, acquired: true });
  const reopened = lstatSync(lockPath, { bigint: true });
  expect(reopened.dev).toBe(before.dev);
  expect(reopened.ino).toBe(before.ino);
}, PROCESS_TIMEOUT);

test("default namespace uses OS identity despite home overrides (isolated resolver observation)", async () => {
  const identityModule = pathToFileURL(repoPath("src/codex/user-identity.ts")).href;
  const child = spawn(`
    import { mock } from "bun:test";
    import { existsSync } from "node:fs";
    const identity = await import(${JSON.stringify(identityModule)});
    const expected = identity.resolveEffectiveUserIdentity();
    const observations = [];
    // Redirect only the OS runtime root in this isolated child, so testing the
    // default resolver never opens the real user's lock. SQLite is NOT mocked.
    mock.module(${JSON.stringify(identityModule)}, () => ({
      ...identity,
      resolveEffectiveUserRuntimeRoot(user) {
        observations.push(user);
        return ${JSON.stringify(root)};
      },
    }));
    const { withClientLifecycle, withClientLifecycleSync } = await import(${JSON.stringify(lockModule)});
    for (const suffix of ["one", "two"]) {
      for (const key of ["HOME", "USERPROFILE", "LOCALAPPDATA", "TMPDIR", "TMP", "TEMP", "OPENCODEX_HOME", "CODEX_HOME", "OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR"]) {
        process.env[key] = ${JSON.stringify(root)} + "/" + suffix;
      }
      await withClientLifecycle(async () => {
        try { withClientLifecycleSync(() => { throw new Error("unexpected entry"); }); }
        catch (error) { if (error.code === "client_lifecycle_busy") return; throw error; }
        throw new Error("split default namespace");
      });
    }
    console.log(JSON.stringify({ expected, observations,
      created: existsSync(${JSON.stringify(join(root, "client-desktop-lifecycle.sqlite"))}) }));
  `);
  expect(await exited(child)).toBe(0);
  const result = JSON.parse(await new Response(child.stdout).text());
  expect(result.created).toBe(true);
  expect(result.observations).toHaveLength(4);
  expect(result.observations.every((value: unknown) => JSON.stringify(value) === JSON.stringify(result.expected))).toBe(true);
}, PROCESS_TIMEOUT);

test("release failures close real SQLite handles, revoke leases and preserve even thrown undefined", async () => {
  const child = spawn(`
    import { Database } from "bun:sqlite";
    import { withClientLifecycle, withClientLifecycleSync, assertClientLifecycleHeld } from ${JSON.stringify(lockModule)};
    const deps = { lockPath: ${JSON.stringify(lockPath)} };
    const exec = Database.prototype.exec;
    const close = Database.prototype.close;
    const results = [];
    for (const sync of [false, true]) for (const primary of [false, true]) for (const fault of ["rollback", "close"]) {
      let lease;
      let caught = false;
      let primaryPreserved = false;
      let releaseReported = false;
      const work = held => {
        lease = held;
        Database.prototype.exec = function(sql, ...args) {
          if (fault === "rollback" && sql === "ROLLBACK") throw undefined;
          return exec.call(this, sql, ...args);
        };
        Database.prototype.close = function(...args) {
          const value = close.apply(this, args);
          if (fault === "close") throw undefined;
          return value;
        };
        if (primary) throw undefined;
        return 1;
      };
      try {
        if (sync) withClientLifecycleSync(work, deps);
        else await withClientLifecycle(async held => work(held), deps);
      } catch (error) {
        caught = true;
        primaryPreserved = primary && error === undefined;
        releaseReported = !primary && error?.code === "client_lifecycle_lock_failed" && Object.hasOwn(error, "cause");
      } finally { Database.prototype.exec = exec; Database.prototype.close = close; }
      let expired = false;
      try { assertClientLifecycleHeld(lease); } catch (error) { expired = error.code === "client_lifecycle_lease_invalid"; }
      const reacquired = withClientLifecycleSync(() => true, deps);
      results.push(caught && (primaryPreserved || releaseReported) && expired && reacquired);
    }
    console.log(JSON.stringify(results));
  `);
  expect(await exited(child)).toBe(0);
  expect(JSON.parse(await new Response(child.stdout).text())).toEqual(Array(8).fill(true));
}, PROCESS_TIMEOUT);

test.skipIf(process.platform === "win32")("POSIX paths are private and links are refused before changing their targets", () => {
  withClientLifecycleSync(() => {}, { lockPath });
  expect(lstatSync(root).mode & 0o777).toBe(0o700);
  expect(lstatSync(lockPath).mode & 0o777).toBe(0o600);
  const target = join(root, "target");
  writeFileSync(target, "untouched", { mode: 0o644 });
  const linked = join(root, "symlink.sqlite");
  symlinkSync(target, linked);
  expect(() => withClientLifecycleSync(() => {}, { lockPath: linked })).toThrow("client_lifecycle_lock_failed");
  expect(readFileSync(target, "utf8")).toBe("untouched");
  expect(lstatSync(target).mode & 0o777).toBe(0o644);
  const hardlink = join(root, "hardlink.sqlite");
  linkSync(target, hardlink);
  expect(() => withClientLifecycleSync(() => {}, { lockPath: hardlink })).toThrow("client_lifecycle_lock_failed");
  const directory = join(root, "not-a-database");
  mkdirSync(directory);
  expect(() => withClientLifecycleSync(() => {}, { lockPath: directory })).toThrow("client_lifecycle_lock_failed");
});
