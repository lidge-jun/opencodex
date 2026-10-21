import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OcxConfig } from "../../src/types";
import { getDefaultConfig } from "../../src/config/proxy-env";
import { loadConfig } from "../../src/config";
import { configSchema } from "../../src/config/schema/config-schema";
import { flushConfigDirHardeningForTests } from "../../src/config/paths";
import { clearAccountQuota, updateAccountQuota } from "../../src/codex/auth-api";
import { handleCodexAuthAPI } from "../../src/codex/auth-api/routes";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import * as runtimeConfig from "../../src/codex/auth-api/runtime-config";
import * as authRead from "../../src/codex/auth-collision";
import { setMainAccountPlan } from "../../src/codex/main-account";
import { clearCodexUpstreamHealth, clearThreadAccountMap, previewCodexAccountForRequest, resolveCodexAccountForThread } from "../../src/codex/routing";
import { clearPoolRotationState } from "../../src/codex/pool-rotation";
import { setCodexAccountPin } from "../../src/codex/account-priority";
import { signedInCodexAccountIds } from "../../src/codex/account-preservation";
import { getEligiblePoolAccounts } from "../../src/codex/routing/selection";
import { rememberActiveCodexAccount } from "../../src/codex/routing/active-account";
import { initializeMainAccountPolicyBinding, reconcileMainCodexAccountRuntimeState, resetMainCodexAccountIdentityTrackingForTests } from "../../src/codex/account-lifecycle";
import { acquireNativeMainProfileDrain, resetLifecycleDrainStateForTests } from "../../src/server/lifecycle";
import { setAsyncIcaclsRunnerForTests, setIcaclsRunnerForTests } from "../../src/lib/windows-secret-acl";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let scratch: string;
let authPath: string;
let previousHome: string | undefined, previousCodex: string | undefined;
const aclOk = { success: true, exitCode: 0, timedOut: false, stdout: "", stderr: "" };
function mainLogin(email = "member@example.test", accountId = "workspace-a") {
  const id_token = `h.${Buffer.from(JSON.stringify({ email, chatgpt_account_id: accountId })).toString("base64url")}.s`;
  writeFileSync(authPath, JSON.stringify({ tokens: { access_token: "synthetic-main", id_token, account_id: accountId } }));
}
function config(strategy: OcxConfig["accountPoolStrategy"] = "quota"): OcxConfig {
  // A separate workspace subscription remains eligible; exact native-main clones are excluded.
  const c: OcxConfig = { ...getDefaultConfig(), autoSwitchThreshold: 80,
    accountPoolStrategy: strategy, activeCodexAccountId: "copy", codexPreserveSignedInAccount: true,
    codexAccounts: [{ id: "copy", email: " MEMBER@example.test ", plan: "team", isMain: false },
      { id: "other", email: "other@example.test", isMain: false }],
  };
  for (const id of ["copy", "other"]) saveCodexAccountCredential(id, {
    accessToken: `synthetic-${id}`, refreshToken: `synthetic-refresh-${id}`,
    expiresAt: Date.now() + 300_000, chatgptAccountId: id === "copy" ? "workspace-a" : "workspace-b",
  });
  mainLogin();
  initializeMainAccountPolicyBinding(authPath);
  updateAccountQuota("copy", 1);
  updateAccountQuota("__main__", 2);
  updateAccountQuota("other", 20);
  return c;
}
async function api(c: OcxConfig, body?: unknown) {
  const req = new Request("http://localhost/api/codex-auth/preserve-signed-in", body === undefined ? {} : {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  return (await handleCodexAuthAPI(req, new URL(req.url), c))!;
}
beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME; previousCodex = process.env.CODEX_HOME;
  scratch = mkdtempSync(join(tmpdir(), "ocx-preserve-"));
  const codex = join(scratch, "codex"); mkdirSync(codex); authPath = join(codex, "auth.json");
  process.env.OPENCODEX_HOME = scratch; process.env.CODEX_HOME = codex;
  setIcaclsRunnerForTests(() => aclOk); setAsyncIcaclsRunnerForTests(async () => aclOk);
  resetLifecycleDrainStateForTests(); resetMainCodexAccountIdentityTrackingForTests();
  clearThreadAccountMap(); clearCodexUpstreamHealth(); clearPoolRotationState(); clearAccountQuota(); setMainAccountPlan(null);
});
afterEach(async () => {
  resetLifecycleDrainStateForTests(); resetMainCodexAccountIdentityTrackingForTests();
  clearThreadAccountMap(); clearCodexUpstreamHealth(); clearPoolRotationState(); clearAccountQuota(); setMainAccountPlan(null);
  await flushConfigDirHardeningForTests(); setIcaclsRunnerForTests(null); setAsyncIcaclsRunnerForTests(null);
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previousHome;
  if (previousCodex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousCodex;
  removeTreeWithRetry(scratch);
});

for (const strategy of ["quota", "round-robin", "fill-first", "reset-first"] as const) {
  test(`${strategy}: other identities outrank native main and its separate workspace subscription`, () => {
    const c = config(strategy);
    c.codexAccountPriorities = { copy: 100, __main__: 100, other: -100 };
    rememberActiveCodexAccount(c, "copy");
    expect(previewCodexAccountForRequest(null, c)).toBe("other");
    expect(resolveCodexAccountForThread("new-thread", c)).toBe("other");
    expect(c.codexAccountPriorities).toEqual({ copy: 100, __main__: 100, other: -100 });
  });
  test(`${strategy}: guarded fallback can spend the signed-in quota`, () => {
    const c = config(strategy); c.pausedCodexAccountIds = ["other"];
    expect(["copy", "__main__"]).toContain(resolveCodexAccountForThread(null, c));
    c.pausedCodexAccountIds.push("copy", "__main__");
    expect(getEligiblePoolAccounts(c)).toEqual([]);
  });
}
test("healthy bound thread and manual pin survive policy enable; explicit apply releases both", async () => {
  const c = config(); c.codexPreserveSignedInAccount = false;
  setCodexAccountPin(c, "copy");
  expect(resolveCodexAccountForThread("existing", c)).toBe("copy");
  const auth = readFileSync(authPath, "utf8");
  expect((await api(c, { enabled: true })).status).toBe(200);
  expect(c.activeCodexAccountPinned).toBe("copy");
  expect(resolveCodexAccountForThread("existing", c)).toBe("copy");
  expect(resolveCodexAccountForThread(null, c)).toBe("copy");
  const result = await (await api(c, { enabled: true, applyToBound: true })).json();
  expect(result.bindings).toBe("released-for-next-request"); expect(result.releasedPin).toBe(true);
  expect(result.nextAccountId).toBe("other");
  expect(c.activeCodexAccountPinned).toBeUndefined();
  expect(resolveCodexAccountForThread("existing", c)).toBe("other");
  expect(readFileSync(authPath, "utf8")).toBe(auth);
  expect(loadConfig().codexPreserveSignedInAccount).toBe(true);
});
test("unrelated pin and binding remain intact during explicit application", async () => {
  const c = config(); c.activeCodexAccountId = "other"; setCodexAccountPin(c, "other");
  expect(resolveCodexAccountForThread("unrelated", c)).toBe("other");
  const result = await (await api(c, { enabled: true, applyToBound: true })).json();
  expect(result.releasedPin).toBe(false); expect(c.activeCodexAccountPinned).toBe("other");
  expect(resolveCodexAccountForThread("unrelated", c)).toBe("other");
});
test("same workspace different member and same member different workspace are independent", () => {
  const c = config();
  c.codexAccounts![1]!.email = "another@example.test";
  saveCodexAccountCredential("other", { accessToken: "synthetic", refreshToken: "synthetic-r", expiresAt: Date.now() + 300_000, chatgptAccountId: "workspace-a" });
  expect([...signedInCodexAccountIds(c)]).toEqual(["__main__", "copy"]);
  mainLogin("member@example.test", "workspace-b"); reconcileMainCodexAccountRuntimeState();
  expect([...signedInCodexAccountIds(c)]).toEqual(["__main__"]);
});
test("owned login replacement and pool credential replacement update protected entries", async () => {
  const c = config();
  expect((await (await api(c)).json()).affectedAccountIds).toEqual(["__main__", "copy"]);
  mainLogin("other@example.test", "workspace-b"); reconcileMainCodexAccountRuntimeState();
  expect([...signedInCodexAccountIds(c)]).toEqual(["__main__", "other"]);
  saveCodexAccountCredential("other", { accessToken: "replacement", refreshToken: "replacement-r", expiresAt: Date.now() + 300_000, chatgptAccountId: "workspace-c" });
  expect([...signedInCodexAccountIds(c)]).toEqual(["__main__"]);
});
test("drain selection protects duplicates using memory without reading native credentials", async () => {
  const c = config(); const drain = acquireNativeMainProfileDrain("preservation-test");
  const read = spyOn(authRead, "readCodexTokensResult").mockImplementation(() => { throw new Error("fenced read"); });
  try {
    expect(getEligiblePoolAccounts(c, undefined, Date.now(), undefined, { nativeMainSelectionOnly: true })).toEqual(["other"]);
    expect((await api(c, { enabled: true, applyToBound: true })).status).toBe(503);
    expect(read).not.toHaveBeenCalled();
  } finally { read.mockRestore(); drain.release(); }
});
test("quota threshold, credit hold and model availability still control fallback", () => {
  const c = config(); updateAccountQuota("other", 90);
  expect(getEligiblePoolAccounts(c)).toEqual(["__main__", "copy"]);
  c.creditCodexAccountIds = []; updateAccountQuota("copy", 100, Date.now() + 60_000); updateAccountQuota("__main__", 100, Date.now() + 60_000);
  expect(getEligiblePoolAccounts(c)).toEqual(["other"]);
  expect(getEligiblePoolAccounts(c, undefined, Date.now(), undefined, { modelEligibleAccountIds: new Set(["copy"]) })).toEqual([]);
});
test("status is observational; disabling preserves and restores custom priorities", async () => {
  const c = config(); c.codexAccountPriorities = { copy: 2, other: -2 };
  const result = await (await api(c)).json();
  expect(result.nextAccountId).toBe("other"); expect(c.activeCodexAccountId).toBe("copy");
  const off = await (await api(c, { enabled: false })).json();
  expect(off.nextAccountId).toBe("copy"); expect(off.nextUsesSignedInQuota).toBe(true); expect(c.codexAccountPriorities).toEqual({ copy: 2, other: -2 });
});
for (const body of [null, [], {}, { enabled: "true" }, { enabled: true, applyToBound: 1 }, { enabled: false, applyToBound: true }, { enabled: true, extra: true }]) {
  test(`invalid management policy body ${JSON.stringify(body)} is rejected`, async () => {
    const c = config(); expect((await api(c, body)).status).toBe(400); expect(c.codexPreserveSignedInAccount).toBe(true);
  });
}
test("config loads malformed policy safely without discarding providers", () => {
  expect(configSchema.parse({ ...getDefaultConfig(), codexPreserveSignedInAccount: "true" }).codexPreserveSignedInAccount).toBe(false);
});

test("missing member or conflicting tokens never link an ordinary pool entry", async () => {
  const c = config();
  writeFileSync(authPath, JSON.stringify({ tokens: { access_token: "synthetic-opaque", account_id: "workspace-a" } }));
  reconcileMainCodexAccountRuntimeState();
  expect([...signedInCodexAccountIds(c)]).toEqual(["__main__"]);
  expect((await (await api(c)).json()).identityKnown).toBe(false);
  const conflicting = `h.${Buffer.from(JSON.stringify({ email: "member@example.test", chatgpt_account_id: "workspace-x" })).toString("base64url")}.s`;
  writeFileSync(authPath, JSON.stringify({ tokens: { access_token: "synthetic-opaque", id_token: conflicting, account_id: "workspace-a" } }));
  reconcileMainCodexAccountRuntimeState();
  expect([...signedInCodexAccountIds(c)]).toEqual(["__main__"]);
  expect((await api(c, { enabled: false })).status).toBe(503);
  expect(c.codexPreserveSignedInAccount).toBe(true);
});
test("confirmed main replacement retires main bindings before selecting new work", () => {
  const c = config(); c.codexPreserveSignedInAccount = false; c.activeCodexAccountId = "__main__";
  setCodexAccountPin(c, "__main__"); reconcileMainCodexAccountRuntimeState();
  expect(resolveCodexAccountForThread("native-existing", c)).toBe("__main__");
  mainLogin("other@example.test", "workspace-b"); reconcileMainCodexAccountRuntimeState();
  c.codexPreserveSignedInAccount = true; delete c.activeCodexAccountPinned;
  expect(resolveCodexAccountForThread("native-existing", c)).toBe("copy");
});
test("request-owned credentials cannot change the protected physical login", () => {
  const c = config();
  expect(getEligiblePoolAccounts(c, undefined, Date.now(), undefined, {
    requestOwnedMainCredential: true, isMainAccountTokenLive: () => true,
  })).toEqual(["other"]);
  expect([...signedInCodexAccountIds(c)]).toEqual(["__main__", "copy"]);
});
test("healthy binding without a manual pin stays on its account until explicit transition", async () => {
  const c = config(); c.codexPreserveSignedInAccount = false;
  expect(resolveCodexAccountForThread("bound-only", c)).toBe("copy");
  await api(c, { enabled: true });
  expect(resolveCodexAccountForThread("bound-only", c)).toBe("copy");
  expect(resolveCodexAccountForThread(null, c)).toBe("other");
  await api(c, { enabled: true, applyToBound: true });
  expect(resolveCodexAccountForThread("bound-only", c)).toBe("other");
});

test("transient malformed native-login reads retain the last owned identity preference", () => {
  const c = config(); writeFileSync(authPath, "{");
  reconcileMainCodexAccountRuntimeState();
  expect([...signedInCodexAccountIds(c)]).toEqual(["__main__", "copy"]);
  expect(getEligiblePoolAccounts(c, undefined, Date.now(), undefined, { nativeMainSelectionOnly: true })).toEqual(["other"]);
});

test("failed persistence keeps the previous policy, manual pin and live binding", async () => {
  const c = config(); c.codexPreserveSignedInAccount = false; setCodexAccountPin(c, "copy");
  expect(resolveCodexAccountForThread("save-failure", c)).toBe("copy");
  const save = spyOn(runtimeConfig, "saveRuntimeConfig").mockImplementation(() => { throw new Error("synthetic save failure"); });
  try {
    await expect(api(c, { enabled: true, applyToBound: true })).rejects.toThrow("synthetic save failure");
    expect(c.codexPreserveSignedInAccount).toBe(false); expect(c.activeCodexAccountPinned).toBe("copy");
    expect(resolveCodexAccountForThread("save-failure", c)).toBe("copy");
  } finally { save.mockRestore(); }
});

test("conflicting token claims cannot retract an existing owned identity observation", () => {
  const c = config();
  const id_token = `h.${Buffer.from(JSON.stringify({ email: "member@example.test", chatgpt_account_id: "workspace-x" })).toString("base64url")}.s`;
  writeFileSync(authPath, JSON.stringify({ tokens: { access_token: "synthetic", id_token, account_id: "workspace-a" } }));
  reconcileMainCodexAccountRuntimeState();
  expect([...signedInCodexAccountIds(c)]).toEqual(["__main__", "copy"]);
});
