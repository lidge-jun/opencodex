import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OcxConfig } from "../../src/types";
import type { GuiSessionState } from "../../src/server/gui-session";
import { GUI_PAIR_BROWSER_ORIGIN_HEADER, GUI_PAIR_CAPABILITY_HEADER } from "../../src/lib/gui-pair-capability";
import { consumeGuiPairIntent, createGuiPairIntent, GUI_PAIR_INTENT_HEADER } from "../../src/lib/gui-pair-intent";
import { deliverGuiPairingGrant, GuiPairingIntentRequiredError } from "../../src/server/gui-pair-delivery";
import { GuiPairingGrantRateLimitError } from "../../src/server/gui-session";
import { resetHardenedStateForTests, setAsyncIcaclsRunnerForTests, setIcaclsRunnerForTests, setPlatformForTests } from "../../src/lib/windows-secret-acl";
import { setWindowsOwnerAclRunnerForTests, windowsOwnerAclDefaultRunnerForTests, windowsPrivateEntriesAclMatches, type WindowsPrivateEntry } from "../../src/lib/windows-owner-acl";
import { resetWindowsPrincipalForTests, setWindowsPrincipalRunnerForTests, setAsyncWindowsPrincipalRunnerForTests, setWindowsPrincipalLocaleForTests } from "../../src/lib/windows-user-principal";
import { resolveTrustedWindowsIcaclsExe } from "../../src/lib/windows-elevation";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoPath } from "../helpers/repo-root";

const ORIGIN = "http://127.0.0.1:10100";
const CAP = "A".repeat(43);
const config = (): OcxConfig => ({ providers: {}, runtimeRole: "standalone", hostname: "127.0.0.1", port: 10100 } as OcxConfig);
const state = (): GuiSessionState => ({ sessions: new Map(), pairingGrants: new Map() });
const request = (proof?: string, origin = ORIGIN, capability = CAP) => new Request(`${ORIGIN}/api/gui/pairing-grants`, {
  method: "POST", headers: {
    [GUI_PAIR_BROWSER_ORIGIN_HEADER]: origin, [GUI_PAIR_CAPABILITY_HEADER]: capability,
    ...(proof ? { [GUI_PAIR_INTENT_HEADER]: proof } : {}),
  },
});
let root: string;
let previous: string | undefined;
const recordPath = () => join(root, "gui-pair-intents", readdirSync(join(root, "gui-pair-intents"))[0]!);
const USER_SID = "S-1-5-21-1-2-3-1001";
const FOREIGN_SID = "S-1-5-21-1-2-3-1002";
const ADMIN_SID = "S-1-5-32-544";
const ACL_ENTRIES: WindowsPrivateEntry[] = [{ path: "directory", directory: true }, { path: "record", directory: false }];
function compliantAcl(entries: readonly WindowsPrivateEntry[] = ACL_ENTRIES): string {
  return [
    `U|${USER_SID}|${USER_SID}|False`,
    ...entries.flatMap((entry, index) => [
      `E|${index}|${USER_SID}|4100|1`,
      `A|${index}|0|${entry.directory ? 3 : 0}|2032127|${USER_SID}|False`,
    ]), "END",
  ].join("\n");
}
// The shape a hardened intent directory has on a GitHub-hosted Windows runner: explicit, protected
// Full Control for SYSTEM, Administrators and the serving account.
function runnerShapeAcl(): string {
  return compliantAcl().replace(`E|0|${USER_SID}|4100|1\nA|0|0|3|2032127|${USER_SID}|False`,
    `E|0|${USER_SID}|37892|3\nA|0|0|3|2032127|S-1-5-18|False\nA|0|0|3|2032127|S-1-5-32-544|False\nA|0|0|3|2032127|${USER_SID}|False`);
}
const aclResult = (stdout = compliantAcl()) => ({ success: true, timedOut: false, stdout });
function changeAclLine(index: number, line: string): string {
  const lines = compliantAcl().split("\n"); lines[index] = line; return lines.join("\n");
}
const ICACLS_OK = { success: true, exitCode: 0, timedOut: false, stdout: "" };

beforeEach(() => {
  previous = process.env.OPENCODEX_HOME;
  root = mkdtempSync(join(tmpdir(), "ocx-pair-intent-"));
  process.env.OPENCODEX_HOME = root;
  setIcaclsRunnerForTests(() => ICACLS_OK);
  setAsyncIcaclsRunnerForTests(async () => ICACLS_OK);
  setWindowsOwnerAclRunnerForTests(entries => aclResult(compliantAcl(entries)));
});
afterEach(() => {
  setWindowsOwnerAclRunnerForTests(null);
  setPlatformForTests(null); resetHardenedStateForTests();
  setWindowsPrincipalRunnerForTests(null); setAsyncWindowsPrincipalRunnerForTests(null);
  setWindowsPrincipalLocaleForTests(null); resetWindowsPrincipalForTests();
  setIcaclsRunnerForTests(null); setAsyncIcaclsRunnerForTests(null);
  if (previous === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previous;
  removeTreeWithRetry(root);
});

describe("one-use local CLI pairing intent", () => {
  test("a headless CLI intent permits one grant without creating a session", () => {
    const intent = createGuiPairIntent(CAP), s = state();
    try {
      const result = deliverGuiPairingGrant(request(intent.proof), config(), s);
      expect(typeof result.grant === "string" && result.grant.startsWith("ocx_pair_")).toBe(true);
      expect(result.browserOrigin).toBe(ORIGIN);
      expect(s.pairingGrants.size).toBe(1); expect(s.sessions.size).toBe(0);
      expect(() => deliverGuiPairingGrant(request(intent.proof), config(), s)).toThrow(GuiPairingIntentRequiredError);
      expect(s.pairingGrants.size).toBe(1);
    } finally { intent.dispose(); }
  });
  test("runtime capability alone never grants standalone pairing", () => {
    const s = state();
    expect(() => deliverGuiPairingGrant(request(), config(), s)).toThrow(GuiPairingIntentRequiredError);
    expect(() => deliverGuiPairingGrant(request("B".repeat(43)), config(), s)).toThrow(GuiPairingIntentRequiredError);
    expect(s.pairingGrants.size).toBe(0);
    expect(existsSync(join(root, "gui-pair-intents"))).toBe(false);
  });
  test("disk readers obtain only a hash, not a usable verifier", () => {
    const intent = createGuiPairIntent(CAP);
    try {
      const disk = readFileSync(recordPath(), "utf8");
      expect(/^[a-f0-9]{64}\n$/.test(disk)).toBe(true);
      expect(disk.includes(intent.proof)).toBe(false);
      expect(consumeGuiPairIntent(CAP, disk.trim())).toBe(false);
      expect(consumeGuiPairIntent(CAP, disk.slice(0, 43))).toBe(false);
      expect(consumeGuiPairIntent(CAP, intent.proof)).toBe(true);
      expect(consumeGuiPairIntent(CAP, intent.proof)).toBe(false);
    } finally { intent.dispose(); }
  });
  test("a guessed proof or different signed capability cannot consume the record", () => {
    const intent = createGuiPairIntent(CAP);
    try {
      expect(consumeGuiPairIntent(CAP, "B".repeat(43))).toBe(false);
      expect(consumeGuiPairIntent("C".repeat(43), intent.proof)).toBe(false);
      expect(consumeGuiPairIntent(CAP, intent.proof)).toBe(true);
    } finally { intent.dispose(); }
  });
  test("a mismatched origin refuses before consuming local intent", () => {
    const intent = createGuiPairIntent(CAP), s = state();
    try {
      expect(() => deliverGuiPairingGrant(request(intent.proof, "http://127.0.0.1:10200"), config(), s)).toThrow();
      expect(s.pairingGrants.size).toBe(0);
      expect(consumeGuiPairIntent(CAP, intent.proof)).toBe(true);
    } finally { intent.dispose(); }
  });
  test("client roles and wildcard binds do not become pairing targets", () => {
    const intent = createGuiPairIntent(CAP);
    try {
      const client = config(); client.runtimeRole = "client";
      const wildcard = config(); wildcard.hostname = "0.0.0.0";
      for (const cfg of [client, wildcard]) expect(() => deliverGuiPairingGrant(request(intent.proof), cfg, state())).toThrow();
      expect(consumeGuiPairIntent(CAP, intent.proof)).toBe(true);
    } finally { intent.dispose(); }
  });
  test("a later command removes records abandoned by interrupted runs", () => {
    const dir = join(root, "gui-pair-intents");
    const abandoned = createGuiPairIntent(CAP), abandonedPath = recordPath();
    utimesSync(abandonedPath, new Date(0), new Date(0));
    const intent = createGuiPairIntent("C".repeat(43));
    try {
      expect(existsSync(abandonedPath)).toBe(false);
      expect(readdirSync(dir)).toHaveLength(1);
      expect(consumeGuiPairIntent("C".repeat(43), intent.proof)).toBe(true);
    } finally { intent.dispose(); abandoned.dispose(); }
  });
  test("sweeping never removes a fresh record an active command still holds", () => {
    const first = createGuiPairIntent(CAP);
    const second = createGuiPairIntent("C".repeat(43));
    try {
      expect(readdirSync(join(root, "gui-pair-intents"))).toHaveLength(2);
      expect(consumeGuiPairIntent(CAP, first.proof)).toBe(true);
      expect(consumeGuiPairIntent("C".repeat(43), second.proof)).toBe(true);
    } finally { first.dispose(); second.dispose(); }
  });
  test("sweeping leaves foreign and unsafe entries alone", () => {
    const dir = join(root, "gui-pair-intents");
    const intent = createGuiPairIntent(CAP);
    try {
      const foreign = join(dir, "not-an-intent");
      writeFileSync(foreign, "x".repeat(65), { mode: 0o600 });
      utimesSync(foreign, new Date(0), new Date(0));
      const staleShape = join(dir, "f".repeat(64));
      writeFileSync(staleShape, "x".repeat(65), { mode: 0o600 });
      utimesSync(staleShape, new Date(0), new Date(0));
      const replacement = join(dir, "e".repeat(64));
      writeFileSync(replacement, "x".repeat(65), { mode: 0o600 });
      utimesSync(replacement, new Date(0), new Date(0));
      linkSync(replacement, join(root, "extra-link"));
      createGuiPairIntent("C".repeat(43)).dispose();
      expect(existsSync(foreign)).toBe(true);
      expect(existsSync(staleShape)).toBe(false);
      expect(existsSync(replacement)).toBe(true); // hard-linked records are never unlinked
      unlinkSync(join(root, "extra-link"));
    } finally { intent.dispose(); }
  });
  test("stale cleanup limits metadata and deletion work before publishing a new intent", () => {
    createGuiPairIntent(CAP).dispose();
    const dir = join(root, "gui-pair-intents");
    // More stale entries than one sweep may inspect; avoid timing-based assertions.
    const abandoned = Array.from({ length: 300 }, (_, index) => join(dir, index.toString(16).padStart(64, "0")));
    for (const path of abandoned) {
      writeFileSync(path, "0".repeat(64) + "\n", { mode: 0o600 });
      utimesSync(path, new Date(0), new Date(0));
    }
    const intent = createGuiPairIntent("C".repeat(43));
    try {
      const remaining = abandoned.filter(path => existsSync(path)).length;
      expect(remaining).toBeGreaterThanOrEqual(300 - 256);
      expect(remaining).toBeLessThan(300);
      expect(consumeGuiPairIntent("C".repeat(43), intent.proof)).toBe(true);
    } finally { intent.dispose(); }
  });
  test("foreign entries count toward the stale cleanup work limit", () => {
    const abandoned = createGuiPairIntent(CAP), path = recordPath();
    utimesSync(path, new Date(0), new Date(0));
    const name = readdirSync(join(root, "gui-pair-intents"))[0]!;
    // Fix enumeration order without depending on a platform's directory ordering.
    const names = [...Array.from({ length: 256 }, (_, index) => `foreign-${index}`), name];
    const scan = spyOn(fs, "readdirSync").mockImplementation((() => names) as typeof fs.readdirSync);
    let intent: ReturnType<typeof createGuiPairIntent> | undefined;
    try {
      intent = createGuiPairIntent("C".repeat(43));
      expect(existsSync(path)).toBe(true);
      expect(consumeGuiPairIntent("C".repeat(43), intent.proof)).toBe(true);
    } finally {
      scan.mockRestore();
      intent?.dispose(); abandoned.dispose();
    }
  });
  test("dispose removes an unused commitment and is idempotent", () => {
    const intent = createGuiPairIntent(CAP), path = recordPath();
    intent.dispose(); intent.dispose();
    expect(existsSync(path)).toBe(false);
    expect(consumeGuiPairIntent(CAP, intent.proof)).toBe(false);
  });
  test("separate processes can consume a commitment only once", async () => {
    if (process.platform === "win32") {
      setIcaclsRunnerForTests(null);
      setAsyncIcaclsRunnerForTests(null);
      setWindowsOwnerAclRunnerForTests(null);
    }
    const intent = createGuiPairIntent(CAP), path = recordPath();
    const code = `import { consumeGuiPairIntent } from ${JSON.stringify(repoPath("src/lib/gui-pair-intent.ts"))};
      await Bun.write(Bun.stdout, "ready\\n");
      await new Response(Bun.stdin.stream()).text();
      process.exit(consumeGuiPairIntent(${JSON.stringify(CAP)}, ${JSON.stringify(intent.proof)}, ${JSON.stringify(root)}) ? 0 : 1);`;
    const startConsumer = () => Bun.spawn([process.execPath, "-e", code], {
      env: process.env, stdin: "pipe", stdout: "pipe", stderr: "pipe", timeout: 15_000,
    });
    const consumers: ReturnType<typeof startConsumer>[] = [];
    try {
      for (let index = 0; index < 8; index++) consumers.push(startConsumer());
      await Promise.all(consumers.map(async child => {
        const reader = child.stdout.getReader();
        try {
          let readiness = "";
          while (!readiness.includes("\n")) {
            const chunk = await reader.read();
            if (chunk.done) break;
            readiness += new TextDecoder().decode(chunk.value);
          }
          expect(readiness).toBe("ready\n");
        } finally { reader.releaseLock(); }
      }));
      for (const child of consumers) child.stdin.end();
      const exits = await Promise.all(consumers.map(child => child.exited));
      expect(exits.filter(exit => exit === 0)).toHaveLength(1);
      expect(exits.filter(exit => exit === 1)).toHaveLength(7);
      expect(existsSync(path)).toBe(false);
      expect(existsSync(`${path}.consuming`)).toBe(false);
    } finally {
      for (const child of consumers) { try { child.stdin.end(); } catch { continue; } }
      await Promise.all(consumers.map(child => child.exited));
      intent.dispose();
    }
  });
  test("proof refusal releases only its own consume lock", () => {
    const intent = createGuiPairIntent(CAP), path = recordPath();
    try {
      expect(consumeGuiPairIntent(CAP, "B".repeat(43))).toBe(false);
      expect(existsSync(`${path}.consuming`)).toBe(false);
      expect(consumeGuiPairIntent(CAP, intent.proof)).toBe(true);
      expect(existsSync(`${path}.consuming`)).toBe(false);
    } finally { intent.dispose(); }
  });
  test.each(["directory", "nonempty-directory", "file"] as const)("preserves an existing %s consume lock", lockKind => {
    const intent = createGuiPairIntent(CAP), path = recordPath(), lock = `${path}.consuming`;
    const record = readFileSync(path, "utf8");
    if (lockKind === "file") writeFileSync(lock, "foreign");
    else { mkdirSync(lock); if (lockKind === "nonempty-directory") writeFileSync(join(lock, "sentinel"), "foreign"); }
    const identity = fs.lstatSync(lock, { bigint: true });
    expect(consumeGuiPairIntent(CAP, intent.proof)).toBe(false);
    intent.dispose();
    expect(readFileSync(path, "utf8")).toBe(record);
    const after = fs.lstatSync(lock, { bigint: true });
    expect([after.dev, after.ino, after.ctimeNs]).toEqual([identity.dev, identity.ino, identity.ctimeNs]);
    if (lockKind === "file") expect(readFileSync(lock, "utf8")).toBe("foreign");
    if (lockKind === "nonempty-directory") expect(readFileSync(join(lock, "sentinel"), "utf8")).toBe("foreign");
  });
  test("grant capacity refusal burns intent and a fresh command can recover", () => {
    const intent = createGuiPairIntent(CAP), s = state(), path = recordPath();
    for (let i = 0; i < 128; i++) s.pairingGrants.set(String(i), {
      browserOrigin: ORIGIN, serverOrigin: ORIGIN, expiresAt: Date.now() + 300_000,
    });
    try {
      expect(() => deliverGuiPairingGrant(request(intent.proof), config(), s)).toThrow(GuiPairingGrantRateLimitError);
      expect(existsSync(path)).toBe(false);
      expect(() => deliverGuiPairingGrant(request(intent.proof), config(), s)).toThrow(GuiPairingIntentRequiredError);
      s.pairingGrants.clear();
      const retry = createGuiPairIntent("C".repeat(43));
      try { expect(deliverGuiPairingGrant(request(retry.proof, ORIGIN, "C".repeat(43)), config(), s)).toHaveProperty("grant"); }
      finally { retry.dispose(); }
    } finally { intent.dispose(); }
  });
  test("required Windows ACL failure leaves no commitment and later publication recovers", () => {
    const dir = join(root, "gui-pair-intents");
    setPlatformForTests("win32"); resetHardenedStateForTests();
    try {
      setIcaclsRunnerForTests(args => args[0] === dir ? ICACLS_OK
        : { success: false, exitCode: 1, timedOut: false, stdout: "" });
      expect(() => createGuiPairIntent(CAP)).toThrow();
      expect(readdirSync(dir)).toHaveLength(0);
      setIcaclsRunnerForTests(() => ICACLS_OK);
      const retry = createGuiPairIntent(CAP);
      try { expect(consumeGuiPairIntent(CAP, retry.proof)).toBe(true); }
      finally { retry.dispose(); }
    } finally { setPlatformForTests(null); resetHardenedStateForTests(); }
  });
  test("publication never overwrites an existing commitment", () => {
    const intent = createGuiPairIntent(CAP), path = recordPath();
    try {
      const original = readFileSync(path, "utf8");
      expect(() => createGuiPairIntent(CAP)).toThrow();
      expect(readFileSync(path, "utf8") === original).toBe(true);
      expect(consumeGuiPairIntent(CAP, intent.proof)).toBe(true);
    } finally { intent.dispose(); }
  });
  test("rejects oversized and corrupted records", () => {
    for (const data of ["x".repeat(4096), "x".repeat(65)]) {
      const intent = createGuiPairIntent(CAP), path = recordPath();
      writeFileSync(path, data);
      expect(consumeGuiPairIntent(CAP, intent.proof)).toBe(false);
      intent.dispose(); // a replacement must be retained, not deleted by stale ownership
      expect(existsSync(path)).toBe(true);
      unlinkSync(path);
    }
  });
  test("rejects linked records without deleting the target", () => {
    const intent = createGuiPairIntent(CAP), path = recordPath(), other = join(root, "hard-link");
    try {
      linkSync(path, other);
      expect(consumeGuiPairIntent(CAP, intent.proof)).toBe(false);
      expect(existsSync(other)).toBe(true);
    } finally { intent.dispose(); }
  });
  test.skipIf(process.platform === "win32")("rejects symlinked records and directories", () => {
    const intent = createGuiPairIntent(CAP), path = recordPath(), target = join(root, "target");
    writeFileSync(target, readFileSync(path)); unlinkSync(path); symlinkSync(target, path);
    expect(consumeGuiPairIntent(CAP, intent.proof)).toBe(false);
    intent.dispose(); expect(existsSync(target)).toBe(true); unlinkSync(path);
    const second = mkdtempSync(join(root, "second-")); symlinkSync(join(root, "gui-pair-intents"), join(second, "gui-pair-intents"));
    expect(() => createGuiPairIntent(CAP, second)).toThrow();
  });
  test.skipIf(process.platform === "win32")("rejects group-writable intent directories", () => {
    mkdirSync(join(root, "gui-pair-intents")); chmodSync(join(root, "gui-pair-intents"), 0o770);
    expect(() => createGuiPairIntent(CAP)).toThrow();
    expect(consumeGuiPairIntent(CAP, "B".repeat(43))).toBe(false);
  });
  test.skipIf(process.platform === "win32")("refuses symlinked configuration homes without touching the real record", () => {
    const intent = createGuiPairIntent(CAP), path = recordPath(), alias = join(root, "alias");
    try {
      symlinkSync(root, alias, "dir");
      expect(() => createGuiPairIntent("C".repeat(43), alias)).toThrow();
      expect(consumeGuiPairIntent(CAP, intent.proof, alias)).toBe(false);
      expect(existsSync(path)).toBe(true);
      expect(consumeGuiPairIntent(CAP, intent.proof, root)).toBe(true);
    } finally { intent.dispose(); }
  });
  test.skipIf(process.platform === "win32")("refuses writable-by-group records and homes, then recovers after protection is restored", () => {
    const intent = createGuiPairIntent(CAP), path = recordPath();
    try {
      chmodSync(path, 0o660);
      expect(consumeGuiPairIntent(CAP, intent.proof)).toBe(false);
      intent.dispose(); expect(existsSync(path)).toBe(true);
      chmodSync(path, 0o600); chmodSync(root, 0o770);
      expect(consumeGuiPairIntent(CAP, intent.proof)).toBe(false);
      expect(() => createGuiPairIntent("C".repeat(43))).toThrow();
      chmodSync(root, 0o700);
      expect(consumeGuiPairIntent(CAP, intent.proof)).toBe(true);
    } finally { chmodSync(root, 0o700); intent.dispose(); }
  });
  test("invalid capability values never select a filesystem path", () => {
    for (const value of ["", "../outside", "x".repeat(1024)]) {
      expect(() => createGuiPairIntent(value)).toThrow();
      expect(consumeGuiPairIntent(value, "B".repeat(43))).toBe(false);
    }
  });
  test("hub invitations retain their existing policy and response", () => {
    const cfg = config(); cfg.runtimeRole = "hub";
    cfg.hub = { managementPublicOrigin: "https://hub.example" } as OcxConfig["hub"];
    const result = deliverGuiPairingGrant(request(undefined, "https://hub.example"), cfg, state());
    expect(result).toHaveProperty("grant");
    expect(existsSync(join(root, "gui-pair-intents"))).toBe(false);
  });
});

describe("Windows redemption owner and effective-DACL policy", () => {
  beforeEach(() => { setPlatformForTests("win32"); resetHardenedStateForTests(); });

  const refusals: [string, string][] = [
    ["extra directory ACE", compliantAcl().replace("4100|1", "4100|2").replace("E|1|", `A|0|0|3|2032127|${FOREIGN_SID}|False\nE|1|`)],
    ["extra record ACE", compliantAcl().replace(`E|1|${USER_SID}|4100|1`, `E|1|${USER_SID}|4100|2`).replace("\nEND", `\nA|1|0|0|2032127|${FOREIGN_SID}|False\nEND`)],
    ["foreign directory owner", changeAclLine(1, `E|0|${FOREIGN_SID}|4100|1`)],
    ["foreign record owner", changeAclLine(3, `E|1|${FOREIGN_SID}|4100|1`)],
    ["unprotected DACL", changeAclLine(1, `E|0|${USER_SID}|4|1`)],
    ["absent DACL", changeAclLine(1, `E|0|${USER_SID}|4096|1`)],
    ["null DACL", changeAclLine(1, `E|0|${USER_SID}|4100|-1`)],
    ["empty DACL", changeAclLine(1, `E|0|${USER_SID}|4100|0`)],
    ["inherited ACE", changeAclLine(2, `A|0|0|19|2032127|${USER_SID}|False`)],
    ["wrong mask", changeAclLine(2, `A|0|0|3|1179785|${USER_SID}|False`)],
    ["foreign grantee", changeAclLine(2, `A|0|0|3|2032127|${FOREIGN_SID}|False`)],
    ["Administrators grantee", changeAclLine(2, `A|0|0|3|2032127|${ADMIN_SID}|False`)],
    ["deny ACE", changeAclLine(2, `A|0|1|3|2032127|${USER_SID}|False`)],
    // AccessAllowedCallback is raw AceType 9, not an ordinary Allow ACE.
    ["callback ACE", changeAclLine(2, `A|0|9|3|2032127|${USER_SID}|True`)],
    ["callback marker on Allow", changeAclLine(2, `A|0|0|3|2032127|${USER_SID}|True`)],
    ["object ACE", changeAclLine(2, "A|0|5|X")],
    ["unknown ACE", changeAclLine(2, "A|0|255|X")],
    ["file inheritance", changeAclLine(4, `A|1|0|3|2032127|${USER_SID}|False`)],
    ["missing directory inheritance", changeAclLine(2, `A|0|0|0|2032127|${USER_SID}|False`)],
    ["inherit-only flag", changeAclLine(2, `A|0|0|11|2032127|${USER_SID}|False`)],
    ["malformed flags", changeAclLine(1, `E|0|${USER_SID}|4100junk|1`)],
    ["malformed mask", changeAclLine(2, `A|0|0|3|2032127junk|${USER_SID}|False`)],
    ["noncanonical flag number", changeAclLine(1, `E|0|${USER_SID}|04100|1`)],
    ["out-of-range flags", changeAclLine(1, `E|0|${USER_SID}|69636|1`)],
    ["extra field", changeAclLine(2, `A|0|0|3|2032127|${USER_SID}|False|extra`)],
    ["invalid token role", changeAclLine(0, `U|${USER_SID}|${USER_SID}|true`)],
    ["invalid token owner", changeAclLine(0, `U|${USER_SID}|name|False`)],
    ["malformed SID", changeAclLine(1, "E|0|account-name|4100|1")],
    ["duplicate token header", compliantAcl().replace("E|0|", `U|${USER_SID}|${USER_SID}|False\nE|0|`)],
    ["missing token header", compliantAcl().split("\n").slice(1).join("\n")],
    ["duplicate entry", changeAclLine(3, `E|0|${USER_SID}|4100|1`)],
    ["out-of-order entry", changeAclLine(1, `E|1|${USER_SID}|4100|1`)],
    ["out-of-range ACE index", changeAclLine(2, `A|2|0|3|2032127|${USER_SID}|False`)],
    ["ACE before entry", compliantAcl().split("\n").map((line, index, lines) => index === 1 ? lines[2]! : index === 2 ? lines[1]! : line).join("\n")],
    ["missing entry", compliantAcl().split("\n").filter((_, index) => index !== 3).join("\n")],
    ["extra entry", compliantAcl().replace("END", `E|2|${USER_SID}|4100|1\nEND`)],
    ["missing END", compliantAcl().replace("\nEND", "")],
    ["trailing line", `${compliantAcl()}\nE|0|${USER_SID}|4100|1`],
    ["two trailing newlines", `${compliantAcl()}\n\n`],
    ["unknown output", changeAclLine(2, "garbled")],
    ["BOM", `\ufeff${compliantAcl()}`],
    ["SYSTEM entry with inheritance flag", runnerShapeAcl().replace("A|0|0|3|2032127|S-1-5-18|", "A|0|0|19|2032127|S-1-5-18|")],
    ["duplicate SYSTEM entry", runnerShapeAcl().replace("A|0|0|3|2032127|S-1-5-32-544|False", "A|0|0|3|2032127|S-1-5-18|False")],
    ["four directory entries", runnerShapeAcl().replace("|3\nA|0|0|3|2032127|S-1-5-18|False", `|4\nA|0|0|3|2032127|S-1-5-18|False\nA|0|0|3|1179817|${FOREIGN_SID}|False`)],
    ["foreign entry beside SYSTEM", runnerShapeAcl().replace("A|0|0|3|2032127|S-1-5-32-544|", `A|0|0|3|1179817|${FOREIGN_SID}|`)],
    ["SYSTEM deny entry", runnerShapeAcl().replace("A|0|0|3|2032127|S-1-5-18|", "A|0|1|3|2032127|S-1-5-18|")],
    // AccessAllowedCallback is AceType 9; a privileged grantee does not make it acceptable.
    ["SYSTEM callback entry", runnerShapeAcl().replace("A|0|0|3|2032127|S-1-5-18|False", "A|0|9|3|2032127|S-1-5-18|True")],
    ["privileged entries without the user", runnerShapeAcl().replace(`|3\nA|0|0|3|2032127|S-1-5-18|False\nA|0|0|3|2032127|S-1-5-32-544|False\nA|0|0|3|2032127|${USER_SID}|False`, "|2\nA|0|0|3|2032127|S-1-5-18|False\nA|0|0|3|2032127|S-1-5-32-544|False")],
    ["user entry below Full Control beside SYSTEM", runnerShapeAcl().replace(`A|0|0|3|2032127|${USER_SID}|`, `A|0|0|3|1179817|${USER_SID}|`)],
    ["bare CR", compliantAcl().replace("\n", "\r")],
  ];
  test.each(refusals)("refuses %s, retains the record and releases its lock", (_name, stdout) => {
    const intent = createGuiPairIntent(CAP), path = recordPath(), s = state();
    setWindowsOwnerAclRunnerForTests(() => aclResult(stdout));
    expect(windowsPrivateEntriesAclMatches(stdout, ACL_ENTRIES)).toBe(false);
    expect(() => deliverGuiPairingGrant(request(intent.proof), config(), s)).toThrow(GuiPairingIntentRequiredError);
    expect(existsSync(path)).toBe(true);
    expect(existsSync(`${path}.consuming`)).toBe(false);
    expect(s.pairingGrants.size).toBe(0);
    setWindowsOwnerAclRunnerForTests(entries => aclResult(compliantAcl(entries)));
    expect(deliverGuiPairingGrant(request(intent.proof), config(), s)).toHaveProperty("grant");
    expect(s.pairingGrants.size).toBe(1);
  });

  test.each(["failure", "timeout", "throw"])("runner %s fails closed without a grant", kind => {
    const intent = createGuiPairIntent(CAP), path = recordPath(), s = state();
    setWindowsOwnerAclRunnerForTests(() => {
      if (kind === "throw") throw new Error("runner unavailable");
      return { success: kind === "timeout", timedOut: kind === "timeout", stdout: compliantAcl() };
    });
    expect(() => deliverGuiPairingGrant(request(intent.proof), config(), s)).toThrow(GuiPairingIntentRequiredError);
    expect(existsSync(path)).toBe(true); expect(existsSync(`${path}.consuming`)).toBe(false);
    expect(s.pairingGrants.size).toBe(0);
  });

  test.each([
    [USER_SID, USER_SID, false, true],
    [USER_SID, ADMIN_SID, true, true],
    [ADMIN_SID, ADMIN_SID, true, true],
    [ADMIN_SID, ADMIN_SID, false, false],
    [ADMIN_SID, USER_SID, true, false],
    [ADMIN_SID, USER_SID, false, false],
    [FOREIGN_SID, FOREIGN_SID, true, false],
    ["S-1-5-21-1-2-3-513", "S-1-5-21-1-2-3-513", true, false],
  ] as const)("owner %s with default %s and admin role %s yields %s", (owner, tokenOwner, enabled, allowed) => {
    const intent = createGuiPairIntent(CAP), path = recordPath(), s = state();
    const stdout = compliantAcl().replace(`U|${USER_SID}|${USER_SID}|False`, `U|${USER_SID}|${tokenOwner}|${enabled ? "True" : "False"}`)
      .replaceAll(`|${USER_SID}|4100|1`, `|${owner}|4100|1`);
    setWindowsOwnerAclRunnerForTests(() => aclResult(stdout));
    expect(windowsPrivateEntriesAclMatches(stdout, ACL_ENTRIES)).toBe(allowed);
    if (allowed) expect(deliverGuiPairingGrant(request(intent.proof), config(), s)).toHaveProperty("grant");
    else expect(() => deliverGuiPairingGrant(request(intent.proof), config(), s)).toThrow(GuiPairingIntentRequiredError);
    expect(existsSync(path)).toBe(!allowed); expect(existsSync(`${path}.consuming`)).toBe(false);
    expect(s.pairingGrants.size).toBe(allowed ? 1 : 0);
  });

  test("ASCII byte output, CRLF and exactly one final newline are accepted", () => {
    for (const stdout of [compliantAcl(), `${compliantAcl()}\n`, `${compliantAcl().replaceAll("\n", "\r\n")}\r\n`]) {
      expect(windowsPrivateEntriesAclMatches(stdout.replaceAll("S-1-", "s-1-"), ACL_ENTRIES)).toBe(true);
      expect(windowsPrivateEntriesAclMatches(Buffer.from(stdout, "ascii"), ACL_ENTRIES)).toBe(true);
    }
    expect(windowsPrivateEntriesAclMatches(compliantAcl().replaceAll("|4100|", "|36868|"), ACL_ENTRIES)).toBe(true);
    expect(windowsPrivateEntriesAclMatches(runnerShapeAcl(), ACL_ENTRIES)).toBe(true);
    expect(windowsPrivateEntriesAclMatches(runnerShapeAcl().replace("A|0|0|3|2032127|S-1-5-32-544|", "A|0|0|3|1179817|S-1-5-32-544|"), ACL_ENTRIES)).toBe(true);
    expect(windowsPrivateEntriesAclMatches(Buffer.from(`\ufeff${compliantAcl()}`), ACL_ENTRIES)).toBe(false);
    expect(windowsPrivateEntriesAclMatches(Buffer.from(compliantAcl(), "utf16le"), ACL_ENTRIES)).toBe(false);
  });

  test("verification follows close, holds the consume lock and never hardens at redemption", () => {
    let hardens = 0, verifies = 0;
    setIcaclsRunnerForTests(() => { hardens++; return ICACLS_OK; });
    setWindowsOwnerAclRunnerForTests(() => { verifies++; return aclResult(); });
    const intent = createGuiPairIntent(CAP), path = recordPath(), publishedHardens = hardens;
    expect(verifies).toBe(0);
    const close = spyOn(fs, "closeSync");
    try {
      setWindowsOwnerAclRunnerForTests((entries, timeoutMs) => {
        verifies++;
        expect(close).toHaveBeenCalled();
        expect(existsSync(`${path}.consuming`)).toBe(true);
        expect(entries).toEqual([{ path: join(root, "gui-pair-intents"), directory: true }, { path, directory: false }]);
        expect(timeoutMs).toBe(5_000);
        return aclResult();
      });
      expect(consumeGuiPairIntent(CAP, "B".repeat(43))).toBe(false);
      expect(verifies).toBe(0);
      close.mockClear();
      expect(consumeGuiPairIntent(CAP, intent.proof)).toBe(true);
      expect(verifies).toBe(1); expect(hardens).toBe(publishedHardens);
    } finally { close.mockRestore(); }
  });

  test.each(["record", "directory"])("rechecks %s identity after the verifier returns", kind => {
    const intent = createGuiPairIntent(CAP), path = recordPath(), dir = join(root, "gui-pair-intents"), s = state();
    setWindowsOwnerAclRunnerForTests(() => {
      if (kind === "record") {
        fs.renameSync(path, join(root, "old-record"));
        writeFileSync(path, `${createHash("sha256").update(intent.proof).digest("hex")}\n`, { mode: 0o600 });
      } else {
        fs.renameSync(dir, join(root, "old-directory")); mkdirSync(dir, { mode: 0o700 });
        fs.renameSync(join(root, "old-directory", path.slice(dir.length + 1)), path);
      }
      return aclResult();
    });
    expect(() => deliverGuiPairingGrant(request(intent.proof), config(), s)).toThrow(GuiPairingIntentRequiredError);
    expect(existsSync(path)).toBe(true); expect(s.pairingGrants.size).toBe(0);
    const lock = kind === "record" ? `${path}.consuming` : join(root, "old-directory", `${path.slice(dir.length + 1)}.consuming`);
    expect(existsSync(lock)).toBe(kind === "directory"); // replacement paths cannot authorize lock cleanup
  });

  test("an independently written matching record still requires private ownership", () => {
    const dir = join(root, "gui-pair-intents"), proof = "D".repeat(43);
    mkdirSync(dir, { mode: 0o700 });
    const name = createHash("sha256").update(`opencodex-gui-pair-intent-v1\n${CAP}`).digest("hex"), path = join(dir, name);
    writeFileSync(path, `${createHash("sha256").update(proof).digest("hex")}\n`, { mode: 0o600 });
    const s = state();
    setWindowsOwnerAclRunnerForTests(() => aclResult(changeAclLine(3, `E|1|${FOREIGN_SID}|4100|1`)));
    expect(() => deliverGuiPairingGrant(request(proof), config(), s)).toThrow(GuiPairingIntentRequiredError);
    expect(existsSync(path)).toBe(true); expect(existsSync(`${path}.consuming`)).toBe(false);
    expect(s.pairingGrants.size).toBe(0);
  });

  test.skipIf(process.platform !== "win32")("native private ACLs grant, an additional ACE refuses, and recovery grants", () => {
    setIcaclsRunnerForTests(null); setAsyncIcaclsRunnerForTests(null); setWindowsOwnerAclRunnerForTests(null);
    const clean = createGuiPairIntent(CAP), cleanState = state();
    // Diagnose the real subprocess before relying on it: the policy fixtures above cannot see what
    // Windows PowerShell actually prints. The protocol carries only SIDs and numbers, never paths.
    const cleanEntries = [{ path: join(root, "gui-pair-intents"), directory: true }, { path: recordPath(), directory: false }];
    const probe = windowsOwnerAclDefaultRunnerForTests(cleanEntries, 30_000);
    if (!probe.success || !windowsPrivateEntriesAclMatches(probe.stdout, cleanEntries)) {
      const shown = typeof probe.stdout === "string" ? probe.stdout : Buffer.from(probe.stdout).toString("latin1");
      throw new Error(`native verifier refused a clean intent: success=${probe.success} timedOut=${probe.timedOut} stdout=${JSON.stringify(shown)}`);
    }
    expect(deliverGuiPairingGrant(request(clean.proof), config(), cleanState)).toHaveProperty("grant");
    const capability = "C".repeat(43), intent = createGuiPairIntent(capability), path = recordPath();
    const dir = join(root, "gui-pair-intents"), s = state();
    const icacls = (...args: string[]) => Bun.spawnSync([resolveTrustedWindowsIcaclsExe(), dir, ...args], {
      stdin: "ignore", stdout: "pipe", stderr: "ignore", windowsHide: true, timeout: 5_000,
    });
    // A directly applicable entry and an inherit-only entry for another principal both survive
    // Get-Acl canonicalization, so each must refuse on its own.
    for (const ace of ["*S-1-5-4:(OI)(CI)(RX)", "*S-1-5-4:(OI)(CI)(IO)(RX)"]) {
      try {
        expect(icacls("/grant", ace).success).toBe(true);
        expect(() => deliverGuiPairingGrant(request(intent.proof, ORIGIN, capability), config(), s)).toThrow(GuiPairingIntentRequiredError);
        expect(existsSync(path)).toBe(true); expect(existsSync(`${path}.consuming`)).toBe(false);
        expect(s.pairingGrants.size).toBe(0);
      } finally { expect(icacls("/remove:g", "*S-1-5-4").success).toBe(true); }
    }
    expect(deliverGuiPairingGrant(request(intent.proof, ORIGIN, capability), config(), s)).toHaveProperty("grant");
    expect(s.pairingGrants.size).toBe(1); expect(existsSync(path)).toBe(false);
  }, 45_000);
});
