import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as nodeFs from "node:fs";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hardenReusedServiceApiToken,
  readServiceApiTokenState,
  readTokenBackupState,
  removeOrphanTokenBackup,
  replaceServiceApiTokenFile,
  restoreTokenBackup,
  serviceApiTokenBackupPath,
  removeServiceApiTokenFileIfOwned,
  serviceApiTokenFilePath,
  serviceApiTokenFingerprint,
  startupDataPlaneToken,
  writeServiceApiTokenFile,
  writeTokenBackup,
} from "../../src/lib/service-secrets";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let home = "";
const previousHome = process.env.OPENCODEX_HOME;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-service-secret-"));
  process.env.OPENCODEX_HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (home) removeTreeWithRetry(home);
});

/**
 * #4236. A service boot always saw OPENCODEX_API_AUTH_TOKEN, because the launchd plist and the
 * systemd unit cat the token file into the environment before exec. A foreground `ocx start` saw
 * neither, so `assertServerAuthConfig` refused to bind a non-loopback hostname that the installed
 * service on the same machine was serving happily. These pin the precedence that closes that.
 */
describe("startup data-plane token resolution", () => {
  const TOKEN = "a".repeat(64);

  test("the environment wins, and nothing is re-exported when it already holds a token", () => {
    writeServiceApiTokenFile(TOKEN);
    expect(startupDataPlaneToken({ OPENCODEX_API_AUTH_TOKEN: "already" }, { authRequired: true })).toBeNull();
  });

  test("OCX_API_TOKEN_FILE still wins over the installed path (WinSW native mode)", () => {
    writeServiceApiTokenFile(TOKEN);
    const named = join(home, "named-token");
    writeFileSync(named, "from-the-named-file\n", "utf8");
    expect(startupDataPlaneToken({ OCX_API_TOKEN_FILE: named }, { authRequired: true })).toBe("from-the-named-file");
  });

  test("the installed token is used when admission is required, and ignored when it is not", () => {
    writeServiceApiTokenFile(TOKEN);
    expect(startupDataPlaneToken({}, { authRequired: true })).toBe(TOKEN);
    // A loopback bind needs no credential, and on a machine connected to a hub this same file
    // holds that hub's issued CLIENT key -- which is not this proxy's admission secret.
    expect(startupDataPlaneToken({}, { authRequired: false })).toBeNull();
  });

  test("an absent or unusable token file resolves to null rather than throwing at boot", () => {
    expect(startupDataPlaneToken({}, { authRequired: true })).toBeNull();
    writeFileSync(serviceApiTokenFilePath(), "\n", "utf8");
    expect(startupDataPlaneToken({}, { authRequired: true })).toBeNull();
  });
});

describe("service API token ownership", () => {
  test("hardens the validated token descriptor rather than a replacement pathname", () => {
    if (process.platform === "win32") return;
    const path = serviceApiTokenFilePath();
    const openedToken = join(home, "opened-token");
    const victim = join(home, "victim");
    writeFileSync(path, "ocx_data_original\n", { mode: 0o644 });
    writeFileSync(victim, "executable\n", { mode: 0o755 });
    chmodSync(path, 0o644);
    chmodSync(victim, 0o755);

    const state = hardenReusedServiceApiToken(token => {
      expect(token).toBe("ocx_data_original");
      renameSync(path, openedToken);
      symlinkSync(victim, path);
    });

    expect(state).toMatchObject({ kind: "present", token: "ocx_data_original" });
    expect(statSync(openedToken).mode & 0o777).toBe(0o600);
    expect(statSync(victim).mode & 0o777).toBe(0o755);
    // Identity at return: the swap during validation is replaced, so the path
    // the caller reports names a hardened file holding the validated token —
    // never the substituted symlink.
    expect(lstatSync(path).isSymbolicLink()).toBe(false);
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8").trim()).toBe("ocx_data_original");
  });

  test("a non-regular token path is unsafe rather than blocking the open", () => {
    if (process.platform === "win32") return;
    const path = serviceApiTokenFilePath();
    execFileSync("mkfifo", [path]);

    const state = hardenReusedServiceApiToken(() => {
      throw new Error("validation must not run for a non-regular token path");
    });

    expect(state.kind).toBe("unsafe");
    if (state.kind === "unsafe") expect(state.reason).toContain("regular file");
  });

  test("writes only the exact owner path through an atomic owner-only replacement", () => {
    const token = "ocx_data_0123456789abcdef0123456789abcdef01234567";
    const persisted = writeServiceApiTokenFile(token);

    expect(persisted.path).toBe(join(home, "service-api-token"));
    expect(persisted.path).toBe(serviceApiTokenFilePath());
    expect(persisted.fingerprint).toBe(serviceApiTokenFingerprint(token));
    expect(lstatSync(persisted.path).isFile()).toBe(true);
    if (process.platform !== "win32") expect(lstatSync(persisted.path).mode & 0o777).toBe(0o600);
    expect(readdirSync(home).filter(name => name.includes(".tmp"))).toEqual([]);
    expect(readServiceApiTokenState()).toEqual({
      kind: "present",
      token,
      fingerprint: persisted.fingerprint,
    });
  });

  test("refuses symlink and pre-existing token targets without exposing token bytes", () => {
    const path = serviceApiTokenFilePath();
    const target = join(home, "foreign-token");
    writeFileSync(target, "foreign-secret\n", { mode: 0o600 });
    let symlinkAvailable = true;
    try {
      symlinkSync(target, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") symlinkAvailable = false;
      else throw error;
    }
    if (symlinkAvailable) {
      const secret = "ocx_data_should_never_appear_in_an_error";
      expect(() => writeServiceApiTokenFile(secret)).toThrow("bounded regular file");
      try { writeServiceApiTokenFile(secret); } catch (error) {
        expect(String(error)).not.toContain(secret);
      }
      rmSync(path);
    }

    writeFileSync(path, "foreign-secret\n", { mode: 0o600 });
    expect(() => writeServiceApiTokenFile("ocx_data_new_secret")).toThrow("pre-existing");
  });

  test("removes only the fingerprint-owned unchanged token", () => {
    const first = writeServiceApiTokenFile("ocx_data_first");
    writeFileSync(first.path, "ocx_data_replacement\n", { mode: 0o600 });
    expect(removeServiceApiTokenFileIfOwned(first.fingerprint)).toBe("changed");
    expect(existsSync(first.path)).toBe(true);

    const replacementFingerprint = serviceApiTokenFingerprint("ocx_data_replacement");
    expect(removeServiceApiTokenFileIfOwned(replacementFingerprint)).toBe("removed");
    expect(existsSync(first.path)).toBe(false);
    expect(removeServiceApiTokenFileIfOwned(replacementFingerprint)).toBe("absent");
  });

  test("writes, restores, and removes the exact owner-only .prev backup", () => {
    const original = writeServiceApiTokenFile("ocx_data_original");
    // Every fsync in this module must run on a writable handle: Windows returns EPERM for
    // fsync on an "r" fd, which is how all three ownership cases failed on windows-latest.
    const openModes: string[] = [];
    const realOpen = nodeFs.openSync;
    const openSpy = spyOn(nodeFs, "openSync").mockImplementation(((path: never, flags?: never, mode?: never) => {
      if (typeof flags === "string") openModes.push(flags);
      return realOpen(path, flags, mode);
    }) as typeof realOpen);
    let backup: ReturnType<typeof writeTokenBackup>;
    try {
      backup = writeTokenBackup(original.fingerprint);
    } finally {
      openSpy.mockRestore();
    }
    expect(openModes.length).toBeGreaterThan(0);
    expect(openModes.filter(mode => mode === "r")).toEqual([]);
    expect(backup.path).toBe(serviceApiTokenBackupPath());
    expect(readTokenBackupState()).toMatchObject({ kind: "present", token: "ocx_data_original" });
    if (process.platform !== "win32") expect(lstatSync(backup.path).mode & 0o777).toBe(0o600);

    replaceServiceApiTokenFile("ocx_data_replacement");
    expect(readServiceApiTokenState()).toMatchObject({ kind: "present", token: "ocx_data_replacement" });
    const restored = restoreTokenBackup(backup.path);
    expect(restored.fingerprint).toBe(original.fingerprint);
    expect(readServiceApiTokenState()).toMatchObject({ kind: "present", token: "ocx_data_original" });
    expect(removeOrphanTokenBackup()).toBe("removed");
    expect(readTokenBackupState()).toEqual({ kind: "absent" });
  });

  test("crash before marker persistence removes an orphan but unsafe .prev is preserved", () => {
    const original = writeServiceApiTokenFile("ocx_data_original");
    writeTokenBackup(original.fingerprint);
    expect(removeOrphanTokenBackup()).toBe("removed");
    expect(readServiceApiTokenState()).toMatchObject({ kind: "present", token: "ocx_data_original" });

    const target = join(home, "foreign-backup");
    writeFileSync(target, "ocx_data_foreign\n", { mode: 0o600 });
    let symlinkAvailable = true;
    try { symlinkSync(target, serviceApiTokenBackupPath()); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") symlinkAvailable = false;
      else throw error;
    }
    if (symlinkAvailable) {
      expect(readTokenBackupState()).toMatchObject({ kind: "unsafe" });
      expect(() => removeOrphanTokenBackup()).toThrow("owner-only bounded regular file");
      expect(existsSync(serviceApiTokenBackupPath())).toBe(true);
    }
  });

  test("refuses a mismatched backup path without exposing either candidate", () => {
    const original = writeServiceApiTokenFile("ocx_data_original");
    writeTokenBackup(original.fingerprint);
    expect(() => restoreTokenBackup(join(home, "not-the-backup"))).toThrow("path mismatch");
    expect(readServiceApiTokenState()).toMatchObject({ kind: "present", token: "ocx_data_original" });
    expect(readTokenBackupState()).toMatchObject({ kind: "present", token: "ocx_data_original" });
  });
});
