import { afterEach, expect, spyOn, test } from "bun:test";
import { ptr, toArrayBuffer } from "bun:ffi";
import * as fs from "node:fs";
import { join, win32 } from "node:path";
import * as acl from "../../src/lib/windows-owner-acl";
import { hardenSecretDirAsync } from "../../src/lib/windows-secret-acl";
import { openWindowsCliApplyAuthority, type WindowsApplyAcquisition, type WindowsApplyAuthorityPins } from "../../src/codex/cli-update-job-store-windows";
import { observeWindowsInstall, sameWindowsInstall, sameWindowsPreservedEntries, windowsInstallNamespaceSupported } from "../../src/codex/cli-update-windows-observation";
import { actualApplyRetentionRootWithinTemp, verifyActualApplyRetentionRoot } from "../helpers/windows-cli-apply-retention-root";
import { createCodexCliTestRoot } from "../helpers/codex-cli-fixture-root";
import { trustWindowsTempFixtureAncestry } from "../helpers/windows-temp-ancestry";
import { removeTreeWithRetry } from "../helpers/remove-tree";

// Portable filesystem model; native Windows acceptance is kept separate below.
async function withDirectoryIdentity(run: (state: { ino: bigint; duringAcl?: () => void }) => Promise<void>) {
  const prefix = "C:\\ocx-observation-fixture", path = win32.join(prefix, "unrelated");
  const state = { ino: 9007199254740992n, duringAcl: undefined as (() => void) | undefined };
  const realStat = fs.lstatSync, realRead = fs.readdirSync;
  const stat = spyOn(fs, "lstatSync").mockImplementation(((name: fs.PathLike, options?: { bigint?: boolean }) => {
    if (name !== path) return realStat(name, options as { bigint: true });
    // Match lstat's number rounding unless the caller requests exact stats.
    const scalar = (value: bigint) => options?.bigint ? value : Number(value);
    return { dev: scalar(9007199254740995n), ino: scalar(state.ino), size: scalar(0n), nlink: scalar(1n),
      isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false } as fs.BigIntStats;
  }) as typeof fs.lstatSync);
  const read = spyOn(fs, "readdirSync").mockImplementation(((name: fs.PathLike, ...args: unknown[]) => {
    if (name === prefix) return ["unrelated"];
    if (name === path) return [];
    return Reflect.apply(realRead, fs, [name, ...args]);
  }) as typeof fs.readdirSync);
  acl.setWindowsOwnerAclAsyncRunnerForTests(async entries => {
    expect(entries).toEqual([{ path: win32.toNamespacedPath(path), directory: true, policy: "write-private" }]);
    await Promise.resolve(); state.duringAcl?.();
    const user = "S-1-5-21-9-9-9-1001";
    return { success: true, timedOut: false,
      stdout: `U|${user}|${user}|False\nE|0|${user}|4|1\nA|0|0|0|2032127|${user}|False\nEND` };
  });
  try { await run(state); } finally { acl.setWindowsOwnerAclAsyncRunnerForTests(null); read.mockRestore(); stat.mockRestore(); }
}

test("directory snapshots retain adjacent identities beyond number precision", async () => {
  await withDirectoryIdentity(async state => {
    const first = await observeWindowsInstall("C:\\ocx-observation-fixture");
    state.ino++;
    const second = await observeWindowsInstall("C:\\ocx-observation-fixture");
    expect(first.directories).toEqual(["unrelated:9007199254740995:9007199254740992"]);
    expect(second.directories).toEqual(["unrelated:9007199254740995:9007199254740993"]);
    expect(sameWindowsInstall(first, second)).toBe(false);
    expect(sameWindowsPreservedEntries(first, second)).toBe(false);
    expect(windowsInstallNamespaceSupported("C:\\ocx-observation-fixture")).toBe(true);
  });
});

test("an adjacent large directory identity changing during ACL read refuses observation", async () => {
  await withDirectoryIdentity(async state => {
    state.duringAcl = () => { state.ino++; };
    await expect(observeWindowsInstall("C:\\ocx-observation-fixture")).rejects.toThrow("installation_changed");
  });
});

test("retention fixture accepts a normal nested temp child and rejects unsafe root spellings", () => {
  const temp = "C:\\Users\\fixture\\AppData\\Local\\Temp";
  const root = temp + "\\session\\ocx-actual-apply-aB1234";
  expect(actualApplyRetentionRootWithinTemp(root, temp)).toBe(true);
  expect(actualApplyRetentionRootWithinTemp(temp + "\\ocx-actual-apply-aB1234", temp)).toBe(true);
  for (const candidate of [null, 42, temp, "C:\\ocx-actual-apply-aB1234",
    temp + "-other\\ocx-actual-apply-aB1234", "D:\\ocx-actual-apply-aB1234",
    "\\\\server\\share\\ocx-actual-apply-aB1234", root + ":stream", root + ".", root + "\\",
    temp + "\\session\\..\\ocx-actual-apply-aB1234", temp + "\\unowned-aB1234", root.replaceAll("\\", "/")]) {
    expect(actualApplyRetentionRootWithinTemp(candidate, temp), String(candidate)).toBe(false);
  }
});

const native = process.platform === "win32" && process.arch === "x64" ? test : test.skip;
const roots = new Map<string, WindowsApplyAcquisition[]>();
// Acquisitions whose native close failed stay strongly reachable for diagnosis; they are
// never revisited by a later afterEach.
const failedCleanup: { root: string; owners: WindowsApplyAcquisition[] }[] = [];
afterEach(() => {
  acl.setWindowsOwnerAclAsyncRunnerForTests(null);
  const failedRoots: string[] = [];
  for (const [root, owners] of roots) {
    roots.delete(root);
    // No installer is created here. Evaluate every owner; a failed native close
    // withholds root deletion and is reported once below.
    const failed = owners.filter(owner => !owner.releaseIfClean());
    if (failed.length === 0) removeTreeWithRetry(root);
    else { failedCleanup.push({ root, owners: failed }); failedRoots.push(root); }
  }
  expect(failedRoots, "fixture pins must close before root removal").toEqual([]);
});
async function authorityFixture() {
  const root = createCodexCliTestRoot("ocx-release-review-"), owners: WindowsApplyAcquisition[] = [];
  roots.set(root, owners);
  await hardenSecretDirAsync(root, { required: true }); trustWindowsTempFixtureAncestry(root);
  const prefix = join(root, "prefix"); fs.mkdirSync(join(prefix, "node_modules", "@openai"), { recursive: true });
  const acquire = () => openWindowsCliApplyAuthority(prefix, true, owner => { owners.push(owner); });
  return { root, prefix, owners, acquire };
}

native("ACL-only release failure deletes only its owned lock and permits a later lease acquisition", async () => {
  const f = await authorityFixture(), guard = await f.acquire();
  acl.setWindowsOwnerAclAsyncRunnerForTests(async () => ({ success: false, timedOut: true, stdout: "" }));
  try { expect(await guard.release()).toBe(false); }
  finally { acl.setWindowsOwnerAclAsyncRunnerForTests(null); }
  expect(guard.resourcesReleased).toBe(true);
  expect(f.owners[0]!.releaseIfClean()).toBe(true);
  expect(fs.existsSync(guard.lock)).toBe(false);
  const next = await f.acquire();
  try {
    expect(await guard.release()).toBe(false); // Cannot release a newer owner.
    expect(fs.existsSync(join(next.lock, "owner.json"))).toBe(true);
  } finally { expect(await next.release()).toBe(true); }
}, 60000);

native("original held deletion proves disposal even when the lock pathname cannot be observed", async () => {
  const f = await authorityFixture(), guard = await f.acquire();
  const realStat = fs.lstatSync;
  const stat = spyOn(fs, "lstatSync").mockImplementation(((path: fs.PathLike, ...args: unknown[]) => {
    if (path === guard.lock) throw Object.assign(new Error("fixture namespace unreadable"), { code: "EACCES" });
    return Reflect.apply(realStat, fs, [path, ...args]);
  }) as typeof fs.lstatSync);
  acl.setWindowsOwnerAclAsyncRunnerForTests(async () => ({ success: false, timedOut: false, stdout: "" }));
  try {
    expect(await guard.release()).toBe(false);
    expect(guard.resourcesReleased).toBe(true);
  } finally { stat.mockRestore(); acl.setWindowsOwnerAclAsyncRunnerForTests(null); }
  // This fixture created no child/staging, and restores the observation before teardown.
  expect(f.owners[0]!.releaseIfClean()).toBe(true);
  expect(fs.existsSync(guard.lock)).toBe(false);
}, 60000);

native("a replacement lock after original handle close cannot retain the old authority", async () => {
  const f = await authorityFixture(), guard = await f.acquire();
  const ctx = f.owners[0]!.resources as { kernel: Parameters<WindowsApplyAuthorityPins["release"]>[1] };
  const close = ctx.kernel.symbols.CloseHandle;
  let replaced = false;
  ctx.kernel.symbols.CloseHandle = handle => {
    const buffer = Buffer.alloc(32768 * 2);
    const length = ctx.kernel.symbols.GetFinalPathNameByHandleW(handle, ptr(buffer), 32768, 0);
    const isLock = buffer.toString("utf16le", 0, length * 2) === win32.toNamespacedPath(guard.lock);
    const result = close(handle);
    if (isLock && result) {
      fs.mkdirSync(guard.lock);
      fs.writeFileSync(join(guard.lock, "owner.json"), "replacement-owner");
      replaced = true;
    }
    return result;
  };
  try { expect(await guard.release()).toBe(true); }
  finally { ctx.kernel.symbols.CloseHandle = close; }
  expect(replaced).toBe(true);
  expect(guard.resourcesReleased).toBe(true);
  expect(fs.readFileSync(join(guard.lock, "owner.json"), "utf8")).toBe("replacement-owner");
  expect(await guard.release()).toBe(false);
  expect(fs.readFileSync(join(guard.lock, "owner.json"), "utf8")).toBe("replacement-owner");
}, 60000);

native.each([1, 2])("failed deletion of held object %s never proves disposal", async refused => {
  const f = await authorityFixture(), guard = await f.acquire();
  const ctx = f.owners[0]!.resources as { kernel: Parameters<WindowsApplyAuthorityPins["release"]>[1] };
  const dispose = ctx.kernel.symbols.SetFileInformationByHandle;
  let deletes = 0;
  ctx.kernel.symbols.SetFileInformationByHandle = (...args) => {
    if (args[1] === 4 && ++deletes === refused) return 0;
    return dispose(...args);
  };
  try {
    expect(await guard.release()).toBe(false);
    expect(guard.resourcesReleased).toBe(false);
  } finally { ctx.kernel.symbols.SetFileInformationByHandle = dispose; }
  expect(f.owners[0]!.releaseIfClean()).toBe(true);
  expect(fs.existsSync(guard.lock)).toBe(true);
  await expect(f.acquire()).rejects.toThrow("job_store_busy");
}, 60000);

native("a failed native close retains its exact pin and execution token", async () => {
  const f = await authorityFixture(), guard = await f.acquire();
  const ctx = f.owners[0]!.resources as { kernel: Parameters<WindowsApplyAuthorityPins["release"]>[1]; pins: WindowsApplyAuthorityPins };
  const close = ctx.kernel.symbols.CloseHandle;
  let failed: bigint | undefined, releases = 0, attempts = 0;
  ctx.kernel.symbols.CloseHandle = handle => {
    failed ??= handle;
    if (handle === failed) { attempts++; return 0; }
    return close(handle);
  };
  try {
    expect(await guard.release()).toBe(false);
    expect(guard.resourcesReleased).toBe(false);
    expect(attempts).toBe(1);
    expect(f.owners[0]!.releaseIfClean({ release() { releases++; } })).toBe(false);
    expect(releases).toBe(0);
  } finally {
    ctx.kernel.symbols.CloseHandle = close;
    // Restore the injected fault and explicitly dispose only this fixture's pin.
    if (failed !== undefined) expect(ctx.pins.release(failed, ctx.kernel)).toBe(true);
  }
  expect(f.owners[0]!.releaseIfClean()).toBe(true);
}, 60000);

native("remaining staging prevents disposal after lock deletion is refused", async () => {
  const f = await authorityFixture(), guard = await f.acquire();
  const staging = await guard.createStaging();
  expect(await guard.release()).toBe(false);
  expect(guard.resourcesReleased).toBe(false);
  expect(fs.existsSync(staging)).toBe(true);
  expect(f.owners[0]!.releaseIfClean()).toBe(true);
  await expect(f.acquire()).rejects.toThrow("job_store_busy");
}, 60000);

for (const when of ["before ACL", "during ACL"] as const) native(`identity failure ${when} preserves lock and closes pins`, async () => {
  const f = await authorityFixture(), guard = await f.acquire();
  const ctx = f.owners[0]!.resources as { kernel: Parameters<WindowsApplyAuthorityPins["release"]>[1] };
  const inspect = ctx.kernel.symbols.GetFileInformationByHandleEx;
  const changedIdentity: typeof inspect = (...args) => {
    const result = inspect(...args);
    if (result && args[1] === 18) new Uint8Array(toArrayBuffer(args[2]!, 0, 24))[8]! ^= 1;
    return result;
  };
  if (when === "before ACL") ctx.kernel.symbols.GetFileInformationByHandleEx = changedIdentity;
  else acl.setWindowsOwnerAclAsyncRunnerForTests(async () => {
    ctx.kernel.symbols.GetFileInformationByHandleEx = changedIdentity;
    return { success: false, timedOut: false, stdout: "" };
  });
  try { await expect(guard.release()).rejects.toThrow("unsafe_store"); }
  finally { ctx.kernel.symbols.GetFileInformationByHandleEx = inspect; acl.setWindowsOwnerAclAsyncRunnerForTests(null); }
  expect(guard.resourcesReleased).toBe(false);
  expect(f.owners[0]!.releaseIfClean()).toBe(true);
  expect(fs.existsSync(join(guard.lock, "owner.json"))).toBe(true);
  expect(await guard.release()).toBe(false);
  await expect(f.acquire()).rejects.toThrow("job_store_busy");
}, 60000);

native("retention root read-only admission requires canonical private OS-temp ancestry", async () => {
  const parent = createCodexCliTestRoot("ocx-retention-parent-"); roots.set(parent, []);
  await hardenSecretDirAsync(parent, { required: true });
  const root = createCodexCliTestRoot("ocx-actual-apply-", parent);
  await hardenSecretDirAsync(root, { required: true });
  expect(await verifyActualApplyRetentionRoot(root)).toBe(root);
  const alias = join(parent, "ocx-actual-apply-alias"); fs.symlinkSync(root, alias, "junction");
  await expect(verifyActualApplyRetentionRoot(alias)).rejects.toThrow("PRIVATE_TEMP_FIXTURE_REQUIRED");
  acl.setWindowsOwnerAclAsyncRunnerForTests(async () => ({ success: false, timedOut: false, stdout: "" }));
  await expect(verifyActualApplyRetentionRoot(root)).rejects.toThrow("PRIVATE_TEMP_FIXTURE_REQUIRED");
}, 60000);
