import { describe, expect, test } from "bun:test";
import { handleAdvisorRoutes, parseAdvisorSettingsPatch } from "../../src/server/management/advisor-routes";
import { handleCompanionRoutes } from "../../src/server/management/companion-routes";
import type { ManagementApiDeps, ManagementContext } from "../../src/server/management/context";
import type { OcxConfig } from "../../src/types";
import { advisorActivityStore } from "../../src/advisor/activity";

/**
 * One complete `ManagementContext` for the route tests. Direct dispatch means the untrusted
 * admin-token case (`trustedLoopbackIngress: false`, no GUI session), and the two required
 * convergence seams are stubbed: the advisor routes never call them, but the fixture must still
 * satisfy the interface.
 */
function makeCtx(
  config: OcxConfig,
  method: string,
  body?: unknown,
  deps: ManagementApiDeps = {},
): { ctx: ManagementContext; saved: OcxConfig[] } {
  const saved: OcxConfig[] = [];
  const ctx: ManagementContext = {
    req: new Request("http://localhost/api/advisor/settings", {
      method,
      ...(body !== undefined ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}),
    }),
    url: new URL("http://localhost/api/advisor/settings"),
    config,
    deps: {
      saveConfigPreservingClaudeCode: cfg => {
        saved.push(cfg);
      },
      ...deps,
    },
    version: "test",
    trustedLoopbackIngress: false,
    guiSessionIssuance: null,
    convergeCodexCatalog: async () => ({ status: "skipped", reason: "not-requested", retryable: false }),
    syncClaudeAgentDefsBestEffort: async () => {},
  };
  return { ctx, saved };
}

const baseConfig = (): OcxConfig => ({
  port: 10100,
  providers: {},
}) as OcxConfig;

test("Advisor activity is routed through management and isolated by runtime config", async () => {
  const config = baseConfig();
  const store = advisorActivityStore(config);
  const id = store.start({ trigger: "repair_failure", workerModel: "worker", advisorModel: "expert", requestedEffort: "max" });
  store.finish(id, { status: "ok", durationMs: 20, effectiveEffort: null });
  const { ctx } = makeCtx(config, "GET");
  ctx.req = new Request("http://localhost/api/advisor/activity");
  ctx.url = new URL(ctx.req.url);
  const body = await (await handleCompanionRoutes(ctx))!.json();
  expect(body.entries).toHaveLength(1);
  expect(body.entries[0]).toMatchObject({ trigger: "repair_failure", effectiveEffort: null });
  expect(body.retention).toBe("process");
  const other = makeCtx(baseConfig(), "GET").ctx;
  other.req = new Request(ctx.req.url); other.url = new URL(ctx.req.url);
  expect((await (await handleAdvisorRoutes(other))!.json()).entries).toHaveLength(0);
});

describe("GET /api/advisor/settings", () => {
  test("context mode is validated, persisted and returned without changing the model", async () => {
    const config = baseConfig();
    config.advisor = { model: "expert/m", policy: "manual" };
    const { ctx, saved } = makeCtx(config, "PUT", { contextMode: "question-only" });
    const response = await handleAdvisorRoutes(ctx);
    expect(response!.status).toBe(200);
    expect((await response!.json()).settings.contextMode).toBe("question-only");
    expect(saved[0]!.advisor).toMatchObject({ model: "expert/m", policy: "manual", contextMode: "question-only" });
    for (const contextMode of [false, null, "question", ""]) expect(parseAdvisorSettingsPatch({ contextMode }).ok).toBe(false);
  });

  test("returns resolved settings with defaults and availability", async () => {
    const { ctx } = makeCtx(baseConfig(), "GET");
    const response = await handleAdvisorRoutes(ctx);
    expect(response).not.toBeNull();
    const body = await response!.json() as { settings: { enabled: boolean; policy: string }; runnable: boolean };
    expect(body.settings.enabled).toBe(false);
    expect(body.settings.policy).toBe("manual");
    expect(body.runnable).toBe(false);
  });

  test("flags enabled-without-model as a warning the GUI can show", async () => {
    const config = baseConfig();
    (config as { advisor?: unknown }).advisor = { enabled: true };
    const { ctx } = makeCtx(config, "GET");
    const body = await (await handleAdvisorRoutes(ctx))!.json() as { warning?: string; runnable: boolean };
    expect(body.warning).toBe("advisor_enabled_without_model");
    expect(body.runnable).toBe(false);
  });

  test("other paths and methods return null for the dispatcher", async () => {
    const { ctx } = makeCtx(baseConfig(), "DELETE");
    expect(await handleAdvisorRoutes(ctx)).toBeNull();
  });

  test("companion dispatch reaches advisor settings", async () => {
    // The management composition root is a sponsored surface, so the live
    // chain calls advisor routes from the next already-wired handler.
    const { ctx } = makeCtx(baseConfig(), "GET");
    const response = await handleCompanionRoutes(ctx);
    expect(response).not.toBeNull();
    const body = await response!.json() as { settings: { policy: string } };
    expect(body.settings.policy).toBe("manual");
  });
});

describe("PUT /api/advisor/settings", () => {
  test("partial patch persists in memory and through the locked writer", async () => {
    const config = baseConfig();
    const { ctx, saved } = makeCtx(config, "PUT", { enabled: true, model: "expert/gpt-6-astra" });
    const response = await handleAdvisorRoutes(ctx);
    const body = await response!.json() as {
      settings: { enabled: boolean; model: string; contextSharingConsent: string | null };
      runnable: boolean;
      warning?: string;
    };
    expect(body.settings.enabled).toBe(true);
    expect(body.settings.model).toBe("expert/gpt-6-astra");
    expect(body.settings.contextSharingConsent).toBeNull();
    expect(body.runnable).toBe(false);
    expect(body.warning).toBe("advisor_context_sharing_consent_required");
    expect(saved).toHaveLength(1);
    // In-memory and persisted state agree.
    expect((config as { advisor?: { model?: string } }).advisor?.model).toBe("expert/gpt-6-astra");
  });

  test("patches merge into an existing advisor block instead of replacing it", async () => {
    const config = baseConfig();
    (config as { advisor?: unknown }).advisor = { enabled: true, model: "keep/me", effort: "high" };
    const { ctx } = makeCtx(config, "PUT", { policy: "preflight" });
    const body = await (await handleAdvisorRoutes(ctx))!.json() as { settings: { model: string; effort: string; policy: string } };
    expect(body.settings.model).toBe("keep/me");
    expect(body.settings.effort).toBe("high");
    expect(body.settings.policy).toBe("preflight");
  });

  test("invalid values are refused with a named field and nothing is saved", async () => {
    for (const bad of [
      { effort: "ultra-plus" },
      { policy: "semantic" },
      { model: 42 },
      { enabled: "yes" },
      { unknown: true },
      { timeoutMs: 5 },
    ]) {
      const config = baseConfig();
      const { ctx, saved } = makeCtx(config, "PUT", bad);
      const response = await handleAdvisorRoutes(ctx);
      expect(response!.status).toBe(400);
      const body = await response!.json() as { error: { code: string; message: string } };
      expect(body.error.code).toMatch(/^invalid_|^unknown_field$/);
      expect(saved).toHaveLength(0);
    }
  });

  test("reset restores the disabled default and persists", async () => {
    const config = baseConfig();
    (config as { advisor?: unknown }).advisor = { enabled: true, model: "x/y" };
    const { ctx, saved } = makeCtx(config, "PUT", { reset: true });
    const body = await (await handleAdvisorRoutes(ctx))!.json() as { settings: { enabled: boolean } };
    expect(body.settings.enabled).toBe(false);
    expect(saved).toHaveLength(1);
    expect((config as { advisor?: unknown }).advisor).toBeUndefined();
  });

  test("a failed save restores the in-memory snapshot", async () => {
    const config = baseConfig();
    (config as { advisor?: unknown }).advisor = { enabled: false };
    const { ctx } = makeCtx(config, "PUT", { enabled: true }, {
      saveConfigPreservingClaudeCode: () => {
        throw new Error("disk full");
      },
    });
    const response = await handleAdvisorRoutes(ctx);
    expect(response!.status).toBe(500);
    expect((config as { advisor?: { enabled?: boolean } }).advisor?.enabled).toBe(false);
  });
});

describe("parseAdvisorSettingsPatch (strict validation)", () => {
  test("valid patches pass through", () => {
    expect(parseAdvisorSettingsPatch({ enabled: true, model: " m/n ", effort: "low", policy: "manual", timeoutMs: 1_800_000 }))
      .toEqual({ ok: true, patch: { enabled: true, model: "m/n", effort: "low", policy: "manual", timeoutMs: 1_800_000 } });
    expect(parseAdvisorSettingsPatch({ timeoutMs: 1_800_001 }).ok).toBe(false);
  });
  test("empty body and non-object bodies are refused", () => {
    expect(parseAdvisorSettingsPatch({}).ok).toBe(false);
    expect(parseAdvisorSettingsPatch("x").ok).toBe(false);
    expect(parseAdvisorSettingsPatch([]).ok).toBe(false);
  });

  test("reset combined with other fields is refused", async () => {
    const config = baseConfig();
    (config as { advisor?: unknown }).advisor = { enabled: true };
    const { ctx, saved } = makeCtx(config, "PUT", { reset: true, enabled: false });
    const response = await handleAdvisorRoutes(ctx);
    expect(response!.status).toBe(400);
    const body = await response!.json() as { error: { code: string } };
    expect(body.error.code).toBe("reset_with_fields");
    expect(saved).toHaveLength(0);
    expect((config as { advisor?: unknown }).advisor).toEqual({ enabled: true });
  });

  test("model clearing: an empty value clears the model and reports not-runnable", async () => {
    const config = baseConfig();
    (config as { advisor?: unknown }).advisor = { enabled: true, model: "expert/gpt-6-astra" };
    const { ctx, saved } = makeCtx(config, "PUT", { model: "" });
    const response = await handleAdvisorRoutes(ctx);
    expect(response!.status).toBe(200);
    const body = await response!.json() as {
      settings: { model: string; enabled: boolean };
      runnable: boolean;
      warning?: string;
    };
    // Clearing the model is a supported state, not a validation failure.
    expect(body.settings.model).toBe("");
    expect(body.settings.enabled).toBe(true);
    expect(body.runnable).toBe(false);
    // Enabled without a model is the state the GUI shows a warning for.
    expect(body.warning).toBe("advisor_enabled_without_model");
    expect(saved).toHaveLength(1);
    expect((config as { advisor?: { model?: string } }).advisor?.model).toBe("");
  });

  test("model clearing: a whitespace-only value trims to an empty model and saves", async () => {
    const config = baseConfig();
    (config as { advisor?: unknown }).advisor = { enabled: false, model: "expert/gpt-6-astra" };
    const { ctx, saved } = makeCtx(config, "PUT", { model: "   " });
    const response = await handleAdvisorRoutes(ctx);
    expect(response!.status).toBe(200);
    const body = await response!.json() as { settings: { model: string } };
    expect(body.settings.model).toBe("");
    expect(saved).toHaveLength(1);
    expect((config as { advisor?: { model?: string } }).advisor?.model).toBe("");
  });

  test("model validation still bounds the trimmed length at 200 characters", async () => {
    const config = baseConfig();
    const { ctx, saved } = makeCtx(config, "PUT", { model: `expert/${"m".repeat(200)}` });
    const response = await handleAdvisorRoutes(ctx);
    expect(response!.status).toBe(400);
    const body = await response!.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe("invalid_model");
    // The message now describes the real contract (string + trimmed bound; empty clears).
    expect(body.error.message).toContain("empty value clears");
    expect(saved).toHaveLength(0);
    // Exactly 200 trimmed characters is still accepted.
    const okCtx = makeCtx(baseConfig(), "PUT", { model: "m".repeat(200) }).ctx;
    expect((await handleAdvisorRoutes(okCtx))!.status).toBe(200);
  });
});

describe("PUT /api/advisor/settings context-sharing consent", () => {
  test("current consent is stored, returned, and makes a configured advisor runnable", async () => {
    const config = baseConfig();
    const { ctx, saved } = makeCtx(config, "PUT", {
      enabled: true,
      model: "expert/gpt-6-astra",
      contextSharingConsent: "v1",
    });
    const body = await (await handleAdvisorRoutes(ctx))!.json() as {
      settings: { contextSharingConsent: string | null; enabled: boolean };
      runnable: boolean;
    };
    expect(body.settings.contextSharingConsent).toBe("v1");
    expect(body.settings.enabled).toBe(true);
    expect(body.runnable).toBe(true);
    expect((config as { advisor?: { contextSharingConsent?: string } }).advisor?.contextSharingConsent).toBe("v1");
    expect(saved).toHaveLength(1);
  });

  test("unknown versions and wrong types are refused and nothing is saved", async () => {
    for (const contextSharingConsent of ["v0", "V1", true, 1, ""]) {
      const config = baseConfig();
      const { ctx, saved } = makeCtx(config, "PUT", { contextSharingConsent });
      const response = await handleAdvisorRoutes(ctx);
      expect(response!.status).toBe(400);
      const body = await response!.json() as { error: { code: string } };
      expect(body.error.code).toBe("invalid_context_sharing_consent");
      expect(saved).toHaveLength(0);
    }
  });

  test("null removes consent and immediately blocks a previously runnable advisor", async () => {
    const config = baseConfig();
    (config as { advisor?: unknown }).advisor = {
      enabled: true,
      model: "expert/gpt-6-astra",
      contextSharingConsent: "v1",
    };
    const { ctx } = makeCtx(config, "PUT", { contextSharingConsent: null });
    const body = await (await handleAdvisorRoutes(ctx))!.json() as {
      settings: { contextSharingConsent: string | null; enabled: boolean };
      runnable: boolean;
      warning?: string;
    };
    expect(body.settings.enabled).toBe(true);
    expect(body.settings.contextSharingConsent).toBeNull();
    expect(body.runnable).toBe(false);
    expect(body.warning).toBe("advisor_context_sharing_consent_required");
    expect((config as { advisor?: { contextSharingConsent?: string } }).advisor?.contextSharingConsent).toBeUndefined();
  });

  test("reset removes consent along with the rest of the advisor block", async () => {
    const config = baseConfig();
    (config as { advisor?: unknown }).advisor = {
      enabled: true,
      model: "expert/gpt-6-astra",
      contextSharingConsent: "v1",
    };
    const { ctx } = makeCtx(config, "PUT", { reset: true });
    const body = await (await handleAdvisorRoutes(ctx))!.json() as {
      settings: { enabled: boolean; contextSharingConsent: string | null };
      runnable: boolean;
    };
    expect(body.settings.enabled).toBe(false);
    expect(body.settings.contextSharingConsent).toBeNull();
    expect(body.runnable).toBe(false);
    expect((config as { advisor?: unknown }).advisor).toBeUndefined();
  });

  test("enabling without consent is stored and left unrunnable", async () => {
    const config = baseConfig();
    const { ctx } = makeCtx(config, "PUT", { enabled: true, model: "expert/gpt-6-astra" });
    const body = await (await handleAdvisorRoutes(ctx))!.json() as { runnable: boolean; warning?: string };
    expect(body.runnable).toBe(false);
    expect(body.warning).toBe("advisor_context_sharing_consent_required");
  });
});

describe("POST /api/advisor/consult and MCP tool helper", () => {
  const originalFetch = globalThis.fetch;

  test("refuses when disabled or missing consent", async () => {
    const disabledCfg = baseConfig();
    const disabledCtx = makeCtx(disabledCfg, "POST", { question: "Which approach?" }).ctx;
    disabledCtx.req = new Request("http://localhost/api/advisor/consult", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "Which approach?" }),
    });
    disabledCtx.url = new URL(disabledCtx.req.url);
    const disabledRes = await handleCompanionRoutes(disabledCtx);
    expect(disabledRes!.status).toBe(409);
    expect((await disabledRes!.json()).error.code).toBe("advisor_disabled");

    const noConsentCfg = baseConfig();
    (noConsentCfg as { advisor?: unknown }).advisor = { enabled: true, model: "expert/gpt-6-astra" };
    const noConsentCtx = makeCtx(noConsentCfg, "POST", { question: "Which approach?" }).ctx;
    noConsentCtx.req = new Request("http://localhost/api/advisor/consult", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "Which approach?" }),
    });
    noConsentCtx.url = new URL(noConsentCtx.req.url);
    const noConsentRes = await handleCompanionRoutes(noConsentCtx);
    expect(noConsentRes!.status).toBe(409);
    expect((await noConsentRes!.json()).error.code).toBe("advisor_consent_required");
  });

  test("returns 200 completed via mocked loopback fetch and supports 202 polling", async () => {
    const config = baseConfig();
    (config as { advisor?: unknown }).advisor = {
      enabled: true,
      model: "expert/gpt-6-astra",
      contextSharingConsent: "v1",
      timeoutMs: 5000,
    };

    try {
      globalThis.fetch = (async () => {
        await Bun.sleep(25);
        return new Response(JSON.stringify({
          choices: [{ message: { content: "Check the session header bridge first." } }],
          usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }) as unknown as typeof fetch;

      const makeConsultCtx = (payload: Record<string, unknown>) => {
        const ctx = makeCtx(config, "POST", payload).ctx;
        ctx.req = new Request("http://localhost/api/advisor/consult", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        ctx.url = new URL(ctx.req.url);
        return ctx;
      };

      const first = await handleAdvisorRoutes(makeConsultCtx({
        question: "Why is adaptive advisor skipped?",
        context: "Headers include baggage=codebuddy.session_id=s1",
        waitMs: 5,
      }));
      expect(first!.status).toBe(202);
      const firstBody = await first!.json() as { status: string; consultationId: string };
      expect(firstBody.status).toBe("in_progress");
      expect(typeof firstBody.consultationId).toBe("string");

      const second = await handleAdvisorRoutes(makeConsultCtx({
        consultationId: firstBody.consultationId,
        waitMs: 1000,
      }));
      expect(second!.status).toBe(200);
      const secondBody = await second!.json() as { ok: boolean; status: string; advice: string; consultationId: string };
      expect(secondBody.ok).toBe(true);
      expect(secondBody.status).toBe("completed");
      expect(secondBody.consultationId).toBe(firstBody.consultationId);
      expect(secondBody.advice).toBe("Check the session header bridge first.");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("MCP tool helper translates 202 in_progress into polling instruction", async () => {
    const { callAdvisorConsultApi, resolveDefaultMcpWaitMs } = await import("../../src/advisor/mcp-server");
    const result = await callAdvisorConsultApi(
      { question: "Need review" },
      {
        baseUrl: "http://127.0.0.1:14599",
        waitMs: 45_000,
        fetchImpl: (async () => new Response(JSON.stringify({
          ok: true,
          status: "in_progress",
          consultationId: "cid-123",
          advisorModel: "xai/grok-4.7",
          elapsedMs: 45_001,
        }), { status: 202, headers: { "content-type": "application/json" } })) as unknown as typeof fetch,
      },
    );
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0]!.text) as { status: string; consultationId: string; instruction: string };
    expect(parsed.status).toBe("in_progress");
    expect(parsed.consultationId).toBe("cid-123");
    expect(parsed.instruction).toContain("cid-123");
  });

  test("ocx advisor consult polls 202 in_progress until completed", async () => {
    const { handleAdvisorCommand } = await import("../../src/cli/advisor");
    const calls: unknown[] = [];
    let attempt = 0;
    const stdoutLines: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => { stdoutLines.push(args.map(String).join(" ")); };
    try {
      const code = await handleAdvisorCommand(
        ["consult", "--question", "Check design", "--json"],
        {
          baseUrl: "http://127.0.0.1:14599",
          fetchImpl: (async (_url: RequestInfo | URL, init?: RequestInit) => {
            calls.push(JSON.parse(String(init?.body)));
            attempt += 1;
            if (attempt === 1) {
              return new Response(JSON.stringify({
                ok: true, status: "in_progress", consultationId: "cid-cli-1", advisorModel: "xai/grok-4.7", elapsedMs: 100,
              }), { status: 202, headers: { "content-type": "application/json" } });
            }
            return new Response(JSON.stringify({
              ok: true, status: "completed", consultationId: "cid-cli-1", advisorModel: "xai/grok-4.7", advice: "Use poll loop",
            }), { status: 200, headers: { "content-type": "application/json" } });
          }) as unknown as typeof fetch,
        },
      );
      expect(code).toBe(0);
    } finally {
      console.log = origLog;
    }
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual({ consultationId: "cid-cli-1" });
    expect(stdoutLines.join("\n")).toContain("Use poll loop");
  });

  test("chat-completions derives Advisor session identity from explicit session headers, not cache keys", async () => {
    const { deriveChatSessionId } = await import("../../src/server/chat-completions");
    expect(deriveChatSessionId(
      new Headers({ baggage: "env=prod, codebuddy.session_id=wb-sess-42%2Fabc;k=1" }),
      {},
    )).toBe("wb-sess-42/abc");
    expect(deriveChatSessionId(
      new Headers({ "x-session-id": "xs-1", baggage: "codebuddy.session_id=wb-1" }),
      { prompt_cache_key: "pck-1" },
    )).toBe("xs-1");
    expect(deriveChatSessionId(
      new Headers({ "x-conversation-id": "conv-9" }),
      {},
    )).toBe("conv-9");
    expect(deriveChatSessionId(
      new Headers(),
      { prompt_cache_key: "cache-key-77" },
    )).toBeUndefined();
    expect(deriveChatSessionId(
      new Headers({ baggage: "codebuddy.session_id=bad%0Anewline" }),
      { prompt_cache_key: "bad\nnewline" },
    )).toBeUndefined();
    const { advisorConversationIdentity } = await import("../../src/advisor/state");
    expect(advisorConversationIdentity({ _advisorSessionIdentity: "wb-sess-42/abc" })).toBe("wb-sess-42/abc");
  });

  test("runExternalAdvisorConsult auto-attaches local WorkBuddy jsonl transcript in full context mode", async () => {
    const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { runExternalAdvisorConsult } = await import("../../src/advisor/external-consult");

    const rootDir = mkdtempSync(join(tmpdir(), "ocx-wb-transcript-"));
    try {
      const projDir = join(rootDir, "Users-test-proj");
      mkdirSync(projDir, { recursive: true });
      const sessionFile = join(projDir, "sess-wb-123.jsonl");
      const rawLines = [
        JSON.stringify({
          type: "message",
          role: "user",
          timestamp: 1_000,
          content: [{ type: "input_text", text: '<system-reminder>large metadata</system-reminder>\n<user_query>Original unedited task description from user</user_query>' }],
        }),
        JSON.stringify({
          type: "message",
          role: "assistant",
          timestamp: 1_001,
          providerData: { model: "deepseek-v4.1-flash", requestModelId: "custom-local:deepseek-v4.1-flash" },
          content: [{ type: "output_text", text: "Let me inspect the failing script." }],
        }),
        JSON.stringify({
          type: "function_call",
          callId: "c_bash",
          name: "Bash",
          timestamp: 1_002,
          arguments: JSON.stringify({ command: "bun test" }),
        }),
        JSON.stringify({
          type: "function_call_result",
          callId: "c_bash",
          name: "Bash",
          status: "completed",
          timestamp: 1_003,
          output: { type: "text", text: "Raw error output: SQLITE_BUSY_SNAPSHOT at line 88" },
        }),
        JSON.stringify({
          type: "function_call",
          callId: "c_adv_search",
          name: "ToolSearch",
          timestamp: 1_004,
          arguments: JSON.stringify({ tool_names: ["mcp__opencodex-advisor__consult_advisor"] }),
        }),
        JSON.stringify({
          type: "function_call_result",
          callId: "c_adv_search",
          name: "ToolSearch",
          status: "completed",
          timestamp: 1_005,
          output: { type: "text", text: "Found mcp__opencodex-advisor__consult_advisor" },
        }),
      ].join("\n");
      writeFileSync(sessionFile, rawLines);

      const cfg = baseConfig();
      (cfg as { advisor?: unknown }).advisor = {
        enabled: true,
        model: "xai/grok-4.7",
        contextMode: "full",
        contextSharingConsent: "v1",
      };

      let seenBody: { messages?: Array<{ role: string; content: string }> } | undefined;
      const res = await runExternalAdvisorConsult(
        cfg,
        {
          question: "Which state machine fix is safest?",
          context: "Worker draft notes",
          workerModel: "deepseek-v4",
          sessionId: "sess-wb-123",
        },
        {
          workbuddyProjectsDir: rootDir,
          consultFn: async (input) => {
            const { buildAdvisorUserPrompt } = await import("../../src/advisor/context");
            seenBody = {
              messages: [{ role: "user", content: buildAdvisorUserPrompt(input) }],
            };
            expect(input.workerIdentity).toContain("deepseek-v4.1-flash");
            expect(input.contextMode).toBe("full");
            return { ok: true, advice: "Use BEGIN IMMEDIATE.", advisorModel: "xai/grok-4.7", durationMs: 12 };
          },
        },
      );
      expect(res.status).toBe(200);
      const userPrompt = seenBody!.messages![0]!.content;
      expect(userPrompt).toContain("Original unedited task description from user");
      expect(userPrompt).toContain("SQLITE_BUSY_SNAPSHOT at line 88");
      expect(userPrompt).toContain("Worker draft notes");
      expect(userPrompt).not.toContain("<system-reminder>");
      expect(userPrompt).not.toContain("ToolSearch");
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test("parseAdvisorSettingsPatch validates autoMountMcp and mcpClients cleanly", () => {
    expect(parseAdvisorSettingsPatch({ autoMountMcp: false, mcpClients: ["workbuddy", "qoder-cn"] }))
      .toEqual({ ok: true, patch: { autoMountMcp: false, mcpClients: ["workbuddy", "qoder-cn"] } });
    expect(parseAdvisorSettingsPatch({ mcpClients: null }))
      .toEqual({ ok: true, patch: { mcpClients: null } });
    expect(parseAdvisorSettingsPatch({ autoMountMcp: "yes" }))
      .toMatchObject({ ok: false, code: "invalid_auto_mount_mcp" });
    expect(parseAdvisorSettingsPatch({ mcpClients: ["unknown-client"] }))
      .toMatchObject({ ok: false, code: "invalid_mcp_clients" });
  });

  test("client-mcp mounts WorkBuddy MCP/hooks/skill, detects trust approvals, preserves shared routing ownership, and unmounts cleanly", async () => {
    const { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { fingerprint, writeRecord, readRecords, integrationsDir } = await import("../../src/integrations/ownership");
    const {
      mountAdvisorMcpForClient,
      unmountAdvisorMcpForClient,
      syncAdvisorMcpClients,
      listAdvisorMcpClientStatuses,
    } = await import("../../src/advisor/client-mcp");

    const fakeHome = mkdtempSync(join(tmpdir(), "ocx-client-mcp-"));
    const ocxDir = join(fakeHome, ".opencodex");
    const env = {};
    try {
      // Seed WorkBuddy existing MCP + unrelated hook
      mkdirSync(join(fakeHome, ".workbuddy"), { recursive: true });
      writeFileSync(join(fakeHome, ".workbuddy", "mcp.json"), JSON.stringify({
        mcpServers: { existing: { command: "echo" } },
      }, null, 2));
      writeFileSync(join(fakeHome, ".workbuddy", "settings.json"), JSON.stringify({
        hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "/other/hook" }] }] },
      }, null, 2));

      // Seed Qoder CN shared settings.json + clean routing ownership record
      mkdirSync(join(fakeHome, ".qoder-cn"), { recursive: true });
      const qoderPath = join(fakeHome, ".qoder-cn", "settings.json");
      const qoderInitial = JSON.stringify({ providers: { opencodex: { name: "OpenCodex" } } }, null, 2) + "\n";
      writeFileSync(qoderPath, qoderInitial);
      writeRecord({
        clientId: "qoder-cn",
        configPath: qoderPath,
        fileFingerprint: fingerprint(qoderInitial),
        blockFingerprint: "0123456789abcdef",
        fragmentPaths: [["providers", "opencodex"]],
        appliedAt: new Date().toISOString(),
        opId: "op-qoder-1",
      }, integrationsDir(ocxDir));

      // Seed WorkBuddy as routed too
      writeRecord({
        clientId: "workbuddy",
        configPath: join(fakeHome, ".workbuddy", "models.json"),
        fileFingerprint: "fedcba9876543210",
        blockFingerprint: "fedcba9876543210",
        fragmentPaths: [["models"]],
        appliedAt: new Date().toISOString(),
        opId: "op-wb-1",
      }, integrationsDir(ocxDir));

      // Seed Cline
      mkdirSync(join(fakeHome, ".cline", "data", "settings"), { recursive: true });

      const cfg = baseConfig();
      (cfg as { advisor?: unknown }).advisor = { enabled: true, model: "xai/grok-4.7", contextSharingConsent: "v1", autoMountMcp: true };

      const syncRes = syncAdvisorMcpClients(cfg, { homeDir: fakeHome, configDir: ocxDir, env });
      expect(syncRes.errors).toEqual([]);
      expect(syncRes.mounted).toContain("workbuddy");
      expect(syncRes.mounted).toContain("qoder-cn");
      expect(syncRes.mounted).not.toContain("cline");
      expect(syncRes.mounted).not.toContain("claude");

      // WorkBuddy MCP + hook + skill + untrusted status initially
      const wbMcp = JSON.parse(readFileSync(join(fakeHome, ".workbuddy", "mcp.json"), "utf8"));
      expect(wbMcp.mcpServers.existing).toEqual({ command: "echo" });
      expect(wbMcp.mcpServers["opencodex-advisor"].args.slice(-2)).toEqual(["advisor", "mcp"]);
      expect(wbMcp.mcpServers["opencodex-advisor"].timeout).toBe(900_000);
      expect(wbMcp.mcpServers["opencodex-advisor"].env.OCX_ADVISOR_MCP_WAIT_MS).toBe("240000");
      expect(existsSync(join(fakeHome, ".workbuddy", "skills", "opencodex-advisor", "SKILL.md"))).toBe(true);
      let wbStatus = listAdvisorMcpClientStatuses(cfg, { homeDir: fakeHome, configDir: ocxDir, env }).find(s => s.clientId === "workbuddy")!;
      expect(wbStatus.trustStatus).toBe("action_required");
      expect(wbStatus.hooksMounted).toBe(true);

      // Simulate WorkBuddy user clicking Trust -> mcp-approvals.json entry added
      writeFileSync(join(fakeHome, ".workbuddy", "mcp-approvals.json"), JSON.stringify({
        "abc123::opencodex-advisor": 1794920570651,
      }));
      wbStatus = listAdvisorMcpClientStatuses(cfg, { homeDir: fakeHome, configDir: ocxDir, env }).find(s => s.clientId === "workbuddy")!;
      expect(wbStatus.trustStatus).toBe("trusted");

      // Qoder CN shared file edited AND OwnershipRecord fileFingerprint updated so Routing stays clean
      const qoderUpdatedText = readFileSync(qoderPath, "utf8");
      const qoderUpdated = JSON.parse(qoderUpdatedText);
      expect(qoderUpdated.providers.opencodex).toEqual({ name: "OpenCodex" });
      expect(qoderUpdated.mcpServers["opencodex-advisor"].transport).toBe("stdio");
      expect(qoderUpdated.hooks.UserPromptSubmit).toHaveLength(1);
      expect(existsSync(join(fakeHome, ".qoder-cn", "skills", "opencodex-advisor", "SKILL.md"))).toBe(true);
      const { spawnSync } = await import("node:child_process");
      const shCheck = spawnSync("sh", ["-n", join(fakeHome, ".qoder-cn", "hooks", "opencodex-advisor-notice.sh")], { encoding: "utf8" });
      expect(shCheck.status).toBe(0);
      expect(readFileSync(join(fakeHome, ".qoder-cn", "hooks", "opencodex-advisor-notice.sh"), "utf8")).toContain("cat <<'EOF'");
      const updatedRecord = readRecords(integrationsDir(ocxDir))["qoder-cn"];
      expect(updatedRecord?.fileFingerprint).toBe(fingerprint(qoderUpdatedText));

      // Explicit selection: mount cline & claude, automatically unmounting workbuddy & qoder-cn
      (cfg as { advisor?: unknown }).advisor = {
        enabled: true,
        model: "xai/grok-4.7",
        contextSharingConsent: "v1",
        mcpClients: ["cline", "claude"],
      };
      const manualRes = syncAdvisorMcpClients(cfg, { homeDir: fakeHome, configDir: ocxDir, env });
      expect(manualRes.mounted.sort()).toEqual(["claude", "cline"]);
      expect(manualRes.unmounted.sort()).toEqual(["qoder-cn", "workbuddy"]);

      const qoderAfterUnmount = JSON.parse(readFileSync(qoderPath, "utf8"));
      expect(qoderAfterUnmount.mcpServers["opencodex-advisor"]).toBeUndefined();
      expect(qoderAfterUnmount.hooks).toBeUndefined();
      expect(existsSync(join(fakeHome, ".qoder-cn", "skills", "opencodex-advisor", "SKILL.md"))).toBe(false);
      expect(readRecords(integrationsDir(ocxDir))["qoder-cn"]?.fileFingerprint)
        .toBe(fingerprint(readFileSync(qoderPath, "utf8")));

      const clineMcp = JSON.parse(readFileSync(join(fakeHome, ".cline", "data", "settings", "cline_mcp_settings.json"), "utf8"));
      expect(clineMcp.mcpServers["opencodex-advisor"].autoApprove).toBeUndefined();
      expect(clineMcp.mcpServers["opencodex-advisor"].timeout).toBe(900);
      expect(clineMcp.mcpServers["opencodex-advisor"].env.OCX_ADVISOR_MCP_WAIT_MS).toBe("240000");
      const clineStatus = manualRes.statuses.find(s => s.clientId === "cline")!;
      expect(clineStatus.trustStatus).toBe("needs_confirmation");
      const claudeJson = JSON.parse(readFileSync(join(fakeHome, ".claude.json"), "utf8"));
      expect(claudeJson.mcpServers["opencodex-advisor"].type).toBe("stdio");

      // OpenCode installs timeout (ms), OCX_ADVISOR_MCP_WAIT_MS, and anti-forgetting SKILL.md cleanly
      const opencodeEnv = { ...env, XDG_CONFIG_HOME: join(fakeHome, ".config") };
      expect(mountAdvisorMcpForClient("opencode", { homeDir: fakeHome, configDir: ocxDir, env: opencodeEnv }).ok).toBe(true);
      const opencodeCfg = JSON.parse(readFileSync(join(fakeHome, ".config", "opencode", "opencode.json"), "utf8"));
      expect(opencodeCfg.mcp["opencodex-advisor"].timeout).toBe(900_000);
      expect(opencodeCfg.mcp["opencodex-advisor"].environment.OCX_ADVISOR_MCP_WAIT_MS).toBe("240000");
      expect(existsSync(join(fakeHome, ".config", "opencode", "skills", "opencodex-advisor", "SKILL.md"))).toBe(true);
      expect(unmountAdvisorMcpForClient("opencode", { homeDir: fakeHome, configDir: ocxDir, env: opencodeEnv }).changed).toBe(true);
      expect(existsSync(join(fakeHome, ".config", "opencode", "skills", "opencodex-advisor", "SKILL.md"))).toBe(false);

      // User's unrelated WorkBuddy MCP server & hook must survive cleanly after unmount
      const wbMcpAfter = JSON.parse(readFileSync(join(fakeHome, ".workbuddy", "mcp.json"), "utf8"));
      expect(wbMcpAfter.mcpServers.existing).toEqual({ command: "echo" });
      expect(wbMcpAfter.mcpServers["opencodex-advisor"]).toBeUndefined();
      const wbSettingsAfter = JSON.parse(readFileSync(join(fakeHome, ".workbuddy", "settings.json"), "utf8"));
      expect(wbSettingsAfter.hooks.UserPromptSubmit).toHaveLength(1);
      expect(wbSettingsAfter.hooks.UserPromptSubmit[0].hooks[0].command).toBe("/other/hook");

      // Direct mount/unmount helper sanity
      expect(mountAdvisorMcpForClient("commandcode", { homeDir: fakeHome, configDir: ocxDir, env }).ok).toBe(true);
      expect(existsSync(join(fakeHome, ".commandcode", "mcp.json"))).toBe(true);
      expect(unmountAdvisorMcpForClient("commandcode", { homeDir: fakeHome, configDir: ocxDir, env }).changed).toBe(true);
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  test("loadWorkBuddySessionMessages parses Qoder/Claude-style session jsonl transcripts and filters advisor polls/thinking", async () => {
    const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { runExternalAdvisorConsult } = await import("../../src/advisor/external-consult");
    const { callAdvisorConsultApi, resolveDefaultMcpWaitMs } = await import("../../src/advisor/mcp-server");

    const rootDir = mkdtempSync(join(tmpdir(), "ocx-qoder-sess-"));
    try {
      const sessDir = join(rootDir, "-Users-demo-proj");
      mkdirSync(sessDir, { recursive: true });
      const sessFile = join(sessDir, "qoder-sess-fixture.jsonl");
      writeFileSync(sessFile, [
        JSON.stringify({ type: "runtime-config", sessionId: "qoder-sess-fixture", model: "dfmodel", timestamp: 1_000 }),
        JSON.stringify({
          type: "user",
          timestamp: "2026-11-17T16:30:26.450Z",
          message: { role: "user", content: [{ type: "text", text: "Fix multi-process OAuth token refresh race in SQLite" }] },
        }),
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-11-17T16:31:00.000Z",
          message: {
            role: "assistant",
            model: "auto",
            content: [
              { type: "thinking", thinking: "SECRET_INTERNAL_COT_DO_NOT_LEAK" },
              { type: "text", text: "Checking existing implementation." },
              { type: "tool_use", id: "t_bash", name: "Bash", input: { command: "node --test" } },
            ],
          },
        }),
        JSON.stringify({
          type: "user",
          timestamp: "2026-11-17T16:31:05.000Z",
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "t_bash", content: "invalid_grant failure on worker 2", is_error: true }],
          },
        }),
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-11-17T16:32:00.000Z",
          message: {
            role: "assistant",
            model: "auto",
            content: [
              { type: "tool_use", id: "t_mcp_poll", name: "mcp_call", input: { toolName: "mcp__opencodex_advisor__consult_advisor", arguments: { consultationId: "old-cid" } } },
            ],
          },
        }),
        JSON.stringify({
          type: "user",
          timestamp: "2026-11-17T16:32:10.000Z",
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "t_mcp_poll", content: '{"status":"in_progress","consultationId":"old-cid"}', is_error: false }],
          },
        }),
      ].join("\n"));

      const cfg = baseConfig();
      (cfg as { advisor?: unknown }).advisor = {
        enabled: true,
        model: "xai/grok-4.7",
        contextMode: "full",
        contextSharingConsent: "v1",
      };

      let promptText = "";
      const res = await runExternalAdvisorConsult(
        cfg,
        { question: "Review lease design", sessionId: "qoder-sess-fixture" },
        {
          workbuddyProjectsDir: rootDir,
          consultFn: async input => {
            expect(input.workerIdentity).toContain("dfmodel");
            const { buildAdvisorUserPrompt } = await import("../../src/advisor/context");
            promptText = buildAdvisorUserPrompt(input);
            return { ok: true, advice: "Fence generation before commit.", advisorModel: "xai/grok-4.7", durationMs: 15 };
          },
        },
      );
      expect(res.status).toBe(200);
      expect(promptText).toContain("Fix multi-process OAuth token refresh race in SQLite");
      expect(promptText).toContain("invalid_grant failure on worker 2");
      expect(promptText).not.toContain("SECRET_INTERNAL_COT_DO_NOT_LEAK");
      expect(promptText).not.toContain("old-cid");

      // Also verify callAdvisorConsultApi instructs callers to pass distinct afterElapsedMs when polling
      const mcpResult = await callAdvisorConsultApi(
        { question: "Long check" },
        {
          fetchImpl: (async () => Response.json({
            ok: true,
            status: "in_progress",
            consultationId: "cid-qoder-1",
            advisorModel: "xai/grok-4.7",
            elapsedMs: 45123,
          }, { status: 202 })) as unknown as typeof fetch,
          baseUrl: "http://127.0.0.1:10100",
        },
      );
      const parsedMcp = JSON.parse(mcpResult.content[0]!.text);
      expect(parsedMcp.status).toBe("in_progress");
      expect(parsedMcp.afterElapsedMs).toBe(45123);
      expect(parsedMcp.nextCallArguments).toEqual({ consultationId: "cid-qoder-1", afterElapsedMs: 45123 });
      expect(parsedMcp.instruction).toContain('"afterElapsedMs":45123');
      expect(resolveDefaultMcpWaitMs("")).toBe(45_000);
      expect(resolveDefaultMcpWaitMs("240000")).toBe(240_000);
      expect(resolveDefaultMcpWaitMs("9999999")).toBe(240_000);

      // Command Code jsonl (type: "message" + nested message + top-level row.model) and Claude attachment model
      const ccFile = join(sessDir, "commandcode-sess-fixture.jsonl");
      writeFileSync(ccFile, [
        JSON.stringify({
          type: "message",
          model: "deepseek/deepseek-v4.1-flash",
          timestamp: "2026-11-17T17:00:00.000Z",
          message: { role: "user", content: [{ type: "text", text: "Command Code race check" }] },
        }),
        JSON.stringify({
          type: "message",
          model: "deepseek/deepseek-v4.1-flash",
          timestamp: "2026-11-17T17:00:10.000Z",
          message: { role: "assistant", content: [{ type: "text", text: "Inspecting lock path." }] },
        }),
      ].join("\n"));
      let ccPrompt = "";
      const ccRes = await runExternalAdvisorConsult(
        cfg,
        { question: "Audit lock", sessionId: "commandcode-sess-fixture" },
        {
          workbuddyProjectsDir: rootDir,
          consultFn: async input => {
            expect(input.workerIdentity).toContain("deepseek/deepseek-v4.1-flash");
            const { buildAdvisorUserPrompt } = await import("../../src/advisor/context");
            ccPrompt = buildAdvisorUserPrompt(input);
            return { ok: true, advice: "Lock looks sound.", advisorModel: "xai/grok-4.7", durationMs: 12 };
          },
        },
      );
      expect(ccRes.status).toBe(200);
      expect(ccPrompt).toContain("Command Code race check");
      expect(ccPrompt).toContain("Inspecting lock path.");

      const claudeFile = join(sessDir, "claude-att-1.jsonl");
      writeFileSync(claudeFile, [
        JSON.stringify({
          type: "attachment",
          attachment: { type: "model", identity: { modelId: "claude-opus-5-5" } },
          timestamp: 1000,
        }),
        JSON.stringify({
          type: "user",
          timestamp: "2026-11-17T17:05:00.000Z",
          message: { role: "user", content: [{ type: "text", text: "Claude attachment model test" }] },
        }),
      ].join("\n"));
      const claudeRes = await runExternalAdvisorConsult(
        cfg,
        { question: "Verify model", sessionId: "claude-att-1" },
        {
          workbuddyProjectsDir: rootDir,
          consultFn: async input => {
            expect(input.workerIdentity).toContain("claude-opus-5-5");
            return { ok: true, advice: "Model captured.", advisorModel: "xai/grok-4.7", durationMs: 10 };
          },
        },
      );
      expect(claudeRes.status).toBe(200);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test("external consult enforces consent in question-only, explicit-ID full-only transcripts, taskId/transcript fingerprints, 240s wait cap, and bounded non-evicting capacity", async () => {
    const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { runExternalAdvisorConsult } = await import("../../src/advisor/external-consult");
    const { consultAdvisorInput } = await import("../../src/advisor/mcp-server");

    // 1. question-only without consent is rejected consistently with routed path.
    const noConsentCfg = baseConfig();
    (noConsentCfg as { advisor?: unknown }).advisor = {
      enabled: true,
      model: "expert/gpt-6-astra",
      contextMode: "question-only",
    };
    const qOnlyDenied = await runExternalAdvisorConsult(noConsentCfg, { question: "Standalone?" });
    expect(qOnlyDenied.status).toBe(409);
    expect((qOnlyDenied.body.error as { code: string }).code).toBe("advisor_consent_required");
    expect((qOnlyDenied.body.error as { message: string }).message).toContain("ocx advisor consent`");

    // 2. waitMs > 240000 is rejected to stay below Bun's 255s idle timeout; afterElapsedMs > 1h is accepted.
    const cfg = baseConfig();
    (cfg as { advisor?: unknown }).advisor = {
      enabled: true,
      model: "expert/gpt-6-astra",
      contextMode: "context",
      contextSharingConsent: "v1",
    };
    const overWait = await runExternalAdvisorConsult(cfg, { question: "Too long wait", waitMs: 240_001 });
    expect(overWait.status).toBe(400);
    expect((overWait.body.error as { code: string }).code).toBe("invalid_wait_ms");
    expect(consultAdvisorInput.afterElapsedMs.safeParse(4_500_000).success).toBe(true);

    // 3. No transcript is attached without explicit sessionId/taskId/transcriptPath, nor in default contextMode="context".
    const rootDir = mkdtempSync(join(tmpdir(), "ocx-ext-sec-"));
    try {
      const projDir = join(rootDir, "p1");
      mkdirSync(projDir, { recursive: true });
      writeFileSync(join(projDir, "sess-a.jsonl"), `${JSON.stringify({
        type: "user",
        timestamp: 1000,
        message: { role: "user", content: "Secret transcript A" },
      })}\n`);
      writeFileSync(join(projDir, "sess-b.jsonl"), `${JSON.stringify({
        type: "user",
        timestamp: 1000,
        message: { role: "user", content: "Secret transcript B" },
      })}\n`);

      // contextMode: "context" must NOT attach local transcript even with sessionId.
      let seenContextMsgs = -1;
      const ctxRes = await runExternalAdvisorConsult(
        cfg,
        { question: "Check", sessionId: "sess-a" },
        {
          workbuddyProjectsDir: rootDir,
          consultFn: async input => {
            seenContextMsgs = input.parsed.context.messages.length;
            return { ok: true, advice: "ok", advisorModel: "expert/gpt-6-astra", durationMs: 1 };
          },
        },
      );
      expect(ctxRes.status).toBe(200);
      expect(seenContextMsgs).toBe(1);

      // contextMode: "full" without sessionId/taskId/transcriptPath must NOT guess newest file.
      const fullCfg = baseConfig();
      (fullCfg as { advisor?: unknown }).advisor = {
        enabled: true,
        model: "expert/gpt-6-astra",
        contextMode: "full",
        contextSharingConsent: "v1",
      };
      let seenFullNoIdMsgs = -1;
      const noIdRes = await runExternalAdvisorConsult(
        fullCfg,
        { question: "Check without id" },
        {
          workbuddyProjectsDir: rootDir,
          consultFn: async input => {
            seenFullNoIdMsgs = input.parsed.context.messages.length;
            return { ok: true, advice: "ok", advisorModel: "expert/gpt-6-astra", durationMs: 1 };
          },
        },
      );
      expect(noIdRes.status).toBe(200);
      expect(seenFullNoIdMsgs).toBe(1);

      // 4. Different taskId / transcript content (same message count) do NOT collide on pending fingerprint.
      const resolvers: Array<(advice: string) => void> = [];
      const makePending = (taskId: string) => runExternalAdvisorConsult(
        fullCfg,
        { question: "Same question", taskId, waitMs: 0 },
        {
          workbuddyProjectsDir: rootDir,
          consultFn: () => new Promise(resolve => {
            resolvers.push(advice => resolve({ ok: true, advice, advisorModel: "expert/gpt-6-astra", durationMs: 5 }));
          }),
        },
      );
      const rA = await makePending("sess-a");
      const rB = await makePending("sess-b");
      expect(rA.status).toBe(202);
      expect(rB.status).toBe(202);
      expect(rA.body.consultationId).not.toBe(rB.body.consultationId);

      // Same taskId + unchanged transcript reuses the pending consultationId.
      const rARepeat = await makePending("sess-a");
      expect(rARepeat.status).toBe(202);
      expect(rARepeat.body.consultationId).toBe(rA.body.consultationId);

      // Changing transcript text without changing message count produces a distinct consultationId.
      writeFileSync(join(projDir, "sess-a.jsonl"), `${JSON.stringify({
        type: "user",
        timestamp: 2000,
        message: { role: "user", content: "Modified transcript A content" },
      })}\n`);
      const rAModified = await makePending("sess-a");
      expect(rAModified.status).toBe(202);
      expect(rAModified.body.consultationId).not.toBe(rA.body.consultationId);

      for (const done of resolvers) done("done");
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }

    // 5. Saturated store (32 pending) rejects 33rd with 429 without evicting pending entries, and polling does not evict.
    const capCfg = baseConfig();
    (capCfg as { advisor?: unknown }).advisor = {
      enabled: true,
      model: "expert/gpt-6-astra",
      contextSharingConsent: "v1",
    };
    const pendingResolvers: Array<() => void> = [];
    const ids: string[] = [];
    for (let i = 0; i < 32; i += 1) {
      const started = await runExternalAdvisorConsult(
        capCfg,
        { question: `Pending Q ${i}`, waitMs: 0 },
        {
          consultFn: () => new Promise(resolve => {
            pendingResolvers.push(() => resolve({ ok: true, advice: `A ${i}`, advisorModel: "expert/gpt-6-astra", durationMs: 1 }));
          }),
        },
      );
      expect(started.status).toBe(202);
      ids.push(started.body.consultationId as string);
    }
    const overflow = await runExternalAdvisorConsult(
      capCfg,
      { question: "Overflow Q 33", waitMs: 0 },
      { consultFn: async () => ({ ok: true, advice: "never", advisorModel: "expert/gpt-6-astra", durationMs: 1 }) },
    );
    expect(overflow.status).toBe(429);
    expect((overflow.body.error as { code: string }).code).toBe("advisor_capacity_exceeded");

    // Polling the oldest entry when store is full (32 entries) must find it (no eviction during poll).
    const polledFirst = await runExternalAdvisorConsult(capCfg, { consultationId: ids[0], waitMs: 0 });
    expect(polledFirst.status).toBe(202);
    expect(polledFirst.body.consultationId).toBe(ids[0]);
    for (const done of pendingResolvers) done();
  });

  test("client-mcp preserves sibling hooks in matched groups, isolates per-client errors, and makes Routing Undo confirm before removing Advisor edits", async () => {
    const { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { fingerprint, readRecords, writeRecord, integrationsDir } = await import("../../src/integrations/ownership");
    const { appendOperation, findOperation, matchesOperationResult } = await import("../../src/integrations/journal");
    const { advisorHookCommand, mountAdvisorMcpForClient, unmountAdvisorMcpForClient, syncAdvisorMcpClients } = await import("../../src/advisor/client-mcp");

    const homeDir = mkdtempSync(join(tmpdir(), "ocx-mcp-hardening-"));
    const configDir = join(homeDir, ".opencodex");
    try {
      // Seed Qoder shared settings.json with a sibling UserPromptSubmit hook in the same group.
      const qoderDir = join(homeDir, ".qoder");
      mkdirSync(qoderDir, { recursive: true });
      const qoderPath = join(qoderDir, "settings.json");
      expect(mountAdvisorMcpForClient("qoder", { homeDir, configDir, env: {} }).ok).toBe(true);
      const registeredCommand = advisorHookCommand(join(qoderDir, "hooks", "opencodex-advisor-notice.sh"));
      const initialDoc = {
        hooks: {
          UserPromptSubmit: [
            {
              matcher: "custom-matcher",
              hooks: [
                { type: "command", command: "/usr/local/bin/user-hook.sh" },
                { type: "command", command: "/old/path/opencodex-advisor-notice.sh" },
                { type: "command", command: registeredCommand },
              ],
            },
          ],
        },
        mcpServers: {},
      };
      const initialText = `${JSON.stringify(initialDoc, null, 2)}\n`;
      writeFileSync(qoderPath, initialText);

      // Record a Routing Apply ownership record + journal entry matching initialText.
      const intDir = integrationsDir(configDir);
      const opId = "op-qoder-apply-1";
      writeRecord({
        clientId: "qoder",
        configPath: qoderPath,
        opId,
        fileFingerprint: fingerprint(initialText),
        managedPaths: ["mcpServers"],
        writtenAt: new Date().toISOString(),
        mode: "apply",
      } as unknown as Parameters<typeof writeRecord>[0], intDir);
      appendOperation({
        opId,
        clientId: "qoder",
        kind: "apply",
        at: new Date().toISOString(),
        configPath: qoderPath,
        snapshot: { kind: "none" },
        resultFingerprint: fingerprint(initialText),
        resultAbsent: false,
        priorRecord: null,
      }, intDir);

      // Mount Advisor MCP: sibling user hook + matcher must survive; journal Undo stays valid.
      const mountRes = mountAdvisorMcpForClient("qoder", { homeDir, configDir, env: {} });
      expect(mountRes.ok).toBe(true);
      const afterMountText = readFileSync(qoderPath, "utf8");
      const afterMountDoc = JSON.parse(afterMountText) as { hooks: { UserPromptSubmit: Array<{ matcher?: string; hooks: Array<{ command: string }> }> } };
      const siblingGroup = afterMountDoc.hooks.UserPromptSubmit.find(g => g.matcher === "custom-matcher");
      expect(siblingGroup).toBeDefined();
      // A hook with the same file name at another path is not the command OpenCodex registered, so it stays.
      expect(siblingGroup!.hooks).toEqual([
        { type: "command", command: "/usr/local/bin/user-hook.sh" },
        { type: "command", command: "/old/path/opencodex-advisor-notice.sh" },
      ]);

      // Routing ownership follows the shared file, so a Routing toggle does not see Advisor's edit as a conflict...
      expect((readRecords(intDir) as Record<string, { fileFingerprint: string }>).qoder!.fileFingerprint).toBe(fingerprint(afterMountText));
      // ...but Undo of the Routing apply sees drift and asks first: restoring its snapshot would remove Advisor's entry.
      const opAfterMount = findOperation(opId, intDir)!;
      expect(matchesOperationResult(opAfterMount, afterMountText)).toBe(false);
      expect(matchesOperationResult(opAfterMount, initialText)).toBe(true);

      // Unmount Advisor MCP: sibling user hook still preserved.
      const unmountRes = unmountAdvisorMcpForClient("qoder", { homeDir, configDir, env: {} });
      expect(unmountRes.ok).toBe(true);
      const afterUnmountDoc = JSON.parse(readFileSync(qoderPath, "utf8")) as { hooks: { UserPromptSubmit: Array<{ matcher?: string; hooks: Array<{ command: string }> }> } };
      expect(afterUnmountDoc.hooks.UserPromptSubmit).toEqual([
        { matcher: "custom-matcher", hooks: [
          { type: "command", command: "/usr/local/bin/user-hook.sh" },
          { type: "command", command: "/old/path/opencodex-advisor-notice.sh" },
        ] },
      ]);

      // Per-client error isolation: block workbuddy config path with a directory while qoder still succeeds.
      mkdirSync(join(homeDir, ".workbuddy", "mcp.json"), { recursive: true });
      const syncCfg = baseConfig();
      (syncCfg as { advisor?: unknown }).advisor = {
        enabled: true,
        model: "expert/gpt-6-astra",
        contextSharingConsent: "v1",
        mcpClients: ["workbuddy", "qoder"],
      };
      const syncRes = syncAdvisorMcpClients(syncCfg, { homeDir, configDir, env: {} });
      expect(syncRes.errors.some(e => e.clientId === "workbuddy")).toBe(true);
      expect(syncRes.mounted).toContain("qoder");
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  test("client-mcp enforces verified ownership markers, never deletes user skill files, respects consent revocation, handles standalone & OPENCODEX_HOME, and preserves shared WORKBUDDY_CONFIG_DIR", async () => {
    const { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { writeRecord, integrationsDir } = await import("../../src/integrations/ownership");
    const {
      ADVISOR_HOOK_MARKER,
      ADVISOR_SKILL_MARKER,
      advisorCommandArgs,
      buildNoticeHookScript,
      listAdvisorMcpClientStatuses,
      reconcileAdvisorMcpForRoutedClient,
      syncAdvisorMcpClients,
    } = await import("../../src/advisor/client-mcp");

    const fakeHome = mkdtempSync(join(tmpdir(), "ocx-mcp-security-"));
    const customConfigDir = join(fakeHome, "custom-ocx-home");
    try {
      // 1. User-owned files in skills/opencodex-advisor survive disabled sync AND unowned overwrite attempts.
      const userSkillDir = join(fakeHome, ".workbuddy", "skills", "opencodex-advisor");
      mkdirSync(userSkillDir, { recursive: true });
      writeFileSync(join(userSkillDir, "my-notes.md"), "# User personal notes\n");
      writeFileSync(join(userSkillDir, "SKILL.md"), "# Custom user skill without marker\n");

      writeRecord({
        clientId: "workbuddy",
        configPath: join(fakeHome, ".workbuddy", "models.json"),
        fileFingerprint: "fp-wb",
        blockFingerprint: "bfp-wb",
        fragmentPaths: [["models"]],
        appliedAt: new Date().toISOString(),
        opId: "op-wb",
      }, integrationsDir(customConfigDir));

      const disabledCfg = baseConfig();
      (disabledCfg as { advisor?: unknown }).advisor = { enabled: false, model: "expert/gpt-6-astra", contextSharingConsent: "v1" };
      const disabledSync = syncAdvisorMcpClients(disabledCfg, { homeDir: fakeHome, configDir: customConfigDir, env: {} });
      expect(disabledSync.errors).toEqual([]);
      expect(disabledSync.unmounted).toEqual([]);
      expect(existsSync(join(userSkillDir, "my-notes.md"))).toBe(true);
      expect(readFileSync(join(userSkillDir, "SKILL.md"), "utf8")).toBe("# Custom user skill without marker\n");
      expect(disabledSync.statuses.find(s => s.clientId === "workbuddy")?.skillMounted).toBe(false);

      // Refusal when attempting to mount over an unowned SKILL.md
      const enabledCfg = baseConfig();
      (enabledCfg as { advisor?: unknown }).advisor = { enabled: true, model: "expert/gpt-6-astra", contextSharingConsent: "v1", autoMountMcp: true };
      const unownedMountSync = syncAdvisorMcpClients(enabledCfg, { homeDir: fakeHome, configDir: customConfigDir, env: {} });
      expect(unownedMountSync.errors.some(e => e.clientId === "workbuddy" && e.message.includes("unowned skill file"))).toBe(true);
      expect(readFileSync(join(userSkillDir, "SKILL.md"), "utf8")).toBe("# Custom user skill without marker\n");
      expect(existsSync(join(userSkillDir, "my-notes.md"))).toBe(true);

      // Remove unowned SKILL.md only -> mounting writes owned SKILL.md + keeps my-notes.md;
      // revoking consent then removes ONLY SKILL.md while preserving my-notes.md; re-granting re-mounts!
      rmSync(join(userSkillDir, "SKILL.md"));
      const cleanMount = syncAdvisorMcpClients(enabledCfg, { homeDir: fakeHome, configDir: customConfigDir, env: {} });
      expect(cleanMount.errors).toEqual([]);
      expect(cleanMount.mounted).toContain("workbuddy");
      expect(readFileSync(join(userSkillDir, "SKILL.md"), "utf8")).toContain(ADVISOR_SKILL_MARKER);
      expect(readFileSync(join(fakeHome, ".workbuddy", "hooks", "opencodex-advisor-notice.sh"), "utf8")).toContain(ADVISOR_HOOK_MARKER);

      const revokedCfg = baseConfig();
      (revokedCfg as { advisor?: unknown }).advisor = { ...enabledCfg.advisor, contextSharingConsent: null };
      const revokeSync = syncAdvisorMcpClients(revokedCfg, { homeDir: fakeHome, configDir: customConfigDir, env: {} });
      expect(revokeSync.unmounted).toContain("workbuddy");
      expect(existsSync(join(userSkillDir, "SKILL.md"))).toBe(false);
      expect(existsSync(join(userSkillDir, "my-notes.md"))).toBe(true);
      const wbAfterRevoke = listAdvisorMcpClientStatuses(revokedCfg, { homeDir: fakeHome, configDir: customConfigDir, env: {} })
        .find(s => s.clientId === "workbuddy")!;
      expect(wbAfterRevoke.mounted).toBe(false);
      expect(wbAfterRevoke.hooksMounted).toBe(false);
      expect(wbAfterRevoke.skillMounted).toBe(false);

      // Route toggle reconciliation when consent is missing/revoked must NOT mount MCP.
      const routeNoConsent = reconcileAdvisorMcpForRoutedClient("workbuddy", true, revokedCfg, { homeDir: fakeHome, configDir: customConfigDir, env: {} });
      expect(routeNoConsent.changed).toBe(false);
      expect(listAdvisorMcpClientStatuses(revokedCfg, { homeDir: fakeHome, configDir: customConfigDir, env: {} })
        .find(s => s.clientId === "workbuddy")?.mounted).toBe(false);

      // Re-granting consent re-mounts cleanly.
      const regrantSync = syncAdvisorMcpClients(enabledCfg, { homeDir: fakeHome, configDir: customConfigDir, env: {} });
      expect(regrantSync.mounted).toContain("workbuddy");

      // 2. Standalone binary argv + custom OPENCODEX_HOME propagation.
      const srcCmd = advisorCommandArgs(customConfigDir, { isStandaloneExecutable: false, execPath: "/usr/local/bin/bun" });
      expect(srcCmd.command).toBe("/usr/local/bin/bun");
      expect(srcCmd.args.slice(-2)).toEqual(["advisor", "mcp"]);
      expect(srcCmd.args.length).toBe(3);
      expect(srcCmd.env.OPENCODEX_HOME).toBe(customConfigDir);

      const binCmd = advisorCommandArgs(customConfigDir, { isStandaloneExecutable: true, execPath: "/usr/local/bin/ocx" });
      expect(binCmd.command).toBe("/usr/local/bin/ocx");
      expect(binCmd.args).toEqual(["advisor", "mcp"]);
      expect(binCmd.env.OPENCODEX_HOME).toBe(customConfigDir);
      const standaloneHook = buildNoticeHookScript(customConfigDir, "/usr/local/bin/ocx");
      // Single-quoted: a path with spaces, `$()` or backticks stays literal when the hook runs.
      expect(standaloneHook).toContain("BUN_BIN='/usr/local/bin/ocx'");
      expect(standaloneHook).toContain("BUN_BE_BUN=1");
      expect(standaloneHook).toContain('adv?.contextSharingConsent === "v1"');

      // 3. Shared WORKBUDDY_CONFIG_DIR: selecting only workbuddy keeps workbuddy-ai from unmounting it.
      const sharedDir = join(fakeHome, "shared-wb");
      const sharedEnv = { WORKBUDDY_CONFIG_DIR: sharedDir };
      const sharedCfg = baseConfig();
      (sharedCfg as { advisor?: unknown }).advisor = {
        enabled: true,
        model: "expert/gpt-6-astra",
        contextSharingConsent: "v1",
        mcpClients: ["workbuddy"],
      };
      const sharedSync = syncAdvisorMcpClients(sharedCfg, { homeDir: fakeHome, configDir: customConfigDir, env: sharedEnv });
      expect(sharedSync.mounted).toEqual(["workbuddy"]);
      expect(sharedSync.unmounted).toEqual([]);
      expect(existsSync(join(sharedDir, "mcp.json"))).toBe(true);
      expect(existsSync(join(sharedDir, "skills", "opencodex-advisor", "SKILL.md"))).toBe(true);
      const sharedMcp = JSON.parse(readFileSync(join(sharedDir, "mcp.json"), "utf8"));
      expect(sharedMcp.mcpServers["opencodex-advisor"].env.OPENCODEX_HOME).toBe(customConfigDir);
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  test("external adaptive consult requires a stable budget identity and scopes reservations across sessionId and taskId", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { createAdvisorTaskBudget } = await import("../../src/advisor/budget");
    const { runExternalAdvisorConsult } = await import("../../src/advisor/external-consult");
    const { CONSULT_ADVISOR_TOOL_ANNOTATIONS } = await import("../../src/advisor/mcp-server");

    expect(CONSULT_ADVISOR_TOOL_ANNOTATIONS.readOnlyHint).toBe(false);
    expect(CONSULT_ADVISOR_TOOL_ANNOTATIONS.openWorldHint).toBe(true);

    const budgetDir = mkdtempSync(join(tmpdir(), "ocx-ext-adaptive-"));
    try {
      const budget = createAdvisorTaskBudget(join(budgetDir, "budget.sqlite"));
      const adaptiveCfg = baseConfig();
      (adaptiveCfg as { advisor?: unknown }).advisor = {
        enabled: true,
        model: "expert/gpt-6-astra",
        policy: "adaptive",
        maxConsultationsPerTask: 1,
        contextSharingConsent: "v1",
      };

      let calls = 0;
      const consultFn = async () => {
        calls += 1;
        return { ok: true, advice: "Advised once.", advisorModel: "expert/gpt-6-astra", durationMs: 4 };
      };

      // Missing taskId, sessionId, and transcriptPath -> fails closed before dispatch.
      const missingId = await runExternalAdvisorConsult(adaptiveCfg, { question: "No identity?" }, { budget, consultFn });
      expect(missingId.status).toBe(400);
      expect((missingId.body.error as { code: string }).code).toBe("advisor_budget_identity_required");
      expect(calls).toBe(0);

      // Session ID without taskId reserves budget and blocks 2nd consultation (via sessionId or same taskId).
      const first = await runExternalAdvisorConsult(adaptiveCfg, { question: "Q1", sessionId: "qoder-sess-1" }, { budget, consultFn });
      expect(first.status).toBe(200);
      expect(calls).toBe(1);

      const second = await runExternalAdvisorConsult(adaptiveCfg, { question: "Q2", sessionId: "qoder-sess-1" }, { budget, consultFn });
      expect(second.status).toBe(429);
      expect((second.body.error as { code: string }).code).toBe("advisor_budget_exhausted");
      expect(calls).toBe(1);

      const thirdViaTaskId = await runExternalAdvisorConsult(adaptiveCfg, { question: "Q3", taskId: "qoder-sess-1" }, { budget, consultFn });
      expect(thirdViaTaskId.status).toBe(429);
      expect((thirdViaTaskId.body.error as { code: string }).code).toBe("advisor_budget_exhausted");
      expect(calls).toBe(1);
    } finally {
      rmSync(budgetDir, { recursive: true, force: true });
    }
  });
});
