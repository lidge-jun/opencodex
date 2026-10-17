import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDefaultConfig, saveConfig, loadConfig, mutatePersistedConfig } from "../../src/config";
import { captureAccountAutoPauseAttempt, wasAccountAutoPaused } from "../../src/oauth/account-auto-pause";
import { routedProviderConfig } from "../../src/router";
import { saveCredential, getAccountSet } from "../../src/oauth/store";
import { getValidAccessSnapshotForAccount } from "../../src/oauth";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const previousHome = process.env.OPENCODEX_HOME;
let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "ocx-policy-revision-")); process.env.OPENCODEX_HOME = home; });
afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});
const refusal = () => Response.json({ error: { type: "permission_error", message: "Your subscription has expired." } }, { status: 403 });
async function fixture(mode: "key" | "oauth" | "forward" = "key", threshold = 1) {
  const config = getDefaultConfig();
  const name = mode === "oauth" ? "command-code" : "revision-fixture";
  config.providers = { [name]: { adapter: "openai-chat", baseUrl: "https://example.test/v1", authMode: mode,
    accountAutoPause: { enabled: true, consecutiveFailures: threshold }, ...(mode === "key" ? { apiKey: "synthetic-key" } : {}) } };
  config.defaultProvider = name;
  let oauth, codex;
  if (mode === "oauth") {
    await saveCredential(name, { access: "synthetic-access", refresh: "synthetic-refresh", expires: Date.now() + 3_600_000, accountId: "synthetic", source: "oauth" });
    oauth = await getValidAccessSnapshotForAccount(name, getAccountSet(name)!.accounts[0]!.id);
  }
  if (mode === "forward") {
    config.codexAccounts = [{ id: "fixture", email: "", isMain: false }];
    const generation = saveCodexAccountCredential("fixture", { accessToken: "synthetic-access", refreshToken: "synthetic-refresh", expiresAt: Date.now() + 3_600_000, chatgptAccountId: "synthetic" });
    codex = { kind: "pool" as const, accountId: "fixture", generation, writerGeneration: 0, accessToken: "synthetic-access", chatgptAccountId: "synthetic" };
  }
  saveConfig(config);
  const capture = () => {
    const provider = mode === "key" ? routedProviderConfig(name, config.providers[name]!) : config.providers[name]!;
    return captureAccountAutoPauseAttempt(name, provider, { config, oauth, codex }, new Headers({ authorization: `Bearer ${mode === "key" ? provider.apiKey : "synthetic-access"}`,
      ...(codex ? { "chatgpt-account-id": codex.chatgptAccountId } : {}) }))!;
  };
  const paused = () => mode === "key" ? config.providers[name]!.apiKeyPool?.[0]?.disabled === true
    : mode === "oauth" ? getAccountSet(name)!.accounts[0]!.paused === true : config.pausedCodexAccountIds?.includes("fixture") === true;
  return { config, name, capture, paused };
}
for (const mode of ["oauth", "key", "forward"] as const) {
  test(`${mode}: disable/re-enable with a backward clock fences an already captured response`, async () => {
    const f = await fixture(mode);
    const observe = f.capture();
    const oldNow = Date.now;
    try {
      Date.now = () => 1;
      f.config.providers[f.name]!.accountAutoPause!.enabled = false;
      saveConfig(f.config);
      f.config.providers[f.name]!.accountAutoPause!.enabled = true;
      saveConfig(f.config);
    } finally { Date.now = oldNow; }
    const response = await observe(refusal());
    expect(f.paused()).toBe(false);
    expect(wasAccountAutoPaused(response)).toBe(false);
    await f.capture()(refusal());
    expect(f.paused()).toBe(true);
  });
}

function editDisk(edit: (raw: ReturnType<typeof getDefaultConfig>) => void) {
  const path = join(home, "config.json");
  const raw = JSON.parse(readFileSync(path, "utf8"));
  edit(raw);
  writeFileSync(path, JSON.stringify(raw, null, 2) + "\n");
}
async function externalWrite(body: string) {
  const { repoPath, repoRoot } = await import("../helpers/repo-root");
  const child = Bun.spawn([process.execPath, "-e", `import { mutatePersistedConfig } from ${JSON.stringify(repoPath("src/config.ts"))}; ${body}`],
    { cwd: repoRoot(), env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
  const error = await new Response(child.stderr).text();
  expect(await child.exited, error).toBe(0);
}
for (const mode of ["oauth", "key", "forward"] as const) {
  test(`${mode}: disk-only disabled provider cannot pause without reload`, async () => {
    const f = await fixture(mode);
    const observe = f.capture();
    editDisk(raw => { raw.providers[f.name]!.disabled = true; });
    const response = await observe(refusal());
    expect(f.paused()).toBe(false);
    expect(wasAccountAutoPaused(response)).toBe(false);
  });
  test(`${mode}: unrelated write preserves the streak and policy epoch`, async () => {
    const f = await fixture(mode, 2);
    await f.capture()(refusal());
    const before = loadConfig().accountAutoPausePolicyRevisions;
    mutatePersistedConfig(fresh => { fresh.port++; return { changed: true, value: true }; });
    expect(loadConfig().accountAutoPausePolicyRevisions).toEqual(before);
    await f.capture()(refusal());
    expect(f.paused()).toBe(true);
  });
  test(`${mode}: external threshold change is checked at commit`, async () => {
    const f = await fixture(mode);
    const observe = f.capture();
    await externalWrite(`mutatePersistedConfig(c => { c.providers[${JSON.stringify(f.name)}].accountAutoPause.consecutiveFailures = 3; return {changed: true, value: true}; });`);
    const response = await observe(refusal());
    expect(f.paused()).toBe(false);
    expect(wasAccountAutoPaused(response)).toBe(false);
  });
  test(`${mode}: external ABA adopted by reload rejects old attempts and accepts new ones`, async () => {
    const f = await fixture(mode);
    const baseline = structuredClone(f.config);
    const observe = f.capture();
    await externalWrite(`for (const enabled of [false, true]) mutatePersistedConfig(c => { c.providers[${JSON.stringify(f.name)}].accountAutoPause.enabled = enabled; return {changed: true, value: true}; });`);
    const { reconcileLiveConfigFromDisk } = await import("../../src/config/live-reconcile");
    reconcileLiveConfigFromDisk(f.config, baseline);
    const response = await observe(refusal());
    expect(f.paused()).toBe(false);
    expect(wasAccountAutoPaused(response)).toBe(false);
    await f.capture()(refusal());
    expect(f.paused()).toBe(true);
  });
  test(`${mode}: malformed revision map suppresses pauses until a valid write`, async () => {
    const f = await fixture(mode);
    const before = f.capture();
    editDisk(raw => { raw.accountAutoPausePolicyRevisions = { [f.name]: "invalid" }; });
    expect(loadConfig().accountAutoPausePolicyRevisions).toBeNull();
    expect(f.capture()).toBeUndefined();
    expect(wasAccountAutoPaused(await before(refusal()))).toBe(false);
    expect(f.paused()).toBe(false);
    saveConfig(f.config);
    await f.capture()(refusal());
    expect(f.paused()).toBe(true);
  });
}

test("OAuth automatic commit fails fast under a separate-process config lock, then retries", async () => {
  const f = await fixture("oauth");
  const observe = f.capture();
  const { repoPath, repoRoot } = await import("../helpers/repo-root");
  const child = Bun.spawn([process.execPath, "-e", `import { withConfigMutationLockSync } from ${JSON.stringify(repoPath("src/config/mutation-lock.ts"))};
    withConfigMutationLockSync(() => { process.stdout.write("locked"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20000); });`],
    { cwd: repoRoot(), env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
  try {
    const reader = child.stdout.getReader();
    const ready = await reader.read();
    reader.releaseLock();
    expect(new TextDecoder().decode(ready.value)).toBe("locked");
    const started = performance.now();
    const response = await observe(refusal());
    expect(performance.now() - started).toBeLessThan(2000);
    expect(wasAccountAutoPaused(response)).toBe(false);
    expect(f.paused()).toBe(false);
  } finally { child.kill(); await child.exited; }
  await f.capture()(refusal());
  expect(f.paused()).toBe(true);
});

test("reload row replacement changes local generation before a stale verdict can commit", async () => {
  const f = await fixture();
  const observe = f.capture();
  const { adoptPersistedProviderIntoLiveConfig } = await import("../../src/config/live-reconcile");
  const row = structuredClone(f.config.providers[f.name]!);
  row.accountAutoPause!.consecutiveFailures = 3;
  // A raw editor cannot update epochs; local generation still remembers both observations.
  editDisk(raw => { raw.providers[f.name] = row; });
  const changed = loadConfig();
  adoptPersistedProviderIntoLiveConfig(f.config, f.name, row, changed);
  row.accountAutoPause!.consecutiveFailures = 1;
  editDisk(raw => { raw.providers[f.name] = row; });
  adoptPersistedProviderIntoLiveConfig(f.config, f.name, row, loadConfig());
  expect(wasAccountAutoPaused(await observe(refusal()))).toBe(false);
  expect(f.paused()).toBe(false);
  await f.capture()(refusal());
  expect(f.paused()).toBe(true);
});


for (const field of ["baseUrl", "adapter", "authMode"] as const) {
  test(`key: disk-only ${field} change with the same revision rejects a stale pause`, async () => {
    const f = await fixture();
    const observe = f.capture();
    editDisk(raw => {
      const row = raw.providers[f.name]!;
      if (field === "baseUrl") row.baseUrl = "https://changed.test/v1";
      else if (field === "adapter") row.adapter = "anthropic";
      else row.authMode = "oauth";
    });
    expect(wasAccountAutoPaused(await observe(refusal()))).toBe(false);
    expect(f.paused()).toBe(false);
  });
}

test("OAuth policy ABA while waiting for the auth writer never commits the old pause", async () => {
  const f = await fixture("oauth");
  const { mutateStore } = await import("../../src/oauth/store");
  let release!: () => void, entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const held = mutateStore(async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); });
  await ready;
  const observe = f.capture();
  const pending = observe(refusal());
  try {
    for (const enabled of [false, true]) {
      f.config.providers[f.name]!.accountAutoPause!.enabled = enabled;
      saveConfig(f.config);
    }
  } finally { release(); await held; }
  expect(wasAccountAutoPaused(await pending)).toBe(false);
  expect(f.paused()).toBe(false);
  await f.capture()(refusal());
  expect(f.paused()).toBe(true);
});
