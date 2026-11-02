import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAIN_CODEX_ACCOUNT_ID } from "../../src/codex/main-account";
import { clearMainAccountInfoCache } from "../../src/codex/auth-api";
import { fakeChatGptJwt } from "../helpers/fake-chatgpt-jwt";
import { clearCodexThreadLineageForTests, recordCodexThreadLineage, resolveCodexThreadLineage } from "../../src/codex/lineage";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import { clearThreadAccountMap, clearCodexUpstreamHealth } from "../../src/codex/routing";
import { codexPoolAffinityKey } from "../../src/codex/auth-context";
import * as authContext from "../../src/codex/auth-context";
import { clearConversationStateIssuerMap, peekConversationStateIssuer } from "../../src/codex/routing/thread-affinity";
import { clearAccountQuota, updateAccountQuota } from "../../src/codex/auth-api";
import { handleClaudeMessages } from "../../src/server/claude-messages";
import { resolveClaudeBridgePoolSession } from "../../src/server/claude-bridge-pool-session";
import { tryAdmitTurn } from "../../src/server/lifecycle";
import type { DataPlaneAdmission } from "../../src/server/auth-cors";
import type { OcxConfig } from "../../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const originalFetch = globalThis.fetch;
const local: DataPlaneAdmission = { kind: "loopback", source: "loopback" };
const metadataUuid = "9745d86c-d579-494a-8d0e-f69a5214cf96";
const principal = (id: string): DataPlaneAdmission => ({ kind: "configured", keyId: "fixture", source: "dedicated", contextPrincipalId: id });
// What a caller could compute from public inputs; the keyed bridge identity must never equal it.
const publicDigest = (principalId: string, value: string) => new Bun.CryptoHasher("sha256")
  .update(JSON.stringify(["opencodex-caller-session-v1", principalId, value])).digest("hex");
// The bridge's own identity for these inputs (same process key), used to read its bookkeeping.
const bridgeIdentity = (admission: DataPlaneAdmission, ingress: Record<string, string> = {}, metadataSessionId?: string) =>
  resolveClaudeBridgePoolSession({ ingress: new Headers(ingress), replay: new Headers(ingress), admission, metadataSessionId })!;
const poolKey = (identity: string) => codexPoolAffinityKey(new Headers({ "session-id": identity, "thread-id": identity }))!;
const account = (wire: Headers | undefined) => wire?.get("chatgpt-account-id");
/** The pool identity is selection-only: no attempt may carry a synthesized pair upstream. */
function expectNoSynthesizedPair(wire: Headers) {
  expect(wire.has("session-id")).toBe(false);
  expect(wire.has("thread-id")).toBe(false);
  for (const name of ["session_id", "session-id", "thread-id"]) expect(wire.get(name) ?? "").not.toMatch(/^[0-9a-f]{64}$/);
}
let home: string, previous: string | undefined, isolated: IsolatedCodexHome, release: () => void;
let wires: Headers[];
let cfg: OcxConfig;

beforeEach(() => {
  previous = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-bridge-pool-"));
  process.env.OPENCODEX_HOME = home;
  isolated = installIsolatedCodexHome("ocx-bridge-codex-");
  release = acquireOwnedSpendHome();
  clearThreadAccountMap(); clearCodexUpstreamHealth(); clearAccountQuota(); clearCodexThreadLineageForTests(); clearConversationStateIssuerMap();
  for (const id of ["fixture-a", "fixture-b"]) {
    saveCodexAccountCredential(id, { accessToken: `fixture-access-${id}`, refreshToken: `fixture-refresh-${id}`, expiresAt: Date.now() + 3_600_000, chatgptAccountId: `account-${id}` });
    updateAccountQuota(id, 10, 10);
  }
  cfg = { defaultProvider: "openai", activeCodexAccountId: "fixture-a", autoSwitchThreshold: 0,
    accountPoolStrategy: "round-robin", accountPoolStickyLimit: 1,
    codexAccounts: [{ id: "fixture-a", label: "a" }, { id: "fixture-b", label: "b" }],
    providers: { openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward", codexAccountMode: "pool", upstreamWebsocket: false } },
  } as unknown as OcxConfig;
  wires = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    wires.push(new Headers(init?.headers));
    return Response.json({ id: "resp_fixture", object: "response", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 } });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch; clearMainAccountInfoCache(); release(); isolated.restore();
  if (previous === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previous;
  removeTreeWithRetry(home); clearThreadAccountMap(); clearCodexUpstreamHealth(); clearAccountQuota(); clearCodexThreadLineageForTests(); clearConversationStateIssuerMap();
});

async function turn(session: string | undefined, admission: DataPlaneAdmission = local, headers: Record<string, string> = {}, model = "openai/gpt-5.4") {
  const lease = tryAdmitTurn();
  expect(lease).not.toBeNull();
  try {
    const response = await handleClaudeMessages(new Request("http://localhost/v1/messages", { method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ model, max_tokens: 32, stream: false, ...(session ? { metadata: { user_id: session } } : {}), messages: [{ role: "user", content: "ping" }] }),
    }), cfg, { model: "", provider: "" }, { requestId: "fixture", start: Date.now(), turnAdmissionLease: lease!, admission });
    await response.text();
    expect(response.status).toBe(200);
  } finally { lease?.release(); }
}

test("pool binds multiple turns and separates sessions while preserving the native session", async () => {
  for (const session of ["user_test_account__session_conversation-native", "user_test_account__session_conversation-native", "user_test_account__session_other", "user_test_account__session_other"]) await turn(session);
  expect(wires).toHaveLength(4);
  expect(wires[0]!.get("chatgpt-account-id")).toBe(wires[1]!.get("chatgpt-account-id"));
  expect(wires[2]!.get("chatgpt-account-id")).toBe(wires[3]!.get("chatgpt-account-id"));
  expect(wires[0]!.get("chatgpt-account-id")).not.toBe(wires[2]!.get("chatgpt-account-id"));
  expect(wires[0]!.get("session_id")).toBe(metadataUuid);
  for (const wire of wires) expectNoSynthesizedPair(wire);
});

test("a synthesized identity with a recorded parent follows the parent's account", async () => {
  const child = bridgeIdentity(local, {}, metadataUuid);
  // A complete caller pair keeps dev behavior, so this binds the root to the first round-robin pick.
  await turn(undefined, local, { "session-id": "fixture-root", "thread-id": "fixture-root" });
  const childHeaders = new Headers({ "session-id": child, "thread-id": child, "x-codex-parent-thread-id": "fixture-root" });
  recordCodexThreadLineage(childHeaders);
  const rootPair = new Headers({ "session-id": child, "thread-id": child });
  expect(resolveCodexThreadLineage(rootPair)?.parentThreadId).toBe("fixture-root");
  await turn("user_test_account__session_conversation-native");
  await turn("user_test_account__session_conversation-native");
  // Control: an unrelated cold session lands on the other account, so the child's placement
  // above came from the recorded parent rather than from a cold pick.
  await turn("user_test_account__session_unrelated");
  const rootAccount = wires[0]!.get("chatgpt-account-id");
  expect(rootAccount).toBeTruthy();
  expect(wires[1]!.get("chatgpt-account-id")).toBe(rootAccount);
  expect(wires[2]!.get("chatgpt-account-id")).toBe(rootAccount);
  expect(wires[3]!.get("chatgpt-account-id")).not.toBe(rootAccount);
  expect(resolveCodexThreadLineage(rootPair)?.parentThreadId).toBe("fixture-root");
});

test("remote principals with identical metadata pin separately and keep the dev wire", async () => {
  for (const id of ["a", "a", "b", "b", "a"]) await turn("user_test_account__session_conversation-native", principal(id));
  expect(account(wires[1])).toBe(account(wires[0]));
  expect(account(wires[2])).not.toBe(account(wires[0]));
  expect(account(wires[3])).toBe(account(wires[2]));
  expect(account(wires[4])).toBe(account(wires[0]));
  for (const wire of wires) {
    expect(wire.get("session_id")).toBe(metadataUuid);
    expectNoSynthesizedPair(wire);
  }
});

test("remote principals sending the same session alias do not share a pool binding", async () => {
  for (const id of ["a", "a", "b", "b", "a"]) await turn(undefined, principal(id), { session_id: "fixture-alias" });
  expect(account(wires[1])).toBe(account(wires[0]));
  expect(account(wires[2])).not.toBe(account(wires[0]));
  expect(account(wires[3])).toBe(account(wires[2]));
  expect(account(wires[4])).toBe(account(wires[0]));
  for (const wire of wires) {
    expect(wire.get("session_id")).toBe("fixture-alias");
    expectNoSynthesizedPair(wire);
  }
});

test("an alias equal to another principal's derived identity does not join that binding", async () => {
  await turn("user_test_account__session_conversation-native", principal("b"));
  const victim = bridgeIdentity(principal("b"), {}, metadataUuid);
  await turn(undefined, principal("a"), { session_id: victim });
  await turn(undefined, principal("a"), { session_id: victim });
  expect(account(wires[1])).not.toBe(account(wires[0]));
  expect(account(wires[2])).toBe(account(wires[1]));
  expect(peekConversationStateIssuer(poolKey(victim))).toBe(account(wires[0])!.replace(/^account-/, ""));
});

test("a complete caller pair built from public inputs cannot address a synthesized identity", async () => {
  await turn("user_test_account__session_conversation-native", principal("b"));
  const victim = bridgeIdentity(principal("b"), {}, metadataUuid);
  const victimAccount = account(wires[0])!.replace(/^account-/, "");
  // Raw metadata session and the publicly computable digest are what an attacker could know.
  for (const guess of [metadataUuid, publicDigest("b", metadataUuid)]) {
    expect(guess).not.toBe(victim);
    expect(poolKey(guess)).not.toBe(poolKey(victim));
    await turn(undefined, principal("a"), { "session-id": guess, "thread-id": guess });
  }
  expect(account(wires[1])).not.toBe(account(wires[0]));
  expect(peekConversationStateIssuer(poolKey(victim))).toBe(victimAccount);
});

test("caller session-id aliases and complete pairs reach the wire exactly as sent", async () => {
  await turn(undefined, local, { "session-id": "fixture-hyphen" });
  expect(wires[0]!.get("session-id")).toBe("fixture-hyphen");
  expect(wires[0]!.get("session_id")).toBe("fixture-hyphen");
  expect(wires[0]!.has("thread-id")).toBe(false);
  await turn(undefined, principal("a"), { "session-id": "fixture-pair", "thread-id": "fixture-pair" });
  expect(wires[1]!.get("session-id")).toBe("fixture-pair");
  expect(wires[1]!.get("thread-id")).toBe("fixture-pair");
});

test("spawn markers do not synthesize thread identity", async () => {
  for (const marker of [{ "x-openai-subagent": "collab_spawn" }, { "x-codex-turn-metadata": '{"subagent_kind":"thread_spawn"}' }]) {
    await turn("user_test_account__session_conversation-native", local, marker);
  }
  expect(wires).toHaveLength(2);
  for (const wire of wires) expect(wire.has("thread-id")).toBe(false);
});

test("API-key Responses routes do not receive pool identity", async () => {
  cfg.providers.other = { adapter: "openai-responses", authMode: "key", apiKey: "fixture-key", baseUrl: "https://example.invalid/v1", models: ["m"] };
  await turn("user_test_account__session_conversation-native", local, {}, "other/m");
  expect(wires[0]!.has("thread-id")).toBe(false);
  expect(wires[0]!.has("session-id")).toBe(false);
});

for (const mode of ["stored", "main"] as const) for (const variant of ["local", "remote", "header"] as const) test(`${mode} pool 401 refresh keeps the dev wire for ${variant} identity on retry`, async () => {
  cfg.codexAccounts = mode === "stored" ? [{ id: "fixture-a", label: "a" }] : [];
  if (mode === "main") {
    cfg.activeCodexAccountId = MAIN_CODEX_ACCOUNT_ID;
    clearMainAccountInfoCache();
    const token = fakeChatGptJwt({ exp: Math.floor(Date.now() / 1000) + 86400, chatgpt_account_id: "fixture-main" });
    writeFileSync(join(isolated.path, "auth.json"), JSON.stringify({ tokens: { access_token: token, refresh_token: "fixture-main-grant", account_id: "fixture-main" } }));
  }
  let refreshes = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === "auth.openai.com") {
      refreshes++;
      return Response.json({ access_token: mode === "main" ? fakeChatGptJwt({ exp: Math.floor(Date.now() / 1000) + 86400, chatgpt_account_id: "fixture-main" }) : "fixture-refreshed-access", refresh_token: "fixture-refreshed-grant", expires_in: 3600 });
    }
    if (!url.pathname.endsWith("/responses")) return Response.json({ rate_limit: { primary_window: { used_percent: 10 } } });
    wires.push(new Headers(init?.headers));
    return wires.length === 1 ? Response.json({ error: { message: "expired" } }, { status: 401 })
      : Response.json({ id: "resp_fixture", object: "response", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 } });
  }) as typeof fetch;
  const admission: DataPlaneAdmission = variant === "remote" ? { kind: "configured", keyId: "fixture", source: "dedicated", contextPrincipalId: "fixture-principal" } : local;
  await turn(variant === "header" ? undefined : "user_test_account__session_conversation-native", admission,
    variant === "header" ? { "x-claude-code-session-id": "fixture-header" } : {});
  expect(refreshes).toBe(1);
  expect(wires).toHaveLength(2);
  for (const name of ["session_id", "session-id", "thread-id"]) {
    expect(wires[1]!.get(name)).toBe(wires[0]!.get(name));
  }
  expect(wires[0]!.get("session_id")).toBe(variant === "header" ? null : metadataUuid);
  for (const wire of wires) expectNoSynthesizedPair(wire);
});

for (const variant of ["local-metadata", "remote-alias"] as const) test(`alternate-account failover binds ${variant} under the initial selection key`, async () => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!url.pathname.endsWith("/responses")) return Response.json({ rate_limit: { primary_window: { used_percent: 10 } } });
    wires.push(new Headers(init?.headers));
    return wires.length === 1 ? Response.json({ error: { message: "rate limited" } }, { status: 429 })
      : Response.json({ id: "resp_fixture", object: "response", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 } });
  }) as typeof fetch;
  const send = () => variant === "local-metadata"
    ? turn("user_test_account__session_conversation-native")
    : turn(undefined, principal("fixture-principal"), { session_id: "fixture-alias" });
  // Observe the alternate pick itself: its selection headers must carry the initial pool key.
  const alternatePickKeys: Array<string | undefined> = [];
  const resolveSpy = spyOn(authContext, "resolveCodexAuthContext");
  try {
    await send();
    for (const call of resolveSpy.mock.calls) {
      const [headers, , , options] = call as Parameters<typeof authContext.resolveCodexAuthContext>;
      if (options?.excludeAccountId) alternatePickKeys.push(codexPoolAffinityKey(headers));
    }
  } finally { resolveSpy.mockRestore(); }
  expect(wires).toHaveLength(2);
  const alternate = account(wires[1]);
  expect(alternate).toBeTruthy();
  expect(alternate).not.toBe(account(wires[0]));
  const identity = variant === "local-metadata"
    ? bridgeIdentity(local, {}, metadataUuid)
    : bridgeIdentity(principal("fixture-principal"), { session_id: "fixture-alias" });
  const key = poolKey(identity);
  expect(alternatePickKeys).toEqual([key]);
  // The alternate account's conversation-state issuer is recorded under the initial selection key.
  expect(peekConversationStateIssuer(key)).toBe(alternate!.replace(/^account-/, ""));
  await send();
  expect(account(wires[2])).toBe(alternate);
  for (const wire of wires) expectNoSynthesizedPair(wire);
});
