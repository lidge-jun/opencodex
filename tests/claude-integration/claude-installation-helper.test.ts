import { afterEach, beforeEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import { clearAccountNeedsReauth } from "../../src/codex/account-runtime-state";
import { clearAccountQuota, setAccountQuotaFromParsed } from "../../src/codex/quota";
import { clearCodexUpstreamHealth, clearThreadAccountMap } from "../../src/codex/routing";
import { saveConfig } from "../../src/config";
import { handleClaudeMessages } from "../../src/server/claude-messages";
import { tryAdmitTurn } from "../../src/server/lifecycle";
import { getRequestLogEntries } from "../../src/server/request-log";
import type { OcxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { drainAndRemoveFixtureRoots } from "../helpers/fixture-teardown";
import { createTempHome, type TempHome } from "../helpers/temp-home";

let home: TempHome;
let upstream: ReturnType<typeof Bun.serve>;
let releaseSpend: () => void;
let bodies: Array<Record<string, unknown>>;
const originalFetch = globalThis.fetch;
const originalAdmission = process.env.OPENCODEX_API_AUTH_TOKEN;
const message = { id: "msg_fixture", type: "message", role: "assistant", model: "claude-x",
  content: [{ type: "text", text: "independent native reply" }], stop_reason: "end_turn", stop_sequence: null,
  usage: { input_tokens: 3, output_tokens: 1 } };
const sse = [
  { type: "message_start", message: { ...message, content: [], stop_reason: null } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "independent native reply" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
  { type: "message_stop" },
].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");

beforeEach(() => {
  home = createTempHome("ocx-claude-installation-helper-");
  delete process.env.OPENCODEX_API_AUTH_TOKEN;
  releaseSpend = acquireOwnedSpendHome();
  clearAccountQuota(); clearCodexUpstreamHealth(); clearThreadAccountMap(); clearAccountNeedsReauth("work");
  bodies = [];
  upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const body = await req.json() as Record<string, unknown>;
    bodies.push(body);
    return body.stream ? new Response(sse, { headers: { "content-type": "text/event-stream" } }) : Response.json(message);
  } });
  globalThis.fetch = ((input, init) => {
    if (!String(input).startsWith(String(upstream.url))) throw new Error("unexpected helper fixture send");
    return originalFetch(input, init);
  }) as typeof fetch;
});
afterEach(async () => {
  globalThis.fetch = originalFetch;
  releaseSpend();
  await upstream.stop(true);
  clearAccountQuota(); clearCodexUpstreamHealth(); clearThreadAccountMap(); clearAccountNeedsReauth("work");
  await drainAndRemoveFixtureRoots({ roots: [{ path: home.root, remove: () => home.remove() }], restoreEnvironment: () => {
    if (originalAdmission === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN;
    else process.env.OPENCODEX_API_AUTH_TOKEN = originalAdmission;
  } });
});

for (const admitted of [false, true]) for (const stream of [false, true]) {
  test(`unavailable optional Pool identity preserves native Messages admitted=${admitted} stream=${stream}`, async () => {
    const cfg = { port: 0, defaultProvider: "anth", activeCodexAccountId: "work", autoSwitchThreshold: 0,
      protocols: { rollout: { managedMessagesNative: true } },
      webSearchSidecar: { enabled: true, backend: "openai" },
      codexAccounts: [{ id: "work", label: "work" }],
      providers: {
        anth: { adapter: "anthropic", baseUrl: String(upstream.url), authMode: "key", apiKey: "fixture-anthropic", allowPrivateNetwork: true, models: ["claude-x"] },
        openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward", codexAccountMode: "pool" },
      },
    } as OcxConfig;
    saveConfig(cfg);
    saveCodexAccountCredential("work", { accessToken: "fixture-work-access", refreshToken: "fixture-work-refresh",
      expiresAt: Date.now() + 3_600_000, chatgptAccountId: "fixture-work-account" });
    setAccountQuotaFromParsed("work", { weeklyPercent: 10 });
    writeFileSync(home.path("codex-installation-secret"), "corrupt", { mode: 0o600 });
    const turnAdmissionLease = admitted ? tryAdmitTurn() : undefined;
    if (admitted) expect(turnAdmissionLease).toBeTruthy();
    const requestId = `helper-identity-${crypto.randomUUID()}`;
    try {
      const response = await handleClaudeMessages(new Request("http://localhost/v1/messages", {
        method: "POST", headers: { "content-type": "application/json", "x-codex-installation-id": "caller-installation" },
        body: JSON.stringify({ model: "anth/claude-x", max_tokens: 32, top_k: 7, stream,
          tools: [{ type: "web_search_20250305", name: "web_search" }], messages: [{ role: "user", content: "fixture" }] }),
      }), cfg, { model: "", provider: "" }, { requestId, start: Date.now(), turnAdmissionLease: turnAdmissionLease ?? undefined });
      const text = await response.text();
      expect(response.status).toBe(200);
      expect(text).toContain("independent native reply");
      expect(bodies).toHaveLength(1);
      expect(bodies[0]).toMatchObject({ model: "claude-x", stream, top_k: 7, tools: [{ type: "web_search_20250305", name: "web_search" }] });
      const rows = getRequestLogEntries().filter(row => row.requestId === requestId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.protocolTrace).toMatchObject({ inbound: "messages", mode: "native" });
      expect(rows[0]!.protocolTrace?.reasonCodes).not.toContain("bridge-only-policy");
      expect(text).not.toContain("codex-installation-secret");
    } finally { turnAdmissionLease?.release(); }
  });
}
