import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetAgentTaskRecoveryState } from "../src/server/responses/agent-task-recovery";
import {
  codexHeaders,
  encryptedInput,
  fakeChatGptJwt,
  FERNET_TASK,
  originalFetch,
  post,
  providerResponse,
  recoverySse,
  routedConfig,
  ROUTING_ENVELOPE,
} from "./helpers/agent-task-recovery";

const realDateNow = Date.now;

describe("agent task recovery security", () => {
  beforeEach(() => resetAgentTaskRecoveryState());

  afterEach(() => {
    globalThis.fetch = originalFetch;
    Date.now = realDateNow;
    resetAgentTaskRecoveryState();
  });

  test("uses only the fixed ChatGPT endpoint and forwards only allowlisted credentials", async () => {
    const accountId = "acct-boundary";
    const token = fakeChatGptJwt(accountId);
    const assignment = "Keep credentials on their owning transport.";
    let recoveryUrl = "";
    let recoveryHeaders = new Headers();
    let recoveryBody = "";
    let recoveryMethod: string | undefined;
    let recoveryRedirect: RequestRedirect | undefined;
    let providerHeaders = new Headers();
    let providerBody = "";
    globalThis.fetch = (async (input, init) => {
      if (String(input).includes("chatgpt.com")) {
        recoveryUrl = String(input);
        recoveryHeaders = new Headers(init?.headers);
        recoveryBody = typeof init?.body === "string" ? init.body : "";
        recoveryMethod = init?.method;
        recoveryRedirect = init?.redirect;
        return new Response(recoverySse(assignment), { status: 200 });
      }
      providerHeaders = new Headers(init?.headers);
      providerBody = typeof init?.body === "string" ? init.body : "";
      return providerResponse();
    }) as typeof fetch;

    const response = await post(
      routedConfig(),
      "xai/grok-4.5",
      encryptedInput(),
      codexHeaders(accountId, {
        "openai-beta": "responses=experimental",
        "user-agent": "codex-test/1",
        cookie: "private-cookie",
        "x-private-caller-header": "private-value",
        "x-codex-parent-thread-id": "parent-boundary",
      }),
    );

    expect(response.status).toBe(200);
    expect(recoveryUrl).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(recoveryMethod).toBe("POST");
    expect(recoveryRedirect).toBe("error");
    expect([...recoveryHeaders.keys()].sort()).toEqual([
      "accept",
      "authorization",
      "chatgpt-account-id",
      "content-type",
      "openai-beta",
      "originator",
      "user-agent",
    ]);
    expect(recoveryHeaders.get("authorization")).toBe(`Bearer ${token}`);
    expect(recoveryHeaders.get("chatgpt-account-id")).toBe(accountId);
    expect(recoveryHeaders.get("originator")).toBe("codex_cli_rs");
    expect(recoveryHeaders.get("openai-beta")).toBe("responses=experimental");
    expect(recoveryHeaders.get("user-agent")).toBe("codex-test/1");
    expect(recoveryHeaders.get("cookie")).toBeNull();
    expect(recoveryHeaders.get("x-private-caller-header")).toBeNull();
    expect(recoveryHeaders.get("x-codex-parent-thread-id")).toBeNull();
    expect(recoveryBody).toContain(FERNET_TASK);
    expect(recoveryBody).not.toContain(token);
    expect(recoveryBody).not.toContain(accountId);
    expect(recoveryBody).not.toContain("private-cookie");
    expect(providerHeaders.get("authorization")).not.toContain(token);
    expect(providerHeaders.get("chatgpt-account-id")).toBeNull();
    expect(providerHeaders.get("cookie")).toBeNull();
    expect(providerBody).toContain(assignment);
    expect(providerBody).not.toContain(FERNET_TASK);
    expect(providerBody).not.toContain(token);
    expect(providerBody).not.toContain(accountId);
  });

  test("a cached recovery never bypasses caller authentication", async () => {
    const assignment = `${ROUTING_ENVELOPE}Do not expose this cached task.`;
    let recoveryFetches = 0;
    let providerFetches = 0;
    globalThis.fetch = (async (input) => {
      if (String(input).includes("chatgpt.com")) {
        recoveryFetches += 1;
        return new Response(recoverySse(assignment), { status: 200 });
      }
      providerFetches += 1;
      return providerResponse();
    }) as typeof fetch;

    expect((await post(routedConfig(), "xai/grok-4.5", encryptedInput(), codexHeaders())).status).toBe(200);
    const unauthenticated = await post(
      routedConfig(),
      "xai/grok-4.5",
      encryptedInput(),
      { originator: "codex_cli_rs", "x-openai-subagent": "collab_spawn" },
    );

    expect(unauthenticated.status).toBe(400);
    expect(await unauthenticated.json()).toMatchObject({
      error: { code: "unreadable_encrypted_agent_task" },
    });
    expect(recoveryFetches).toBe(1);
    expect(providerFetches).toBe(1);
  });

  test("a proxy admission secret is never forwarded to ChatGPT", async () => {
    let forwardedBody = "";
    globalThis.fetch = (async (input, init) => {
      if (String(input).includes("chatgpt.com")) {
        forwardedBody = typeof init?.body === "string" ? init.body : "";
      }
      return new Response("event: error\ndata: {}\n\n", { status: 200 });
    }) as typeof fetch;

    const response = await post(
      routedConfig(),
      "xai/grok-4.5",
      encryptedInput(),
      {
        authorization: "Bearer ocx_data_testsecret",
        "chatgpt-account-id": "acct-forged",
        originator: "codex_cli_rs",
        "x-openai-subagent": "collab_spawn",
      },
    );

    expect(response.status).toBe(400);
    expect(forwardedBody).toBe("");
  });

  for (const apiKeyHeader of ["x-opencodex-api-key", "x-api-key"] as const) {
    test(`rejects callers admitted through ${apiKeyHeader}`, async () => {
      let fetchCalls = 0;
      globalThis.fetch = (async () => {
        fetchCalls += 1;
        throw new Error("recovery must stay unreachable");
      }) as typeof fetch;

      const response = await post(
        routedConfig(),
        "xai/grok-4.5",
        encryptedInput(),
        codexHeaders("acct-api-key", { [apiKeyHeader]: "proxy-key" }),
      );

      expect(response.status).toBe(400);
      expect(fetchCalls).toBe(0);
      expect(await response.json()).toMatchObject({
        error: { code: "unreadable_encrypted_agent_task" },
      });
    });
  }

  test("rejects opaque bearer tokens and mismatched ChatGPT account headers", async () => {
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error("recovery must stay unreachable");
    }) as typeof fetch;

    const opaque = await post(
      routedConfig(),
      "xai/grok-4.5",
      encryptedInput(),
      {
        authorization: "Bearer generic-api-token",
        "chatgpt-account-id": "acct-generic",
        originator: "codex_cli_rs",
        "x-openai-subagent": "collab_spawn",
      },
    );
    const mismatchedHeaders = codexHeaders("acct-token");
    mismatchedHeaders.set("chatgpt-account-id", "acct-other");
    const mismatched = await post(
      routedConfig(),
      "xai/grok-4.5",
      encryptedInput(),
      mismatchedHeaders,
    );

    expect(opaque.status).toBe(400);
    expect(mismatched.status).toBe(400);
    expect(fetchCalls).toBe(0);
  });

  test("rejects expired ChatGPT tokens and non-loopback proxy binds", async () => {
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error("recovery must stay unreachable");
    }) as typeof fetch;

    const expiredHeaders = codexHeaders("acct-expired");
    expiredHeaders.set("authorization", `Bearer ${fakeChatGptJwt("acct-expired", {
      exp: Math.floor(Date.now() / 1000) - 1,
    })}`);
    const expired = await post(
      routedConfig(),
      "xai/grok-4.5",
      encryptedInput(),
      expiredHeaders,
    );
    const remoteConfig = routedConfig();
    remoteConfig.hostname = "0.0.0.0";
    const remote = await post(
      remoteConfig,
      "xai/grok-4.5",
      encryptedInput(),
      codexHeaders("acct-remote"),
    );

    expect(expired.status).toBe(400);
    expect(remote.status).toBe(400);
    expect(fetchCalls).toBe(0);
  });

  test("enforces token validity boundaries before recovery or cache access", async () => {
    let now = 1_800_000_000_000;
    Date.now = () => now;
    const nowSeconds = Math.floor(now / 1_000);
    let recoveryFetches = 0;
    let providerFetches = 0;
    globalThis.fetch = (async (input) => {
      if (String(input).includes("chatgpt.com")) {
        recoveryFetches += 1;
        return new Response(recoverySse("Credential-bound assignment."), { status: 200 });
      }
      providerFetches += 1;
      return providerResponse();
    }) as typeof fetch;

    const requestWithClaims = (accountId: string, claims: Record<string, unknown>) => {
      const headers = codexHeaders(accountId);
      headers.set("authorization", `Bearer ${fakeChatGptJwt(accountId, claims)}`);
      return post(routedConfig(), "xai/grok-4.5", encryptedInput(), headers);
    };

    expect((await requestWithClaims("acct-exp-now", { exp: nowSeconds })).status).toBe(400);
    expect((await requestWithClaims("acct-valid", { exp: nowSeconds + 1 })).status).toBe(200);
    expect((await requestWithClaims("acct-nbf-edge", { nbf: nowSeconds + 60 })).status).toBe(200);
    expect((await requestWithClaims("acct-nbf-future", { nbf: nowSeconds + 61 })).status).toBe(400);
    expect((await requestWithClaims("acct-nbf-invalid", { nbf: "tomorrow" })).status).toBe(400);
    expect(recoveryFetches).toBe(2);
    expect(providerFetches).toBe(2);

    const expiringHeaders = codexHeaders("acct-cache-expiry");
    expiringHeaders.set("authorization", `Bearer ${fakeChatGptJwt("acct-cache-expiry", {
      exp: nowSeconds + 1,
    })}`);
    expect((await post(routedConfig(), "xai/grok-4.5", encryptedInput(), expiringHeaders)).status).toBe(200);
    now += 2_000;
    expect((await post(routedConfig(), "xai/grok-4.5", encryptedInput(), expiringHeaders)).status).toBe(400);
    expect(recoveryFetches).toBe(3);
    expect(providerFetches).toBe(3);
  });

  test("rejects ambiguous agent envelopes before authenticated recovery", async () => {
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error("recovery must stay unreachable");
    }) as typeof fetch;
    const ambiguous = encryptedInput() as Array<{ content: Array<Record<string, unknown>> }>;
    ambiguous[0]!.content.push({ type: "encrypted_content", encrypted_content: FERNET_TASK });

    const response = await post(
      routedConfig(),
      "xai/grok-4.5",
      ambiguous,
      codexHeaders("acct-ambiguous"),
    );

    expect(response.status).toBe(400);
    expect(fetchCalls).toBe(0);
  });

  test("rejects JWTs outside the native Codex OAuth issuer, audience, or client", async () => {
    const encodeJwt = (claims: Record<string, unknown>): string => {
      const header = Buffer.from(JSON.stringify({
        alg: "RS256",
        typ: "JWT",
        kid: "fixture-key",
      })).toString("base64url");
      const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
      return `${header}.${payload}.fakesig`;
    };
    const baseClaims = {
      iss: "https://auth.openai.com/",
      aud: "https://api.openai.com/v1",
      client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
      exp: Math.floor(Date.now() / 1000) + 3_600,
      "https://api.openai.com/auth": { chatgpt_account_id: "acct-forged" },
    };
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error("recovery must stay unreachable");
    }) as typeof fetch;

    for (const claims of [
      { ...baseClaims, iss: "https://issuer.example" },
      { ...baseClaims, aud: "https://api.example/v1" },
      { ...baseClaims, client_id: "third-party-client" },
      { ...baseClaims, "https://api.openai.com/auth": undefined, chatgpt_account_id: "acct-forged" },
    ]) {
      const response = await post(
        routedConfig(),
        "xai/grok-4.5",
        encryptedInput(),
        {
          authorization: `Bearer ${encodeJwt(claims)}`,
          "chatgpt-account-id": "acct-forged",
          originator: "codex_cli_rs",
          "x-openai-subagent": "collab_spawn",
        },
      );
      expect(response.status).toBe(400);
    }

    expect(fetchCalls).toBe(0);
  });

  test("rejects unsigned JWT-shaped caller credentials", async () => {
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({
      iss: "https://auth.openai.com/",
      aud: "https://api.openai.com/v1",
      client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
      exp: Math.floor(Date.now() / 1000) + 3_600,
      "https://api.openai.com/auth": { chatgpt_account_id: "acct-unsigned" },
    })).toString("base64url");
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error("recovery must stay unreachable");
    }) as typeof fetch;

    const response = await post(
      routedConfig(),
      "xai/grok-4.5",
      encryptedInput(),
      {
        authorization: `Bearer ${header}.${payload}.unsigned`,
        "chatgpt-account-id": "acct-unsigned",
        originator: "codex_cli_rs",
        "x-openai-subagent": "collab_spawn",
      },
    );

    expect(response.status).toBe(400);
    expect(fetchCalls).toBe(0);
  });

  test("non-Codex originators keep the typed fail-fast error", async () => {
    let recoveryFetches = 0;
    globalThis.fetch = (async (input) => {
      if (String(input).includes("chatgpt.com")) recoveryFetches += 1;
      return new Response("event: error\ndata: {}\n\n", { status: 200 });
    }) as typeof fetch;

    const response = await post(
      routedConfig(),
      "xai/grok-4.5",
      encryptedInput(),
      { ...codexHeaders(), originator: "other" },
    );

    expect(response.status).toBe(400);
    expect(recoveryFetches).toBe(0);
  });

  test("accepts the current Codex Work desktop originator", async () => {
    let recoveryOriginator = "";
    globalThis.fetch = (async (input, init) => {
      if (String(input).includes("chatgpt.com")) {
        recoveryOriginator = new Headers(init?.headers).get("originator") ?? "";
        return new Response(recoverySse("Recover the desktop child task."), { status: 200 });
      }
      return providerResponse();
    }) as typeof fetch;
    const headers = codexHeaders();
    headers.set("originator", "codex_work_desktop");

    const response = await post(
      routedConfig(),
      "xai/grok-4.5",
      encryptedInput(),
      headers,
    );

    expect(response.status).toBe(200);
    expect(recoveryOriginator).toBe("codex_work_desktop");
  });

  test("accepts the Codexless originator", async () => {
    let recoveryOriginator = "";
    globalThis.fetch = (async (input, init) => {
      if (String(input).includes("chatgpt.com")) {
        recoveryOriginator = new Headers(init?.headers).get("originator") ?? "";
        return new Response(recoverySse("Recover the Codexless child task."), { status: 200 });
      }
      return providerResponse();
    }) as typeof fetch;
    const headers = codexHeaders();
    headers.set("originator", "codexless_agent");

    const response = await post(
      routedConfig(),
      "xai/grok-4.5",
      encryptedInput(),
      headers,
    );

    expect(response.status).toBe(200);
    expect(recoveryOriginator).toBe("codexless_agent");
  });
});
