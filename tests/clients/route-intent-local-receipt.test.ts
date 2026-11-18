import { expect, test } from "bun:test";
import { createTempHome } from "../helpers/temp-home";
import { projectHomeRouteIntent, ROUTE_CLIENT_IDS, parseRouteClientOutcomes, routeClientOutcomesForPeer } from "../../src/link/route-intent";
import { writeRouteIntentReceipt, readRouteIntentReceiptStrict } from "../../src/integrations/route-intent-state";
import type { OcxConfig } from "../../src/types";

test("long local paths and multiline diagnostics remain readable locally and never cross the peer boundary", () => {
  const home = createTempHome("route-local-diagnostic-");
  try {
    const document = projectHomeRouteIntent({ port: 18274, providers: {} } as OcxConfig, "1");
    const target = `C:\\Users\\${"nested-path\\".repeat(40)}models.json`;
    const message = "Write refused.\nPreserve the owned snapshot and retry.";
    const outcomes = ROUTE_CLIENT_IDS.map(client => ({ client, outcome: "current" as const,
      ...(client === "pi" ? { target, message } : {}) }));
    writeRouteIntentReceipt({ version: 1, document, clients: document.clients, sources: document.sources, selectedClients: ["codex", "claude"],
      outcomes, appliedRouteIntentDigest: null, appliedAt: new Date().toISOString() }, home.path("route-state"));
    expect(readRouteIntentReceiptStrict(home.path("route-state"))?.outcomes.find(row => row.client === "pi"))
      .toMatchObject({ target, message });
    expect(parseRouteClientOutcomes(outcomes)).toBeNull();
    const peer = routeClientOutcomesForPeer(outcomes);
    expect(parseRouteClientOutcomes(peer)).not.toBeNull();
    expect(JSON.stringify(peer)).not.toContain("nested-path");
    expect(JSON.stringify(peer)).not.toContain("snapshot");
  } finally { home.remove(); }
});
