import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../../types";
import type { IncomingMeta, ProviderAdapter } from "../base";
import type { TranslatorBudget } from "../../lib/translator-budget";
import type { AdapterTierMetadata } from "../../providers/fastwire";
import { isZenFreeEndpoint, zenFreeHasApiKey } from "../opencode-free-session";
import {
  missingZenFreeGateTools,
  zenFreeGateCallGuidance,
  zenFreeGateChatTool,
} from "../opencode-free-tools";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Append the keyless-tier gate declarations to an already-serialized Chat
 * body. Returns the request untouched when the endpoint is not the canonical
 * Zen one, when a key is configured, or when the pair is already present —
 * every other destination keeps byte-identical bodies.
 */
function amendZenFreeGateDeclarations(
  request: { body: unknown },
  provider: Pick<OcxProviderConfig, "baseUrl" | "apiKey">,
): string | undefined {
  if (!isZenFreeEndpoint(provider.baseUrl) || zenFreeHasApiKey(provider)) return undefined;
  if (typeof request.body !== "string") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(request.body);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const tools = Array.isArray(parsed.tools) ? parsed.tools : undefined;
  const names = (tools ?? []).map(tool =>
    isRecord(tool) && isRecord(tool.function) && typeof tool.function.name === "string"
      ? tool.function.name
      : undefined,
  ).filter((name): name is string => typeof name === "string");
  const missing = missingZenFreeGateTools(names);
  if (missing.length === 0) return undefined;
  return JSON.stringify({ ...parsed, tools: [...(tools ?? []), ...missing.map(zenFreeGateChatTool)] });
}

/**
 * Keyless Zen tier compatibility for the Chat wire, applied after the
 * ordinary adapter has serialized the request (same post-serialization shape
 * as `withClinePassDeepSeekV4ToolReplayCompatibility`).
 *
 * Two behaviors, both gated on the canonical Zen endpoint without a
 * configured key, so every other destination is untouched:
 *
 * - build: append the missing never-invoked shell/read gate declarations.
 * - parse: substitute guidance text for a gate-named call the client never
 *   declared, instead of letting the turn die downstream. The client catalog
 *   snapshot is captured here at build time (the parse path has no parsed
 *   request); a gate name the client itself declared flows untouched.
 */
export function withZenFreeTierSupport(
  adapter: ProviderAdapter,
  provider: Pick<OcxProviderConfig, "baseUrl" | "apiKey">,
  explicitClientToolNames?: Iterable<string>,
): ProviderAdapter {
  // Client catalog snapshot for the parse substitution below. Per-adapter
  // instance state, same build-into-parse handoff the wrapped adapter
  // already uses for its requested model id. Lanes that never call
  // buildRequest (native Chat) pass the catalog explicitly instead.
  let buildClientToolNames: Set<string> | undefined;
  const gateApplies = (): boolean =>
    isZenFreeEndpoint(provider.baseUrl) && !zenFreeHasApiKey(provider);
  const catalogNames = (): Set<string> | undefined =>
    explicitClientToolNames !== undefined ? new Set(explicitClientToolNames) : buildClientToolNames;
  return {
    ...adapter,
    async buildRequest(parsed: OcxParsedRequest, incoming: IncomingMeta) {
      buildClientToolNames = new Set(
        (parsed.context.tools ?? []).map(tool => tool.name).filter((name): name is string => typeof name === "string"),
      );
      const request = await adapter.buildRequest(parsed, incoming);
      const amended = amendZenFreeGateDeclarations(request, provider);
      return amended === undefined ? request : { ...request, body: amended };
    },
    async *parseStream(
      response: Response,
      budget: TranslatorBudget,
      tierMetadata?: AdapterTierMetadata,
    ): AsyncGenerator<AdapterEvent> {
      let suppressing = false;
      for await (const event of adapter.parseStream(response, budget, tierMetadata)) {
        if (event.type === "tool_call_start") {
          const guidance = gateApplies()
            ? zenFreeGateCallGuidance(event.name, catalogNames())
            : undefined;
          if (guidance !== undefined) {
            suppressing = true;
            yield { type: "text_delta", text: guidance };
            continue;
          }
          suppressing = false;
        } else if (suppressing && (event.type === "tool_call_delta" || event.type === "tool_call_end")) {
          if (event.type === "tool_call_end") suppressing = false;
          continue;
        }
        yield event;
      }
    },
  };
}
