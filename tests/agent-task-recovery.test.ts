import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createTranslatorBudget } from "../src/lib/translator-budget";
import { warnAgentTaskRecoveryStartup } from "../src/server";
import { resetAgentTaskRecoveryState } from "../src/server/responses/agent-task-recovery";
import { agentTaskRecoveryWaiterCountForTests } from "../src/server/responses/agent-task-recovery-cache";
import {
  agentMessage,
  codexHeaders,
  encryptedInput,
  FERNET_TASK,
  originalFetch,
  post,
  providerResponse,
  recoveryArgumentsDoneSse,
  recoveryCompletedSse,
  recoverySse,
  routedConfig,
  ROUTING_ENVELOPE,
  SECOND_FERNET_TASK,
} from "./helpers/agent-task-recovery";

describe("agent task recovery (opt-in, default off)", () => {
  beforeEach(() => {
    resetAgentTaskRecoveryState();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetAgentTaskRecoveryState();
  });

  test("keeps the disabled fail-fast response byte-identical to the absent feature", async () => {
    const snapshot = async (config: ReturnType<typeof routedConfig>) => {
      let fetchCalls = 0;
      globalThis.fetch = (async () => {
        fetchCalls += 1;
        throw new Error("recovery and provider dispatch must stay unreachable");
      }) as typeof fetch;
      const response = await post(config, "xai/grok-4.5", encryptedInput(), codexHeaders());
      return {
        status: response.status,
        statusText: response.statusText,
        headers: [...response.headers.entries()].sort(),
        body: Buffer.from(await response.arrayBuffer()).toString("hex"),
        fetchCalls,
      };
    };

    const absent = await snapshot(routedConfig(null));
    const disabled = await snapshot(routedConfig({ enabled: false }));

    expect(disabled).toEqual(absent);
    expect(absent.status).toBe(400);
    const raw = Buffer.from(absent.body, "hex").toString("utf8");
    expect(JSON.parse(raw)).toMatchObject({
      error: { code: "unreadable_encrypted_agent_task" },
    });
    expect(absent.fetchCalls).toBe(0);
    expect(raw).not.toContain(FERNET_TASK);
    expect(raw).not.toContain("acct-caller");
  });

  test("keeps disabled normal routed requests behaviorally identical to the absent feature", async () => {
    const snapshot = async (config: ReturnType<typeof routedConfig>) => {
      let request: unknown = null;
      globalThis.fetch = (async (input, init) => {
        request = {
          url: String(input),
          method: init?.method,
          headers: [...new Headers(init?.headers).entries()]
            .filter(([name]) => name !== "x-grok-req-id")
            .sort(),
          body: typeof init?.body === "string"
            ? Buffer.from(init.body).toString("hex")
            : null,
        };
        return providerResponse();
      }) as typeof fetch;
      const response = await post(
        config,
        "xai/grok-4.5",
        agentMessage([{ type: "input_text", text: "Ordinary routed request." }]),
        codexHeaders(),
      );
      const responseBody = await response.json() as Record<string, unknown>;
      delete responseBody.id;
      delete responseBody.created_at;
      return {
        request,
        response: {
          status: response.status,
          headers: [...response.headers.entries()].sort(),
          body: responseBody,
        },
      };
    };

    expect(await snapshot(routedConfig({ enabled: false }))).toEqual(await snapshot(routedConfig(null)));
  });

  test("warns at startup only for an explicit recovery opt-in without exposing credentials", () => {
    const config = routedConfig(null);
    const secret = "startup-secret-sentinel";
    config.providers.xai!.apiKey = secret;
    const originalWarn = console.warn;
    const capture = (recovery: typeof config.agentTaskRecovery): string[] => {
      const warnings: string[] = [];
      config.agentTaskRecovery = recovery;
      console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
      warnAgentTaskRecoveryStartup(config);
      return warnings;
    };

    try {
      expect(capture(undefined)).toEqual([]);
      expect(capture({ enabled: false })).toEqual([]);
      const warnings = capture({ enabled: true });
      expect(warnings).toHaveLength(3);
      expect(warnings.join("\n")).toContain("Experimental encrypted V2 task recovery is enabled");
      expect(warnings.join("\n")).toContain("Recovered plaintext assignment data");
      expect(warnings.join("\n")).toContain("process-local in-memory cache");
      expect(warnings.join("\n")).not.toContain(secret);
    } finally {
      console.warn = originalWarn;
    }
  });

  test("baseline: encrypted routed task still fails when recovery returns no assignment", async () => {
    const fetchedUrls: string[] = [];
    globalThis.fetch = (async (input) => {
      fetchedUrls.push(String(input));
      return new Response("event: error\ndata: {}\n\n", { status: 200 });
    }) as typeof fetch;

    const response = await post(
      routedConfig(),
      "xai/grok-4.5",
      encryptedInput(),
      codexHeaders(),
    );
    const json = await response.json() as { error?: { code?: string } };

    expect(response.status).toBe(400);
    expect(json.error?.code).toBe("unreadable_encrypted_agent_task");
    expect(fetchedUrls.length).toBeGreaterThan(0);
    expect(fetchedUrls[0]).toContain("chatgpt.com/backend-api/codex");
  });

  test("authenticated ChatGPT recovery accepts the decrypted payload without a duplicated routing envelope", async () => {
    const assignment = "Implement the focused regression test.";
    const fetchedUrls: string[] = [];
    const forwardedBodies: string[] = [];
    globalThis.fetch = (async (input, init) => {
      fetchedUrls.push(String(input));
      const raw = typeof init?.body === "string" ? init.body : "";
      forwardedBodies.push(raw);
      if (String(input).includes("chatgpt.com")) {
        return new Response(recoverySse(assignment), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      return providerResponse();
    }) as typeof fetch;

    const response = await post(
      routedConfig(),
      "xai/grok-4.5",
      encryptedInput(),
      codexHeaders(),
    );

    expect(response.status).toBe(200);
    expect(fetchedUrls).toHaveLength(2);
    expect(fetchedUrls[0]).toContain("chatgpt.com/backend-api/codex");
    expect(forwardedBodies[0]).toContain("capture_assignment");
    expect(forwardedBodies[1]).toContain("Implement the focused regression test.");
    expect(forwardedBodies[1]).not.toContain(FERNET_TASK);
    expect(forwardedBodies[1].match(/Message Type: NEW_TASK/g)).toHaveLength(1);
  });

  test("charges namespaced tool bridge maps only once across recovery reparse", async () => {
    const recoveryRequests: Request[] = [];
    const providerRequests: Request[] = [];
    const requestHeaders = codexHeaders();
    globalThis.fetch = (async (input, init) => {
      const request = new Request(input, init);
      if (request.url.includes("chatgpt.com")) {
        recoveryRequests.push(request);
        return new Response(recoverySse("Use the advertised tool."), { status: 200 });
      }
      providerRequests.push(request);
      return providerResponse();
    }) as typeof fetch;
    const namespace = "mcp__review";
    const name = "read_file";
    const wireName = `${namespace}__${name}`;
    const mappingBytes = new TextEncoder().encode(JSON.stringify([wireName, namespace, name])).byteLength;
    const budget = createTranslatorBudget();
    const originalCharge = budget.chargeRetained.bind(budget);
    const mappingCharges: number[] = [];
    budget.chargeRetained = (bytes, scope) => {
      if (scope.kind === "retained_collectors" && bytes === mappingBytes) mappingCharges.push(bytes);
      originalCharge(bytes, scope);
    };

    try {
      const response = await post(
        routedConfig(),
        "xai/grok-4.5",
        encryptedInput(),
        requestHeaders,
        undefined,
        {
          translatorBudget: budget,
          tools: [{
            type: "namespace",
            name: namespace,
            tools: [{ type: "function", name, parameters: { type: "object" } }],
          }],
        },
      );

      expect(response.status).toBe(200);
      expect(recoveryRequests).toHaveLength(1);
      expect(recoveryRequests[0]?.headers.get("authorization"))
        .toBe(requestHeaders.get("authorization"));
      expect(recoveryRequests[0]?.headers.get("chatgpt-account-id")).toBe("acct-caller");
      expect(providerRequests).toHaveLength(1);
      expect(mappingCharges).toHaveLength(1);
    } finally {
      budget.dispose();
    }
  });

  test("accepts function-call-arguments SSE events", async () => {
    const assignment = "Handle the recovered task.";
    let providerBody = "";
    globalThis.fetch = (async (input, init) => {
      if (String(input).includes("chatgpt.com")) {
        return new Response(recoveryArgumentsDoneSse(assignment), { status: 200 });
      }
      providerBody = typeof init?.body === "string" ? init.body : "";
      return providerResponse();
    }) as typeof fetch;

    const response = await post(
      routedConfig(),
      "xai/grok-4.5",
      encryptedInput(),
      codexHeaders(),
    );

    expect(response.status).toBe(200);
    expect(providerBody).toContain("Message Type: NEW_TASK");
    expect(providerBody).toContain(assignment);
    expect(providerBody).not.toContain(FERNET_TASK);
  });

  test("accepts an assignment carried only by the completed response snapshot", async () => {
    const assignment = "Read the completed response output.";
    let providerBody = "";
    globalThis.fetch = (async (input, init) => {
      if (String(input).includes("chatgpt.com")) {
        return new Response(recoveryCompletedSse(assignment), { status: 200 });
      }
      providerBody = typeof init?.body === "string" ? init.body : "";
      return providerResponse();
    }) as typeof fetch;

    const response = await post(routedConfig(), "xai/grok-4.5", encryptedInput(), codexHeaders());

    expect(response.status).toBe(200);
    expect(providerBody).toContain(assignment);
  });

  test("fails closed when completed recovery events disagree", async () => {
    let providerFetches = 0;
    globalThis.fetch = (async (input) => {
      if (String(input).includes("chatgpt.com")) {
        const first = recoverySse("First assignment.").split("data: {\"type\":\"response.completed\"")[0]!;
        return new Response(`${first}${recoveryCompletedSse("Second assignment.")}`, { status: 200 });
      }
      providerFetches += 1;
      return providerResponse();
    }) as typeof fetch;

    const response = await post(routedConfig(), "xai/grok-4.5", encryptedInput(), codexHeaders());

    expect(response.status).toBe(400);
    expect(providerFetches).toBe(0);
  });

  test("fails closed on malformed recovery SSE without retrying or dispatching", async () => {
    let recoveryFetches = 0;
    let providerFetches = 0;
    globalThis.fetch = (async (input) => {
      if (String(input).includes("chatgpt.com")) {
        recoveryFetches += 1;
        return new Response("data: {not-json}\n\ndata: [DONE]\n\n", { status: 200 });
      }
      providerFetches += 1;
      return providerResponse();
    }) as typeof fetch;

    const response = await post(
      routedConfig(),
      "xai/grok-4.5",
      encryptedInput(),
      codexHeaders(),
    );
    const raw = await response.text();

    expect(response.status).toBe(400);
    expect(recoveryFetches).toBe(1);
    expect(providerFetches).toBe(0);
    expect(raw).not.toContain(FERNET_TASK);
    expect(raw).not.toContain("acct-caller");
  });

  test("rejects a plausible tool call when the recovery stream never completes", async () => {
    let providerFetches = 0;
    globalThis.fetch = (async (input) => {
      if (String(input).includes("chatgpt.com")) {
        const partial = recoverySse("Never dispatch this partial result.")
          .split("data: {\"type\":\"response.completed\"")[0]!;
        return new Response(partial, { status: 200 });
      }
      providerFetches += 1;
      return providerResponse();
    }) as typeof fetch;

    const response = await post(
      routedConfig(),
      "xai/grok-4.5",
      encryptedInput(),
      codexHeaders(),
    );

    expect(response.status).toBe(400);
    expect(providerFetches).toBe(0);
  });

  test("times out recovery without dispatching the encrypted task", async () => {
    let recoveryFetches = 0;
    let providerFetches = 0;
    globalThis.fetch = ((input, init) => {
      if (!String(input).includes("chatgpt.com")) {
        providerFetches += 1;
        return Promise.resolve(providerResponse());
      }
      recoveryFetches += 1;
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        const rejectAbort = () => reject(signal?.reason ?? new DOMException("aborted", "AbortError"));
        if (signal?.aborted) rejectAbort();
        else signal?.addEventListener("abort", rejectAbort, { once: true });
      });
    }) as typeof fetch;

    const response = await post(
      routedConfig({ enabled: true, timeoutMs: 1_000 }),
      "xai/grok-4.5",
      encryptedInput(),
      codexHeaders(),
    );

    expect(response.status).toBe(400);
    expect(recoveryFetches).toBe(1);
    expect(providerFetches).toBe(0);
  });

  test("cancels recovery with the client and never reaches the routed provider", async () => {
    const controller = new AbortController();
    let markRecoveryStarted: (() => void) | undefined;
    const recoveryStarted = new Promise<void>((resolve) => {
      markRecoveryStarted = resolve;
    });
    let providerFetches = 0;
    globalThis.fetch = ((input, init) => {
      if (!String(input).includes("chatgpt.com")) {
        providerFetches += 1;
        return Promise.resolve(providerResponse());
      }
      markRecoveryStarted?.();
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        const rejectAbort = () => reject(signal?.reason ?? new DOMException("aborted", "AbortError"));
        if (signal?.aborted) rejectAbort();
        else signal?.addEventListener("abort", rejectAbort, { once: true });
      });
    }) as typeof fetch;

    const pending = post(
      routedConfig(),
      "xai/grok-4.5",
      encryptedInput(),
      codexHeaders(),
      controller.signal,
    );
    await recoveryStarted;
    controller.abort(new DOMException("client disconnected", "AbortError"));
    const response = await pending;

    expect(response.status).toBe(499);
    expect(providerFetches).toBe(0);
    expect(await response.json()).toMatchObject({
      error: { code: "client_cancelled" },
    });
  });

  test("scopes cache entries by parent thread and authenticated account", async () => {
    let recoveryFetches = 0;
    let providerFetches = 0;
    globalThis.fetch = (async (input) => {
      if (String(input).includes("chatgpt.com")) {
        recoveryFetches += 1;
        return new Response(recoverySse("Scoped cached assignment."), { status: 200 });
      }
      providerFetches += 1;
      return providerResponse();
    }) as typeof fetch;

    const headers = codexHeaders("acct-one", { "x-codex-parent-thread-id": "parent-one" });
    expect((await post(routedConfig(), "xai/grok-4.5", encryptedInput(), headers)).status).toBe(200);
    expect((await post(routedConfig(), "xai/grok-4.5", encryptedInput(), headers)).status).toBe(200);
    expect((await post(
      routedConfig(),
      "xai/grok-4.5",
      encryptedInput(),
      codexHeaders("acct-one", { "x-codex-parent-thread-id": "parent-two" }),
    )).status).toBe(200);
    expect((await post(
      routedConfig(),
      "xai/grok-4.5",
      encryptedInput(),
      codexHeaders("acct-two", { "x-codex-parent-thread-id": "parent-one" }),
    )).status).toBe(200);

    expect(recoveryFetches).toBe(3);
    expect(providerFetches).toBe(4);
  });

  test("deduplicates concurrent recovery for the same scoped task", async () => {
    let recoveryFetches = 0;
    let providerFetches = 0;
    let releaseRecovery: (() => void) | undefined;
    const recoveryGate = new Promise<void>((resolve) => {
      releaseRecovery = resolve;
    });
    globalThis.fetch = (async (input) => {
      if (String(input).includes("chatgpt.com")) {
        recoveryFetches += 1;
        await recoveryGate;
        return new Response(recoverySse("Shared recovery assignment."), { status: 200 });
      }
      providerFetches += 1;
      return providerResponse();
    }) as typeof fetch;
    const headers = codexHeaders("acct-flight", { "x-codex-parent-thread-id": "parent-flight" });

    const first = post(routedConfig(), "xai/grok-4.5", encryptedInput(), headers);
    const second = post(routedConfig(), "xai/grok-4.5", encryptedInput(), headers);
    for (let turn = 0; turn < 200 && agentTaskRecoveryWaiterCountForTests() < 2; turn += 1) {
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    expect(agentTaskRecoveryWaiterCountForTests()).toBe(2);
    releaseRecovery?.();
    const responses = await Promise.all([first, second]);

    expect(responses.map(response => response.status)).toEqual([200, 200]);
    expect(recoveryFetches).toBe(1);
    expect(providerFetches).toBe(2);
  });

  test("enforces the configured cache entry bound", async () => {
    let recoveryFetches = 0;
    globalThis.fetch = (async (input, init) => {
      if (String(input).includes("chatgpt.com")) {
        recoveryFetches += 1;
        const body = typeof init?.body === "string" ? init.body : "";
        const assignment = body.includes(SECOND_FERNET_TASK) ? "Task B." : "Task A.";
        return new Response(recoverySse(assignment), { status: 200 });
      }
      return providerResponse();
    }) as typeof fetch;
    const config = routedConfig({ enabled: true, cacheEntries: 1 });
    const headers = codexHeaders("acct-cache", { "x-codex-parent-thread-id": "parent-cache" });

    expect((await post(config, "xai/grok-4.5", encryptedInput(), headers)).status).toBe(200);
    expect((await post(
      config,
      "xai/grok-4.5",
      encryptedInput({ ciphertext: SECOND_FERNET_TASK }),
      headers,
    )).status).toBe(200);
    expect((await post(config, "xai/grok-4.5", encryptedInput(), headers)).status).toBe(200);

    expect(recoveryFetches).toBe(3);
  });

  test("keeps plaintext v1-style tasks on the normal routed path", async () => {
    let recoveryFetches = 0;
    let providerFetches = 0;
    let providerBody = "";
    globalThis.fetch = (async (input, init) => {
      if (String(input).includes("chatgpt.com")) {
        recoveryFetches += 1;
        throw new Error("recovery must stay unreachable");
      }
      providerFetches += 1;
      providerBody = typeof init?.body === "string" ? init.body : "";
      return providerResponse();
    }) as typeof fetch;

    const response = await post(
      routedConfig(),
      "xai/grok-4.5",
      agentMessage([
        { type: "input_text", text: ROUTING_ENVELOPE },
        { type: "encrypted_content", encrypted_content: "Readable task payload." },
      ]),
      codexHeaders(),
    );

    expect(response.status).toBe(200);
    expect(recoveryFetches).toBe(0);
    expect(providerFetches).toBe(1);
    expect(providerBody).toContain("Readable task payload.");
  });

  test("leaves native encrypted passthrough unchanged", async () => {
    let fetchedUrl = "";
    let forwardedBody = "";
    globalThis.fetch = (async (input, init) => {
      fetchedUrl = String(input);
      forwardedBody = typeof init?.body === "string" ? init.body : "";
      return providerResponse();
    }) as typeof fetch;

    const response = await post(
      routedConfig(),
      "gpt-5.6-sol",
      encryptedInput(),
      codexHeaders(),
    );

    expect(response.status).toBe(200);
    expect(fetchedUrl).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(forwardedBody).toContain(FERNET_TASK);
    expect(forwardedBody).not.toContain("capture_assignment");
  });

  test("does not enable recovery inside combo attempts", async () => {
    const config = routedConfig();
    config.combos = {
      routed: {
        strategy: "failover",
        targets: [{ provider: "xai", model: "grok-4.5" }],
      },
    };
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error("combo must fail before dispatch");
    }) as typeof fetch;

    const response = await post(
      config,
      "combo/routed",
      encryptedInput(),
      codexHeaders(),
    );

    expect(response.status).toBe(400);
    expect(fetchCalls).toBe(0);
    expect(await response.json()).toMatchObject({
      error: { code: "unreadable_encrypted_agent_task" },
    });
  });
});
