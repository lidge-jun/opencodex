import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../types";
import type { TranslatorBudget } from "../lib/translator-budget";
import type { AdapterTierMetadata } from "../providers/fastwire";
import type { AdapterRequest, IncomingMeta, ProviderAdapter } from "./base";
import {
  transformProviderRequest,
  type CompatibilityFunctionCallRedirect,
} from "./provider-compatibility";

function rewriteEvents(
  events: Iterable<AdapterEvent>,
  redirect: CompatibilityFunctionCallRedirect | undefined,
): AdapterEvent[] {
  if (!redirect) return [...events];
  const rewritten: AdapterEvent[] = [];
  let suppressing = false;
  for (const event of events) {
    if (event.type === "tool_call_start") {
      suppressing = redirect.names.has(event.name);
      if (suppressing) {
        rewritten.push({ type: "text_delta", text: redirect.message(event.name) });
        continue;
      }
    } else if (suppressing && (event.type === "tool_call_delta" || event.type === "tool_call_end")) {
      if (event.type === "tool_call_end") suppressing = false;
      continue;
    }
    rewritten.push(event);
  }
  return rewritten;
}

/** Wrap an ordinary adapter with the selected provider's compatibility profile. */
export function withProviderRequestCompatibility(
  adapter: ProviderAdapter,
  provider: OcxProviderConfig,
  providerId?: string,
): ProviderAdapter {
  const buildRequest = adapter.buildRequest.bind(adapter);
  const parseStream = adapter.parseStream.bind(adapter);
  const parseResponse = adapter.parseResponse?.bind(adapter);
  // Registered adapters are request-scoped. Retries rebuild before parsing, so this holds
  // exactly the policy attached to the request whose response the wrapped adapter consumes.
  let responseRedirect: CompatibilityFunctionCallRedirect | undefined;

  return {
    ...adapter,
    buildRequest(parsed: OcxParsedRequest, incoming: IncomingMeta) {
      const apply = (request: AdapterRequest) => {
        const transformed = transformProviderRequest(provider, request, {
          providerId,
          parsed,
          incomingHeaders: incoming?.headers,
        });
        responseRedirect = transformed.compatibilityFunctionCallRedirect;
        return transformed;
      };
      const request = buildRequest(parsed, incoming);
      return request instanceof Promise ? request.then(apply) : apply(request);
    },
    async *parseStream(
      response: Response,
      budget: TranslatorBudget,
      tierMetadata?: AdapterTierMetadata,
    ): AsyncGenerator<AdapterEvent> {
      let suppressing = false;
      for await (const event of parseStream(response, budget, tierMetadata)) {
        if (event.type === "tool_call_start" && responseRedirect?.names.has(event.name)) {
          suppressing = true;
          yield { type: "text_delta", text: responseRedirect.message(event.name) };
          continue;
        }
        if (suppressing && (event.type === "tool_call_delta" || event.type === "tool_call_end")) {
          if (event.type === "tool_call_end") suppressing = false;
          continue;
        }
        yield event;
      }
    },
    ...(parseResponse ? {
      async parseResponse(response: Response, budget: TranslatorBudget, tierMetadata?: AdapterTierMetadata) {
        return rewriteEvents(await parseResponse(response, budget, tierMetadata), responseRedirect);
      },
    } : {}),
  };
}
