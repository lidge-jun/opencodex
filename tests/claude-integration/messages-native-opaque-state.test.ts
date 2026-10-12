/**
 * Opaque thinking state and caller betas on the managed native Messages lane (PF-10), key auth.
 * A thinking signature or `redacted_thinking` block reaches first-party Anthropic only: an
 * Anthropic-compatible destination receives the body without them and the trace records
 * `opaque-state-stripped`, or, under `unrepresentable: "reject"`, the request is refused before
 * any send. A dropped caller beta is recorded by code only, never by value.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { handleClaudeMessages } from "../../src/server/claude-messages";
import { getRequestLogEntries } from "../../src/server/request-log";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const SIGNATURE = "fixture-signature-DDDDDDDDDDDDDDDDDDDD";
const REDACTED = "fixture-redacted-EEEEEEEEEEEEEEEEEEEE";
const UNKNOWN_BETA = "fixture-unlisted-beta-2099-02-02";

interface Seen {
  headers: Headers;
  body: Record<string, unknown>;
}

let seen: Seen[] = [];
let upstream: ReturnType<typeof Bun.serve> | undefined;
let testDir = "";
let previousHome: string | undefined;
let releaseSpendHome: (() => void) | undefined;

const MESSAGE = {
  id: "msg_fixture",
  type: "message",
  role: "assistant",
  model: "claude-x",
  content: [{ type: "text", text: "fixture reply" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 5, output_tokens: 2 },
};

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  testDir = mkdtempSync(join(tmpdir(), "ocx-messages-native-opaque-"));
  process.env.OPENCODEX_HOME = testDir;
  seen = [];
  releaseSpendHome = acquireOwnedSpendHome();
  upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    seen.push({ headers: req.headers, body: await req.json() as Record<string, unknown> });
    return Response.json(MESSAGE);
  } });
});

afterEach(async () => {
  releaseSpendHome?.();
  releaseSpendHome = undefined;
  await upstream?.stop(true);
  upstream = undefined;
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (testDir) removeTreeWithRetry(testDir);
});

function compatibleConfig(reject = false): OcxConfig {
  const config = {
    port: 0,
    defaultProvider: "anth",
    providers: { anth: {
      adapter: "anthropic", baseUrl: `http://127.0.0.1:${upstream!.port}`, authMode: "key", apiKey: "fixture-key",
      allowPrivateNetwork: true, models: ["claude-x"],
    } },
    protocols: {
      rollout: { managedMessagesNative: true },
      ...(reject ? { unrepresentable: "reject" } : {}),
    },
  } as OcxConfig;
  saveConfig(config);
  return config;
}

/** A key-auth route to api.anthropic.com, served by an in-process transport. */
function firstPartyConfig(): OcxConfig {
  const transport = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    seen.push({ headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    return Response.json(MESSAGE);
  }) as typeof fetch;
  const provider: OcxProviderConfig & { fetch: typeof fetch } = {
    adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: "key", apiKey: "fixture-key",
    models: ["claude-x"], fetch: transport,
  };
  const config = {
    port: 0,
    defaultProvider: "first",
    providers: { first: provider },
    protocols: { rollout: { managedMessagesNative: true } },
  } as OcxConfig;
  saveConfig(config);
  return config;
}

function body(model: string) {
  return {
    model,
    max_tokens: 64,
    stream: false,
    thinking: { type: "enabled", budget_tokens: 1024 },
    messages: [
      { role: "user", content: "fixture question" },
      { role: "assistant", content: [
        { type: "redacted_thinking", data: REDACTED },
        { type: "thinking", thinking: "fixture reasoning", signature: SIGNATURE },
        { type: "text", text: "fixture answer" },
      ] },
      { role: "user", content: "fixture follow-up" },
    ],
  };
}

async function send(config: OcxConfig, payload: Record<string, unknown>, headers: Record<string, string> = {}) {
  const requestId = `pf10-opaque-${crypto.randomUUID()}`;
  const response = await handleClaudeMessages(new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(payload),
  }), config, { model: "", provider: "" }, { requestId, start: Date.now() });
  const text = await response.text();
  const rows = getRequestLogEntries().filter(entry => entry.requestId === requestId);
  expect(rows).toHaveLength(1);
  return { response, text, row: rows[0]! };
}

describe("opaque thinking state on the native Messages lane", () => {
  test("an Anthropic-compatible destination gets the body without it, and the trace says so", async () => {
    const { response, row } = await send(compatibleConfig(), body("anth/claude-x"));
    expect(response.status).toBe(200);
    expect(seen).toHaveLength(1);
    const wire = JSON.stringify(seen[0]!.body);
    expect(wire).not.toContain(SIGNATURE);
    expect(wire).not.toContain(REDACTED);
    expect(wire).toContain("fixture reasoning");
    expect(row.protocolTrace).toMatchObject({ inbound: "messages", mode: "native" });
    expect(row.protocolTrace?.reasonCodes).toContain("opaque-state-stripped");
    expect(JSON.stringify(row)).not.toContain(SIGNATURE);
  });

  test("under reject the request is refused before any send", async () => {
    const { response, text, row } = await send(compatibleConfig(true), body("anth/claude-x"));
    expect(response.status).toBe(400);
    expect(JSON.parse(text)).toMatchObject({ type: "error", error: { type: "invalid_request_error" } });
    expect(seen).toHaveLength(0);
    expect(row.protocolTrace).toMatchObject({ inbound: "messages", mode: "blocked" });
    expect(row.protocolTrace?.reasonCodes).toEqual(expect.arrayContaining(["feature-unrepresentable", "opaque-state-stripped"]));
  });

  test("first-party Anthropic receives every signature and redacted block", async () => {
    const { response, row } = await send(firstPartyConfig(), body("first/claude-x"));
    expect(response.status).toBe(200);
    expect(seen).toHaveLength(1);
    const wire = JSON.stringify(seen[0]!.body);
    expect(wire).toContain(SIGNATURE);
    expect(wire).toContain(REDACTED);
    expect(row.protocolTrace?.reasonCodes).not.toContain("opaque-state-stripped");
  });
});

describe("caller betas on the native Messages lane", () => {
  test("a compatible destination receives none; the trace names the code, never the value", async () => {
    const { response, row } = await send(compatibleConfig(), { ...body("anth/claude-x"), messages: [{ role: "user", content: "fixture" }] }, {
      "anthropic-beta": `interleaved-thinking-2025-05-14,${UNKNOWN_BETA}`,
    });
    expect(response.status).toBe(200);
    expect(seen[0]!.headers.get("anthropic-beta")).toBeNull();
    expect(row.protocolTrace?.reasonCodes).toContain("anthropic-beta-dropped");
    expect(JSON.stringify(row)).not.toContain(UNKNOWN_BETA);
  });

  test("first-party Anthropic receives the allowlisted value only", async () => {
    await send(firstPartyConfig(), { ...body("first/claude-x"), messages: [{ role: "user", content: "fixture" }] }, {
      "anthropic-beta": `${UNKNOWN_BETA}, Interleaved-Thinking-2025-05-14`,
    });
    expect(seen[0]!.headers.get("anthropic-beta")).toBe("interleaved-thinking-2025-05-14");
  });

  test("no caller beta records nothing", async () => {
    const { row } = await send(compatibleConfig(), { ...body("anth/claude-x"), messages: [{ role: "user", content: "fixture" }] });
    expect(row.protocolTrace?.reasonCodes).not.toContain("anthropic-beta-dropped");
  });
});
