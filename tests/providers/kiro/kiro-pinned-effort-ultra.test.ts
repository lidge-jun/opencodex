import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAccountSet, saveCredential, setActiveAccount } from "../../../src/oauth/store";
import { handleChatCompletions } from "../../../src/server/chat-completions";
import { handleClaudeMessages } from "../../../src/server/claude-messages";
import { handleResponses } from "../../../src/server/responses";
import type { OcxConfig } from "../../../src/types";
import { acquireOwnedSpendHome } from "../../helpers/owned-spend-home";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../../helpers/remove-tree";

const realFetch = globalThis.fetch;
const oldOcxHome = process.env.OPENCODEX_HOME;
let home = "";
let isolated: IsolatedCodexHome;
let releaseSpend: () => void;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "ocx-kiro-ultra-pin-"));
  isolated = installIsolatedCodexHome("ocx-kiro-ultra-codex-");
  process.env.OPENCODEX_HOME = home;
  releaseSpend = acquireOwnedSpendHome();
  await saveCredential("kiro", {
    access: "synthetic-access", refresh: "synthetic-refresh", expires: Date.now() + 3_600_000,
    accountId: "ultra-pin-account", source: "oauth",
    kiro: { profileArn: "arn:aws:codewhisperer:us-east-1:123456789012:profile/0", apiRegion: "us-east-1" },
  }, { addAccount: true });
  await setActiveAccount("kiro", getAccountSet("kiro")!.accounts[0]!.id);
});
afterEach(() => {
  // Ledger lease first: an open SQLite handle inside a directory being removed is a teardown race.
  releaseSpend();
  globalThis.fetch = realFetch;
  if (oldOcxHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = oldOcxHome;
  isolated.restore();
  removeTreeWithRetry(home);
});

/** A provider pin is an operator setting; `ultra` is a declared effort, so config admits it. */
type Pin = string | { form: "provider" | "model" | "global"; effort: string };
function config(models: string[], pin?: Pin): OcxConfig {
  const form = typeof pin === "string" ? "provider" : pin?.form;
  const effort = typeof pin === "string" ? pin : pin?.effort;
  return { port: 0, defaultProvider: "kiro",
    ...(form === "global" ? { modelPinnedEfforts: { [models[0]!]: effort } } : {}),
    providers: { kiro: {
      adapter: "kiro", authMode: "oauth", baseUrl: "https://runtime.us-east-1.kiro.dev", models,
      ...(form === "provider" ? { pinnedReasoningEffort: effort } : {}),
      ...(form === "model" ? { modelPinnedReasoningEfforts: { [models[0]!]: effort } } : {}),
    } } } as unknown as OcxConfig;
}

/** Capture the wire body; answer 500 so no case depends on a synthetic success frame. */
function captureWire(): { bodies: Record<string, unknown>[] } {
  const bodies: Record<string, unknown>[] = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response("{}", { status: 500, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { bodies };
}

async function responsesRequest(
  model: string, effort: string | undefined, pin: Pin | undefined, stream = false,
) {
  const captured = captureWire();
  const response = await handleResponses(new Request("http://localhost/v1/responses", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: `kiro/${model}`, input: "hi", stream,
      ...(effort ? { reasoning: { effort } } : {}),
    }),
  }), config([model], pin), { model, provider: "kiro" });
  const body = await response.json() as {
    error?: { message?: string; type?: string; code?: string };
  };
  return {
    status: response.status, error: body.error, wires: captured.bodies,
    contentType: response.headers.get("content-type"),
  };
}

/**
 * The Messages surface. Its public contract for a local build refusal is the fixed condition copy,
 * not the adapter's detail, so this returns the raw body for an exact-shape assertion rather than
 * digging out `error.message` and hiding an extra field.
 */
async function messagesRequest(model: string, pin: Pin | undefined, stream = false) {
  const captured = captureWire();
  const response = await handleClaudeMessages(new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: `kiro/${model}`, max_tokens: 256, stream,
      messages: [{ role: "user", content: "hi" }],
    }),
  }), config([model], pin), { model: "", provider: "" } as never);
  const body = await response.json() as unknown;
  return {
    status: response.status, body, wires: captured.bodies,
    contentType: response.headers.get("content-type"),
  };
}

/** Chat Completions is the third surface that reaches this adapter, and its copy is fixed too. */
async function chatRequest(model: string, pin: Pin | undefined, stream = false) {
  const captured = captureWire();
  const response = await handleChatCompletions(new Request("http://localhost/v1/chat/completions", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: `kiro/${model}`, stream, messages: [{ role: "user", content: "hi" }],
    }),
  }), config([model], pin), { model: "", provider: "" } as never);
  const body = await response.json() as unknown;
  return {
    status: response.status, body, wires: captured.bodies,
    contentType: response.headers.get("content-type"),
  };
}

const reasoningField = (wire: Record<string, unknown> | undefined) =>
  wire?.additionalModelRequestFields as Record<string, unknown> | undefined;
const userContent = (wire: Record<string, unknown> | undefined) => (wire?.conversationState as {
  currentMessage: { userInputMessage: { content: string } };
} | undefined)?.currentMessage.userInputMessage.content;

// Pins are applied after parsing. Exercise each form through every client surface, including
// the seven Claude ids newly moved from emulated to native effort.
const affectedModels = [
  "claude-opus-4.8", "claude-opus-4.7", "claude-opus-4.6", "claude-sonnet-5.5",
  "claude-sonnet-5", "claude-sonnet-4.6", "claude-haiku-5.5",
];
for (const model of affectedModels) {
  for (const form of ["provider", "model", "global"] as const) {
    for (const surface of ["responses", "chat", "messages"] as const) {
      test(`${surface}: ${model} ${form} ultra pin sends native max`, async () => {
        const pin = { form, effort: "ultra" };
        for (const stream of [false, true]) {
          const result = surface === "responses" ? await responsesRequest(model, "high", pin, stream)
            : surface === "chat" ? await chatRequest(model, pin, stream)
            : await messagesRequest(model, pin, stream);
          expect(result.status).toBe(surface === "messages" ? 529 : 500);
          expect(result.wires).toHaveLength(1);
          expect(reasoningField(result.wires[0])).toEqual({ output_config: { effort: "max" } });
        }
      });
    }
  }
}

test("native GPT ultra pin also sends max", async () => {
  const result = await responsesRequest("gpt-5.6-sol", undefined, "ultra");
  expect(result.status).toBe(500);
  expect(result.wires).toHaveLength(1);
  expect(reasoningField(result.wires[0])).toEqual({ reasoning: { effort: "max" } });
});

test("Chat Completions retains fixed refusal copy for minimal", async () => {
  for (const stream of [false, true]) {
    const { status, body, wires, contentType } = await chatRequest("claude-opus-5.5", "minimal", stream);
    expect(status).toBe(400);
    expect(body).toEqual({ error: { message: "The provider rejected the request.",
      type: "invalid_request_error", param: null, code: "invalid_request_error" } });
    expect(wires).toHaveLength(0);
    expect(contentType).toContain("application/json");
  }
});

test("pinned minimal is refused with the same Responses detail on both stream modes", async () => {
  // The emulated set admits `minimal`; the rest of the native table rejects it. These ids are the
  // ones the docs name as refusing, so the roster here is spelled out instead of derived from the
  // allowlist under test.
  for (const model of ["claude-opus-5", "claude-opus-5.5", "gpt-5.6-sol"]) {
    for (const stream of [false, true]) {
      const { status, error, wires } = await responsesRequest(model, undefined, "minimal", stream);
      expect({ model, stream, status }).toEqual({ model, stream, status: 400 });
      expect({ model, stream, message: error?.message }).toEqual({
        model, stream, message: `Kiro ${model} does not support reasoning effort "minimal"`,
      });
      expect({ model, stream, sends: wires.length }).toEqual({ model, stream, sends: 0 });
    }
  }
});

test("a model with no native field keeps its emulated path, so a pinned ultra is dropped silently", async () => {
  // `claude-sonnet-4.5` never takes the native field, so the adapter's ladder check never runs and
  // `kiroThinkingBudget` has no `ultra` entry: the request is sent with no reasoning signal at all.
  // This is pre-existing behavior for emulated models, not a consequence of the native Claude work,
  // and it is why the docs must say "dropped" rather than "rejected" for this half of the roster.
  const dropped = await responsesRequest("claude-sonnet-4.5", "high", "ultra");
  expect(dropped.status).toBe(500);
  expect(dropped.wires).toHaveLength(1);
  expect(reasoningField(dropped.wires[0])).toBeUndefined();
  expect(userContent(dropped.wires[0])).not.toContain("<thinking_mode>");

  // Same model, same path, a pin the emulation does understand: the pin demonstrably arrives.
  const minimal = await responsesRequest("claude-sonnet-4.5", "high", "minimal");
  expect(minimal.status).toBe(500);
  expect(minimal.wires).toHaveLength(1);
  expect(reasoningField(minimal.wires[0])).toBeUndefined();
  expect(userContent(minimal.wires[0])).toContain("<thinking_mode>enabled</thinking_mode>");
});

test("the Messages surface replaces the adapter detail with the fixed condition copy", async () => {
  // The same throw reaches a different public body here: `ownedAnthropicErrorPayload` re-shapes the
  // Responses error and keeps only `upstreamConditionMessage("request_rejected")`, so the model and
  // effort never reach a Messages client. Asserting the whole body pins that replacement rather
  // than a substring a future forwarding change would still satisfy.
  for (const [model, pin] of [["claude-opus-5", "minimal"]] as const) {
    for (const stream of [false, true]) {
      const { status, body, wires, contentType } = await messagesRequest(model, pin, stream);
      expect({ model, pin, stream, status }).toEqual({ model, pin, stream, status: 400 });
      expect({ model, pin, stream, body }).toEqual({
        model, pin, stream,
        body: {
          type: "error",
          error: { type: "invalid_request_error", message: "The provider rejected the request." },
        },
      });
      expect({ model, pin, stream, sends: wires.length }).toEqual({ model, pin, stream, sends: 0 });
      expect(contentType).toContain("application/json");
    }
  }
});

test("a caller's own ultra is folded on the Messages surface too, before the adapter", async () => {
  // `src/claude/inbound.ts` copies `output_config.effort` verbatim (its set includes `ultra`), so
  // what reduces the value is the Responses parser the translated request is handed to — not the
  // translator. Both surfaces therefore fold a caller's `ultra` and neither can deliver it.
  // A synthetic upstream 500 arrives as 529 `overloaded_error` here: claude-messages reclassifies
  // transient upstream 5xx so the Claude Code client backs off instead of failing fatally.
  const captured = captureWire();
  const response = await handleClaudeMessages(new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: "kiro/claude-opus-4.8", max_tokens: 256,
      output_config: { effort: "ultra" },
      messages: [{ role: "user", content: "hi" }],
    }),
  }), config(["claude-opus-4.8"]), { model: "", provider: "" } as never);
  expect(response.status).toBe(529);
  expect(captured.bodies).toHaveLength(1);
  expect(reasoningField(captured.bodies[0])).toEqual({ output_config: { effort: "max" } });
});
