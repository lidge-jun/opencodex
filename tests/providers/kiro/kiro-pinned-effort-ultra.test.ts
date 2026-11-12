import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KIRO_NATIVE_EFFORT_FIELDS } from "../../../src/adapters/kiro/reasoning";
import { getAccountSet, saveCredential, setActiveAccount } from "../../../src/oauth/store";
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
function config(models: string[], pin?: string): OcxConfig {
  return { port: 0, defaultProvider: "kiro", providers: { kiro: {
    adapter: "kiro", authMode: "oauth", baseUrl: "https://runtime.us-east-1.kiro.dev",
    models, ...(pin ? { pinnedReasoningEffort: pin } : {}),
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

async function responsesRequest(model: string, effort: string | undefined, pin: string | undefined) {
  const captured = captureWire();
  const response = await handleResponses(new Request("http://localhost/v1/responses", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: `kiro/${model}`, input: "hi", stream: false,
      ...(effort ? { reasoning: { effort } } : {}),
    }),
  }), config([model], pin), { model, provider: "kiro" });
  const body = await response.json() as { error?: { message?: string; type?: string } };
  return { status: response.status, error: body.error, wires: captured.bodies };
}

const reasoningField = (wire: Record<string, unknown> | undefined) =>
  wire?.additionalModelRequestFields as Record<string, unknown> | undefined;
const userContent = (wire: Record<string, unknown> | undefined) => (wire?.conversationState as {
  currentMessage: { userInputMessage: { content: string } };
} | undefined)?.currentMessage.userInputMessage.content;

// The claim this file replaces: "ultra never reaches the adapter". It reaches the adapter whenever
// an operator pin supplies it, because pins are applied AFTER the inbound fold — the Responses
// parser turns a caller's `ultra` into `max` (src/responses/parser.ts) and the Messages translator
// copies a caller's `output_config.effort` through (src/claude/inbound.ts), but
// `applyPinnedEffort` (src/server/effort-policy.ts) writes the configured value last.
test("an operator pin of ultra reaches the adapter, which admits only its own ladder", async () => {
  const native = await responsesRequest("claude-opus-4.8", "high", "ultra");
  expect(native.status).toBe(400);
  expect(native.error?.type).toBe("invalid_request_error");
  expect(native.error?.message).toContain('claude-opus-4.8 does not support reasoning effort "ultra"');
  // Nothing was sent: the refusal happens while the payload is built, not after an upstream round trip.
  expect(native.wires).toHaveLength(0);

  // The same request without the pin is folded to `max` and does reach the wire.
  const folded = await responsesRequest("claude-opus-4.8", "ultra", undefined);
  expect(folded.status).toBe(500);
  expect(folded.wires).toHaveLength(1);
  expect(reasoningField(folded.wires[0])).toEqual({ output_config: { effort: "max" } });
});

test("every model with a native Kiro effort field rejects a pinned ultra instead of sending it", async () => {
  const models = Object.keys(KIRO_NATIVE_EFFORT_FIELDS);
  // Guard the enumeration itself: an empty table would make the loop below pass vacuously.
  expect(models.length).toBeGreaterThan(0);
  for (const model of models) {
    const { status, error, wires } = await responsesRequest(model, undefined, "ultra");
    expect({ model, status }).toEqual({ model, status: 400 });
    expect({ model, message: error?.message }).toEqual({
      model, message: `Kiro ${model} does not support reasoning effort "ultra"`,
    });
    expect({ model, sends: wires.length }).toEqual({ model, sends: 0 });
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

test("the Messages surface applies the same pin and answers with an Anthropic 400", async () => {
  captureWire();
  const response = await handleClaudeMessages(new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: "kiro/claude-opus-4.8", max_tokens: 256,
      messages: [{ role: "user", content: "hi" }],
    }),
  }), config(["claude-opus-4.8"], "ultra"), { model: "", provider: "" } as never);
  const body = await response.json() as { type?: string; error?: { type?: string } };
  expect(response.status).toBe(400);
  expect(body.type).toBe("error");
  expect(body.error?.type).toBe("invalid_request_error");
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
