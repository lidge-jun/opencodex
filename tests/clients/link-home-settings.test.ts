/**
 * #6957: the Home's OpenCodex-owned Codex settings on a Remote Link Child.
 *
 * The projection, the strict parse, the overlay the Codex injector sees, and how a sync picks
 * between a fresh Home read, the last recorded read and the Child's local values.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  describeHomeCodexSettings,
  overlayHomeCodexSettings,
  parseHomeCodexSettingsDocument,
  projectHomeCodexSettings,
  type HomeCodexSettingsDocument,
} from "../../src/link/codex-settings";
import {
  fetchLinkHomeManagement,
  homeCodexSettingsPath,
  linkHomeName,
  readHomeCodexSettingsRecord,
  recordHomeCodexSettings,
  resolveHomeCodexSettings,
} from "../../src/client/link-home";
import { deriveCodexInjectionPlan } from "../../src/codex/inject/plan";
import { validateCodexRoutingTarget } from "../../src/codex/inject/routing-target";
import type { OcxClientConnectionConfig, OcxConfig } from "../../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const LINK_ID = `lnk_${"c".repeat(16)}`;
const KEY = `ocx_data_${"d".repeat(40)}`;
const connection = {
  transport: "link",
  link: { tunnelPort: 23457, linkId: LINK_ID },
  apiKeyId: "link-key-1",
} as OcxClientConnectionConfig;

const document: HomeCodexSettingsDocument = {
  version: 1,
  home: { name: "home-box", version: "2.84.0" },
  settings: {
    fastMode: true,
    multiAgentMode: "v1",
    webSearchSidecarEnabled: false,
    subagentDefaults: { model: "anthropic/claude-sonnet-5-5", reasoningEffort: "high" },
  },
};

let root = "";
let previousHome: string | undefined;
let codexHome: IsolatedCodexHome | null = null;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  root = mkdtempSync(join(tmpdir(), "ocx-link-home-"));
  process.env.OPENCODEX_HOME = root;
  codexHome = installIsolatedCodexHome("ocx-link-home-codex-");
});

afterEach(() => {
  codexHome?.restore();
  codexHome = null;
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (root) removeTreeWithRetry(root);
});

function serving(body: unknown, status = 200, seen: Request[] = []): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push(new Request(String(input), init));
    return Response.json(body, { status });
  }) as typeof fetch;
}

async function applied(): Promise<void> {
  recordHomeCodexSettings(LINK_ID, await resolveHomeCodexSettings(connection, KEY, { fetchImpl: serving(document) }));
}

describe("Home Codex settings document", () => {
  test("projects only what the Child's injector writes, and only an effective sub-agent sync", () => {
    const projected = projectHomeCodexSettings({ port: 1, providers: {}, injectionModel: "x/y", syncCodexSubagentDefaults: false } as unknown as OcxConfig, "2.84.0");
    expect(projected.settings).toEqual({ fastMode: null, multiAgentMode: null, webSearchSidecarEnabled: true, subagentDefaults: null });
    expect(parseHomeCodexSettingsDocument(projected)).toEqual(projected);
  });

  test("parses strictly: an extra field, an unsafe label or an unknown mode rejects the document", () => {
    expect(parseHomeCodexSettingsDocument(document)).toEqual(document);
    expect(parseHomeCodexSettingsDocument({ ...document, extra: 1 })).toBeNull();
    expect(parseHomeCodexSettingsDocument({ ...document, home: { ...document.home, name: "mac\u202Eduts" } })).toBeNull();
    expect(parseHomeCodexSettingsDocument({ ...document, settings: { ...document.settings, multiAgentMode: "v3" } })).toBeNull();
    expect(parseHomeCodexSettingsDocument({ ...document, settings: { ...document.settings, model_reasoning_effort: "high" } })).toBeNull();
    expect(parseHomeCodexSettingsDocument({
      ...document, settings: { ...document.settings, subagentDefaults: { model: "m", reasoningEffort: "high\nx" } },
    })).toBeNull();
  });

  test("the overlay keeps the Child's listener facts and takes the Home's policy", () => {
    const local = {
      port: 10100, hostname: "127.0.0.1", providers: {}, fastMode: false, multiAgentMode: "v2",
      webSearchSidecar: { enabled: true, model: "local-model" }, injectionModel: "local/model", syncCodexSubagentDefaults: false,
    } as unknown as OcxConfig;
    const applied = overlayHomeCodexSettings(local, document.settings);
    expect(applied.port).toBe(10100);
    expect(applied.hostname).toBe("127.0.0.1");
    expect(applied.fastMode).toBe(true);
    expect(applied.multiAgentMode).toBe("v1");
    expect(applied.webSearchSidecar).toEqual({ enabled: false, model: "local-model" });
    expect(applied.injectionModel).toBe("anthropic/claude-sonnet-5-5");
    expect(applied.injectionEffort).toBe("high");
    expect(applied.syncCodexSubagentDefaults).toBe(true);
    const unset = overlayHomeCodexSettings(local, { ...document.settings, fastMode: null, multiAgentMode: null, subagentDefaults: null });
    expect("fastMode" in unset).toBe(false);
    expect("multiAgentMode" in unset).toBe(false);
    expect(unset.syncCodexSubagentDefaults).toBe(false);
    expect(local.fastMode).toBe(false);
  });

  test("the injection plan writes the Home's values into the Child's Codex config", () => {
    const local = { port: 10100, providers: {}, fastMode: false, webSearchSidecar: { enabled: true } } as unknown as OcxConfig;
    const plan = deriveCodexInjectionPlan("", {
      config: overlayHomeCodexSettings(local, document.settings),
      routingTarget: validateCodexRoutingTarget({ baseUrl: "http://127.0.0.1:10100/v1", requiresAdmissionToken: false, tokenEnv: "OPENCODEX_API_AUTH_TOKEN" }),
      catalogPathOption: null,
      journalReadOnly: true,
    });
    expect(plan.kind).toBe("ok");
    const content = plan.kind === "ok" ? plan.content : "";
    expect(content).toContain("fast_mode = true");
    expect(content).toContain("anthropic/claude-sonnet-5-5");
    expect(content).toMatch(/web_search = "disabled"/);
  });

  test("describes every applied value on its own line", () => {
    expect(describeHomeCodexSettings(document.settings)).toEqual([
      "fast mode: on",
      "multi-agent mode: v1",
      "web search sidecar: off",
      "native sub-agent defaults: anthropic/claude-sonnet-5-5 (high)",
    ]);
  });
});

describe("resolving the settings a Child sync applies", () => {
  test("a fresh read is sent with the link key and recorded privately only once applied", async () => {
    const seen: Request[] = [];
    const resolved = await resolveHomeCodexSettings(connection, KEY, { fetchImpl: serving(document, 200, seen), now: () => new Date("2026-10-11T00:00:00.000Z") });
    expect(resolved).toEqual({ source: "home", document, fetchedAt: "2026-10-11T00:00:00.000Z" });
    expect(seen[0]!.url).toBe("http://127.0.0.1:23457/v1/link-management/codex-settings");
    expect(seen[0]!.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    // Not yet applied: `ocx status` must not report settings an injection never wrote.
    expect(readHomeCodexSettingsRecord(LINK_ID)).toBeNull();
    recordHomeCodexSettings(LINK_ID, resolved);
    expect(readHomeCodexSettingsRecord(LINK_ID)?.document).toEqual(document);
    expect(readHomeCodexSettingsRecord(`lnk_${"e".repeat(16)}`)).toBeNull();
    if (process.platform !== "win32") expect(statSync(homeCodexSettingsPath()).mode & 0o777).toBe(0o600);
  });

  test("a failed read reuses the last record; a Home without the route keeps local values", async () => {
    await applied();
    const failing = (async () => { throw new Error("tunnel down"); }) as unknown as typeof fetch;
    const cached = await resolveHomeCodexSettings(connection, KEY, { fetchImpl: failing });
    expect(cached).toMatchObject({ source: "cached", document, reason: "the Home is unreachable" });
    const unsupported = await resolveHomeCodexSettings(connection, KEY, { fetchImpl: serving({ error: "not_found" }, 404) });
    expect(unsupported).toEqual({ source: "local", reason: "the Home does not publish Codex settings; upgrade the Home" });
    expect(readHomeCodexSettingsRecord(LINK_ID)).toBeNull();
    const invalid = await resolveHomeCodexSettings(connection, KEY, { fetchImpl: serving({ ...document, extra: true }) });
    expect(invalid).toEqual({ source: "local", reason: "the Home returned an unreadable settings document" });
  });

  test("names the Home by the Child-initiated alias first, then by the recorded host name", async () => {
    expect(linkHomeName(connection, () => null)).toBeNull();
    await applied();
    expect(linkHomeName(connection, () => null)).toBe("home-box");
    mkdirSync(join(root, "link"), { recursive: true });
    expect(linkHomeName(connection, () => ({
      linkId: LINK_ID, alias: "studio-ssh", hubHostKeyFingerprint: `SHA256:${"a".repeat(43)}`, peerListenerPort: 1, tunnelPort: 23457,
    }))).toBe("studio-ssh");
    writeFileSync(homeCodexSettingsPath(), "{not json");
    expect(linkHomeName(connection, () => null)).toBeNull();
  });

  test("a management read outside the allowlist throws before anything is sent", async () => {
    const seen: Request[] = [];
    const fetchImpl = serving({}, 200, seen);
    await expect(fetchLinkHomeManagement(connection, KEY, "/api/logs", {}, { fetchImpl })).rejects.toThrow("not readable");
    await expect(fetchLinkHomeManagement(connection, KEY, "/api/provider-quotas?refresh=1", {}, { fetchImpl })).rejects.toThrow("not readable");
    await expect(fetchLinkHomeManagement(connection, KEY, "//evil.example/api/providers", {}, { fetchImpl })).rejects.toThrow("not readable");
    expect(seen).toHaveLength(0);
    const ok = await fetchLinkHomeManagement(connection, KEY, "/api/providers", {}, { fetchImpl });
    expect(ok.status).toBe(200);
    expect(seen[0]!.url).toBe("http://127.0.0.1:23457/v1/link-management/api/providers");
  });
});
