import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../../types";
import type { IncomingMeta, ProviderAdapter } from "../base";
import type { TranslatorBudget } from "../../lib/translator-budget";
import type { AdapterTierMetadata } from "../../providers/fastwire";
import { isZenFreeEndpoint, zenFreeHasApiKey } from "../opencode-free-session";
import {
  withZenFreeGateDeclarations,
  zenFreeGateCallGuidance,
  zenFreeGateChatTool,
} from "../opencode-free-tools";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function chatToolName(tool: unknown): string | undefined {
  const name = isRecord(tool) && isRecord(tool.function) ? tool.function.name : undefined;
  return typeof name === "string" ? name : undefined;
}

/**
 * Append the keyless-tier gate declarations to an already-serialized Chat
 * body. Returns the amended JSON, or undefined when the shared helper finds
 * nothing to do (other endpoint, keyed use, or pair already present).
 */
function amendZenFreeGateDeclarations(
  request: { body: unknown },
  provider: Pick<OcxProviderConfig, "baseUrl" | "apiKey">,
): string | undefined {
  if (typeof request.body !== "string") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(request.body);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const gated = withZenFreeGateDeclarations(
    provider,
    Array.isArray(parsed.tools) ? parsed.tools : undefined,
    chatToolName,
    zenFreeGateChatTool,
  );
  if (gated === undefined) return undefined;
  return JSON.stringify({ ...parsed, tools: gated });
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
