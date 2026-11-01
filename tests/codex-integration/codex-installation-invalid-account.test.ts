import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../../src/config";
import { MAIN_CODEX_ACCOUNT_ID } from "../../src/codex/account-id";
import { markAccountNeedsReauth } from "../../src/codex/account-runtime-state";
import { getCodexAccountCredential, inspectLocalCodexCredentialSlots } from "../../src/codex/account-store";
import { headersForCodexAuthContext, resolveCodexAuthContext, type CodexAuthContext } from "../../src/codex/auth-context";
import { isolateCodexPoolClientMetadata, rewriteTurnMetadataInstallationId } from "../../src/codex/forward-transport-headers";
import { CodexInstallationIdUnavailableError } from "../../src/codex/installation-id";
import { sendUpstreamFrame } from "../../src/server/index/live-sideband";
import { handleLive, resolveLiveSidebandUpgrade } from "../../src/server/live";
import { tryAdmitTurn } from "../../src/server/lifecycle";
import { handleResponses, handleResponsesCompact } from "../../src/server/responses";
import { handleSearch } from "../../src/server/search";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { callerId, install, installationLiveFixture, liveConfig, metadata, turn } from "../helpers/codex-installation-live";

const fixture = installationLiveFixture();
const originalFetch = globalThis.fetch;
function credential(account: string) {
  return { accessToken: "fixture-token", refreshToken: "fixture-refresh", expiresAt: Date.now() + 3_600_000, chatgptAccountId: account };
}
for (const account of ["", "   ", "\t\r\n"]) {
  for (const wrapped of [false, true]) test(`credential admission rejects ${JSON.stringify(account)} wrapped=${wrapped}`, async () => {
    const value = wrapped ? { generation: 1, credential: credential(account) } : credential(account);
    writeFileSync(join(getConfigDir(), "codex-accounts.json"), JSON.stringify({ "live-a": value }));
    expect(getCodexAccountCredential("live-a")).toBeNull();
    expect(() => inspectLocalCodexCredentialSlots({ "live-a": value })).toThrow();
    await expect(resolveCodexAuthContext(new Headers(), liveConfig(), "pool", { accountId: "live-a" })).rejects.toThrow();
  });
  for (const corrupt of [false, true]) {
    for (const mode of ["direct", "turn", "absent"] as const) test(`projection refuses invalid pool ${JSON.stringify(account)} ${mode} corrupt=${corrupt}`, () => {
      if (corrupt) fixture.corrupt();
      const cm = mode === "direct" ? { [install]: callerId } : mode === "turn" ? { [turn]: JSON.stringify({ installation_id: callerId }) } : {};
      const body = { client_metadata: cm };
      const original = JSON.stringify(body);
      const context = { kind: "pool", accountId: "live-a", chatgptAccountId: account, accessToken: "fixture-token" } as CodexAuthContext;
      expect(() => headersForCodexAuthContext(new Headers(cm), context)).toThrow(CodexInstallationIdUnavailableError);
      expect(() => isolateCodexPoolClientMetadata(body, account)).toThrow(CodexInstallationIdUnavailableError);
      expect(() => rewriteTurnMetadataInstallationId(JSON.stringify({ installation_id: callerId }), account)).toThrow(CodexInstallationIdUnavailableError);
      const frames: unknown[] = [];
      const upstream = { send(value: unknown) { frames.push(value); } } as unknown as WebSocket;
      const frame = JSON.stringify({ type: "session.update", session: body });
      expect(() => sendUpstreamFrame(upstream, frame, context)).toThrow(CodexInstallationIdUnavailableError);
      expect(frames).toHaveLength(0);
      expect(JSON.stringify(body)).toBe(original);
    });
  }
}
test("main and main-pool retain turn metadata; absent pool surfaces do not read secret storage", () => {
  fixture.corrupt();
  for (const kind of ["main", "main-pool"] as const) {
    const headers = new Headers({ [turn]: JSON.stringify({ installation_id: callerId }) });
    const context = { kind, chatgptAccountId: "", accessToken: "fixture-token" } as CodexAuthContext;
    expect(headersForCodexAuthContext(headers, context).get(turn)).toBe(headers.get(turn));
  }
  const body = { client_metadata: metadata(false) };
  expect(isolateCodexPoolClientMetadata(body, "canonical-live-a")).toBe(body);
  expect(isolateCodexPoolClientMetadata(body, undefined)).toBe(body);
});
for (const account of ["", "   "]) for (const corrupt of [false, true]) {
  for (const inHeader of [false, true]) for (const [surface, handler] of [
    ["responses", handleResponses], ["responses/compact", handleResponsesCompact], ["alpha/search", handleSearch], ["live", handleLive],
  ] as const) test(`stored invalid account HTTP ${JSON.stringify(account)} ${surface} header=${inHeader} corrupt=${corrupt}`, async () => {
    writeFileSync(join(getConfigDir(), "codex-accounts.json"), JSON.stringify({ "live-a": credential(account) }));
    markAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID);
    if (corrupt) fixture.corrupt();
    const config = liveConfig(); config.providers.openai!.upstreamWebsocket = false;
    const rawTurn = JSON.stringify({ installation_id: callerId });
    const cm = inHeader ? {} : { [turn]: rawTurn };
    const req = new Request(`http://localhost/v1/${surface}`, { method: "POST", headers: {
      "content-type": "application/json", ...(inHeader ? { [turn]: rawTurn } : {}),
    }, body: JSON.stringify({ model: "gpt-5.5", input: [], stream: false, query: "fixture", sdp: "v=0 offer",
      client_metadata: cm, session: { model: "gpt-live-1", client_metadata: cm } }) });
    const sends: unknown[] = [];
    const release = acquireOwnedSpendHome();
    globalThis.fetch = (async (input, init) => {
      sends.push(new Request(input, init));
      return Response.json({ id: "fixture", output: [] });
    }) as typeof fetch;
    try {
      const response = await handler(req, config, { model: "", provider: "" });
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(sends).toHaveLength(0);
    } finally { globalThis.fetch = originalFetch; release(); }
  });
  test(`stored invalid account refuses Live WS admission ${JSON.stringify(account)} corrupt=${corrupt}`, async () => {
    writeFileSync(join(getConfigDir(), "codex-accounts.json"), JSON.stringify({ "live-a": credential(account) }));
    markAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID);
    if (corrupt) fixture.corrupt();
    const lease = tryAdmitTurn()!;
    try {
      const selected = await resolveLiveSidebandUpgrade(new Request("http://localhost/v1/live"), liveConfig(),
        { model: "", provider: "" }, { style: "frameless-standalone", query: "model=gpt-live-1" }, lease);
      expect(selected).toBeInstanceOf(Response);
      expect((selected as Response).status).toBeGreaterThanOrEqual(400);
    } finally { lease.release(); }
  });
}
