import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { claimLinkRetirement, clearLinkRetirement, disownLinkRetirement, LinkRetirementError, readLinkRetirement, reownLinkRetirement } from "../../src/link/retirement";
import { linkStorePath } from "../../src/link/paths";
import { writeLinkStore, type LinkRecord, type LinkStore } from "../../src/link/store";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) removeTreeWithRetry(root); });
const link: LinkRecord = { id: "lnk_0123456789abcdef", alias: "alpha.example.test", direction: "hub-initiated", hostKeyFingerprint: "SHA256:ABCDEFGHIJKLMNOP", tunnelPort: 10100, apiKeyId: "key-1", createdAt: "2026-09-25T00:00:00.000Z" };
function setup(): string {
  const dir = mkdtempSync(join(tmpdir(), "ocx-retirement-"));
  roots.push(dir);
  writeLinkStore(linkStorePath(dir), { version: 1, listenerPort: null, links: [link] });
  return dir;
}
function receiptPath(dir: string): string { return join(dir, "link", `retirement-${link.id}.json`); }

test("receipt survives a fresh process and is private", async () => {
  const dir = setup();
  const receipt = claimLinkRetirement(link, dir);
  const modulePath = fileURLToPath(new URL("../../src/link/retirement.ts", import.meta.url));
  const child = Bun.spawn([process.execPath, "-e", `import {readLinkRetirement} from ${JSON.stringify(modulePath)}; console.log(JSON.stringify(readLinkRetirement(${JSON.stringify(link.id)}, ${JSON.stringify(dir)})))`], { stdout: "pipe", stderr: "pipe" });
  expect(JSON.parse(await new Response(child.stdout).text())).toEqual(receipt);
  expect(await child.exited).toBe(0);
  if (process.platform !== "win32") expect(statSync(receiptPath(dir)).mode & 0o777).toBe(0o600);
  expect(clearLinkRetirement(receipt, dir)).toBe(true);
  expect(readLinkRetirement(link.id, dir)).toBeNull();
});

test("competing processes cannot both claim the same link", async () => {
  const dir = setup();
  const modulePath = fileURLToPath(new URL("../../src/link/retirement.ts", import.meta.url));
  const code = `import {claimLinkRetirement} from ${JSON.stringify(modulePath)}; try { claimLinkRetirement(${JSON.stringify(link)}, ${JSON.stringify(dir)}); process.exit(0); } catch { process.exit(1); }`;
  const children = [0, 1].map(() => Bun.spawn([process.execPath, "-e", code], { stdout: "pipe", stderr: "pipe" }));
  expect((await Promise.all(children.map(child => child.exited))).sort()).toEqual([0, 1]);
  expect(readLinkRetirement(link.id, dir)?.link).toEqual(link);
});

test("claim and clear compare the full identity and nonce", () => {
  const dir = setup();
  expect(() => claimLinkRetirement({ ...link, apiKeyId: "replacement" }, dir)).toThrow(LinkRetirementError);
  const receipt = claimLinkRetirement(link, dir);
  expect(() => claimLinkRetirement(link, dir)).toThrow(LinkRetirementError);
  expect(clearLinkRetirement({ ...receipt, nonce: "a".repeat(64) }, dir)).toBe(false);
  expect(clearLinkRetirement({ ...receipt, link: { ...link, alias: "other.example.test" } }, dir)).toBe(false);
  expect(readLinkRetirement(link.id, dir)).toEqual(receipt);
  expect(clearLinkRetirement(receipt, dir)).toBe(true);
  const replacement = claimLinkRetirement(link, dir);
  expect(clearLinkRetirement(receipt, dir)).toBe(false);
  expect(readLinkRetirement(link.id, dir)).toEqual(replacement);
});

test("claim reads the injected current store inside the supplied config lock", () => {
  const dir = setup();
  let calls = 0;
  const store = (links: LinkRecord[]): LinkStore => ({ version: 1, listenerPort: null, links });
  const readLocked = (current: LinkStore) => () => {
    calls++;
    const db = new Database(join(dir, "config-mutation.sqlite"));
    try {
      db.exec("PRAGMA busy_timeout = 0");
      expect(() => db.exec("BEGIN IMMEDIATE")).toThrow();
    } finally { db.close(); }
    return current;
  };
  for (const current of [store([]), store([{ ...link, apiKeyId: "replacement" }]), store([{ ...link, remotePlatform: "windows" }])]) {
    expect(() => claimLinkRetirement(link, dir, readLocked(current))).toThrow("link identity changed");
    expect(existsSync(receiptPath(dir))).toBe(false);
  }
  const receipt = claimLinkRetirement(link, dir, readLocked(store([link])));
  expect(calls).toBe(4);
  expect(receipt.link).toEqual(link);
  expect(readLinkRetirement(link.id, dir)).toEqual(receipt);
  if (process.platform !== "win32") expect(statSync(receiptPath(dir)).mode & 0o777).toBe(0o600);
});

test("claim fails closed on malformed stores and reader errors", () => {
  const dir = setup();
  const error = new Error("reader failed");
  expect(() => claimLinkRetirement(link, dir, () => { throw error; })).toThrow(error);
  const malformed = JSON.parse('{"version":1,"listenerPort":null,"links":[{"id":"invalid"}]}') as LinkStore;
  expect(() => claimLinkRetirement(link, dir, () => malformed)).toThrow();
  expect(existsSync(receiptPath(dir))).toBe(false);
  writeFileSync(linkStorePath(dir), "{");
  expect(() => claimLinkRetirement(link, dir)).toThrow();
  expect(readFileSync(linkStorePath(dir), "utf8")).toBe("{");
  expect(existsSync(receiptPath(dir))).toBe(false);
});

test("corrupt or mismatched records refuse reads, claims and clears without changing bytes", () => {
  const dir = setup();
  const receipt = claimLinkRetirement(link, dir);
  for (const text of ["{", JSON.stringify({ ...receipt, extra: true }), JSON.stringify({ ...receipt, nonce: "bad" }), JSON.stringify({ ...receipt, link: { ...link, id: "lnk_aaaaaaaaaaaaaaaa" } })]) {
    writeFileSync(receiptPath(dir), text);
    expect(() => readLinkRetirement(link.id, dir)).toThrow(LinkRetirementError);
    expect(() => claimLinkRetirement(link, dir)).toThrow(LinkRetirementError);
    expect(() => clearLinkRetirement(receipt, dir)).toThrow(LinkRetirementError);
    expect(readFileSync(receiptPath(dir), "utf8")).toBe(text);
  }
  expect(() => readLinkRetirement("../escape", dir)).toThrow(LinkRetirementError);
});

test("a receipt keeps the operation that claimed it, refuses a malformed one, and still reads without one", () => {
  const dir = setup();
  const receipt = claimLinkRetirement(link, dir, undefined, "purge", "detach-0001");
  expect(readLinkRetirement(link.id, dir)).toEqual({ ...receipt, mode: "purge", operationId: "detach-0001" });
  const stored = JSON.parse(readFileSync(receiptPath(dir), "utf8")) as Record<string, unknown>;
  writeFileSync(receiptPath(dir), JSON.stringify({ ...stored, operationId: "bad id with spaces" }));
  expect(() => readLinkRetirement(link.id, dir)).toThrow(LinkRetirementError);
  writeFileSync(receiptPath(dir), JSON.stringify({ ...stored, operationId: "detach-0001", extra: true }));
  expect(() => readLinkRetirement(link.id, dir)).toThrow(LinkRetirementError);
  const { mode: _mode, operationId: _operationId, ...legacy } = stored;
  writeFileSync(receiptPath(dir), JSON.stringify(legacy));
  expect(readLinkRetirement(link.id, dir)).toEqual({ version: 1, link, nonce: receipt.nonce });
});

test("a disowned receipt names its former owner, which a re-own clears, and a receipt cannot name both", () => {
  const dir = setup();
  const receipt = claimLinkRetirement(link, dir, undefined, "purge", "detach-0001");
  const disowned = disownLinkRetirement(receipt, dir)!;
  expect({ operationId: disowned.operationId, formerOwner: disowned.formerOwner }).toEqual({ operationId: undefined, formerOwner: "detach-0001" });
  expect(reownLinkRetirement(disowned, "detach-0001", dir)).toBe(true);
  expect(readLinkRetirement(link.id, dir)).toEqual({ ...receipt });
  const stored = JSON.parse(readFileSync(receiptPath(dir), "utf8")) as Record<string, unknown>;
  writeFileSync(receiptPath(dir), JSON.stringify({ ...stored, formerOwner: "other-op" }));
  expect(() => readLinkRetirement(link.id, dir)).toThrow(LinkRetirementError);
});
