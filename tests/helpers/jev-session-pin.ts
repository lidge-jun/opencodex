import { spyOn } from "bun:test";
import * as capability from "../../src/combos/request-capability";
import { createProtocolEnvelope } from "../../src/protocols/envelope";
import { clearComboSelectionState, clearComboTargetCooldowns } from "../../src/combos";
import { createTranslatorBudget } from "../../src/lib/translator-budget";
import type { DataPlaneAdmission } from "../../src/server/auth-cors";
import type { RequestLogContext } from "../../src/server/request-log";
import { executeComboResponses } from "../../src/server/responses/core-combo";
import type { ResponsesDispatchers } from "../../src/server/responses/core-options";
import { clearComboRecallForTests } from "../../src/server/responses/combo-session-recall";
import { clearJevSessionPinsForTests } from "../../src/server/responses/jev-session-pin";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";

const JEV_URL = "https://api.typesafe.ai/v1/systemone";
export const SOL = { provider: "sol", model: "gpt-5.6-sol" } as const;
export const LUNA = { provider: "luna", model: "gpt-5.6-luna" } as const;

export function resetState(): void {
  clearComboSelectionState();
  clearComboTargetCooldowns();
  clearComboRecallForTests();
  clearJevSessionPinsForTests();
}

export function modelProvider(model: string): OcxProviderConfig {
  return {
    adapter: "openai-chat",
    baseUrl: `https://${model}.example.test/v1`,
    authMode: "key",
    apiKey: `key-${model}`,
    liveModels: false,
    models: [model],
    modelReasoningEfforts: { [model]: ["low", "medium", "high"] },
  };
}

/** A JEV Combo whose decision service records every call and always answers `choice`. */
export function makeConfig(choice: string, decisions: string[], sessionPin: boolean): OcxConfig {
  const jevFetch = (async () => {
    decisions.push(choice);
    return Response.json({ answers: { route: { choice, confidence: 0.8 } } });
  }) as typeof fetch;
  return {
    port: 0,
    defaultProvider: "sol",
    providers: {
      jev: { adapter: "jev-decision", baseUrl: JEV_URL, authMode: "key", liveModels: false, apiKey: "typesafe-test-key", fetch: jevFetch },
      sol: modelProvider(SOL.model),
      luna: modelProvider(LUNA.model),
    },
    combos: {
      auto: {
        alias: "jev-auto",
        strategy: "jev",
        targets: [{ ...LUNA }, { ...SOL }],
        ...(sessionPin ? { sessionPin: { ttlMs: 20 * 60_000 } } : {}),
      },
    },
  };
}

export type ChildOptions = Parameters<ResponsesDispatchers["handleResponses"]>[3];
/** `config` is the config object the combo handed to the child dispatcher. */
export type Child = (
  body: Record<string, unknown>, complete: () => void, options: ChildOptions, config: OcxConfig,
) => Response | Promise<Response>;

/** Children complete like a real stream: the completion callback runs before the response returns. */
function dispatchers(child: Child): ResponsesDispatchers {
  return {
    async handleResponses(request, config, _logCtx, options) {
      const body = await request.json() as Record<string, unknown>;
      return child(body, () => options?.onResponseComplete?.(String(body.model)), options, config);
    },
    async handleComboResponses() {
      throw new Error("nested combo dispatch is not expected");
    },
  };
}

export const served: Child = (body, complete) => {
  complete();
  return Response.json({ id: `resp-${String(body.model)}`, object: "response", status: "completed", model: body.model, output: [] });
};

export async function turn(config: OcxConfig, options: {
  session?: string | null;
  admission?: DataPlaneAdmission;
  child?: Child;
  signal?: AbortSignal;
  log?: RequestLogContext;
  models?: string[];
  effort?: string;
  input?: unknown;
  previousResponseId?: string;
  bodyFields?: Record<string, unknown>;
  chatSource?: Record<string, unknown>;
} = {}): Promise<Response> {
  const body = { model: "jev-auto", input: options.input ?? "Implement the next step.", stream: false, ...options.bodyFields,
    ...(options.previousResponseId ? { previous_response_id: options.previousResponseId } : {}),
    ...(options.effort ? { reasoning: { effort: options.effort } } : {}) };
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.session !== null) headers.session_id = options.session ?? "session-a";
  const request = new Request("http://127.0.0.1/v1/responses", { method: "POST", headers, body: JSON.stringify(body) });
  const budget = createTranslatorBudget();
  const child = options.child ?? served;
  try {
    return await executeComboResponses(request, body, "auto", config, options.log ?? { model: "", provider: "" }, {
      translatorBudget: budget,
      ...(options.chatSource ? {
        inboundWire: "chat" as const,
        protocolSource: {
          inbound: "chat" as const,
          envelope: createProtocolEnvelope({ inbound: "chat", body: options.chatSource, translatorBudget: budget }),
          dispatchNativeChild: async () => { throw new Error("unexpected native dispatch"); },
        },
      } : {}),
      ...(options.admission ? { admission: options.admission } : {}),
      ...(options.signal ? { abortSignal: options.signal } : {}),
    }, dispatchers((childBody, complete, childOptions, childConfig) => {
      options.models?.push(String(childBody.model));
      return child(childBody, complete, childOptions, childConfig);
    }));
  } finally {
    budget.dispose();
  }
}

/** A per-turn pinned Combo whose decision service answers `answers` in order and records each payload. */
export function perTurnConfig(answers: string[], payloads: Array<Record<string, unknown>>): OcxConfig {
  const config = makeConfig("unused", [], true);
  config.combos!.auto!.sessionPin = { ttlMs: 20 * 60_000, effort: "per-turn" };
  config.providers.jev!.fetch = (async (_input, init) => {
    payloads.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const choice = answers.shift();
    if (choice === undefined) throw new Error("decision service down");
    return Response.json({ answers: { route: { choice, confidence: 0.7 } },
      usage: { input_tokens: 8, output_tokens: 2 } });
  }) as typeof fetch;
  return config;
}
export const offered = (payload: Record<string, unknown> | undefined) => {
  const criteria = (payload?.questions as { route: { criteria: Record<string, { target: string }> } }).route.criteria;
  return [...new Set(Object.values(criteria).map(option => option.target))];
};
export const effortOf = (body: Record<string, unknown>) => (body.reasoning as { effort?: string } | undefined)?.effort;


// Run the fixture edit after the real gate evaluates its inputs and before admission resumes.
export function afterCapabilityGate(edit: () => void): void {
  const gate = capability.comboCapabilityGate;
  spyOn(capability, "comboCapabilityGate").mockImplementation(async (...args) => {
    const result = await gate(...args);
    edit();
    return result;
  });
}

/** A union Combo without a session pin, so every turn pays for exactly one decision. */
export function unionConfig(answers: string[], payloads: Array<Record<string, unknown>>): OcxConfig {
  const config = perTurnConfig(answers, payloads);
  delete config.combos!.auto!.sessionPin;
  config.combos!.auto!.capabilityPolicy = "union";
  return config;
}

/** Run a live config edit while the next paid decision call is in flight, once. */
export function duringDecision(config: OcxConfig, edit: () => void, after = false): void {
  const decide = config.providers.jev!.fetch!;
  let pending = true;
  config.providers.jev!.fetch = (async (input, init) => {
    if (!pending) return decide(input, init);
    pending = false;
    if (!after) edit();
    const response = await decide(input, init);
    if (after) edit();
    return response;
  }) as typeof fetch;
}

export const IMAGE_INPUT = [{ role: "user", content: [{ type: "input_image", image_url: "https://example.test/image.png" }] }];
