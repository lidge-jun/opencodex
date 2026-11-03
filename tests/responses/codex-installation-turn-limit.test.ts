import { afterEach, beforeEach, expect, test } from "bun:test";
import { handleResponses, handleResponsesCompact } from "../../src/server/responses";
import { handleSearch } from "../../src/server/search";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { install, installationLiveFixture, liveConfig, turn, turnMetadataBytes } from "../helpers/codex-installation-live";

const fixture = installationLiveFixture();
const originalFetch = globalThis.fetch;
let release: () => void;
let sent: Request[];
beforeEach(() => {
  release = acquireOwnedSpendHome(); sent = [];
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init); sent.push(request);
    return Response.json({ id: "resp_turn_limit_fixture", status: "completed", output: [] });
  }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = originalFetch; release(); });
for (const surface of ["Responses", "compact", "search"] as const)
for (const header of [false, true]) for (const bytes of [32768, 32769]) {
  test(`${surface} ${header ? "header" : "body-only"} turn metadata ${bytes} bytes`, async () => {
    const raw = turnMetadataBytes(bytes);
    const config = liveConfig(); config.providers.openai!.upstreamWebsocket = false;
    const headers = new Headers({ "content-type": "application/json" }); if (header) headers.set(turn, raw);
    const req = new Request(`http://localhost/v1/${surface === "compact" ? "responses/compact" : surface === "search" ? "alpha/search" : "responses"}`, {
      method: "POST", headers, body: JSON.stringify({ model: "gpt-5.5", input: [], stream: false,
        ...(header ? {} : { client_metadata: { [turn]: raw } }) }),
    });
    const handler = surface === "compact" ? handleResponsesCompact : surface === "search" ? handleSearch : handleResponses;
    const response = await handler(req, config, { model: "", provider: "" });
    expect(response.status).toBe(bytes > 32768 ? 503 : 200);
    if (bytes > 32768) {
      expect(sent).toHaveLength(0);
      expect(await response.json()).toEqual({ error: { type: "server_error", code: "server_is_overloaded", message: "Codex installation identity unavailable" } });
    } else {
      await response.text(); expect(sent).toHaveLength(1);
      const wire = sent[0]!;
      const metadata = header ? wire.headers.get(turn) : (await wire.json()).client_metadata[turn];
      expect(JSON.parse(metadata).installation_id).toBe(fixture.expected());
      expect(wire.headers.has(install)).toBe(false);
    }
  });
}
