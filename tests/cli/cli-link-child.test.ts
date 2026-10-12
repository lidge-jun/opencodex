/**
 * #6957: management commands on a Remote Link Child either read the Home over the link or are
 * refused with one message that names the Home and the link. Nothing is sent for a refusal, and
 * no refusal points at a relay transport a link Child never has.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeApiError, runtimeRequest } from "../../src/cli/runtime-api";
import { accountClassificationConfig, apiJson, classifyAccount, LINK_HOME_BASE } from "../../src/cli/account-api";
import { linkChildLocalNotice, linkChildProviderChangeRefusal, readLinkChildContext } from "../../src/cli/link-child";
import type { OcxConfig } from "../../src/types";
import { linkCodexSettingsLines, remoteHubBannerLine, type CliRemoteHubStatus } from "../../src/cli/status";
import { hubStateFailureReason } from "../../src/client/hub-state";
import { fetchHubUsage, HubClientError } from "../../src/client/hub-client";
import { serviceApiTokenFingerprint } from "../../src/lib/service-secrets";
import type { LiveProxy } from "../../src/server/proxy-liveness";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const KEY = `ocx_data_${"f".repeat(40)}`;
const LINK_ID = `lnk_${"a".repeat(16)}`;
const TUNNEL = 23458;
const clientLive = async () => ({ pid: process.pid, port: 10100, hostname: "127.0.0.1", source: "config", role: "client" }) as LiveProxy;

let root = "";
let previousHome: string | undefined;

function writeChild(transport: "link" | "hub" = "link"): void {
  writeFileSync(join(root, "config.json"), JSON.stringify({
    port: 10100,
    providers: {},
    defaultProvider: "openai",
    runtimeRole: "client",
    client: {
      serverUrl: transport === "link" ? `http://127.0.0.1:${TUNNEL}` : "https://hub.example.test",
      managementUrl: transport === "link" ? `http://127.0.0.1:${TUNNEL}` : "https://hub.example.test",
      managementTransport: "direct",
      ...(transport === "link" ? { transport: "link", link: { tunnelPort: TUNNEL, linkId: LINK_ID } } : {}),
      selectedClients: ["codex"],
      tokenEnv: "OPENCODEX_API_AUTH_TOKEN",
      apiKeyId: "link-key-1",
      tokenFingerprint: serviceApiTokenFingerprint(KEY),
      protocolVersion: 1,
      connectedAt: "2026-10-01T00:00:00.000Z",
    },
  }));
  writeFileSync(join(root, "service-api-token"), `${KEY}\n`, { mode: 0o600 });
}

function homeServing(body: unknown, seen: Request[], status = 200): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push(new Request(String(input), init));
    return Response.json(body, { status });
  }) as typeof fetch;
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  root = mkdtempSync(join(tmpdir(), "ocx-cli-link-child-"));
  process.env.OPENCODEX_HOME = root;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (root) removeTreeWithRetry(root);
});

describe("management CLI on a Remote Link Child", () => {
  test("an allowlisted read is answered by the Home through the link", async () => {
    writeChild();
    const seen: Request[] = [];
    const body = await runtimeRequest("/api/providers", {}, {
      findLiveProxy: clientLive,
      linkHome: { fetchImpl: homeServing([{ name: "home-provider" }], seen) },
    });
    expect(body).toEqual([{ name: "home-provider" }]);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe(`http://127.0.0.1:${TUNNEL}/v1/link-management/api/providers`);
    expect(seen[0]!.headers.get("authorization")).toBe(`Bearer ${KEY}`);
  });

  test("a change or an unlisted read is refused with the one Child message and nothing is sent", async () => {
    writeChild();
    const seen: Request[] = [];
    for (const [method, path] of [["PUT", "/api/settings"], ["GET", "/api/logs"], ["GET", "/api/provider-quotas?refresh=1"]] as const) {
      const error = await runtimeRequest(path, { method }, {
        findLiveProxy: clientLive, linkHome: { fetchImpl: homeServing({}, seen) },
      }).catch(value => value) as RuntimeApiError;
      expect(error).toBeInstanceOf(RuntimeApiError);
      expect(error.code).toBe("link_child_management_unavailable");
      expect(error.message).toContain("Remote Link Child managed by its Home");
      expect(error.message).toContain(LINK_ID);
      expect(error.message).toContain(`${method} ${path.split("?")[0]}`);
      expect(error.message).not.toContain("relay transport");
    }
    expect(seen).toHaveLength(0);
  });

  test("a hub client keeps its own refusal", async () => {
    writeChild("hub");
    expect(readLinkChildContext()).toBeNull();
    const error = await runtimeRequest("/api/settings", { method: "PUT" }, { findLiveProxy: clientLive }).catch(value => value) as RuntimeApiError;
    expect(error.code).toBe("client_role_management_unavailable");
  });

  test("account reads come from the Home and account changes are refused", async () => {
    writeChild();
    const seen: Request[] = [];
    const read = await apiJson({ fetchImpl: homeServing({ activeCodexAccountId: "acct-1" }, seen) }, LINK_HOME_BASE, "GET", "/api/codex-auth/active");
    expect(read).toEqual({ status: 200, json: { activeCodexAccountId: "acct-1" } });
    expect(seen[0]!.url).toBe(`http://127.0.0.1:${TUNNEL}/v1/link-management/api/codex-auth/active`);
    const write = await apiJson({ fetchImpl: homeServing({}, seen) }, LINK_HOME_BASE, "PUT", "/api/codex-auth/active");
    expect(write.status).toBe(403);
    expect(String(write.json.error)).toContain("PUT /api/codex-auth/active runs on the Home");
    expect(seen).toHaveLength(1);
  });

  test("an older Home without the relay is named as the thing to upgrade", async () => {
    writeChild();
    const seen: Request[] = [];
    const error = await runtimeRequest("/api/settings", {}, {
      findLiveProxy: clientLive,
      linkHome: { fetchImpl: homeServing({ error: { type: "invalid_request_error", code: "not_found", message: "Unknown endpoint" } }, seen, 404) },
    }).catch(value => value) as RuntimeApiError;
    expect(error.status).toBe(503);
    expect(error.message).toContain("upgrade the Home");
  });

  test("local reads are labelled as local and inactive", () => {
    writeChild();
    expect(linkChildLocalNotice("The providers")).toContain("inactive while it is linked");
    expect(linkChildProviderChangeRefusal("ocx provider add")).toContain("ocx provider add runs on the Home");
    writeChild("hub");
    expect(linkChildLocalNotice("The providers")).toBeNull();
    expect(linkChildProviderChangeRefusal("ocx provider add")).toBeNull();
  });

  test("account commands classify providers from the Home, without any credential value", async () => {
    writeChild();
    const seen: Request[] = [];
    const local = { port: 10100, providers: {} } as unknown as OcxConfig;
    const classified = await accountClassificationConfig({ fetchImpl: homeServing([
      { name: "home-keyed", adapter: "openai-chat", baseUrl: "https://example.test/v1", hasApiKey: true, authMode: "key" },
    ], seen) }, local);
    if ("error" in classified) throw new Error(classified.error);
    const config = classified.config;
    expect(seen[0]!.url).toBe(`http://127.0.0.1:${TUNNEL}/v1/link-management/api/providers`);
    expect(classifyAccount(config, "home-keyed")).toEqual({ type: "api-key" });
    expect(classifyAccount(local, "home-keyed")).toEqual({ error: 'unknown provider "home-keyed"' });
    // A Home that cannot answer is an error, never a fall back to the inactive local providers.
    const failed = await accountClassificationConfig({ fetchImpl: homeServing({}, seen, 500) }, local);
    expect(failed).toEqual({ error: `Could not read the provider list from its Home over Remote Link (${LINK_ID}): the Home answered HTTP 500.` });
    const explained = await accountClassificationConfig({ fetchImpl: homeServing({ error: "provider store busy" }, seen, 503) }, local);
    expect(explained).toEqual({ error: `Could not read the provider list from its Home over Remote Link (${LINK_ID}): provider store busy.` });
    const older = await accountClassificationConfig({ fetchImpl: homeServing({ error: { code: "not_found" } }, seen, 404) }, local);
    expect("error" in older && older.error).toContain("upgrade the Home");
    writeChild("hub");
    expect(await accountClassificationConfig({}, local)).toEqual({ config: local });
  });

  test("usage and status name the Home instead of a hub", async () => {
    const usage = await fetchHubUsage(`http://127.0.0.1:${TUNNEL}`, KEY, new URLSearchParams(), {
      fetchImpl: (async () => new Response(null, { status: 404 })) as unknown as typeof fetch, peer: "Home",
    }).catch(value => value) as HubClientError;
    expect(usage.message).toBe("Home does not support client usage; upgrade the Home");
    expect(hubStateFailureReason(new HubClientError("hub_state_unsupported", "x", 404), "Home"))
      .toBe("this Home is too old to report its state; upgrade the Home");
    expect(hubStateFailureReason(new HubClientError("hub_state_unsupported", "x", 404)))
      .toBe("this hub is too old to report its state; upgrade the hub");

    const status: CliRemoteHubStatus = {
      connected: true, origin: `http://127.0.0.1:${TUNNEL}`, stateSource: "hub", hubVersion: "2.84.0",
      providers: [], oauth: [], subagentModels: [], truncated: false, claudeCodeEnabled: null,
      link: { linkId: LINK_ID, homePhrase: "Home home-box", codexSettings: { source: "home", fetchedAt: "2026-10-11T00:00:00.000Z", lines: ["fast mode: on"] } },
    };
    expect(remoteHubBannerLine(status)).toContain(`Home home-box over Remote Link (${LINK_ID})`);
    expect(remoteHubBannerLine(status)).not.toMatch(/\bhub\b/);
    expect(linkCodexSettingsLines(status.link!)).toEqual([
      "Codex settings from Home home-box (applied 2026-10-11T00:00:00.000Z):",
      "  fast mode: on",
    ]);
  });
});
