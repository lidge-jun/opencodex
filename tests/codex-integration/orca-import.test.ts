import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadConfig, saveConfig, setPersistedConfigMutationBeforeCommitForTests } from "../../src/config";
import { parseOrcaAuth, readBoundedLocalFile, assertPlainLocalPath } from "../../src/codex/orca-auth-source";
import { importOrcaAccounts } from "../../src/codex/orca-import";
import { forceRefreshCodexPoolToken, getValidCodexToken, markCodexAccountValidated, readCodexAccountRecord } from "../../src/codex/account-store";
import { setAsyncIcaclsRunnerForTests, setIcaclsRunnerForTests } from "../../src/lib/windows-secret-acl";
import { flushConfigDirHardeningForTests } from "../../src/config/paths";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let scratch: string;
let source: string;
let target: string;
let main: string;
let registry: string;
let originalHome: string | undefined;
let originalCodexHome: string | undefined;

function auth(account = "synthetic-account", sequence = 1, expiry = Date.now() + 3600_000, subject = "synthetic-subject") {
  const claims = { sub: subject, exp: Math.floor(expiry / 1000), sequence,
    "https://api.openai.com/auth": { chatgpt_account_id: account } };
  const access = `synthetic.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.fixture`;
  return JSON.stringify({ tokens: { account_id: account, access_token: access, refresh_token: "synthetic-refresh-never-copy" } });
}
function addSource(raw = auth()) {
  const path = join(source, "codex-accounts", randomUUID(), "home", "auth.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, raw);
  const id = dirname(dirname(path)).split(/[\\/]/).pop()!;
  writeFileSync(join(dirname(path), ".orca-managed-home"), `${id}\n`);
  const registered = JSON.parse(readFileSync(registry, "utf8"));
  registered.settings.codexManagedAccounts.push({ id, managedHomePath: dirname(path), managedHomeRuntime: "host" });
  writeFileSync(registry, JSON.stringify(registered));
  return path;
}
function store() { return JSON.parse(readFileSync(join(target, "codex-accounts.json"), "utf8")); }
function importedId() { return Object.keys(store())[0]!; }

beforeEach(() => {
  originalHome = process.env.OPENCODEX_HOME;
  originalCodexHome = process.env.CODEX_HOME;
  const ok = { success: true, exitCode: 0, timedOut: false, stdout: "" };
  setIcaclsRunnerForTests(() => ok);
  setAsyncIcaclsRunnerForTests(async () => ok);
  scratch = mkdtempSync(join(tmpdir(), "ocx-orca-import-"));
  target = join(scratch, "target"); source = join(scratch, "orca"); main = join(scratch, "main");
  for (const directory of [target, main, join(source, "codex-accounts")]) mkdirSync(directory, { recursive: true });
  registry = join(source, "orca-data.json");
  writeFileSync(registry, JSON.stringify({ settings: { codexManagedAccounts: [] } }));
  process.env.OPENCODEX_HOME = target; process.env.CODEX_HOME = main;
  saveConfig(loadConfig());
});
afterEach(async () => {
  await flushConfigDirHardeningForTests();
  setIcaclsRunnerForTests(null); setAsyncIcaclsRunnerForTests(null);
  setPersistedConfigMutationBeforeCommitForTests(null);
  if (originalHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = originalHome;
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = originalCodexHome;
  removeTreeWithRetry(scratch);
});

describe("offline Orca import", () => {
  test("preview writes nothing and reports no identities or paths", () => {
    const sourcePath = addSource();
    const before = readdirSync(target).map(name => [name, readFileSync(join(target, name)).toString("base64")]);
    const raw = readFileSync(sourcePath, "utf8");
    expect(importOrcaAccounts({ sourceDir: source, registryPath: registry })).toEqual({ mode: "preview", discovered: 1, eligible: 1, imported: 0, duplicates: 0, invalid: 0 });
    expect(readdirSync(target).map(name => [name, readFileSync(join(target, name)).toString("base64")])).toEqual(before);
    expect(readFileSync(sourcePath, "utf8")).toBe(raw);
  });
  test("apply imports once, links source, excludes refresh token, and remains pending", () => {
    const path = addSource(); addSource();
    const originalAuth = readFileSync(path, "utf8");
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("unexpected network"); });
    try {
      expect(importOrcaAccounts({ sourceDir: source, registryPath: registry, apply: true })).toMatchObject({ imported: 1, duplicates: 1 });
      expect(importOrcaAccounts({ sourceDir: source, registryPath: registry, apply: true })).toMatchObject({ imported: 0, duplicates: 2 });
      expect(readFileSync(join(target, "codex-accounts.json"), "utf8")).not.toContain("synthetic-refresh-never-copy");
      expect(store()[importedId()]).toMatchObject({ codexValidationPending: true, credential: { refreshToken: "" } });
      expect(readFileSync(path, "utf8")).toBe(originalAuth);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally { fetchSpy.mockRestore(); }
  });
  test("deduplicates main and orphan credential records", () => {
    addSource(auth("main-identity")); addSource(auth("orphan-identity"));
    writeFileSync(join(main, "auth.json"), auth("main-identity"));
    writeFileSync(join(target, "codex-accounts.json"), JSON.stringify({ orphan: {
      accessToken: "fixture", refreshToken: "fixture", expiresAt: 0, chatgptAccountId: "orphan-identity" } }));
    expect(importOrcaAccounts({ sourceDir: source, registryPath: registry, apply: true })).toMatchObject({ eligible: 0, duplicates: 2, imported: 0 });
  });
  test("retry completes interrupted registration using the same untouched credential record", () => {
    const path = addSource();
    const options = { sourceDir: source, registryPath: registry };
    const id = `orca-${randomUUID()}`;
    // Seed the exact crash boundary directly: credentials were published, config was not.
    // Avoid an unrelated successful import and config rewrite just to construct this fixture.
    const credential = { ...parseOrcaAuth(readFileSync(path, "utf8")), sourceAuthPath: path };
    const before = JSON.stringify({ [id]: { credential, generation: 1, codexValidationPending: true } }, null, 2) + "\n";
    writeFileSync(join(target, "codex-accounts.json"), before);
    expect(importOrcaAccounts(options)).toMatchObject({ eligible: 1, imported: 0, duplicates: 0 });
    expect(loadConfig().codexAccounts ?? []).toEqual([]);
    expect(importOrcaAccounts({ ...options, apply: true })).toMatchObject({ imported: 1, duplicates: 0 });
    expect(loadConfig().codexAccounts?.map(account => account.id)).toEqual([id]);
    expect(readFileSync(join(target, "codex-accounts.json"), "utf8")).toBe(before);
    expect(importOrcaAccounts({ ...options, apply: true })).toMatchObject({ imported: 0, duplicates: 1 });
  });
  test.each(["ordinary-id", "advanced", "validated", "deleted", "subject", "path", "refresh-grant", "another-orphan", "main"])("does not recover an unrelated %s orphan", scenario => {
    addSource();
    const options = { sourceDir: source, registryPath: registry, apply: true };
    importOrcaAccounts(options);
    const id = importedId();
    const config = loadConfig(); config.codexAccounts = []; saveConfig(config);
    const records = store();
    const record = records[id];
    if (scenario === "ordinary-id") { records.ordinary = record; delete records[id]; }
    if (scenario === "advanced") record.generation = 2;
    if (scenario === "validated") record.lastCodexValidationStatus = "ok";
    if (scenario === "deleted") record.deletedAt = 1;
    if (scenario === "subject") record.credential.sourceSubject = "different-subject";
    if (scenario === "path") record.credential.sourceAuthPath = join(source, "other", "auth.json");
    if (scenario === "refresh-grant") record.credential.refreshToken = "synthetic-owned-grant";
    if (scenario === "another-orphan") records.ordinary = { ...record };
    if (scenario === "main") writeFileSync(join(main, "auth.json"), auth());
    const before = JSON.stringify(records, null, 2) + "\n";
    writeFileSync(join(target, "codex-accounts.json"), before);
    expect(importOrcaAccounts(options)).toMatchObject({ imported: 0, eligible: 0, duplicates: 1 });
    expect(loadConfig().codexAccounts).toEqual([]);
    expect(readFileSync(join(target, "codex-accounts.json"), "utf8")).toBe(before);
  });
  test("invalid and expired sources are skipped; unreadable main fails closed", () => {
    addSource("{}"); addSource(auth("expired", 1, 0));
    expect(importOrcaAccounts({ sourceDir: source, registryPath: registry })).toMatchObject({ invalid: 2, eligible: 0 });
    writeFileSync(join(main, "auth.json"), "not json");
    expect(() => importOrcaAccounts({ sourceDir: source, registryPath: registry, apply: true })).toThrow();
  });
  test("live proxy blocks apply", () => {
    addSource(); writeFileSync(join(target, "ocx.pid"), String(process.pid));
    expect(() => importOrcaAccounts({ sourceDir: source, registryPath: registry, apply: true })).toThrow("Stop the opencodex proxy");
  });
  test("failed config commit restores the exact previous credential store", () => {
    addSource();
    const path = join(target, "codex-accounts.json");
    const original = '{"retained": {"generation": 7, "deletedAt": 1}}\n';
    writeFileSync(path, original);
    const configBefore = readFileSync(join(target, "config.json"), "utf8");
    setPersistedConfigMutationBeforeCommitForTests(() => { throw new Error("synthetic commit failure"); });
    expect(() => importOrcaAccounts({ sourceDir: source, registryPath: registry, apply: true })).toThrow();
    expect(readFileSync(path, "utf8")).toBe(original);
    expect(readFileSync(join(target, "config.json"), "utf8")).toBe(configBefore);
    expect(importOrcaAccounts({ sourceDir: source, registryPath: registry, apply: true }).imported).toBe(1);
  });
  test("rejects mixed modes, network paths and files above the bounded read limit", () => {
    const parsed = JSON.parse(auth());
    expect(() => parseOrcaAuth(JSON.stringify({ ...parsed, auth_mode: "apikey" }))).toThrow();
    expect(() => parseOrcaAuth(JSON.stringify({ ...parsed, OPENAI_API_KEY: "synthetic-key" }))).toThrow();
    expect(() => assertPlainLocalPath("\\\\synthetic-server\\share\\auth.json")).toThrow();
    const path = addSource("x".repeat(32));
    expect(() => readBoundedLocalFile(path, 16)).toThrow();
  });
  test("imports only registered host homes with matching ownership markers", () => {
    const path = addSource();
    const registered = readFileSync(registry, "utf8");
    writeFileSync(registry, JSON.stringify({ settings: { codexManagedAccounts: [] } }));
    expect(importOrcaAccounts({ sourceDir: source, registryPath: registry })).toMatchObject({ discovered: 0, eligible: 0 });
    writeFileSync(registry, registered);
    writeFileSync(join(dirname(path), ".orca-managed-home"), "wrong-owner");
    expect(importOrcaAccounts({ sourceDir: source, registryPath: registry })).toMatchObject({ invalid: 1, eligible: 0 });
    unlinkSync(registry);
    expect(() => importOrcaAccounts({ sourceDir: source, registryPath: registry })).toThrow();
  });
  test.skipIf(process.platform !== "win32")("accepts Windows registry home path capitalization", () => {
    addSource();
    const registered = JSON.parse(readFileSync(registry, "utf8"));
    registered.settings.codexManagedAccounts[0].managedHomePath = registered.settings.codexManagedAccounts[0].managedHomePath.toUpperCase();
    writeFileSync(registry, JSON.stringify(registered));
    expect(importOrcaAccounts({ sourceDir: source, registryPath: registry })).toMatchObject({ eligible: 1, invalid: 0 });
  });
  test("rejects directory junctions without reading linked credentials", () => {
    const path = addSource();
    const link = join(scratch, "linked-source");
    symlinkSync(source, link, process.platform === "win32" ? "junction" : "dir");
    expect(() => readBoundedLocalFile(path.replace(source, link))).toThrow();
  });
  test("a validated source retains validation across same-identity rotation", async () => {
    const path = addSource(); importOrcaAccounts({ sourceDir: source, registryPath: registry, apply: true });
    const id = importedId();
    const first = await getValidCodexToken(id);
    markCodexAccountValidated(id, Date.now(), first.generation);
    writeFileSync(path, auth("synthetic-account", 2));
    expect((await getValidCodexToken(id)).generation).toBe(first.generation + 1);
    expect(readCodexAccountRecord(id)).toMatchObject({ lastCodexValidationStatus: "ok" });
    expect(readCodexAccountRecord(id)?.codexValidationPending).toBeUndefined();
  });
  test("runtime follows source rotation with generation fence and never refreshes after 401", async () => {
    const path = addSource(); importOrcaAccounts({ sourceDir: source, registryPath: registry, apply: true });
    const id = importedId();
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("unexpected network"); });
    try {
      const first = await getValidCodexToken(id);
      await expect(forceRefreshCodexPoolToken(id, { rejectedGeneration: first.generation, rejectedAccessToken: first.accessToken })).rejects.toThrow("Orca bearer was rejected");
      writeFileSync(path, auth("synthetic-account", 2));
      const second = await getValidCodexToken(id);
      expect(second.generation).toBe(first.generation + 1);
      expect(second.accessToken).not.toBe(first.accessToken);
      markCodexAccountValidated(id, Date.now(), first.generation);
      expect(readCodexAccountRecord(id)?.codexValidationPending).toBe(true);
      writeFileSync(path, auth("synthetic-account", 3, Date.now() + 3600_000, "different-subject"));
      await expect(getValidCodexToken(id)).rejects.toThrow("identity changed");
      writeFileSync(path, auth("synthetic-account", 3, 0));
      await expect(getValidCodexToken(id)).rejects.toThrow("Orca credential unavailable");
      writeFileSync(path, auth("other-account", 3));
      await expect(getValidCodexToken(id)).rejects.toThrow("identity changed");
      unlinkSync(path);
      await expect(getValidCodexToken(id)).rejects.toThrow("Orca credential unavailable");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally { fetchSpy.mockRestore(); }
  });
  test.each(["removed", "rotated", "unchanged"])("deferred validation rereads a %s source after WHAM", async change => {
    const { fetchPoolAccountQuota } = await import("../../src/codex/auth-api");
    const path = addSource(); importOrcaAccounts({ sourceDir: source, registryPath: registry, apply: true });
    const id = importedId();
    let warmups = 0;
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async input => {
      if (String(input).endsWith("/wham/usage")) {
        if (change === "removed") unlinkSync(path);
        if (change === "rotated") writeFileSync(path, auth("synthetic-account", 2));
        return Response.json({ plan_type: "pro", rate_limit: { secondary_window: { used_percent: 0, limit_window_seconds: 604800 } } });
      }
      if (String(input).endsWith("/codex/responses")) {
        warmups++;
        return new Response('data: {"type":"response.completed"}\n\n');
      }
      throw new Error("unexpected network request");
    });
    try {
      await fetchPoolAccountQuota(id, true, "pro", getValidCodexToken, true);
      expect(warmups).toBe(change === "unchanged" ? 1 : 0);
      expect(readCodexAccountRecord(id)?.codexValidationPending).toBe(change === "unchanged" ? undefined : true);
    } finally { fetchSpy.mockRestore(); }
  });
});
