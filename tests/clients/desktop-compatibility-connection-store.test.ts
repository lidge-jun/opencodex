import { afterAll, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { X509Certificate } from "node:crypto";
import { createDesktopConnectionStore } from "../../src/codex/desktop-compatibility/connection-store";
import { createDesktopCompatibilityRuntime } from "../../src/codex/desktop-compatibility/runtime";
import { createCertificateAuthority } from "../../src/claude/intercept/local-ca";
import { setAsyncIcaclsRunnerForTests, setIcaclsRunnerForTests } from "../../src/lib/windows-secret-acl";
const roots: string[] = [];
const success = () => ({ success: true, exitCode: 0, timedOut: false, stdout: "" });
setIcaclsRunnerForTests(success); setAsyncIcaclsRunnerForTests(async () => success());
afterAll(() => { setIcaclsRunnerForTests(null); setAsyncIcaclsRunnerForTests(null); for (const root of roots) rmSync(root, { recursive: true }); });
function fixture() { const path = mkdtempSync(join(tmpdir(), "ocx-desktop-endpoint-")); roots.push(path); return { path, store: createDesktopConnectionStore(path) }; }
const identity = () => ({ version: 1 as const, id: randomUUID(), connectPort: 40001, pacPort: 40002 });

test("failed temporary cleanup preserves the publication error as well as the residue", async () => {
  const { path, store } = fixture(), primary = new Error("fixture publication failure"), cleanup = new Error("fixture cleanup failure");
  const realLink = fs.linkSync, realUnlink = fs.unlinkSync;
  const link = spyOn(fs, "linkSync").mockImplementation((source, destination) => {
    if (String(destination) === join(path, "connection.json")) throw primary;
    return realLink(source, destination);
  });
  const unlink = spyOn(fs, "unlinkSync").mockImplementation(target => {
    if (String(target).startsWith(join(path, "connection-")) && String(target).endsWith(".tmp")) throw cleanup;
    return realUnlink(target);
  });
  try {
    const error = await store.publish(identity()).catch(value => value);
    expect(error).toBeInstanceOf(Error); expect(error.message).toBe("desktop_compatibility_connection_cleanup_required");
    expect(error.cause).toBeInstanceOf(AggregateError); expect(error.cause.errors).toEqual([primary, cleanup]);
    expect(store.read()).toBeNull(); expect(readdirSync(path).some(value => value.endsWith(".tmp"))).toBe(true);
  } finally { link.mockRestore(); unlink.mockRestore(); }
});

test("one public endpoint identity survives reopening without rewriting the file", async () => {
  const { path, store } = fixture(), value = identity(); expect(store.read()).toBeNull();
  await store.publish(value);
  const saved = readFileSync(join(path, "connection.json"), "utf8");
  const reopened = createDesktopConnectionStore(path);
  expect(reopened.read()).toEqual(value); expect(await reopened.publish(value)).toEqual(value);
  expect(readFileSync(join(path, "connection.json"), "utf8")).toBe(saved);
  expect(Object.keys(JSON.parse(saved)).sort()).toEqual(["connectPort", "id", "pacPort", "version"]);
  expect(readdirSync(path).some(file => file.endsWith(".tmp"))).toBe(false);
});
test("changed, invalid or unsupported state is preserved rather than assigned new endpoints", async () => {
  const { path, store } = fixture(), value = identity(); await store.publish(value);
  await expect(store.publish({ ...value, id: randomUUID() })).rejects.toThrow("connection_changed");
  for (const content of ["broken", JSON.stringify({ ...value, connectPort: 80 }), JSON.stringify({ ...value, version: 2 }), JSON.stringify({ ...value, token: "fixture" })]) {
    writeFileSync(join(path, "connection.json"), content);
    expect(() => store.read()).toThrow("connection_invalid");
    await expect(store.publish(value)).rejects.toThrow("connection_invalid");
    expect(readFileSync(join(path, "connection.json"), "utf8")).toBe(content);
  }
});
test("a competing publication cannot replace the first endpoint identity", async () => {
  const { path, store } = fixture(), first = identity(), second = { ...identity(), connectPort: 40003, pacPort: 40004 };
  const results = await Promise.allSettled([store.publish(first), createDesktopConnectionStore(path).publish(second)]);
  expect(results.filter(value => value.status === "fulfilled")).toHaveLength(1);
  expect([first.id, second.id]).toContain(store.read()!.id);
  expect(readdirSync(path).some(file => file.endsWith(".tmp"))).toBe(false);
});

test("a fresh runtime reopens the persisted endpoints and serves an already cached PAC", async () => {
  const { path } = fixture();
  const authority = createCertificateAuthority({ commonName: "persisted-runtime-fixture", validityDays: 1 }), cert = new X509Certificate(authority.certPem);
  const account = { id: "fixture", userId: "fixture-user", plan: "pro" as const, structure: "personal" as const };
  const makeRuntime = () => createDesktopCompatibilityRuntime({ platform: "win32", testOnly: true,
    connectionStore: createDesktopConnectionStore(path), identity: { readCurrentIdentity: async () => account, verifyFreshIdentity: async () => account },
    loadAuthority: async () => ({ authority, commonName: "persisted-runtime-fixture", fingerprint: cert.fingerprint256.replaceAll(":", ""), expiresAt: Date.parse(cert.validTo), reused: true, renewalDue: false }),
    trust: async () => "trusted", buildSupported: () => true, routingSupported: () => true,
    upstreamFetch: (async () => Response.json({ fixture: "original-response" })) as typeof fetch,
  });
  const first = makeRuntime(), second = makeRuntime();
  try {
    await first.start(); const url = first.getPacUrl()!, pac = await fetch(url).then(res => res.text());
    const saved = readFileSync(join(path, "connection.json"), "utf8");
    const proxy = `http://127.0.0.1:${/PROXY 127\.0\.0\.1:(\d+)/.exec(pac)![1]}`;
    const request = () => fetch("https://chatgpt.com/backend-api/conversation", { proxy, tls: { ca: authority.certPem } }).then(res => res.json());
    expect(await request()).toEqual({ fixture: "original-response" });
    await first.stop(); await second.start();
    expect(second.getPacUrl()).toBe(url); expect(await fetch(url).then(res => res.text())).toBe(pac);
    expect(await request()).toEqual({ fixture: "original-response" });
    expect(readFileSync(join(path, "connection.json"), "utf8")).toBe(saved);
  } finally { await first.stop(); await second.stop(); }
}, 10000);
