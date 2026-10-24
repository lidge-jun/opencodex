import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearGenericFailoverHealth } from "../../src/oauth/generic-account-failover";
import { getAccountSet, saveCredential, setActiveAccount } from "../../src/oauth/store";
import { resetCommandCodeReasoningEffortsForTest } from "../../src/providers/command-code-efforts";
import { handleResponses } from "../../src/server/responses";
import type { OcxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const GENERATE_URL = "https://api.commandcode.ai/alpha/generate";
const CREDIT_MESSAGE = "You have insufficient credits to make this request. Please purchase more credits to continue using the service.";
const COMPLETED = [
  JSON.stringify({ type: "text-delta", text: "OK" }),
  JSON.stringify({ type: "finish", finishReason: "stop" }),
].join("\n") + "\n";

const originalHome = process.env.OPENCODEX_HOME;
const originalFetch = globalThis.fetch;
let fixtureHome: string;
let releaseSpend: (() => void) | undefined;

beforeEach(async () => {
  fixtureHome = mkdtempSync(join(tmpdir(), "ocx-command-credit-rotation-"));
  process.env.OPENCODEX_HOME = fixtureHome;
  releaseSpend = acquireOwnedSpendHome();
  clearGenericFailoverHealth();
  for (let index = 0; index < 2; index++) await saveCredential("command-code", {
    access: `synthetic-command-${index}`, refresh: `synthetic-refresh-${index}`,
    expires: Date.now() + 3_600_000, accountId: `fixture-${index}`, source: "oauth",
  }, { addAccount: true });
  await setActiveAccount("command-code", getAccountSet("command-code")!.accounts[0]!.id);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  releaseSpend?.();
  releaseSpend = undefined;
  clearGenericFailoverHealth();
  resetCommandCodeReasoningEffortsForTest();
  if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = originalHome;
  removeTreeWithRetry(fixtureHome);
});

/** The first account answers with `refusal`; any other account completes the turn. */
async function sendWithFirstAccountRefusal(refusal: () => Response) {
  const authorizations: string[] = [];
  globalThis.fetch = (async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== GENERATE_URL) throw new Error(`Unexpected fixture request: ${url}`);
    const authorization = new Headers(init?.headers).get("authorization") ?? "";
    authorizations.push(authorization);
    return authorization === "Bearer synthetic-command-0" ? refusal() : new Response(COMPLETED);
  }) as typeof fetch;
  const config = { defaultProvider: "command-code", providers: {
    "command-code": { adapter: "command-code", baseUrl: "https://api.commandcode.ai", authMode: "oauth",
      models: ["deepseek/deepseek-v4-flash"] },
  } } as OcxConfig;
  const response = await handleResponses(new Request("http://localhost/v1/responses", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "command-code/deepseek/deepseek-v4-flash", input: "hello", stream: false }),
  }), config, { model: "", provider: "" });
  return { response, body: await response.text(), authorizations };
}

describe("Command Code credit refusal through the dispatch path", () => {
  test("an exhausted account's credit refusal rotates the same request to its sibling", async () => {
    const { response, body, authorizations } = await sendWithFirstAccountRefusal(() => Response.json(
      { success: false, error: { code: "BAD_REQUEST", message: CREDIT_MESSAGE } }, { status: 400 },
    ));

    expect(response.status, body).toBe(200);
    expect(JSON.parse(body).status).toBe("completed");
    expect(authorizations).toEqual(["Bearer synthetic-command-0", "Bearer synthetic-command-1"]);
    expect(getAccountSet("command-code")!.activeAccountId).toBe(getAccountSet("command-code")!.accounts[1]!.id);
  }, 20_000);

  test("an ordinary BAD_REQUEST stays on the account and is never treated as exhaustion", async () => {
    const { response, body, authorizations } = await sendWithFirstAccountRefusal(() => Response.json(
      { success: false, error: { code: "BAD_REQUEST", message: "invalid params" } }, { status: 400 },
    ));

    expect(response.status, body).toBe(400);
    expect(authorizations).toEqual(["Bearer synthetic-command-0"]);
    expect(getAccountSet("command-code")!.activeAccountId).toBe(getAccountSet("command-code")!.accounts[0]!.id);
  }, 20_000);
});
