/**
 * Remote Link Codex-journal scenarios for tests/clients/client-link-teardown.test.ts.
 *
 * The Codex paths (config.toml, the journal, the catalog) are fixed when src/codex/paths loads, so
 * a scenario that writes them directly runs here, in a child whose CODEX_HOME and OPENCODEX_HOME the
 * parent test set to its own temp directory before anything was imported. Prints one JSON result.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// First, before any source module loads or anything is written: the parent test creates the temp
// home, writes a one-time token into it and hands the same token over. A direct run (a developer's
// real HOME, no token, or a token the home does not carry) stops here.
{
  const token = process.env.OCX_FIXTURE_TOKEN;
  const marker = process.env.HOME ? join(process.env.HOME, ".ocx-fixture-token") : "";
  let carried: string | null = null;
  try { carried = marker && existsSync(marker) ? readFileSync(marker, "utf8") : null; } catch { carried = null; }
  if (!token || carried !== token) {
    console.error("client-link-journal-runner.ts is a test fixture; run it through tests/clients/client-link-teardown.test.ts.");
    process.exit(2);
  }
}

const scenario = readFileSync(0, "utf8").trim() as "catalog-changed" | "standalone-handover" | "foreign-journal";
const home = process.env.OPENCODEX_HOME!;
const { getDefaultConfig, saveConfig } = await import("../../src/config");
const { connectClient } = await import("../../src/client/connect");
const { injectCodexConfig } = await import("../../src/codex/inject");
const { handleDisconnectCommand } = await import("../../src/cli/connect");
const { CODEX_CONFIG_PATH, DEFAULT_CATALOG_PATH } = await import("../../src/codex/paths");
const { JOURNAL_PATH } = await import("../../src/codex/journal");

// Prove by path that every Codex and OpenCodex path this child writes is inside the temp home the
// parent created and passed as HOME; refuse before the first write otherwise.
const { realpathSync } = await import("node:fs");
const { dirname: parentOf, relative, isAbsolute } = await import("node:path");
const ownedRoot = realpathSync.native(process.env.HOME!);
const inside = (path: string) => { const rel = relative(ownedRoot, realpathSync.native(path)); return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel); };
for (const path of [parentOf(CODEX_CONFIG_PATH), parentOf(DEFAULT_CATALOG_PATH), parentOf(JOURNAL_PATH), home]) {
  if (!inside(path)) throw new Error(`refusing to run: ${path} is not inside the owned test home ${ownedRoot}`);
}

const linkId = "lnk_0123456789abcdef";
const key = `ocx_data_${"a".repeat(40)}`;
const lifecycleLockDeps = { lockPath: join(home, "lifecycle.sqlite") };
const config = getDefaultConfig();
config.port = 10100;
saveConfig(config);
writeFileSync(CODEX_CONFIG_PATH, "model_provider = \"openai\"\n");
const owner = () => JSON.parse(readFileSync(JOURNAL_PATH, "utf8")).owner as unknown;
const connect = (noSync: boolean) => connectClient({
  serverUrl: "http://127.0.0.1:34567",
  managementUrl: "http://127.0.0.1:34567",
  managementTransport: "direct",
  transport: "link",
  link: { tunnelPort: 34567, linkId },
  credential: { kind: "link", apiKeyId: "key-1", key },
  selectedClients: ["codex"],
  ...(noSync ? { noSync: true } : {}),
}, {
  fetchImpl: (async (input: RequestInfo | URL) => String(input).endsWith("/readyz")
    ? Response.json({ status: "ready", protocol: 1, minimumClientProtocol: 1, managementUrl: "http://127.0.0.1:34567" })
    : Response.json({ models: [] })) as typeof fetch,
  catalogCompatibility: { supportedEfforts: () => new Set() },
  lifecycleLockDeps,
});
const warnings: string[] = [], errors: string[] = [];
console.warn = (...parts: unknown[]) => { warnings.push(parts.map(String).join(" ")); };
const log = console.log;
console.log = () => {};
const result: Record<string, unknown> = {};

if (scenario === "catalog-changed") {
  await connect(true);
  // Something else rewrote the catalog after connect: neither ours nor the recorded prior one.
  writeFileSync(DEFAULT_CATALOG_PATH, JSON.stringify({ models: [{ slug: "rewritten-elsewhere" }] }));
  console.error = (...parts: unknown[]) => { errors.push(parts.map(String).join(" ")); };
  result.exit = await handleDisconnectCommand([], {
    lifecycleLockDeps,
    linkTeardownDeps: {
      reapOrphanTunnel: async () => ({ tunnel: "absent" as const }),
      runner: { run: async () => ({ code: 1, stdout: "", stderr: "" }) },
      knownHostsFile: join(home, "known_hosts"),
    },
  });
} else {
  // The standalone proxy's own injection (journaled to this live process), or an earlier client's.
  const earlier = await injectCodexConfig(10100, { ...config, syncResumeHistory: false }, {
    catalogPath: null,
    ...(scenario === "foreign-journal" ? { journalOwner: { kind: "client" as const, apiKeyId: "earlier-key" } } : {}),
  });
  result.injected = earlier.success;
  result.before = owner();
  await connect(false);
  result.after = owner();
}
console.log = log;
console.log(JSON.stringify({ ...result, warnings, errors }));
