import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OcxConfig } from "../../src/types";
import type { GuiSessionState } from "../../src/server/gui-session";
import { GUI_PAIR_BROWSER_ORIGIN_HEADER, GUI_PAIR_CAPABILITY_HEADER } from "../../src/lib/gui-pair-capability";
import { consumeGuiPairIntent, createGuiPairIntent, GUI_PAIR_INTENT_HEADER } from "../../src/lib/gui-pair-intent";
import { deliverGuiPairingGrant, GuiPairingIntentRequiredError } from "../../src/server/gui-pair-delivery";
import { GuiPairingGrantRateLimitError } from "../../src/server/gui-session";
import { resetHardenedStateForTests, setAsyncIcaclsRunnerForTests, setIcaclsRunnerForTests, setPlatformForTests } from "../../src/lib/windows-secret-acl";
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
const ICACLS_OK = { success: true, exitCode: 0, timedOut: false, stdout: "" };

beforeEach(() => {
  previous = process.env.OPENCODEX_HOME;
  root = mkdtempSync(join(tmpdir(), "ocx-pair-intent-"));
  process.env.OPENCODEX_HOME = root;
  setIcaclsRunnerForTests(() => ICACLS_OK);
  setAsyncIcaclsRunnerForTests(async () => ICACLS_OK);
});
afterEach(() => {
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
