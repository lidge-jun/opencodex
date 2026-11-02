import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAIN_CODEX_ACCOUNT_ID } from "../../src/codex/main-account";
import { clearMainAccountInfoCache } from "../../src/codex/auth-api";
import { fakeChatGptJwt } from "../helpers/fake-chatgpt-jwt";
import { recordCodexThreadLineage, resolveCodexThreadLineage } from "../../src/codex/lineage";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import { clearThreadAccountMap, clearCodexUpstreamHealth } from "../../src/codex/routing";
import { clearAccountQuota, updateAccountQuota } from "../../src/codex/auth-api";
import { handleClaudeMessages } from "../../src/server/claude-messages";
import { tryAdmitTurn } from "../../src/server/lifecycle";
import type { DataPlaneAdmission } from "../../src/server/auth-cors";
import type { OcxConfig } from "../../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const originalFetch = globalThis.fetch;
const local: DataPlaneAdmission = { kind: "loopback", source: "loopback" };
let home: string, previous: string | undefined, isolated: IsolatedCodexHome, release: () => void;
let wires: Headers[];
let cfg: OcxConfig;

beforeEach(() => {
  previous = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-bridge-pool-"));
  process.env.OPENCODEX_HOME = home;
  isolated = installIsolatedCodexHome("ocx-bridge-codex-");
  release = acquireOwnedSpendHome();
  clearThreadAccountMap(); clearCodexUpstreamHealth(); clearAccountQuota();
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
  removeTreeWithRetry(home); clearThreadAccountMap(); clearCodexUpstreamHealth(); clearAccountQuota();
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
  expect(wires[0]!.get("session_id")).toBe("9745d86c-d579-494a-8d0e-f69a5214cf96");
});

test("an existing child lineage retains its account across bridge turns", async () => {
  const child = "9745d86c-d579-494a-8d0e-f69a5214cf96";
  const rootHeaders = new Headers({ "session-id": "fixture-root", "thread-id": "fixture-root" });
  const childHeaders = new Headers({ "session-id": child, "thread-id": child, "x-codex-parent-thread-id": "fixture-root" });
  recordCodexThreadLineage(rootHeaders);
  recordCodexThreadLineage(childHeaders);
  const rootPair = new Headers({ "session-id": child, "thread-id": child });
  expect(resolveCodexThreadLineage(rootPair)?.parentThreadId).toBe("fixture-root");
  await turn("user_test_account__session_conversation-native");
  await turn("user_test_account__session_conversation-native");
  expect(wires[0]!.get("chatgpt-account-id")).toBeTruthy();
  expect(wires[0]!.get("chatgpt-account-id")).toBe(wires[1]!.get("chatgpt-account-id"));
  expect(resolveCodexThreadLineage(rootPair)?.parentThreadId).toBe("fixture-root");
});

test("remote principals produce stable distinct upstream identities", async () => {
  const principal = (id: string): DataPlaneAdmission => ({ kind: "configured", keyId: "fixture", source: "dedicated", contextPrincipalId: id });
  for (const id of ["a", "b", "a"]) await turn("user_test_account__session_conversation-native", principal(id));
  expect(wires[0]!.get("session_id")).toMatch(/^[0-9a-f]{64}$/);
  expect(wires[0]!.get("session_id")).toBe(wires[2]!.get("session_id"));
  expect(wires[0]!.get("session_id")).not.toBe(wires[1]!.get("session_id"));
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

for (const mode of ["stored", "main"] as const) for (const variant of ["local", "remote", "header"] as const) test(`${mode} pool 401 refresh preserves ${variant} identity on retry`, async () => {
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
    expect(wires[0]!.get(name)).toBeTruthy();
    expect(wires[1]!.get(name)).toBe(wires[0]!.get(name));
  }
});
