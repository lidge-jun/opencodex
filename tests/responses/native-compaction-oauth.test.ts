import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDefaultConfig } from "../../src/config";
import * as oauth from "../../src/oauth";
import * as oauthStore from "../../src/oauth/store";
import type { OAuthCredentials } from "../../src/oauth/types";
import { supportsNativeResponsesCompactEndpoint, supportsNativeResponsesCompactionTrigger } from "../../src/providers/openai-tiers-destination";
import { SUMMARY_PREFIX } from "../../src/responses/compaction";
import * as thoughtReplay from "../../src/responses/thought-signature-replay";
import { handleResponsesCompact } from "../../src/server/responses";
import type { OcxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { baseCompactionBody, completedPayload, installCompactionRoutingAclFixture, removeCompactionFixture } from "../helpers/compaction-routing-fixtures";

installCompactionRoutingAclFixture();

describe("OAuth compact preserves the authenticated routed path", () => {
  const providerName = "kimi-responses";
  const accessToken = "resolved-oauth-compact-fixture";
  const selection = { accountId: "fixture-account", revision: "fixture-revision" };
  const generation = "fixture-generation";
  const summary = "Preserved task summary fixture.";
  const retainedUser = { type: "message", role: "user", content: [{ type: "input_text", text: "Keep the task fixture." }] };
  const restores: Array<{ mockRestore(): void }> = [];
  let previousHome: string | undefined;
  let originalFetch: typeof fetch;
  let home: string;
  let release: () => void;
  let loggedIn: boolean;
  let oauthLookups: string[];
  let selectionCommits: string[];

  beforeEach(() => {
    previousHome = process.env.OPENCODEX_HOME;
    originalFetch = globalThis.fetch;
    home = mkdtempSync(join(tmpdir(), "ocx-compact-oauth-"));
    process.env.OPENCODEX_HOME = home;
    release = acquireOwnedSpendHome();
    loggedIn = true;
    oauthLookups = [];
    selectionCommits = [];
    const credential: OAuthCredentials = { access: accessToken, refresh: "fixture-refresh", expires: Date.now() + 3_600_000 };
    const resolve = async (provider: string): Promise<oauth.OAuthAccessSnapshot> => {
      oauthLookups.push(provider);
      if (!loggedIn) throw new oauth.OAuthLoginRequiredError(provider);
      return { provider, accountId: selection.accountId, generation, accessToken };
    };
    // Match the differential fixture's selection, generation and unexpired account row.
    // Spies are restored per case; no module mock or persistent auth store is installed.
    restores.push(
      spyOn(oauth, "getValidAccessTokenSnapshot").mockImplementation(resolve),
      spyOn(oauth, "getValidAccessSnapshotForAccount").mockImplementation(resolve),
      spyOn(oauthStore, "captureOAuthAccountSelection").mockImplementation(() => loggedIn ? selection : null),
      spyOn(oauthStore, "commitOAuthAccountSelection").mockImplementation(async (provider, accountId) => {
        selectionCommits.push(provider);
        return loggedIn && accountId === selection.accountId ? selection : null;
      }),
      spyOn(oauthStore, "credentialGeneration").mockReturnValue(generation),
      spyOn(oauthStore, "getAccountSet").mockImplementation(() => loggedIn ? {
        activeAccountId: selection.accountId, selectionRevision: selection.revision,
        accounts: [{ id: selection.accountId, label: "OAuth fixture", credential }],
      } : null),
      spyOn(oauthStore, "getAccountCredentialWithStatus").mockImplementation(() => loggedIn ? {
        credential, paused: false, needsReauth: false,
      } : null),
      spyOn(thoughtReplay, "thoughtSignatureReplaySalt").mockReturnValue(Buffer.alloc(32, 7)),
    );
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    try {
      release();
      await removeCompactionFixture(home);
    } finally {
      for (const spy of restores.splice(0).reverse()) spy.mockRestore();
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
    }
  });

  function configFor(endpoint: boolean | undefined): OcxConfig {
    // Use the registered Responses ID: the "kimi" alias reconciles to Chat.
    return { ...getDefaultConfig(), defaultProvider: providerName, providers: {
      [providerName]: { adapter: "openai-responses", authMode: "oauth", proxy: "direct",
        baseUrl: "https://api.kimi.com/coding/v1", supportsNativeCompactionTrigger: true,
        ...(endpoint === undefined ? {} : { supportsNativeCompactEndpoint: endpoint }),
      },
    } };
  }

  function request(): Request {
    return new Request("http://localhost/v1/responses/compact", {
      method: "POST", headers: { "content-type": "application/json", authorization: "Bearer caller-compact-fixture" },
      body: JSON.stringify(baseCompactionBody({ model: `${providerName}/kimi-for-coding`, input: [retainedUser], store: false })),
    });
  }

  test.each([true, false, undefined])("endpoint opt-in %s retains OAuth admission and v1 replacement history", async endpoint => {
    const calls: Request[] = [];
    globalThis.fetch = (async (url, init) => {
      const sent = new Request(url, init);
      calls.push(sent);
      return sent.headers.get("authorization") === `Bearer ${accessToken}`
        ? Response.json(completedPayload(summary))
        : Response.json({ error: { message: "Missing OAuth fixture credential" } }, { status: 401 });
    }) as typeof fetch;
    const config = configFor(endpoint);
    const response = await handleResponsesCompact(request(), config, { model: "", provider: "" });
    const payload = await response.json();
    expect({ status: response.status, payload }).toMatchObject({ status: 200 });
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]!.url).pathname).toBe("/coding/v1/responses");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers.get("authorization")).toBe(`Bearer ${accessToken}`);
    const sentBody = await calls[0]!.json();
    expect(sentBody.model).toBe("kimi-for-coding");
    expect(sentBody.tools).toBeUndefined();
    expect(JSON.stringify(sentBody)).not.toContain("compaction_trigger");
    expect(JSON.stringify(sentBody)).toContain("CONTEXT CHECKPOINT COMPACTION");
    expect(payload.output).toEqual([retainedUser, {
      type: "message", role: "user", content: [{ type: "input_text", text: `${SUMMARY_PREFIX}\n${summary}` }],
    }]);
    expect(oauthLookups.length).toBeGreaterThan(0);
    expect(oauthLookups.every(provider => provider === providerName)).toBe(true);
    expect(selectionCommits).toEqual([providerName]);
    expect(supportsNativeResponsesCompactEndpoint(providerName, config.providers[providerName]!)).toBe(false);
    // Disabling the unauthenticated direct v1 path must not disable independent native v2.
    expect(supportsNativeResponsesCompactionTrigger(config.providers[providerName]!)).toBe(true);
  });

  test.each([true, false, undefined])("endpoint opt-in %s without a login refuses before inference", async endpoint => {
    loggedIn = false;
    const calls: Request[] = [];
    globalThis.fetch = (async (url, init) => {
      calls.push(new Request(url, init));
      return Response.json({ error: { message: "Unexpected inference without login" } }, { status: 401 });
    }) as typeof fetch;
    const response = await handleResponsesCompact(request(), configFor(endpoint), { model: "", provider: "" });
    expect(response.status).toBe(401);
    await response.text();
    expect(calls).toHaveLength(0);
    expect(selectionCommits).toHaveLength(0);
  });
});
