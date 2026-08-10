import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join, parse } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

import {
  resolveCodexCoordinatorDatabasePath,
  resolveCodexCatalogSerializationDatabasePath,
  resolveCodexHistorySerializationDatabasePath,
  resolveEffectiveUserIdentity,
  probeCodexCoordinatorNamespace,
  samePathIdentity,
} from "../src/codex/user-identity";

let codexHome = "";
let previousHome: string | undefined;

const CHILD_TIMEOUT_MS = 10_000;
const userIdentityModuleUrl = pathToFileURL(
  join(import.meta.dir, "..", "src", "codex", "user-identity.ts"),
).href;
const identityProbe = `
  import {
    resolveCodexCoordinatorDatabasePath,
    resolveEffectiveUserIdentity,
  } from ${JSON.stringify(userIdentityModuleUrl)};
  import { realpathSync } from "node:fs";

  const canonicalCodexHome = realpathSync.native(process.env.OCX_TEST_CANONICAL_CODEX_HOME);
  const identity = resolveEffectiveUserIdentity();
  const databasePath = resolveCodexCoordinatorDatabasePath(identity, canonicalCodexHome);
  process.stdout.write(JSON.stringify({ identity, databasePath }));
`;

interface IdentityProbeResult {
  identity: ReturnType<typeof resolveEffectiveUserIdentity>;
  databasePath: string;
}

async function runIdentityProbe(
  env: Record<string, string>,
  cwd: string,
): Promise<IdentityProbeResult> {
  const child = Bun.spawn([process.execPath, "--eval", identityProbe], {
    cwd,
    env: { ...process.env, ...env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill(), CHILD_TIMEOUT_MS);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exitCode, stderr).toBe(0);
    expect(stdout.trim().split("\n"), stderr).toHaveLength(1);
    return JSON.parse(stdout) as IdentityProbeResult;
  } finally {
    clearTimeout(timeout);
  }
}

beforeEach(() => {
  previousHome = process.env.HOME;
  codexHome = mkdtempSync(join(tmpdir(), "ocx-user-identity-codex-home-"));
});

test("samePathIdentity is case-insensitive on Windows and exact elsewhere", () => {
  const winPath = "C:\\Users\\Alice\\AppData\\Local\\OpenCodex\\Runtime\\v1\\S-1-5-21\\history-write-locks\\abc.sqlite";
  expect(samePathIdentity(winPath, winPath.toLowerCase(), "win32")).toBe(true);
  expect(samePathIdentity(winPath, winPath.toLowerCase(), "linux")).toBe(false);
  expect(samePathIdentity(winPath, "D:\\Users\\Alice\\AppData\\Local\\OpenCodex\\Runtime\\v1\\S-1-5-21\\history-write-locks\\abc.sqlite", "win32")).toBe(false);
  expect(samePathIdentity("/tmp/a/b.sqlite", "/tmp/a/b.sqlite", "linux")).toBe(true);
  expect(samePathIdentity("/tmp/a/b.sqlite", "/tmp/A/b.sqlite", "linux")).toBe(false);
});

test("the coordinator namespace probe is read-only", () => {
  if (process.platform === "win32") return;
  // No real user has this uid, so the namespace cannot exist before or after.
  const uid = 2_147_483_647;
  const probe = probeCodexCoordinatorNamespace({ platform: "posix", uid });
  expect(probe.status).toBe("missing");
  const root = join(realpathSync.native("/tmp"), `opencodex-runtime-v1-${uid}`);
  expect(existsSync(root)).toBe(false);
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  rmSync(codexHome, { recursive: true, force: true });
});

test("the effective identity is uid/SID and does not follow HOME", () => {
  const before = resolveEffectiveUserIdentity();
  process.env.HOME = join(tmpdir(), "fake-home-that-must-not-key-coordination");
  const after = resolveEffectiveUserIdentity();

  expect(after).toEqual(before);
  if (process.platform === "win32") {
    expect(after.platform).toBe("win32");
    expect("sid" in after && after.sid).toMatch(/^S-1-/);
  } else {
    expect(after).toEqual({ platform: "posix", uid: process.getuid!() });
  }
  expect(JSON.stringify(after)).not.toContain(process.env.HOME);
});

test("the coordinator resolver returns the final database path", () => {
  const canonicalHome = realpathSync.native(codexHome);
  const finalPath = resolveCodexCoordinatorDatabasePath(
    resolveEffectiveUserIdentity(),
    canonicalHome,
  );

  expect(parse(finalPath).ext).toBe(".sqlite");
  expect(parse(finalPath).base).toMatch(/^[a-f0-9]{64}\.sqlite$/);
  expect(parse(parse(finalPath).dir).base).toBe("native-write-locks");
  expect(finalPath).toBe(resolveCodexCoordinatorDatabasePath(
    resolveEffectiveUserIdentity(),
    canonicalHome,
  ));
});

test("real processes resolve one identity and coordinator path across every home/runtime environment", async () => {
  const canonicalHome = realpathSync.native(codexHome);
  const environmentRoots = ["a", "b"].map(label => {
    const root = mkdtempSync(join(tmpdir(), `ocx-user-identity-env-${label}-`));
    const paths = {
      home: join(root, "home"),
      userProfile: join(root, "profile"),
      homeDrive: join(root, "drive"),
      homePath: join(root, "path"),
      xdgRuntime: join(root, "runtime"),
      temp: join(root, "temp"),
      codexHome: join(root, "ambient-codex"),
      opencodexHome: join(root, "ambient-opencodex"),
      workingDirectory: join(root, "working-directory"),
    };
    for (const path of Object.values(paths)) mkdirSync(path, { recursive: true });
    return { root, paths };
  });

  try {
    const probes = await Promise.all(environmentRoots.map(({ paths }, index) => {
      const accountEnvironment = process.platform === "win32"
        ? {
            USERNAME: `fake-username-${index}`,
            USERDOMAIN: `fake-domain-${index}`,
            USERDOMAIN_ROAMINGPROFILE: `fake-roaming-domain-${index}`,
            USERDNSDOMAIN: `fake-dns-domain-${index}`,
          }
        : {
            UID: String(900_000 + index),
            EUID: String(910_000 + index),
            USER: `fake-user-${index}`,
            LOGNAME: `fake-logname-${index}`,
          };
      return runIdentityProbe({
        HOME: paths.home,
        USERPROFILE: paths.userProfile,
        HOMEDRIVE: paths.homeDrive,
        HOMEPATH: paths.homePath,
        XDG_RUNTIME_DIR: paths.xdgRuntime,
        TMPDIR: paths.temp,
        TEMP: paths.temp,
        TMP: paths.temp,
        LOCALAPPDATA: paths.temp,
        CODEX_HOME: paths.codexHome,
        OPENCODEX_HOME: paths.opencodexHome,
        OCX_TEST_CANONICAL_CODEX_HOME: canonicalHome,
        ...accountEnvironment,
      }, paths.workingDirectory);
    }));

    const osIdentity = resolveEffectiveUserIdentity();
    const osDatabasePath = resolveCodexCoordinatorDatabasePath(osIdentity, canonicalHome);
    for (const probe of probes) {
      expect(probe.identity).toEqual(osIdentity);
      expect(probe.databasePath).toBe(osDatabasePath);
    }
    expect(probes[1]?.identity).toEqual(probes[0]?.identity);
    expect(probes[1]?.databasePath).toBe(probes[0]?.databasePath);
  } finally {
    for (const { root } of environmentRoots) rmSync(root, { recursive: true, force: true });
  }
}, { timeout: 20_000 });

/**
 * H is keyed by the canonical state database as well as the canonical home.
 *
 * N and K key on the home alone, which fully determines the routing and catalog
 * bytes they guard. History does not work that way: one `CODEX_HOME` can name a
 * different `state_5.sqlite`, and two operations against different history
 * databases are not the same exclusion. Hashing only the home would serialize
 * them together; hashing a raw request path would let two spellings of one
 * database take different locks.
 */
test("H is keyed by state database identity and is never N's or K's path", () => {
  const identity = resolveEffectiveUserIdentity();
  const canonicalHome = realpathSync.native(codexHome);
  const stateDbA = join(canonicalHome, "state_5.sqlite");
  const stateDbB = join(canonicalHome, "other", "state_5.sqlite");

  const nativePath = resolveCodexCoordinatorDatabasePath(identity, canonicalHome);
  const catalogPath = resolveCodexCatalogSerializationDatabasePath(identity, canonicalHome);
  const historyA = resolveCodexHistorySerializationDatabasePath(identity, canonicalHome, stateDbA);
  const historyB = resolveCodexHistorySerializationDatabasePath(identity, canonicalHome, stateDbB);

  // Three distinct exclusions, never sharing a database.
  expect(new Set([nativePath, catalogPath, historyA]).size).toBe(3);

  // A second state database under the SAME home is a different H, while N and K
  // are unchanged — the property that keying H on the home alone would destroy.
  expect(historyB).not.toBe(historyA);
  expect(resolveCodexCoordinatorDatabasePath(identity, canonicalHome)).toBe(nativePath);
  expect(resolveCodexCatalogSerializationDatabasePath(identity, canonicalHome)).toBe(catalogPath);

  // Stable across calls, and living in its own directory rather than N's or K's.
  expect(resolveCodexHistorySerializationDatabasePath(identity, canonicalHome, stateDbA))
    .toBe(historyA);
  expect(parse(historyA).dir).not.toBe(parse(nativePath).dir);
  expect(parse(historyA).dir).not.toBe(parse(catalogPath).dir);

  // A relative state database is refused rather than silently keyed on its text.
  expect(() => resolveCodexHistorySerializationDatabasePath(identity, canonicalHome, "state_5.sqlite"))
    .toThrow();
});
