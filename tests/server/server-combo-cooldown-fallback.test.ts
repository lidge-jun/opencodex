import { afterAll, afterEach, beforeEach, describe, expect, mock, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagementRequest as Request } from "../helpers/management-auth";
import { comboProviderFactory } from "../helpers/combo-provider";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { clearComboSelectionState, clearComboTargetCooldowns } from "../../src/combos";
import { clearComboRecallForTests } from "../../src/server/responses/combo-session-recall";
import { clearKeyCooldowns } from "../../src/providers/key-failover";
import { clearCodexUpstreamHealth } from "../../src/codex/routing";
import { clearRequestLogsForTests, type RequestLogContext } from "../../src/server/request-log";
import {
  clearResponseStateForTests,
  flushResponseState,
  responseStatePersistPendingForTests,
} from "../../src/responses/state";
import type { ProviderAdapter } from "../../src/adapters/base";
import type { AdapterEvent, OcxConfig, OcxProviderConfig } from "../../src/types";

// `mock.module` outlives this file: Bun keeps the override below for every file that runs after
// this one in the same process. This is a spread snapshot of the real module, taken before it.
const actualResolver = { ...(await import("../../src/server/adapter-resolve")) };
const actualResolveAdapter = actualResolver.resolveAdapter;
let customRunTurn: NonNullable<ProviderAdapter["runTurn"]> | undefined;

mock.module("../../src/server/adapter-resolve", () => ({
  ...actualResolver,
  resolveAdapter(provider: OcxProviderConfig, cacheRetention?: "none" | "short" | "long") {
    if (provider.adapter !== "test-run-turn") {
      return actualResolveAdapter(provider, cacheRetention);
    }
    return {
      name: "test-run-turn",
      buildRequest: () => ({ url: provider.baseUrl, method: "POST", headers: {}, body: "" }),
      async *parseStream(): AsyncGenerator<AdapterEvent> {
        yield { type: "error", message: "test runTurn adapter does not use parseStream" };
      },
      async runTurn(parsed, incoming, emit) {
        if (!customRunTurn) throw new Error("custom runTurn not installed");
        await customRunTurn(parsed, incoming, emit);
      },
    } satisfies ProviderAdapter;
  },
}));

afterAll(() => {  // Put the real module back for every later file in the same process.
  mock.module("../../src/server/adapter-resolve", () => actualResolver);
});

const { handleResponses } = await import("../../src/server/responses");

/**
 * Cooldown-readiness combo failover: a first target that reports ready and then fails
 * must still hand off to the next combo target.
 *
 * This case was written in `server-combo-failover-e2e.test.ts` and moved here. That
 * file carries a file-size-ratchet cap that the new test pushed past its ceiling, so
 * the case lives in this sibling file instead of raising the cap.
 *
 * The harness below is the subset of that file's fixture these cases actually use: real
 * loopback upstreams, an isolated home, and the combo/request-log state that leaks
 * between tests. The loopback cases drive real adapters; the runTurn case uses the same
 * narrow resolver seam as the parent file to emit deterministic adapter events.
 */

// The parent file raises this for the same reason: a real loopback server plus combo
// failover exceeds the 5s default under full-suite load on Windows.
setDefaultTimeout(30_000);

let testDir = "";
let previousHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;
const servers: Array<ReturnType<typeof Bun.serve>> = [];
const provider = comboProviderFactory(() => undefined);
let releaseSpendHome: (() => void) | undefined;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-combo-zero-output-codex-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-combo-zero-output-"));
  process.env.OPENCODEX_HOME = testDir;
  // Direct handler dispatches need the writer lease that startServer normally holds.
  releaseSpendHome = acquireOwnedSpendHome();
  clearComboSelectionState();
  clearComboRecallForTests();
  clearComboTargetCooldowns();
  clearKeyCooldowns();
  clearCodexUpstreamHealth();
  clearRequestLogsForTests();
  clearResponseStateForTests();
});

afterEach(async () => {
  customRunTurn = undefined;
  // Release before home teardown to prevent Windows removal failures and a live unlinked database.
  releaseSpendHome?.();
  releaseSpendHome = undefined;
  let responseStatePending = true;
  try {
    for (const server of servers.splice(0)) await server.stop(true);
    await flushResponseState();
    responseStatePending = responseStatePersistPendingForTests();
  } finally {
    clearResponseStateForTests();
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    isolatedCodexHome?.restore();
    isolatedCodexHome = null;
    if (testDir) removeTreeWithRetry(testDir);
    clearComboSelectionState();
    clearComboRecallForTests();
    clearComboTargetCooldowns();
    clearKeyCooldowns();
    clearCodexUpstreamHealth();
    clearRequestLogsForTests();
  }
  expect(responseStatePending).toBe(false);
});

/** Loopback upstream whose lifetime the afterEach owns. */
function serve(handler: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  servers.push(server);
  return server;
}

describe("combo cooldown-ready fallback", () => {
  test("runTurn cooldown-ready heartbeat preserves combo fallback on a final 429", async () => {
    let firstHits = 0;
    let backupHits = 0;
    customRunTurn = async (_parsed, _incoming, emit) => {
      firstHits += 1;
      emit({ type: "heartbeat", preflightReady: true });
      emit({ type: "error", status: 429, errorType: "rate_limit_error", message: "stated reset still active" });
    };
    const backup = serve(() => {
      backupHits += 1;
      return new Response([
        `data: ${JSON.stringify({ choices: [{ delta: { content: "backup after cooldown" } }] })}`,
        "data: [DONE]",
        "",
      ].join("\n"), { headers: { "content-type": "text/event-stream" } });
    });
    const config = comboConfig({
      a: provider("test-run-turn", "test://run-turn", "key-a"),
      b: provider("openai-chat", baseUrl(backup), "key-b"),
    });

    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "combo/free", input: "hello", stream: true }),
    }), config, { model: "", provider: "" });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(firstHits).toBe(1);
    expect(backupHits).toBe(1);
    expect(body).toContain("backup after cooldown");
    expect(body).not.toContain("stated reset still active");
  });

  test("a delayed stated reset does not hold a combo child before fallback", async () => {
    const delayedReset = Promise.withResolvers<void>();
    const firstStarted = Promise.withResolvers<void>();
    let firstHits = 0;
    let backupHits = 0;
    customRunTurn = async (_parsed, incoming, emit) => {
      firstHits += 1;
      if (!incoming.comboAttempt) {
        emit({ type: "heartbeat", preflightReady: true });
        firstStarted.resolve();
        await delayedReset.promise;
      } else {
        firstStarted.resolve();
      }
      emit({ type: "error", status: 429, errorType: "rate_limit_error", message: "stated reset still active" });
    };
    const backup = serve(() => {
      backupHits += 1;
      return new Response([
        `data: ${JSON.stringify({ choices: [{ delta: { content: "backup after delayed reset" } }] })}`,
        "data: [DONE]",
        "",
      ].join("\n"), { headers: { "content-type": "text/event-stream" } });
    });
    const config = comboConfig({
      a: provider("test-run-turn", "test://run-turn", "key-a"),
      b: provider("openai-chat", baseUrl(backup), "key-b"),
    });
    const pending = handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "combo/free", input: "hello", stream: true }),
    }), config, { model: "", provider: "" });
    await firstStarted.promise;
    let guard: ReturnType<typeof setTimeout> | undefined;
    let response: Response | null;
    try {
      response = await Promise.race([
        pending,
        new Promise<null>(resolve => { guard = setTimeout(() => resolve(null), 2_500); }),
      ]);
    } finally {
      if (guard !== undefined) clearTimeout(guard);
      delayedReset.resolve();
    }
    if (response === null) {
      await (await pending).body?.cancel();
      throw new Error("combo held its response until the delayed reset arrived");
    }
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(firstHits).toBe(1);
    expect(backupHits).toBe(1);
    expect(body).toContain("backup after delayed reset");
    expect(body).not.toContain("stated reset still active");
  });
});
/** Provider base URL for a fixture server, without the trailing slash. */
function baseUrl(server: ReturnType<typeof Bun.serve>): string {
  return `${server.url.toString().replace(/\/$/, "")}/v1`;
}

/** Minimal completed Responses payload the backup target answers with. */
function responsesSuccess(text: string, model = "responses-model"): Record<string, unknown> {
  return {
    id: `resp-${model}`,
    object: "response",
    status: "completed",
    model,
    output: [{
      id: "msg_backup",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text, annotations: [] }],
    }],
    usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
  };
}

/** Failover combo over the supplied providers, one target per provider in order. */
function comboConfig(
  providers: OcxConfig["providers"],
  targets = Object.keys(providers).map((name, index) => ({ provider: name, model: `m${index + 1}` })),
  extra: Partial<NonNullable<OcxConfig["combos"]>[string]> = {},
): OcxConfig {
  return {
    port: 0,
    defaultProvider: Object.keys(providers)[0]!,
    providers,
    combos: { free: { strategy: "failover", targets, ...extra } },
  };
}
