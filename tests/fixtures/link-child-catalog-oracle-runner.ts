/**
 * The A3 oracle's Child (050): a separate process with its own OPENCODEX_HOME and CODEX_HOME, prepared as a connected
 * Remote Link Child. "setup" seeds it; "sync" stands in for the Child's `ocx sync --expect-link <id> --json` behind the
 * pinned SSH gate: the real connected sync, then the real ocx.sync.fanout/1 serializer, framed as the gate frames it.
 */
import { mock } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const options = JSON.parse(readFileSync(0, "utf8")) as { mode: "setup" | "sync"; linkId: string; catalog?: unknown; homeBody?: string };
const home = process.env.OPENCODEX_HOME!;
mkdirSync(home, { recursive: true });
const lifecycle = await import("../../src/client/lifecycle-lock");
const lock = lifecycle.withClientLifecycleSync;
mock.module("../../src/client/lifecycle-lock", () => ({ ...lifecycle,
  withClientLifecycleSync: (work: Parameters<typeof lock>[0]) => lock(work, { lockPath: join(home, "lifecycle.sqlite") }),
}));
const token = `ocx_data_${"d".repeat(40)}`;

if (options.mode === "setup") {
  const { getDefaultConfig, saveConfig } = await import("../../src/config");
  const { CODEX_CONFIG_PATH, CODEX_HOME, CODEX_PROFILE_PATH, DEFAULT_CATALOG_PATH } = await import("../../src/codex/paths");
  const { markJournalInjectedState, writeJournal } = await import("../../src/codex/journal");
  const { serviceApiTokenFingerprint } = await import("../../src/lib/service-secrets");
  const { ensureCatalogBackup } = await import("../../src/codex/catalog/parsing");
  mkdirSync(CODEX_HOME, { recursive: true });
  const config = getDefaultConfig();
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) });
  config.port = probe.port!;
  await probe.stop(true);
  config.runtimeRole = "client";
  config.client = {
    serverUrl: "http://127.0.0.1:34567", managementUrl: "http://127.0.0.1:34567", managementTransport: "direct", transport: "link",
    link: { tunnelPort: 34567, linkId: options.linkId }, selectedClients: ["codex"], tokenEnv: "OPENCODEX_API_AUTH_TOKEN",
    apiKeyId: "oracle-child", tokenFingerprint: serviceApiTokenFingerprint(token), protocolVersion: 1, connectedAt: "2026-11-01T00:00:00.000Z",
  };
  saveConfig(config);
  const original = 'model = "native"\n';
  const injected = `# Auto-injected by opencodex (undo: ocx restore)\nopenai_base_url = "http://127.0.0.1:${config.port}/v1"\n${original}`;
  writeFileSync(CODEX_CONFIG_PATH, original);
  writeJournal({ currentStateIsNative: true, owner: { kind: "client", apiKeyId: "oracle-child" } });
  writeFileSync(CODEX_CONFIG_PATH, injected);
  writeFileSync(CODEX_PROFILE_PATH, 'model = "managed"\n');
  markJournalInjectedState(injected, 'model = "managed"\n', {
    injectedOpenaiBaseUrl: `http://127.0.0.1:${config.port}/v1`, injectedRealtimeWsBaseUrl: null, injectedCatalogPath: DEFAULT_CATALOG_PATH,
  });
  const nativeCatalog = { models: [{ slug: "oracle-native", visibility: "list" }] };
  writeFileSync(DEFAULT_CATALOG_PATH, JSON.stringify(nativeCatalog));
  ensureCatalogBackup(DEFAULT_CATALOG_PATH, nativeCatalog);
  // The stale catalog the Child last pulled (001's evidence shape), and the models_cache Codex built from it.
  writeFileSync(DEFAULT_CATALOG_PATH, JSON.stringify(options.catalog));
  writeFileSync(join(CODEX_HOME, "models_cache.json"), JSON.stringify(options.catalog));
  writeFileSync(join(home, "service-api-token"), token);
  process.exit(0);
}

const { parseSyncExpectation } = await import("../../src/cli/sync-expectation");
const { syncConnectedClient } = await import("../../src/client/connect");
const { renderFanoutJson, runHomeFanout } = await import("../../src/cli/sync-fanout");
const { packageVersion } = await import("../../src/lib/package-version");
const parsed = parseSyncExpectation(["--expect-link", options.linkId]);
if (!parsed.ok || !parsed.expectation) { console.error("oracle: expectation did not parse"); process.exit(2); }
let state: "synced" | "stale" | "failed" = "failed", exit = 1;
try {
  const result = await syncConnectedClient({ restartCodex: false, expect: parsed.expectation }, {
    fetchImpl: (async () => new Response(options.homeBody!, { headers: { "content-type": "application/json" } })) as typeof fetch,
    catalogCompatibility: { supportedEfforts: () => new Set(["low", "medium", "high", "xhigh"]) },
    linkHome: { fetchImpl: (async () => Response.json({}, { status: 404 })) as typeof fetch },
  });
  state = result.stale ? "stale" : "synced";
  exit = 0;
} catch (error) {
  console.error(`oracle: sync failed ${error instanceof Error ? error.message : "unknown"}`);
}
// What sync-command.ts prints for a Child (no fan-out of its own): the real document builder and renderer.
const document = await runHomeFanout({ home: { state, exit }, catalogCurrent: false, applicable: false,
  readStore: () => { throw new Error("a Child runs no fan-out"); }, readLinkStatus: async () => { throw new Error("unused"); },
  runChild: async () => { throw new Error("unused"); } });
process.stderr.write(`ocx-fanout:selected:${packageVersion("0.0.0")}\n`);
process.stdout.write(`ocx-fanout:stdout-begin\n${renderFanoutJson(document)}\n`);
process.exit(exit);
