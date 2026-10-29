import { afterEach, expect, spyOn, test } from "bun:test";
import { dlopen } from "bun:ffi";
import { win32 } from "node:path";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  createWindowsNativePrincipalLookup, readWindowsNativePrincipal, resolveWindowsNativePrincipal,
  type NativePrincipalTiming, type WindowsNativePrincipalApi,
} from "../../src/lib/windows-native-principal";
import {
  cachedCurrentWindowsIdentity, resetWindowsPrincipalForTests, resolveCurrentWindowsPrincipal,
  resolveCurrentWindowsPrincipalAsync, setNativeWindowsPrincipalLookupsForTests,
  setWindowsPrincipalRunnerForTests, setAsyncWindowsPrincipalRunnerForTests,
} from "../../src/lib/windows-user-principal";
import { resolveTrustedWindowsSystemDirectory, resolveTrustedWindowsPowerShellExe } from "../../src/lib/windows-elevation";
import {
  hardenSecretPathAsync, resetHardenedStateForTests, setAsyncIcaclsRunnerForTests,
  timedOutSecretPathCountForTests, flushWindowsSecretAclReapsBeforeRemoval,
} from "../../src/lib/windows-secret-acl";

const SID = "S-1-5-21-111-222-333-1001", SID_ADDRESS = 8192, STRING_ADDRESS = 4096, TOKEN = 0x1a4n;
const IDENTITY = { sid: SID, name: "EXAMPLE\\Owner" };
function utf16(target: Uint16Array, text: string) {
  for (let i = 0; i < text.length; i++) target[i] = text.charCodeAt(i);
}
function fixture(account = "Owner", domain = "EXAMPLE", sid = SID) {
  const freed: number[] = [], closed: bigint[] = [];
  let formats = 0, translations = 0;
  const api: WindowsNativePrincipalApi = {
    openProcessToken(access, output) { expect(access).toBe(8); output[0] = TOKEN; return 1; },
    getTokenInformation(token, kind, buffer, length) {
      expect(token).toBe(TOKEN); expect(kind).toBe(1);
      new DataView(buffer.buffer).setBigUint64(0, BigInt(SID_ADDRESS), true); length[0] = 44; return 1;
    },
    convertSidToStringSid(address, output) {
      expect(address).toBe(SID_ADDRESS); formats++; output[0] = BigInt(STRING_ADDRESS); return 1;
    },
    readCodeUnit(address, offset) { expect(address).toBe(STRING_ADDRESS); return sid.charCodeAt(offset / 2) || 0; },
    localFree(address) { freed.push(address); }, closeHandle(token) { closed.push(token); },
    lastError: () => 122,
    lookupAccountSid(address, name, nameLength, authority, domainLength) {
      expect(address).toBe(SID_ADDRESS); translations++;
      if (!name) { nameLength[0] = account.length + 1; domainLength[0] = domain.length + 1; return 0; }
      expect(authority).not.toBeNull(); utf16(name, account); utf16(authority!, domain);
      nameLength[0] = account.length; domainLength[0] = domain.length; return 1;
    },
  };
  return { api, freed, closed, formats: () => formats, translations: () => translations };
}

afterEach(() => {
  setNativeWindowsPrincipalLookupsForTests(null);
  setWindowsPrincipalRunnerForTests(null); setAsyncWindowsPrincipalRunnerForTests(null);
  resetWindowsPrincipalForTests();
});

for (const [account, domain] of [["Owner", "LOCALHOST"], ["alice", "CORP"],
  ["person@example.com", "MicrosoftAccount"], ["테스트", "机器"], ["名𐐀", "" ]]) {
  test(`native UTF16 account translation preserves ${domain || "empty domain"}`, () => {
    const f = fixture(account, domain);
    expect(readWindowsNativePrincipal(f.api)).toEqual({ sid: SID, name: domain ? `${domain}\\${account}` : account });
    expect(f.translations()).toBe(2); expect(f.formats()).toBe(1);
    expect(f.freed).toEqual([STRING_ADDRESS]); expect(f.closed).toEqual([TOKEN]);
  });
}

test("name failures refuse before SID allocation and always close the token", () => {
  const breaks: Array<(api: WindowsNativePrincipalApi) => void> = [
    api => { api.lookupAccountSid = () => 1; },
    api => { api.lastError = () => 1332; },
    api => { api.lookupAccountSid = (_sid, _name, length) => { length[0] = 0; return 0; }; },
    api => { api.lookupAccountSid = (_sid, _name, length) => { length[0] = 32_769; return 0; }; },
    api => { api.lookupAccountSid = (_sid, _name, length, _domain, domainLength) => {
      length[0] = 2; domainLength[0] = 32_769; return 0;
    }; },
    api => { const lookup = api.lookupAccountSid; api.lookupAccountSid = (...args) => args[1] ? 0 : lookup(...args); },
    api => { const lookup = api.lookupAccountSid; api.lookupAccountSid = (...args) => {
      const result = lookup(...args); if (args[1]) args[1].fill(65); return result;
    }; },
    api => { const lookup = api.lookupAccountSid; api.lookupAccountSid = (...args) => {
      const result = lookup(...args); if (args[1]) args[1].fill(0); return result;
    }; },
    api => { const lookup = api.lookupAccountSid; api.lookupAccountSid = (...args) => {
      const result = lookup(...args); if (args[1]) args[2][0] = args[1].length + 1; return result;
    }; },
  ];
  for (const change of breaks) {
    const f = fixture(); change(f.api);
    expect(() => readWindowsNativePrincipal(f.api)).toThrow();
    expect(f.formats()).toBe(0); expect(f.freed).toEqual([]); expect(f.closed).toEqual([TOKEN]);
  }
});

test("SID failures after name translation retain the reused reader's resource cleanup", () => {
  for (const sid of ["S-1-", "1".repeat(300)]) {
    const f = fixture("Owner", "EXAMPLE", sid);
    expect(() => readWindowsNativePrincipal(f.api)).toThrow();
    expect(f.freed).toEqual([STRING_ADDRESS]); expect(f.closed).toEqual([TOKEN]);
  }
  const f = fixture(); f.api.getTokenInformation = () => 0;
  expect(() => readWindowsNativePrincipal(f.api)).toThrow();
  expect(f.translations()).toBe(0); expect(f.closed).toEqual([TOKEN]);
});

test("unsupported native execution is explicit; trusted path and DLL errors never downgrade", () => {
  let opened = 0, closed = 0;
  const load = (() => { opened++; return { symbols: {}, close() { closed++; } }; }) as unknown as typeof dlopen;
  const deps = { platform: "win32" as NodeJS.Platform, arch: "arm64", systemDirectory: () => "C:\\OS\\System32", load };
  expect(resolveWindowsNativePrincipal(deps)).toBeNull(); expect(opened).toBe(0);
  expect(() => resolveWindowsNativePrincipal({ ...deps, arch: "x64", systemDirectory: () => { throw new Error("trusted failure"); } }))
    .toThrow("trusted failure");
  expect(opened).toBe(0);
  const failed = ((path: string) => {
    if (path.endsWith("kernel32.dll")) throw new Error("second DLL failed");
    return { symbols: {}, close() { closed++; } };
  }) as unknown as typeof dlopen;
  expect(() => resolveWindowsNativePrincipal({ ...deps, arch: "x64", load: failed })).toThrow("second DLL failed");
  expect(closed).toBe(1);
});

class HeldWorker extends EventTarget {
  sent = 0;
  unref() {}
  postMessage() { this.sent++; }
  reply(data: unknown) { this.dispatchEvent(new MessageEvent("message", { data })); }
  close() { this.dispatchEvent(new Event("close")); }
}
function clock() {
  let now = 0;
  const pending = new Set<{ at: number; callback: () => void }>();
  const timing: NativePrincipalTiming = {
    now: () => now,
    schedule(callback, ms) { const timer = { at: now + ms, callback }; pending.add(timer); return () => { pending.delete(timer); }; },
  };
  return { timing, advance(ms: number) { now += ms; for (const t of [...pending]) if (t.at <= now) t.callback(); },
    elapseWithoutTimers(ms: number) { now += ms; } };
}

test("expired A and live B share one Worker through native completion and closure", async () => {
  const worker = new HeldWorker(), c = clock(); let created = 0;
  const lookup = createWindowsNativePrincipalLookup(() => { created++; return worker as unknown as Worker; });
  const a = lookup(10, c.timing).catch(error => error), b = lookup(100, c.timing);
  let progressed = false; await Promise.resolve().then(() => { progressed = true; });
  expect(progressed).toBe(true); expect(worker.sent).toBe(1);
  c.advance(10); expect(await a).toBeInstanceOf(Error);
  const later = lookup(100, c.timing); expect(created).toBe(1);
  worker.reply({ kind: "identity", ...IDENTITY }); worker.close();
  expect(await b).toEqual(IDENTITY); expect(await later).toEqual(IDENTITY);
});

test("timer delivery lag does not admit an expired native result", async () => {
  const worker = new HeldWorker(), c = clock();
  const lookup = createWindowsNativePrincipalLookup(() => worker as unknown as Worker);
  const result = lookup(10, c.timing).catch(error => error);
  c.elapseWithoutTimers(11); worker.reply({ kind: "identity", ...IDENTITY }); worker.close();
  expect(await result).toBeInstanceOf(Error);
});

test("worker constructor, malformed messages, errors and early closure refuse", async () => {
  await expect(createWindowsNativePrincipalLookup(() => { throw new Error("constructor failed"); })(100))
    .rejects.toThrow("constructor failed");
  for (const message of [undefined, { kind: "failure" }, { kind: "identity", sid: SID }, { kind: "other" }]) {
    const worker = new HeldWorker(); const lookup = createWindowsNativePrincipalLookup(() => worker as unknown as Worker);
    const result = lookup(100).catch(error => error);
    if (message !== undefined) worker.reply(message); worker.close();
    expect(await result).toBeInstanceOf(Error);
  }
  const worker = new HeldWorker(), lookup = createWindowsNativePrincipalLookup(() => worker as unknown as Worker);
  const result = lookup(100).catch(error => error); worker.dispatchEvent(new Event("error")); worker.close();
  expect(await result).toBeInstanceOf(Error);
});

test.if(process.platform === "win32" && process.arch === "x64")("expired default caller never caches a late native result", async () => {
  const worker = new HeldWorker(), c = clock();
  const lookup = createWindowsNativePrincipalLookup(() => worker as unknown as Worker);
  setNativeWindowsPrincipalLookupsForTests({ sync: () => IDENTITY, async: ms => lookup(ms, c.timing) });
  const expired = resolveCurrentWindowsPrincipalAsync(10).catch(error => error);
  c.advance(10); expect((await expired).code).toBe("EACLIDENTITY");
  expect(cachedCurrentWindowsIdentity()).toBeNull();
  worker.reply({ kind: "identity", ...IDENTITY }); worker.close(); await Promise.resolve();
  expect(cachedCurrentWindowsIdentity()).toBeNull();
});

test("injected principal runners beat native lookup and native failures are uncached without PowerShell", () => {
  let calls = 0;
  setNativeWindowsPrincipalLookupsForTests({ sync: () => { calls++; throw new Error("native failed"); }, async: async () => null });
  setWindowsPrincipalRunnerForTests(() => ({ success: true, exitCode: 0, timedOut: false, stdout: `${SID}\nINJECTED\\user` }));
  expect(resolveCurrentWindowsPrincipal(100)).toBe(`*${SID}`); expect(calls).toBe(0);
  setWindowsPrincipalRunnerForTests(null);
  const spawn = spyOn(Bun, "spawnSync").mockImplementation(() => { throw new Error("fallback must not start"); });
  try {
    for (let i = 0; i < 2; i++) {
      let error: unknown; try { resolveCurrentWindowsPrincipal(100); } catch (e) { error = e; }
      expect((error as NodeJS.ErrnoException).code).toBe("EACLIDENTITY");
      expect(cachedCurrentWindowsIdentity()).toBeNull();
    }
    expect(calls).toBe(2); expect(spawn).not.toHaveBeenCalled();
  } finally { spawn.mockRestore(); }
});

test("explicit native unavailability retains the trusted helper", () => {
  setNativeWindowsPrincipalLookupsForTests({ sync: () => null, async: async () => null });
  // Override only the OS process boundary, leaving the existing executable resolver intact on Windows.
  if (process.platform !== "win32") return;
  const spawn = spyOn(Bun, "spawnSync").mockReturnValue({
    success: true, exitCode: 0, stdout: Buffer.from(`${SID}\nHELPER\\user`), exitedDueToTimeout: false,
  } as ReturnType<typeof Bun.spawnSync>);
  try {
    expect(resolveCurrentWindowsPrincipal(1000)).toBe(`*${SID}`);
    expect(cachedCurrentWindowsIdentity()?.name).toBe("HELPER\\user"); expect(spawn).toHaveBeenCalledTimes(1);
  } finally { spawn.mockRestore(); }
});

test("a synchronous native overrun refuses before cache admission", () => {
  setNativeWindowsPrincipalLookupsForTests({ sync: () => IDENTITY, async: async () => IDENTITY });
  let reads = 0;
  const now = spyOn(performance, "now").mockImplementation(() => reads++ === 0 ? 0 : 101);
  try {
    let error: unknown; try { resolveCurrentWindowsPrincipal(100); } catch (e) { error = e; }
    expect((error as NodeJS.ErrnoException).code).toBe("EACLIDENTITY");
    expect(cachedCurrentWindowsIdentity()).toBeNull();
  } finally { now.mockRestore(); }
});

test.if(process.platform === "win32" && process.arch === "x64")("async native unavailable fallback and injected runner retain precedence", async () => {
  let nativeCalls = 0;
  setNativeWindowsPrincipalLookupsForTests({ sync: () => null, async: async () => { nativeCalls++; return null; } });
  setAsyncWindowsPrincipalRunnerForTests(async () => ({ success: true, exitCode: 0, timedOut: false, stdout: `${SID}\nINJECTED\\async` }));
  expect(await resolveCurrentWindowsPrincipalAsync(1000)).toBe(`*${SID}`); expect(nativeCalls).toBe(0);
  setAsyncWindowsPrincipalRunnerForTests(null);
  const spawn = spyOn(Bun, "spawn");
  try {
    expect(await resolveCurrentWindowsPrincipalAsync(5000)).toMatch(/^\*S-1-/);
    expect(nativeCalls).toBe(1); expect(spawn).toHaveBeenCalledTimes(1);
  } finally { spawn.mockRestore(); }
});

test.if(process.platform === "win32" && process.arch === "x64")("native caller expiry stays out of the ACL timeout memo and never starts icacls", async () => {
  const root = mkdtempSync(join(tmpdir(), "ocx-native-identity-")), target = join(root, "secret");
  writeFileSync(target, "fixture");
  const worker = new HeldWorker(), c = clock(); let entered!: () => void, icacls = 0;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const lookup = createWindowsNativePrincipalLookup(() => { entered(); return worker as unknown as Worker; });
  setNativeWindowsPrincipalLookupsForTests({ sync: () => IDENTITY, async: ms => lookup(ms, c.timing) });
  setAsyncIcaclsRunnerForTests(async () => { icacls++; return { success: true, exitCode: 0, timedOut: false, stdout: "" }; });
  resetHardenedStateForTests();
  const work = hardenSecretPathAsync(target, { required: true, deadlineMs: 1000 }).catch(error => error);
  try {
    await started; c.advance(1001);
    expect((await work).code).toBe("EACLIDENTITY"); expect(icacls).toBe(0);
    expect(cachedCurrentWindowsIdentity()).toBeNull(); expect(timedOutSecretPathCountForTests()).toBe(0);
    worker.reply({ kind: "identity", ...IDENTITY }); worker.close(); await Promise.resolve();
    expect(cachedCurrentWindowsIdentity()).toBeNull();
  } finally {
    worker.close(); await work; await flushWindowsSecretAclReapsBeforeRemoval(root);
    setAsyncIcaclsRunnerForTests(null); resetHardenedStateForTests(); rmSync(root, { recursive: true, force: true });
  }
});

test.if(process.platform === "win32" && process.arch === "x64")("native SID/name match independent Unicode PowerShell and DLLs close", () => {
  const control = Bun.spawnSync([resolveTrustedWindowsPowerShellExe(), "-NoProfile", "-NonInteractive", "-Command",
    "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$i=[Security.Principal.WindowsIdentity]::GetCurrent();$i.User.Value;$i.Name"],
  { stdin: "ignore", stdout: "pipe", stderr: "ignore", windowsHide: true, timeout: 30_000 });
  expect(control.success).toBe(true);
  const [sid, name] = new TextDecoder().decode(control.stdout).trim().split(/\r?\n/);
  const closed: string[] = [];
  const load = ((...args: Parameters<typeof dlopen>) => {
    const library = dlopen(...args), close = library.close;
    return { ...library, symbols: library.symbols, close() { closed.push(String(args[0])); close(); } };
  }) as typeof dlopen;
  const directory = resolveTrustedWindowsSystemDirectory();
  const identity = resolveWindowsNativePrincipal({ platform: "win32", arch: "x64", systemDirectory: () => directory, load });
  // Equality booleans keep real account identifiers out of a failing assertion's diff.
  expect(identity?.sid === sid).toBe(true); expect(identity?.name === name).toBe(true);
  expect(closed).toEqual([win32.join(directory, "kernel32.dll"), win32.join(directory, "advapi32.dll")]);
});
