/**
 * `ocx config show` on a client says so, and stops burying the fact (#4236).
 *
 * `runtimeRole: "client"` and the `client` block were already in the output and were already
 * missed: an agent read a client's config, saw `providers: {}` and no grok, and concluded the hub
 * could not serve grok. Two things made that easy. Nothing labelled the situation, and
 * `client.priorCatalog` — the base64 snapshot connect took before overwriting the local catalog,
 * up to 64 MB of it — sat in the middle of the document.
 *
 * So the synthetic `_remoteHub` note is asserted to be the FIRST key (it has to be read before
 * the empty `providers` map), `priorCatalog` is asserted to be a size marker, and `config export`
 * is asserted to be untouched and still `config validate`-clean — because a synthetic annotation
 * that leaked into a round trip would be a worse bug than the one it fixes.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { remoteHubConfigNote } from "../../src/cli/config-command";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { SPAWN_BUDGET_MS } from "../helpers/test-budget";

const repoRoot = dirname(fileURLToPath(new URL("../../package.json", import.meta.url)));
const cliPath = join(repoRoot, "src", "cli", "index.ts");
const isolatedCodexHome = mkdtempSync(join(tmpdir(), "ocx-config-client-codex-"));

setDefaultTimeout(SPAWN_BUDGET_MS);

function runCli(args: string[], home: string) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: repoRoot,
    env: { ...process.env, CODEX_HOME: isolatedCodexHome, OPENCODEX_HOME: home },
    encoding: "utf8",
    timeout: SPAWN_BUDGET_MS - 5_000,
  });
}

/** 12 KB of base64 stands in for the real thing; the assertion is about the shape, not the size. */
const PRIOR_CATALOG = "A".repeat(12_288);

/** The data-plane token this fixture's `tokenFingerprint` is computed from. */
const FIXTURE_TOKEN = "fixture-token";

function clientHome(options: { token?: string | null } = {}): string {
  const home = mkdtempSync(join(tmpdir(), "ocx-config-client-"));
  const token = options.token === undefined ? FIXTURE_TOKEN : options.token;
  if (token !== null) writeFileSync(join(home, "service-api-token"), token, { mode: 0o600 });
  writeFileSync(join(home, "config.json"), JSON.stringify({
    port: 10100,
    providers: {},
    runtimeRole: "client",
    client: {
      serverUrl: "https://hub.example.test:8443",
      managementUrl: "https://hub.example.test",
      managementTransport: "direct",
      selectedClients: ["codex", "claude"],
      tokenEnv: "OPENCODEX_API_AUTH_TOKEN",
      apiKeyId: "client-one",
      tokenFingerprint: createHash("sha256").update(FIXTURE_TOKEN).digest("hex"),
      protocolVersion: 1,
      connectedAt: "2026-09-01T00:00:00.000Z",
      priorCatalog: PRIOR_CATALOG,
    },
  }, null, 2));
  return home;
}

function standaloneHome(): string {
  const home = mkdtempSync(join(tmpdir(), "ocx-config-standalone-"));
  writeFileSync(join(home, "config.json"), JSON.stringify({ port: 10100, providers: {} }));
  return home;
}

/** The shape `collectClientConnectionStatus()` returns, narrowed to what the note reads. */
type NoteConnection = Parameters<typeof remoteHubConfigNote>[1] extends () => infer T ? T : never;

function connection(overrides: Partial<NoteConnection> = {}): NoteConnection {
  return { state: "connected", token: "owned", ...overrides } as NoteConnection;
}

const CLIENT_CONFIG = {
  runtimeRole: "client",
  client: { serverUrl: "https://hub.example.test:8443" },
} as OcxConfig;

describe("remoteHubConfigNote", () => {
  test("only a client with a connection block gets a note, and nothing is probed otherwise", () => {
    // The thunk throws: a standalone or hub install must not pay for the connection probe, and
    // the guard has to return before it.
    const refuse = (): NoteConnection => { throw new Error("connection must not be probed"); };
    expect(remoteHubConfigNote({ runtimeRole: "client" } as OcxConfig, refuse)).toBeNull();
    expect(remoteHubConfigNote({ runtimeRole: "standalone" } as OcxConfig, refuse)).toBeNull();
    expect(remoteHubConfigNote({ runtimeRole: "hub" } as OcxConfig, refuse)).toBeNull();
    expect(remoteHubConfigNote({} as OcxConfig, refuse)).toBeNull();
  });

  test("the note names the hub and points at the command that has the facts", () => {
    const note = remoteHubConfigNote(CLIENT_CONFIG, () => connection());
    expect(note).toEqual({
      connected: true,
      origin: "https://hub.example.test:8443",
      note: "provider credentials and model availability live on the hub; run ocx status",
    });
  });

  test("connected is observed, not assumed: a revoked or rotated-away token reads false", () => {
    // `connected: true` was hardcoded for any config carrying a `client` block. That is the same
    // defect in miniature — configuration is not evidence the connection works — and this is the
    // case that proves it: the key was revoked or rotated at the hub, the token file this machine
    // holds is no longer the one the connection recorded, and nothing here can reach the hub.
    for (const token of ["missing", "changed", "unsafe"] as const) {
      const note = remoteHubConfigNote(CLIENT_CONFIG, () => connection({ token }));
      expect({ token, connected: note?.connected }).toEqual({ token, connected: false });
      expect(note?.note).toContain(`hub data-plane token is ${token}`);
      // Still the hub's origin, and still a pointer at the command that can say more.
      expect(note?.origin).toBe("https://hub.example.test:8443");
      expect(note?.note).toContain("ocx connect status");
    }
  });

  test("a mismatched or invalid connection record is named rather than called connected", () => {
    const mismatched = remoteHubConfigNote(CLIENT_CONFIG, () => connection({
      state: "mismatched", reason: "config.json.client is present without runtimeRole=client",
    }));
    expect(mismatched?.connected).toBe(false);
    expect(mismatched?.note).toContain("its connection is mismatched");
    expect(mismatched?.note).toContain("config.json.client is present without runtimeRole=client");
    const disconnected = remoteHubConfigNote(CLIENT_CONFIG, () => connection({ state: "disconnected", token: "missing" }));
    expect(disconnected?.connected).toBe(false);
    expect(disconnected?.note).toContain("its connection is disconnected");
  });
});

describe("ocx config show on a client", () => {
  test("leads with _remoteHub and omits the priorCatalog blob", () => {
    const home = clientHome();
    try {
      const result = runCli(["config", "show"], home);
      expect(result.status).toBe(0);
      const parsed = JSON.parse(result.stdout);
      // First key: it must be read before the empty providers map, not after it.
      expect(Object.keys(parsed)[0]).toBe("_remoteHub");
      expect(parsed._remoteHub).toEqual({
        connected: true,
        origin: "https://hub.example.test:8443",
        note: "provider credentials and model availability live on the hub; run ocx status",
      });
      expect(parsed.client.priorCatalog).toBe(`<omitted: ${PRIOR_CATALOG.length} bytes>`);
      expect(result.stdout).not.toContain(PRIOR_CATALOG.slice(0, 256));
      // Everything else is still there; this is an annotation, not a filter.
      expect(parsed.runtimeRole).toBe("client");
      expect(parsed.client.apiKeyId).toBe("client-one");
    } finally {
      removeTreeWithRetry(home);
    }
  });

  test("config get on the blob is omitted too, not printed through a side door", () => {
    const home = clientHome();
    try {
      const result = runCli(["config", "get", "client.priorCatalog"], home);
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe(`<omitted: ${PRIOR_CATALOG.length} bytes>`);
    } finally {
      removeTreeWithRetry(home);
    }
  });

  test("config export carries the real config and stays validate-clean", () => {
    const home = clientHome();
    const exported = join(home, "exported.json");
    try {
      const result = runCli(["config", "export", exported], home);
      expect(result.status).toBe(0);
      const text = readFileSync(exported, "utf8");
      // A synthetic annotation that leaked into an export would break the round trip.
      expect(text).not.toContain("_remoteHub");
      // And the export is the REAL config: the omission marker is a display concern only.
      const parsed = JSON.parse(text);
      expect(parsed.client.priorCatalog).toBe(PRIOR_CATALOG);
      const validated = runCli(["config", "validate", exported], home);
      expect(validated.status).toBe(0);
      expect(validated.stdout).toContain("Config is valid.");
    } finally {
      removeTreeWithRetry(home);
    }
  });

  test("a client holding no data-plane token is not reported as connected", () => {
    // End to end, because the hardcoded `true` lived at the call site's expense: `ocx config
    // show` is what an agent reads, and this is the machine that cannot reach its hub at all.
    const home = clientHome({ token: null });
    try {
      const result = runCli(["config", "show"], home);
      expect(result.status).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed._remoteHub.connected).toBe(false);
      expect(parsed._remoteHub.origin).toBe("https://hub.example.test:8443");
      expect(parsed._remoteHub.note).toContain("hub data-plane token is missing");
    } finally {
      removeTreeWithRetry(home);
    }
  });

  test("a standalone machine's output is unannotated", () => {
    const home = standaloneHome();
    try {
      const result = runCli(["config", "show"], home);
      expect(result.status).toBe(0);
      expect(result.stdout).not.toContain("_remoteHub");
      expect(Object.keys(JSON.parse(result.stdout))).not.toContain("_remoteHub");
    } finally {
      removeTreeWithRetry(home);
    }
  });
});
