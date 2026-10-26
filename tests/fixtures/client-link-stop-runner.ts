/** Isolated disk and native-runtime coverage for a connected Link Child's stop. */
import { mock } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDefaultConfig, saveConfig } from "../../src/config";
import { CODEX_CONFIG_PATH, CODEX_HOME, CODEX_PROFILE_PATH, DEFAULT_CATALOG_PATH } from "../../src/codex/paths";
import { JOURNAL_PATH, markJournalInjectedState, writeJournal } from "../../src/codex/journal";
import { serviceApiTokenFingerprint } from "../../src/lib/service-secrets";

const options = JSON.parse(readFileSync(0, "utf8")) as {
  mode: "runtime" | "helper" | "api" | "parent";
  transport?: "link" | "hub";
  signal?: NodeJS.Signals;
  repeat?: boolean;
  mutation?: "connection" | "journal" | "process-journal" | "config" | "profile" | "unverified" | "selection" | "oversized" | "nonregular";
};
const home = process.env.OPENCODEX_HOME!;
mkdirSync(CODEX_HOME, { recursive: true });
mkdirSync(home, { recursive: true });
const lifecycle = await import("../../src/client/lifecycle-lock");
const lock = lifecycle.withClientLifecycleSync;
mock.module("../../src/client/lifecycle-lock", () => ({ ...lifecycle,
  withClientLifecycleSync: (work: Parameters<typeof lock>[0]) => lock(work, { lockPath: join(home, "lifecycle.sqlite") }),
}));
const token = `ocx_data_${"c".repeat(40)}`;
const config = getDefaultConfig();
const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) });
config.port = probe.port!;
await probe.stop(true);
config.runtimeRole = "client";
config.client = {
  serverUrl: options.transport === "hub" ? "https://hub.example.test" : "http://127.0.0.1:34567",
  managementUrl: options.transport === "hub" ? "https://hub.example.test" : "http://127.0.0.1:34567",
  managementTransport: "direct", transport: options.transport ?? "link",
  ...(options.transport === "hub" ? {} : { link: { tunnelPort: 34567, linkId: "lnk_0123456789abcdef" } }),
  selectedClients: ["codex"], tokenEnv: "OPENCODEX_API_AUTH_TOKEN", apiKeyId: "fixture-client",
  tokenFingerprint: serviceApiTokenFingerprint(token), protocolVersion: 1, connectedAt: "2026-10-01T00:00:00.000Z",
};
saveConfig(config);
const expected = structuredClone(config.client);
const original = 'model = "native"\n';
const injected = `# Auto-injected by opencodex (undo: ocx restore)\nopenai_base_url = "http://127.0.0.1:${config.port}/v1"\n${original}`;
writeFileSync(CODEX_CONFIG_PATH, original);
writeJournal({ currentStateIsNative: true, owner: { kind: "client", apiKeyId: expected.apiKeyId } });
writeFileSync(CODEX_CONFIG_PATH, injected);
writeFileSync(CODEX_PROFILE_PATH, 'model = "managed"\n');
markJournalInjectedState(injected, 'model = "managed"\n', {
  injectedOpenaiBaseUrl: `http://127.0.0.1:${config.port}/v1`, injectedRealtimeWsBaseUrl: null, injectedCatalogPath: DEFAULT_CATALOG_PATH,
});
writeFileSync(DEFAULT_CATALOG_PATH, '{"models":[{"id":"home-model"}]}');
writeFileSync(join(home, "service-api-token"), token);
writeFileSync(join(home, "grok-sentinel"), "unrelated Grok configuration");
const mutate = () => {
  if (options.mutation === "connection") { config.client!.connectedAt = "2026-10-02T00:00:00.000Z"; saveConfig(config); }
  if (options.mutation === "selection") { config.client!.selectedClients = ["claude"]; saveConfig(config); }
  if (options.mutation === "journal" || options.mutation === "process-journal" || options.mutation === "unverified") {
    const journal = JSON.parse(readFileSync(JOURNAL_PATH, "utf8"));
    if (options.mutation === "unverified") delete journal.injectedConfigHash;
    else journal.owner = options.mutation === "journal" ? { kind: "client", apiKeyId: "another-client" } : { kind: "process", pid: process.pid };
    writeFileSync(JOURNAL_PATH, JSON.stringify(journal));
  }
  if (options.mutation === "config") writeFileSync(CODEX_CONFIG_PATH, injected + 'approval_policy = "on-request"\n');
  if (options.mutation === "profile") writeFileSync(CODEX_PROFILE_PATH, 'model = "operator-edit"\n');
  if (options.mutation === "oversized" || options.mutation === "nonregular") {
    unlinkSync(JOURNAL_PATH);
    if (options.mutation === "oversized") writeFileSync(CODEX_CONFIG_PATH, " ".repeat(1024 * 1024 + 1));
    else { unlinkSync(CODEX_CONFIG_PATH); mkdirSync(CODEX_CONFIG_PATH); }
  }
};
if (options.mode !== "runtime") mutate();
const protectedPaths = [join(home, "config.json"), DEFAULT_CATALOG_PATH, join(home, "service-api-token"), join(home, "grok-sentinel")];
let protectedBefore = protectedPaths.map(path => readFileSync(path, "utf8"));
const configContents = () => statSync(CODEX_CONFIG_PATH).isFile() ? readFileSync(CODEX_CONFIG_PATH, "utf8") : "<nonregular>";
const before = configContents();
const profileBefore = readFileSync(CODEX_PROFILE_PATH, "utf8");
const report = (result: unknown) => writeFileSync(join(home, "result.json"), JSON.stringify({
  result, before, profileBefore, after: configContents(),
  profileAfter: existsSync(CODEX_PROFILE_PATH) ? readFileSync(CODEX_PROFILE_PATH, "utf8") : null,
  journalRetained: existsSync(JOURNAL_PATH), protectedUnchanged: protectedPaths.every((path, index) => readFileSync(path, "utf8") === protectedBefore[index]),
}));
if (options.mode === "runtime") {
  const { startClientRuntime } = await import("../../src/client/runtime");
  const { startMachineListener } = await import("../../src/client/machine-listener");
  await startClientRuntime({ block: false }, { startListener: (port, deps) => {
    const server = startMachineListener(port, deps);
    const stop = server.stop.bind(server);
    server.stop = ((close: boolean) => { report({ atListenerStop: true }); return stop(close); }) as typeof server.stop;
    return server;
  } });
  mutate();
  protectedBefore = protectedPaths.map(path => readFileSync(path, "utf8"));
  process.emit(options.signal ?? "SIGTERM", options.signal ?? "SIGTERM");
} else {
  const result = options.mode === "api"
    ? await (await import("../../src/server/stop-teardown")).performStopTeardown(new URL("http://127.0.0.1:10100/api/stop?deferSharedTeardown=1&teardownNonce=fixture"), { ownsReceipt: () => true })
    : options.mode === "parent" ? await (await import("../../src/cli/stop-restore")).restoreSharedClientStateAfterStop(() => {}, expected)
    : (await import("../../src/client/stop-routing")).restoreLinkClientRouting(expected);
  const repeated = options.repeat ? (await import("../../src/client/stop-routing")).restoreLinkClientRouting(expected) : undefined;
  report(repeated ? { first: result, repeated } : result);
}
