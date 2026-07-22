import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";

type Capture = {
  url: string;
  method: string;
  authorization: string | null;
  accountId: string | null;
  body: Record<string, unknown>;
};

type MigrationReceipt = {
  backupMatchesOriginal: boolean;
  backupMode: number;
  v1BackupUnchanged: boolean;
  firstProviderIds: string[];
  firstDefaultProvider: string;
  mode: string;
  hiddenLegacy: boolean;
  marker: number;
  selectedModels: string[];
  knownReferencesRewritten: boolean;
  contextCapsMerged: boolean;
  warningPathsOnly: boolean;
  unrelatedProvidersUnchanged: boolean;
  unrelatedSelectedIdsUnchanged: boolean;
  secondIdempotent: boolean;
  secondNoSave: boolean;
  restoredByteIdentity: boolean;
  restoredLegacyParse: boolean;
  remigrated: boolean;
  absencePreserved: boolean;
  collisionFailsBeforeSave: boolean;
};

function hashTree(path: string): string {
  const hash = createHash("sha256");
  if (!existsSync(path)) return hash.update("absent").digest("hex");

  const visit = (current: string): void => {
    const stat = lstatSync(current);
    const label = relative(path, current) || ".";
    hash.update(`${label}\0${stat.mode & 0o777}\0`);
    if (stat.isSymbolicLink()) {
      hash.update(`link\0${readlinkSync(current)}\0`);
      return;
    }
    if (stat.isDirectory()) {
      hash.update("dir\0");
      for (const entry of readdirSync(current).sort()) visit(join(current, entry));
      return;
    }
    hash.update("file\0");
    hash.update(readFileSync(current));
  };
  visit(path);
  return hash.digest("hex");
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function responsesLifecycle(body: Record<string, unknown>): string {
  const item = {
    id: "msg_fixture",
    type: "message",
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text: "OK", annotations: [] }],
  };
  const response = {
    id: "resp_fixture",
    object: "response",
    status: "completed",
    model: body.model,
    output: [item],
    usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
  };
  const frames = [
    { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
    { type: "response.content_part.added", item_id: item.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
    { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: "OK" },
    { type: "response.output_text.done", item_id: item.id, output_index: 0, content_index: 0, text: "OK" },
    { type: "response.content_part.done", item_id: item.id, output_index: 0, content_index: 0, part: item.content[0] },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response },
  ];
  return frames.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join("");
}

describe("OpenAI provider-option integration spine", () => {
  test("keeps Pool, Direct, and API ownership stable across transports and management", async () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-provider-option-e2e-"));
    const opencodexHome = join(root, "opencodex");
    const codexHome = join(root, "codex");
    const claudeConfigDir = join(root, "claude");
    const realClaudeDir = join(homedir(), ".claude");
    const realClaudeHashBefore = hashTree(realClaudeDir);
    const previousEnv = {
      OPENCODEX_HOME: process.env.OPENCODEX_HOME,
      CODEX_HOME: process.env.CODEX_HOME,
      CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    };
    const savedFetch = globalThis.fetch;
    const captures: Capture[] = [];
    const resets: Array<() => void> = [];
    let loopbackOrigin: string | null = null;
    let server: { url: URL; stop(closeActiveConnections?: boolean): Promise<void> } | null = null;

    const loopbackTuples = new Set([
      "GET /healthz",
      "GET /api/config",
      "GET /api/providers",
      "GET /api/models",
      "GET /api/logs",
      "GET /api/subagent-models",
      "GET /api/injection-model",
      "PATCH /api/providers",
      "PUT /api/disabled-models",
      "PUT /api/subagent-models",
      "PUT /api/injection-model",
      "POST /v1/responses",
      "POST /v1/responses/compact",
    ]);
    const upstreamTuples = new Set([
      "POST https://chatgpt.com/backend-api/codex/responses",
      "POST https://chatgpt.com/backend-api/codex/responses/compact",
      "POST https://api.openai.com/v1/responses",
      "POST https://api.openai.com/v1/responses/compact",
    ]);

    try {
      for (const dir of [opencodexHome, codexHome, claudeConfigDir]) {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
      }
      process.env.OPENCODEX_HOME = opencodexHome;
      process.env.CODEX_HOME = codexHome;
      process.env.CLAUDE_CONFIG_DIR = claudeConfigDir;
      const authPath = join(codexHome, "auth.json");
      writeFileSync(authPath, JSON.stringify({
        tokens: { access_token: "fixture-main-access", account_id: "fixture-main-account" },
      }) + "\n", { mode: 0o600 });
      chmodSync(authPath, 0o600);

      globalThis.fetch = (async (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        const tuple = `${request.method} ${url.pathname}`;
        if (loopbackOrigin !== null && url.origin === loopbackOrigin && loopbackTuples.has(tuple)) {
          return savedFetch(request);
        }
        if (request.method === "GET" && url.href === "https://chatgpt.com/backend-api/wham/usage") {
          const isAdded = request.headers.get("authorization") === "Bearer fixture-pool-access";
          return Response.json({
            plan_type: "pro",
            rate_limit: { secondary_window: { used_percent: isAdded ? 10 : 90 } },
          });
        }
        const upstreamTuple = `${request.method} ${url.href}`;
        if (!upstreamTuples.has(upstreamTuple)) {
          throw new Error(`deny-by-default fetch blocked: ${upstreamTuple}`);
        }
        const body = await request.clone().json() as Record<string, unknown>;
        captures.push({
          url: url.href,
          method: request.method,
          authorization: request.headers.get("authorization"),
          accountId: request.headers.get("chatgpt-account-id"),
          body,
        });
        if (url.pathname.endsWith("/compact")) {
          return Response.json({ output: [], model: body.model, usage: { input_tokens: 2, output_tokens: 0 } });
        }
        if (body.stream === true) {
          return new Response(responsesLifecycle(body), { headers: { "content-type": "text/event-stream" } });
        }
        return Response.json({
          id: "resp_fixture",
          object: "response",
          status: "completed",
          model: body.model,
          output: [],
          usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
        });
      }) as typeof fetch;

      const [
        configModule,
        deriveModule,
        registryModule,
        accountStore,
        authApi,
        routing,
        websocketRegistry,
        requestLog,
        catalog,
        serverModule,
        mainAccount,
        sidecar,
      ] = await Promise.all([
        import("../src/config"),
        import("../src/providers/derive"),
        import("../src/providers/registry"),
        import("../src/codex/account-store"),
        import("../src/codex/auth-api"),
        import("../src/codex/routing"),
        import("../src/codex/websocket-registry"),
        import("../src/server/request-log"),
        import("../src/codex/catalog"),
        import("../src/server"),
        import("../src/codex/main-account"),
        import("../src/providers/openai-sidecar"),
      ]);

      resets.push(
        requestLog.clearRequestLogsForTests,
        catalog.resetCatalogRuntimeStateForTests,
        routing.clearThreadAccountMap,
        routing.clearCodexUpstreamHealth,
        authApi.clearAccountQuota,
        authApi.clearCodexQuotaPrimeState,
        websocketRegistry.clearCodexWebSocketRegistry,
        () => authApi.clearAccountNeedsReauth("fixture-pool"),
        () => authApi.clearAccountNeedsReauth(mainAccount.MAIN_CODEX_ACCOUNT_ID),
      );

      const seed = (id: string) => deriveModule.providerConfigSeed(
        registryModule.PROVIDER_REGISTRY.find(entry => entry.id === id)!,
      );
      const openai = seed("openai");
      delete openai.codexAccountMode;
      const api = seed("openai-apikey");
      api.liveModels = false;
      api.apiKey = "fixture-api-key";
      const config = {
        port: 0,
        defaultProvider: "openai",
        openaiProviderTierVersion: 2 as const,
        websockets: true,
        autoSwitchThreshold: 80,
        providers: { openai, "openai-apikey": api },
        codexAccounts: [{
          id: "fixture-pool",
          email: "pool@example.test",
          plan: "plus",
          logLabel: "p123abc",
          chatgptAccountId: "fixture-pool-account",
          isMain: false,
        }],
        activeCodexAccountId: mainAccount.MAIN_CODEX_ACCOUNT_ID,
      };
      configModule.saveConfig(config);
      accountStore.saveCodexAccountCredential("fixture-pool", {
        accessToken: "fixture-pool-access",
        refreshToken: "fixture-pool-refresh",
        expiresAt: Date.now() + 3_600_000,
        chatgptAccountId: "fixture-pool-account",
      });
      authApi.updateAccountQuota("fixture-pool", 10, undefined, 10);
      authApi.updateAccountQuota(mainAccount.MAIN_CODEX_ACCOUNT_ID, 90, undefined, 90);

      expect(registryModule.PROVIDER_REGISTRY.map(entry => entry.id)).toContain("openai");
      expect(registryModule.PROVIDER_REGISTRY.map(entry => entry.id)).toContain("openai-apikey");
      expect(registryModule.PROVIDER_REGISTRY.map(entry => entry.id)).not.toContain("openai-multi");
      expect(deriveModule.deriveProviderPresets().map(entry => entry.id)).not.toContain("openai-multi");
      expect(sidecar.listOpenAiForwardSidecarCandidates(config).map(row => row.providerName)).toEqual(["openai"]);

      server = serverModule.startServer(0);
      loopbackOrigin = new URL(server.url).origin;
      const local = (path: string, init?: RequestInit) => fetch(new URL(path, server!.url), init);
      const post = (path: string, body: unknown, headers: HeadersInit = {}) => local(path, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
      const put = (path: string, body: unknown) => local(path, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const patchMode = async (mode: "pool" | "direct") => local(`/api/providers?name=openai`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ codexAccountMode: mode }),
      });
      expect((await local("/healthz")).status).toBe(200);
      const providerRows = await local("/api/providers").then(response => response.json()) as Array<{ name: string; codexAccountMode?: string }>;
      expect(providerRows.map(row => row.name).sort()).toEqual(["openai", "openai-apikey"]);
      expect(providerRows.find(row => row.name === "openai")?.codexAccountMode).toBe("pool");
      const configDto = await local("/api/config").then(response => response.json()) as { providers: Record<string, { codexAccountMode?: string }> };
      expect(configDto.providers.openai.codexAccountMode).toBe("pool");
      expect(configDto.providers["openai-multi"]).toBeUndefined();

      const poolHttp = await post("/v1/responses", {
        model: "gpt-5.6-sol", input: "pool fixture", stream: false,
      }, { authorization: "Bearer fixture-caller-main" });
      expect(poolHttp.status).toBe(200);
      expect(await poolHttp.json()).toMatchObject({ model: "gpt-5.6-sol" });
      expect(captures.at(-1)).toMatchObject({
        authorization: "Bearer fixture-pool-access",
        accountId: "fixture-pool-account",
        body: { model: "gpt-5.6-sol" },
      });
      const poolSse = await post("/v1/responses", {
        model: "gpt-5.6-terra", input: "pool sse fixture", stream: true,
      }, { authorization: "Bearer fixture-caller-main" });
      expect(poolSse.status).toBe(200);
      expect(await poolSse.text()).toContain("response.completed");
      expect(captures.at(-1)).toMatchObject({ authorization: "Bearer fixture-pool-access", accountId: "fixture-pool-account" });
      const poolCompact = await post("/v1/responses/compact", {
        model: "gpt-5.6-luna", input: [], reasoning: { effort: "high" },
      }, { authorization: "Bearer fixture-caller-main" });
      expect(poolCompact.status).toBe(200);
      expect(await poolCompact.json()).toMatchObject({ model: "gpt-5.6-luna" });
      expect(captures.at(-1)).toMatchObject({ authorization: "Bearer fixture-pool-access", accountId: "fixture-pool-account" });
      expect(captures.at(-1)?.body.reasoning).toBeUndefined();

      const NativeWebSocket = globalThis.WebSocket;
      const expectedWsUrl = new URL("/v1/responses", server.url);
      expectedWsUrl.protocol = "ws:";
      const ws = new NativeWebSocket(expectedWsUrl, {
        headers: { authorization: "Bearer fixture-caller-main" },
      } as unknown as string[]);
      await new Promise<void>((resolve, reject) => {
        ws.addEventListener("open", () => resolve(), { once: true });
        ws.addEventListener("error", () => reject(new Error("fixture websocket failed to open")), { once: true });
      });
      const wsTurn = (model: string) => new Promise<Capture>((resolve, reject) => {
        const before = captures.length;
        const timer = setTimeout(() => reject(new Error(`fixture websocket timeout: ${model}`)), 2_000);
        const onMessage = (event: MessageEvent) => {
          if (!String(event.data).includes('"type":"response.completed"')) return;
          clearTimeout(timer);
          ws.removeEventListener("message", onMessage);
          if (captures.length !== before + 1) return reject(new Error(`unexpected capture count for ${model}`));
          resolve(captures.at(-1)!);
        };
        ws.addEventListener("message", onMessage);
        ws.send(JSON.stringify({ type: "response.create", model, input: "fixture" }));
      });
      expect(await wsTurn("gpt-5.6-sol")).toMatchObject({
        authorization: "Bearer fixture-pool-access",
        accountId: "fixture-pool-account",
        body: { model: "gpt-5.6-sol" },
      });
      expect(websocketRegistry.getTrackedCodexWebSocketCountForAccount("fixture-pool")).toBe(1);

      const directPatch = await patchMode("direct");
      expect(directPatch.status).toBe(200);
      expect(await directPatch.json()).toEqual({ success: true, name: "openai", codexAccountMode: "direct" });
      expect((await local("/api/config").then(response => response.json()) as typeof configDto).providers.openai.codexAccountMode).toBe("direct");
      const directBaseline = {
        config: hashTree(join(opencodexHome, "config.json")),
        accounts: hashTree(join(opencodexHome, "codex-accounts.json")),
        active: configModule.loadConfig().activeCodexAccountId,
        mainQuota: authApi.getAccountQuota(mainAccount.MAIN_CODEX_ACCOUNT_ID),
        addedQuota: authApi.getAccountQuota("fixture-pool"),
        mainHealth: routing.getCodexUpstreamHealth(mainAccount.MAIN_CODEX_ACCOUNT_ID),
        addedHealth: routing.getCodexUpstreamHealth("fixture-pool"),
      };

      for (const [path, model, stream] of [
        ["/v1/responses", "gpt-5.6-sol", false],
        ["/v1/responses", "gpt-5.6-terra", true],
        ["/v1/responses/compact", "gpt-5.6-luna", false],
      ] as const) {
        const response = await post(path, { model, input: path.endsWith("compact") ? [] : "direct fixture", stream }, {
          authorization: "Bearer fixture-caller-main",
        });
        expect(response.status).toBe(200);
        await response.text();
        expect(captures.at(-1)).toMatchObject({ authorization: "Bearer fixture-caller-main", accountId: null, body: { model } });
      }
      expect(await wsTurn("gpt-5.6-sol")).toMatchObject({
        authorization: "Bearer fixture-caller-main",
        accountId: null,
        body: { model: "gpt-5.6-sol" },
      });
      expect(websocketRegistry.getTrackedCodexWebSocketCountForAccount("fixture-pool")).toBe(0);
      const directAfter = {
        config: hashTree(join(opencodexHome, "config.json")),
        accounts: hashTree(join(opencodexHome, "codex-accounts.json")),
        active: configModule.loadConfig().activeCodexAccountId,
        mainQuota: authApi.getAccountQuota(mainAccount.MAIN_CODEX_ACCOUNT_ID),
        addedQuota: authApi.getAccountQuota("fixture-pool"),
        mainHealth: routing.getCodexUpstreamHealth(mainAccount.MAIN_CODEX_ACCOUNT_ID),
        addedHealth: routing.getCodexUpstreamHealth("fixture-pool"),
      };
      expect(directAfter).toEqual(directBaseline);

      const poolPatch = await patchMode("pool");
      expect(poolPatch.status).toBe(200);
      expect(await poolPatch.json()).toEqual({ success: true, name: "openai", codexAccountMode: "pool" });
      expect((await local("/api/providers").then(response => response.json()) as typeof providerRows)
        .find(row => row.name === "openai")?.codexAccountMode).toBe("pool");
      const poolAgain = await post("/v1/responses", {
        model: "gpt-5.6-terra", input: "pool after flip", stream: false,
      }, { authorization: "Bearer fixture-caller-main" });
      expect(poolAgain.status).toBe(200);
      await poolAgain.text();
      expect(captures.at(-1)).toMatchObject({ authorization: "Bearer fixture-pool-access", accountId: "fixture-pool-account" });

      const apiHttpCases = [
        { selected: "openai-apikey/gpt-5.6", wire: "gpt-5.6", mode: undefined },
        { selected: "openai-apikey/gpt-5.6-sol-pro", wire: "gpt-5.6-sol", mode: "pro" },
        { selected: "openai-apikey/gpt-5.6-terra-pro", wire: "gpt-5.6-terra", mode: "pro" },
        { selected: "openai-apikey/gpt-5.6-luna-pro", wire: "gpt-5.6-luna", mode: "pro" },
      ] as const;
      for (const row of apiHttpCases) {
        const response = await post("/v1/responses", {
          model: row.selected,
          input: "api fixture",
          stream: false,
          reasoning: { effort: "high" },
        }, { authorization: "Bearer fixture-caller-main" });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ model: row.wire });
        const capture = captures.at(-1)!;
        expect(capture).toMatchObject({
          url: "https://api.openai.com/v1/responses",
          authorization: "Bearer fixture-api-key",
          accountId: null,
          body: { model: row.wire },
        });
        if (row.mode) expect(capture.body.reasoning).toMatchObject({ effort: "high", mode: row.mode });
      }
      const apiWs = await wsTurn("openai-apikey/gpt-5.6-sol-pro");
      expect(apiWs).toMatchObject({
        url: "https://api.openai.com/v1/responses",
        authorization: "Bearer fixture-api-key",
        accountId: null,
        body: { model: "gpt-5.6-sol", reasoning: { mode: "pro" } },
      });
      const apiCompact = await post("/v1/responses/compact", {
        model: "openai-apikey/gpt-5.6-sol-pro",
        input: [],
        reasoning: { effort: "high", mode: "pro" },
      }, { authorization: "Bearer fixture-caller-main" });
      expect(apiCompact.status).toBe(200);
      expect(await apiCompact.json()).toMatchObject({ model: "gpt-5.6-sol" });
      expect(captures.at(-1)).toMatchObject({
        url: "https://api.openai.com/v1/responses/compact",
        authorization: "Bearer fixture-api-key",
        accountId: null,
        body: { model: "gpt-5.6-sol" },
      });
      expect(captures.at(-1)?.body.reasoning).toBeUndefined();

      const closed = new Promise<void>(resolve => ws.addEventListener("close", () => resolve(), { once: true }));
      ws.close();
      await closed;

      const selected = "openai-apikey/gpt-5.6-sol-pro";
      expect((await put("/api/disabled-models", { models: [selected] })).status).toBe(200);
      const modelRows = await local("/api/models").then(response => response.json()) as Array<{
        provider: string;
        id: string;
        namespaced: string;
        disabled: boolean;
        native?: boolean;
      }>;
      expect(modelRows.find(row => row.namespaced === selected)?.disabled).toBe(true);
      expect(modelRows.some(row => row.provider === "openai" && row.native === true && row.namespaced === row.id)).toBe(true);
      expect(modelRows.some(row => row.namespaced.startsWith("openai-apikey/"))).toBe(true);
      expect(modelRows.some(row => row.namespaced.startsWith("openai-multi/"))).toBe(false);
      expect((await put("/api/subagent-models", { models: [selected] })).status).toBe(200);
      expect(await local("/api/subagent-models").then(response => response.json())).toMatchObject({ chosen: [selected] });
      expect((await put("/api/injection-model", { model: selected, effort: "high" })).status).toBe(200);
      expect(await local("/api/injection-model").then(response => response.json())).toMatchObject({ model: selected, effort: "high" });

      const logs = await local("/api/logs").then(response => response.json()) as Array<Record<string, unknown>>;
      expect(logs.some(row => row.provider === "openai-p123abc"
        && row.requestedModel === "gpt-5.6-sol"
        && row.resolvedModel === "gpt-5.6-sol")).toBe(true);
      expect(logs.some(row => row.provider === "openai"
        && row.requestedModel === "gpt-5.6-sol"
        && row.resolvedModel === "gpt-5.6-sol")).toBe(true);
      expect(logs.some(row => row.provider === "openai-apikey"
        && row.model === "gpt-5.6-sol-pro"
        && row.requestedModel === selected
        && row.resolvedModel === "gpt-5.6-sol")).toBe(true);
      const usageLines = existsSync(join(opencodexHome, "usage.jsonl"))
        ? readFileSync(join(opencodexHome, "usage.jsonl"), "utf8").trim().split("\n").filter(Boolean)
          .map(line => JSON.parse(line) as Record<string, unknown>)
        : [];
      for (const expected of [
        { provider: "openai-p123abc", requestedModel: "gpt-5.6-sol", resolvedModel: "gpt-5.6-sol" },
        { provider: "openai", requestedModel: "gpt-5.6-sol", resolvedModel: "gpt-5.6-sol" },
        { provider: "openai-apikey", model: "gpt-5.6-sol-pro", requestedModel: selected, resolvedModel: "gpt-5.6-sol" },
      ]) expect(usageLines.some(row => Object.entries(expected).every(([key, value]) => row[key] === value))).toBe(true);

      const migrationRoot = mkdtempSync(join(tmpdir(), "ocx-provider-option-migration-"));
      try {
        const child = Bun.spawn([
          process.execPath,
          join(import.meta.dir, "fixtures/openai-provider-option-migration-child.ts"),
          join(migrationRoot, "opencodex"),
          join(migrationRoot, "codex"),
        ], { stdout: "pipe", stderr: "pipe", env: { ...process.env } });
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        expect(stderr).toBe("");
        expect(exitCode).toBe(0);
        const receipt = JSON.parse(stdout) as MigrationReceipt;
        expect(receipt).toEqual({
          backupMatchesOriginal: true,
          backupMode: expect.any(Number),
          v1BackupUnchanged: true,
          firstProviderIds: ["openai", "openai-apikey", "custom"],
          firstDefaultProvider: "openai",
          mode: "pool",
          hiddenLegacy: true,
          marker: 2,
          selectedModels: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
          knownReferencesRewritten: true,
          contextCapsMerged: true,
          warningPathsOnly: true,
          unrelatedProvidersUnchanged: true,
          unrelatedSelectedIdsUnchanged: true,
          secondIdempotent: true,
          secondNoSave: true,
          restoredByteIdentity: true,
          restoredLegacyParse: true,
          remigrated: true,
          absencePreserved: true,
          collisionFailsBeforeSave: false,
        });
        if (process.platform !== "win32") {
          expect(receipt.backupMode).toBe(0o600);
        }
      } finally {
        rmSync(migrationRoot, { recursive: true, force: true });
      }

      expect(captures.every(capture => upstreamTuples.has(`${capture.method} ${capture.url}`))).toBe(true);
      const evidenceDir = process.env.OCX_EVIDENCE_DIR;
      if (evidenceDir) {
        mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
        writeFileSync(join(evidenceDir, "030_e2e.json"), JSON.stringify({
          schemaVersion: 1,
          verdict: "PASS",
          publicNetworkFallback: false,
          poolDefault: "PASS",
          directIsolation: "PASS",
          http: "PASS",
          websocket: "PASS",
          compact: "PASS",
          apiProIsolation: "PASS",
          migrationRestore: "PASS",
          oneOpenAiModelGroup: "PASS",
          realClaudeStateUnchanged: true,
        }, null, 2) + "\n", { mode: 0o600 });
      }
    } finally {
      try {
        if (server) await server.stop(true);
      } finally {
        globalThis.fetch = savedFetch;
        for (const reset of resets) reset();
        restoreEnv("OPENCODEX_HOME", previousEnv.OPENCODEX_HOME);
        restoreEnv("CODEX_HOME", previousEnv.CODEX_HOME);
        restoreEnv("CLAUDE_CONFIG_DIR", previousEnv.CLAUDE_CONFIG_DIR);
        rmSync(root, { recursive: true, force: true });
        expect(hashTree(realClaudeDir)).toBe(realClaudeHashBefore);
      }
    }
  }, 30_000);
});
