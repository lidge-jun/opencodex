import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config";
import { hardenExistingSecret } from "../../src/config/load-degrade";
import { flushConfigDirHardeningForTests, hardenConfigDir } from "../../src/config/paths";
import * as acl from "../../src/lib/windows-secret-acl";
import * as principal from "../../src/lib/windows-user-principal";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const originalPlatform = process.platform;
let home: string;
let previousHome: string | undefined;
let previousVerify: string | undefined;
const calls: string[] = [];

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  previousVerify = process.env.OPENCODEX_ACL_VERIFY_EXISTING;
  home = mkdtempSync(join(tmpdir(), "ocx-config-read-acl-"));
  process.env.OPENCODEX_HOME = home;
  delete process.env.OPENCODEX_ACL_VERIFY_EXISTING;
  writeFileSync(join(home, "config.json"), JSON.stringify({ port: 19481, defaultProvider: "openai", providers: {} }));
  writeFileSync(join(home, "auth.json"), "{}");
  acl.resetHardenedStateForTests();
  acl.setPlatformForTests("win32");
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  const identity = () => ({ success: true, exitCode: 0, timedOut: false,
    stdout: "S-1-5-21-1-2-3-1001\nfixture\\user\n" });
  principal.setWindowsPrincipalRunnerForTests(identity);
  principal.setAsyncWindowsPrincipalRunnerForTests(async () => identity());
  calls.length = 0;
  const run = (args: string[], _timeout?: number): acl.IcaclsResult => {
    calls.push(args[0]);
    return { success: true, exitCode: 0, timedOut: false, stdout: "" };
  };
  acl.setIcaclsRunnerForTests(run);
  acl.setAsyncIcaclsRunnerForTests(async (args, timeout) => run(args, timeout));
});

afterEach(async () => {
  await flushConfigDirHardeningForTests();
  Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  acl.setIcaclsRunnerForTests(null);
  acl.setAsyncIcaclsRunnerForTests(null);
  acl.setPlatformForTests(null);
  principal.setWindowsPrincipalRunnerForTests(null);
  principal.setAsyncWindowsPrincipalRunnerForTests(null);
  principal.resetWindowsPrincipalForTests();
  acl.setStatForTests(null);
  acl.resetHardenedStateForTests();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (previousVerify === undefined) delete process.env.OPENCODEX_ACL_VERIFY_EXISTING;
  else process.env.OPENCODEX_ACL_VERIFY_EXISTING = previousVerify;
  removeTreeWithRetry(home);
});

test("repeated Windows config reads preserve successful ACL observations", async () => {
  expect(loadConfig().port).toBe(19481);
  await flushConfigDirHardeningForTests();
  const first = [...calls];
  for (const path of [home, join(home, "config.json"), join(home, "auth.json")]) {
    expect(first.filter(value => value === path).length).toBeGreaterThan(0);
  }
  const before = readFileSync(join(home, "config.json"), "utf8");
  expect(loadConfig().port).toBe(19481);
  await flushConfigDirHardeningForTests();
  expect(calls).toEqual(first);
  expect(readFileSync(join(home, "config.json"), "utf8")).toBe(before);
});

for (const platform of ["win32", "darwin"]) {
  test(`optional directory hardening leaves a regular file unchanged on ${platform}`, async () => {
    Object.defineProperty(process, "platform", { value: platform, configurable: true });
    acl.setPlatformForTests(platform);
    const path = join(home, "not-a-config-directory");
    writeFileSync(path, "fixture-unsafe-root");
    const mode = statSync(path).mode;
    process.env.OPENCODEX_HOME = path;

    hardenConfigDir();
    await flushConfigDirHardeningForTests();

    expect(calls).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe("fixture-unsafe-root");
    expect(statSync(path).mode).toBe(mode);
  });
}

test("optional directory hardening still follows a directory symlink or junction", async () => {
  const target = join(home, "directory-target");
  const link = join(home, "directory-link");
  mkdirSync(target);
  symlinkSync(target, link, originalPlatform === "win32" ? "junction" : "dir");
  process.env.OPENCODEX_HOME = link;

  hardenConfigDir();
  await flushConfigDirHardeningForTests();

  expect(calls.length).toBeGreaterThan(0);
  expect(statSync(link).isDirectory()).toBe(true);
});

test("an external metadata change still invalidates a Windows file ACL observation", () => {
  const path = join(home, "auth.json");
  let freshness = 1n;
  acl.setStatForTests(() => ({ dev: 1n, ino: 1n, ctimeNs: freshness }));
  hardenExistingSecret(path);
  const first = calls.length;
  // Exercise the production freshness check instead of weakening its cache identity.
  freshness += 1n;
  hardenExistingSecret(path);
  expect(calls.length).toBeGreaterThan(first);
});

test("POSIX config reads still apply private directory and file permissions", () => {
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
  acl.setPlatformForTests("darwin");
  chmodSync(home, 0o755);
  const path = join(home, "auth.json");
  chmodSync(path, 0o644);
  hardenConfigDir();
  hardenExistingSecret(path);
  // Windows does not implement these mode bits; that is the branch being simulated above.
  if (originalPlatform !== "win32") {
    expect(statSync(home).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  }
  expect(calls).toEqual([]);
});
