import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagementRequest as Request } from "../helpers/management-auth";
import { comboProviderFactory } from "../helpers/combo-provider";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { clearComboSelectionState, clearComboTargetCooldowns, isComboTargetInCooldown } from "../../src/combos";
import { clearComboRecallForTests } from "../../src/server/responses/combo-session-recall";
import { clearKeyCooldowns } from "../../src/providers/key-failover";
import { clearCodexUpstreamHealth } from "../../src/codex/routing";
import { clearRequestLogsForTests, type RequestLogContext } from "../../src/server/request-log";
import { responseWithDeferredRequestLog } from "../../src/server/relay";
import { readUsageEntries } from "../../src/usage/log";
import { logsFromApiBody } from "../helpers/logs-api";
import { handleManagementAPI } from "../../src/server/management-api";
import { catalogConvergenceFactory } from "../helpers/catalog-convergence";
import {
  clearResponseStateForTests,
  flushResponseState,
  responseStatePersistPendingForTests,
} from "../../src/responses/state";
import { chatSuccess } from "../helpers/combo-failover-upstream";
import type { OcxConfig } from "../../src/types";

setDefaultTimeout(30_000);

let testDir = "";
let previousHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;
const servers: Array<ReturnType<typeof Bun.serve>> = [];
const provider = comboProviderFactory(() => undefined);
let releaseSpendHome: (() => void) | undefined;
const takeSpendHome = (): void => { releaseSpendHome ??= acquireOwnedSpendHome(); };
const pendingTurns: Response[] = [];
function trackTurn(response: Response): Response { pendingTurns.push(response); return response; }

const { handleResponses } = await import("../../src/server/responses");
type HandleOptions = NonNullable<Parameters<typeof handleResponses>[3]>;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-combo-opaque-err-codex-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-combo-opaque-err-"));
  process.env.OPENCODEX_HOME = testDir;
  clearComboSelectionState();
  clearComboRecallForTests();
  clearComboTargetCooldowns();
  clearKeyCooldowns();
  clearCodexUpstreamHealth();
  clearRequestLogsForTests();
  clearResponseStateForTests();
});

afterEach(async () => {
  let responseStatePending = true;
  let cancelFailure: unknown;
  try {
    for (const turn of pendingTurns.splice(0)) {
      if (turn.bodyUsed || !turn.body || turn.body.locked) continue;
      try { await turn.body.cancel(); }
      catch (error) { cancelFailure ??= error; }
    }
    for (const server of servers.splice(0)) await server.stop(true);
    await flushResponseState();
    responseStatePending = responseStatePersistPendingForTests();
  } finally {
    releaseSpendHome?.();
    releaseSpendHome = undefined;
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
  if (cancelFailure !== undefined) throw cancelFailure;
  expect(responseStatePending).toBe(false);
});

function serve(handler: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  servers.push(server);
  return server;
}

function baseUrl(server: ReturnType<typeof Bun.serve>): string {
  return `${server.url.toString().replace(/\/$/, "")}/v1`;
}

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

let loggedRequestSequence = 0;

async function postLogged(
  config: OcxConfig,
  raw: Record<string, unknown> = {},
  options: HandleOptions = {},
  headers: Record<string, string> = {},
): Promise<Response> {
  const logCtx: RequestLogContext = { model: "", provider: "" };
  const start = Date.now();
  takeSpendHome();
  const response = await handleResponses(new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ model: "combo/free", input: "hello", stream: false, ...raw }),
  }), config, logCtx, options);
  loggedRequestSequence += 1;
  return trackTurn(responseWithDeferredRequestLog(
    response,
    `combo-test-${loggedRequestSequence}`,
    start,
    logCtx,
  ));
}

async function management(
  config: OcxConfig,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response | null> {
  const request = new Request(`http://localhost${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return handleManagementAPI(request, new URL(request.url), config, {
    createManagementConvergeCodex: catalogConvergenceFactory(),
  });
}

async function latestAttemptReceipts(config: OcxConfig) {
  const response = await management(config, "GET", "/api/logs?tail=1");
  const logs = logsFromApiBody(await response!.json());
  const usage = readUsageEntries();
  return { log: logs[0]!, usage: usage.at(-1)! };
}

describe("server combo opaque error failover", () => {
  test("opaque OpenRouter numeric-code 400 hops to the next combo target", async () => {
    const hits: string[] = [];
    const openrouter = serve(() => {
      hits.push("a");
      return Response.json({
        error: {
          message: "Provider returned error",
          code: 400,
          metadata: { raw: "ERROR", provider_name: "Stealth", is_byok: false },
        },
        user_id: "user_test",
      }, { status: 400 });
    });
    const backup = serve(() => {
      hits.push("backup");
      return chatSuccess("healthy fallback", "m2");
    });
    const config = comboConfig({
      a: provider("openai-chat", baseUrl(openrouter), "key-openrouter"),
      backup: provider("openai-chat", baseUrl(backup), "key-backup"),
    }, [
      { provider: "a", model: "stealth/crouton-alpha" },
      { provider: "backup", model: "m2" },
    ]);

    const response = await postLogged(config);

    expect(response.status).toBe(200);
    expect(JSON.stringify(await response.json())).toContain("healthy fallback");
    expect(hits).toEqual(["a", "backup"]);
    expect(isComboTargetInCooldown("free", { provider: "a", model: "stealth/crouton-alpha" })).toBe(false);

    const { log, usage } = await latestAttemptReceipts(config);
    for (const receipt of [log, usage]) {
      expect(receipt).toMatchObject({
        provider: "combo",
        model: "combo/free",
        resolvedModel: "m2",
        attempts: [
          { ordinal: 1, provider: "a", model: "stealth/crouton-alpha", status: 400 },
          { ordinal: 2, provider: "backup", model: "m2", status: 200 },
        ],
      });
    }
  });
});
