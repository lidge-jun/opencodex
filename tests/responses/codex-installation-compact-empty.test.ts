import { afterEach, beforeEach, expect, test } from "bun:test";
import { handleResponsesCompact } from "../../src/server/responses";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { callerToken, install, installationLiveFixture, liveConfig, turn } from "../helpers/codex-installation-live";

const fixture = installationLiveFixture();
const originalFetch = globalThis.fetch;
let release: () => void;
let sent: Request[];
beforeEach(() => {
  release = acquireOwnedSpendHome(); sent = [];
  globalThis.fetch = (async (input, init) => {
    const req = new Request(input, init);
    if (req.url.endsWith("/responses/compact")) {
      sent.push(req); return Response.json({ detail: "Not Found" }, { status: 404 });
    }
    if (!req.url.endsWith("/responses")) throw new Error("unexpected compact fixture upstream");
    sent.push(req);
    return new Response('data: ' + JSON.stringify({ type: "response.completed", response: {
      id: "resp_fixture_compact", status: "completed", output: [{ type: "compaction", encrypted_content: "fixture-opaque" }],
    } }) + '\n\n', { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = originalFetch; release(); });

for (const kind of ["main", "main-pool", "pool"] as const) for (const name of [install, turn, "absent"] as const) {
  test(`native 404 routed compact preserves ${kind} ${name} existence and empty value`, async () => {
    const cfg = liveConfig(kind); cfg.providers.openai!.upstreamWebsocket = false;
    const headers = new Headers({ "content-type": "application/json", authorization: `Bearer ${callerToken}`, "chatgpt-account-id": "caller-account" });
    if (name !== "absent") headers.set(name, "");
    const req = new Request("http://localhost/v1/responses/compact", { method: "POST", headers,
      body: JSON.stringify({ model: "gpt-5.5", input: [{ role: "user", content: "fixture history" }] }) });
    const response = await handleResponsesCompact(req, cfg, { model: "", provider: "" });
    expect(response.status).toBe(200); await response.text();
    expect(sent.map(req => new URL(req.url).pathname)).toEqual(["/backend-api/codex/responses/compact", "/backend-api/codex/responses"]);
    for (const wire of sent) for (const key of [install, turn]) {
      expect(wire.headers.has(key)).toBe(key === name);
      if (key === name) expect(wire.headers.get(key)).toBe(kind === "pool" && key === install ? fixture.expected() : "");
    }
    expect(req.headers.get(name)).toBe(name === "absent" ? null : "");
  });
}
