import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  emptyLinkStore,
  hasLinks,
  LinkStoreError,
  parseLinkStore,
  readLinkStore,
  writeLinkStore,
  type LinkStore,
} from "../../src/link/store";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const previousHome = process.env.OPENCODEX_HOME;
const roots: string[] = [];

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  for (const root of roots.splice(0)) removeTreeWithRetry(root);
});

function fixturePath(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `ocx-link-store-${label}-`));
  roots.push(root);
  process.env.OPENCODEX_HOME = root;
  return join(root, "link", "links.json");
}

function validStore(): LinkStore {
  return {
    version: 1,
    listenerPort: 20100,
    links: [{
      id: "lnk_0123456789abcdef",
      alias: "alpha.example.test",
      direction: "hub-initiated",
      hostKeyFingerprint: "SHA256:ABCDEFGHIJKLMNOP",
      tunnelPort: 10100,
      apiKeyId: "data-key-id",
      createdAt: "2026-09-25T00:00:00.000Z",
    }],
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function expectLinkStoreError(action: () => unknown): void {
  expect(action).toThrow(LinkStoreError);
}

test("a missing links file is an empty store", () => {
  const path = fixturePath("missing");
  expect(readLinkStore(path)).toEqual(emptyLinkStore());
  expect(hasLinks(path)).toBe(false);
});

test("link store writes and reads back with private POSIX permissions", () => {
  const path = fixturePath("roundtrip");
  const store = validStore();
  writeLinkStore(path, store);
  expect(readLinkStore(path)).toEqual(store);
  expect(hasLinks(path)).toBe(true);
  expect(readFileSync(path, "utf8")).not.toContain("ocx_data_");
  if (process.platform !== "win32") {
    expect(statSync(join(path, "..")).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  }
});

test("damaged store documents fail closed with LinkStoreError", () => {
  const base = validStore();
  const malformed: Array<[string, unknown]> = [
    ["invalid JSON", "{"],
    ["unsupported version", { ...base, version: 2 }],
    ["unknown top-level field", { ...base, extra: true }],
    ["unknown record field", { ...base, links: [{ ...base.links[0], extra: true }] }],
    ["invalid id", { ...base, links: [{ ...base.links[0], id: "bad" }] }],
    ["invalid alias", { ...base, links: [{ ...base.links[0], alias: "alpha beta" }] }],
    ["invalid fingerprint", { ...base, links: [{ ...base.links[0], hostKeyFingerprint: "not-a-fingerprint" }] }],
    ["invalid port", { ...base, links: [{ ...base.links[0], tunnelPort: 0 }] }],
    ["empty api key id", { ...base, links: [{ ...base.links[0], apiKeyId: "" }] }],
    ["spaced api key id", { ...base, links: [{ ...base.links[0], apiKeyId: "data key" }] }],
    ["control character api key id", { ...base, links: [{ ...base.links[0], apiKeyId: "data\nkey" }] }],
    ["duplicate id", { ...base, links: [base.links[0], clone(base.links[0])] }],
  ];
  for (const [, document] of malformed) {
    expectLinkStoreError(() => parseLinkStore(typeof document === "string" ? document : JSON.stringify(document)));
  }
});

test("host-key fingerprint null is valid only for client-initiated links", () => {
  const client = validStore();
  client.links[0] = { ...client.links[0], direction: "client-initiated", hostKeyFingerprint: null };
  expect(parseLinkStore(JSON.stringify(client))).toEqual(client);

  const hub = validStore();
  hub.links[0] = { ...hub.links[0], hostKeyFingerprint: null };
  expectLinkStoreError(() => parseLinkStore(JSON.stringify(hub)));
});

test("hasLinks reports false for a corrupted store", () => {
  const path = fixturePath("corrupt");
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify({ version: 2, listenerPort: null, links: [] }));
  expect(hasLinks(path)).toBe(false);
});
