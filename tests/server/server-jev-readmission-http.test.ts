import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { saveConfig } from "../../src/config";
import { startServer } from "../../src/server";
import * as sidecarAuth from "../../src/server/responses/request-sidecar-auth";
import { readUsageEntries } from "../../src/usage/log";
import { perTurnConfig, resetState, SOL } from "../helpers/jev-session-pin";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { createTempHome } from "../helpers/temp-home";

beforeEach(resetState);
afterEach(() => { mock.restore(); resetState(); });

test.each([
  ["responses", "persists a decision when readmission fails", { status: 503, type: "server_error", code: "combo_unavailable" }],
  ["chat/completions", "persists a decision when readmission fails", { status: 503, type: "server_error", code: "server_is_overloaded" }],
  ["messages", "persists a decision when readmission fails", { status: 503, type: "api_error", code: "combo_unavailable" }],
  ["messages", "honors metered consent revoked by management during image planning", { status: 503, type: "api_error", code: "combo_unavailable" }],
] as const)("%s %s", async (endpoint, scenario, contract) => {
    const revokeConsent = scenario.startsWith("honors");
    const home = createTempHome("ocx-jev-readmission-");
    const releaseSpend = acquireOwnedSpendHome();
    const config = perTurnConfig([], []);
    config.hostname = "127.0.0.1";
    config.apiSurfaces = { messages: { enabled: true } };
    config.combos!.auto!.capabilityPolicy = "union";
    for (const provider of [config.providers.sol!, config.providers.luna!]) provider.inputModalities = ["text"];
    let decisions = 0;
    let children = 0;
    const upstream = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch(request) {
        if (new URL(request.url).pathname === "/systemone") {
          decisions++;
          return Response.json({ answers: { route: { choice: "sol/gpt-5.6-sol:high", confidence: 0.8 } },
            usage: { input_tokens: 8, output_tokens: 2 } });
        }
        children++;
        return Response.json({ error: { message: "unexpected child" } }, { status: 500 });
      },
    });
    delete config.providers.jev;
    config.providers.decision = { adapter: "jev-decision", baseUrl: new URL("/systemone", upstream.url).href,
      authMode: "key", apiKey: "test-key", defaultModel: "test-decision", liveModels: false, allowPrivateNetwork: true };
    const combo = config.combos!.auto!;
    combo.decisionProvider = "decision";
    if (revokeConsent) {
      combo.strategy = "failover";
      delete combo.decisionProvider;
      delete combo.sessionPin;
      combo.targets = [{ ...SOL, metered: true }];
      combo.allowMeteredTargets = true;
    }
    for (const provider of [config.providers.sol!, config.providers.luna!]) {
      provider.baseUrl = new URL("/v1", upstream.url).href;
      provider.allowPrivateNetwork = true;
    }
    const details = "synthetic internal readmission failure";
    let server: ReturnType<typeof startServer> | undefined;
    let saves = 0;
    const probe = spyOn(sidecarAuth, "canDescribeComboImages").mockImplementation(async () => {
      if (revokeConsent && saves === 0) {
        const token = (await Bun.file(home.path("admin-api-token")).text()).trim();
        const save = await fetch(new URL("/api/combos", server!.url), {
          method: "PUT", headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify({ id: "auto", combo: { ...combo, allowMeteredTargets: false } }),
        });
        expect(save.status).toBe(200);
        saves++;
      }
      if (decisions) throw new Error(details);
      return false;
    });
    try {
      saveConfig(config);
      server = startServer(0);
      const imageUrl = "https://example.test/fixture.png";
      const image = endpoint === "responses" ? { type: "input_image", image_url: imageUrl }
        : endpoint === "messages" ? { type: "image", source: { type: "url", url: imageUrl } }
          : { type: "image_url", image_url: { url: imageUrl } };
      const messages = [{ role: "user", content: [image] }];
      const response = await fetch(new URL("/v1/" + endpoint, server.url), {
        method: "POST",
        headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: "jev-auto", stream: false,
          ...(endpoint === "responses" ? { input: messages } : { messages, max_tokens: 64 }) }),
      });
      expect(response.status).toBe(contract.status);
      const text = await response.text();
      expect(JSON.parse(text).error).toMatchObject({ type: contract.type, code: contract.code });
      expect(text).not.toContain(details);
      expect(decisions).toBe(revokeConsent ? 0 : 1);
      expect(children).toBe(0);
      if (revokeConsent) {
        expect(saves).toBe(1);
        return;
      }
      const rows = readUsageEntries();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.jevDecision?.usage).toMatchObject({ inputTokens: 8, outputTokens: 2, totalTokens: 10 });
    } finally {
      try { await server?.stop(true); }
      finally {
        probe.mockRestore();
        await upstream.stop(true);
        try { releaseSpend(); }
        finally { home.remove(); }
      }
    }
  },
);
