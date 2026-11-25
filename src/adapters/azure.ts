import type { IncomingMeta, ProviderAdapter } from "./base";
import type { OcxParsedRequest, OcxProviderConfig } from "../types";
import { createResponsesPassthroughAdapter } from "./openai-responses";
import { isPlainObject } from "./openai-responses/internal";

/** Shared by wire construction and pre-dispatch spend admission. */
export function effectiveAzureOutputBudget(provider: OcxProviderConfig, budget: unknown): unknown {
  const floor = provider.minMaxOutputTokens;
  return (provider.adapter === "azure" || provider.adapter === "azure-openai")
    && typeof floor === "number" && Number.isInteger(floor) && floor > 0
    && typeof budget === "number" && Number.isInteger(budget) && budget > 0 && budget < floor
    ? floor : budget;
}

export function createAzureAdapter(provider: OcxProviderConfig): ProviderAdapter & { passthrough: true } {
  const inner = createResponsesPassthroughAdapter({
    ...provider,
    baseUrl: provider.baseUrl,
  });

  return {
    ...inner,
    name: "azure-openai",

    async buildRequest(parsed: OcxParsedRequest, incoming: IncomingMeta) {
      if (provider.authMode === "forward") {
        throw new Error("azure-openai does not support forward auth mode");
      }
      if (typeof provider.apiKey !== "string" || provider.apiKey.trim() === "") {
        throw new Error("azure-openai requires a non-empty apiKey");
      }

      // An operator may opt into a floor for deployments that reject tiny validation
      // budgets. Copy only the envelope; keep caller-owned input and normal serialization.
      const raw = parsed._rawBody;
      const budget = isPlainObject(raw) ? raw.max_output_tokens : undefined;
      const effectiveBudget = effectiveAzureOutputBudget(provider, budget);
      const effective = effectiveBudget !== budget && isPlainObject(raw)
        ? { ...parsed, _rawBody: { ...raw, max_output_tokens: effectiveBudget } }
        : parsed;
      const request = await inner.buildRequest(effective, incoming);
      const unresolvedPlaceholder = request.url.match(/\{[^}]*\}/)?.[0] ?? request.url.match(/[{}]/)?.[0];
      if (unresolvedPlaceholder) {
        throw new Error(`azure-openai baseUrl contains unresolved ${unresolvedPlaceholder} — set your real resource URL`);
      }

      const headers = { ...request.headers };
      headers["api-key"] = provider.apiKey;
      delete headers["Authorization"];
      // The inner adapter always targets Azure's v1 API here, which needs no api-version query.
      const body = JSON.parse(request.body);
      if (Array.isArray(body.input)) {
        body.input = body.input.map((item: unknown) => {
          if (!isPlainObject(item) || typeof item.call_id !== "string") return item;
          const hasPlaintext = (item.type === "custom_tool_call" && typeof item.input === "string")
            || (item.type === "function_call" && typeof item.arguments === "string");
          if (!hasPlaintext || !Object.hasOwn(item, "encrypted_content")) return item;
          const { encrypted_content: _encrypted, ...plaintextCall } = item;
          return plaintextCall;
        });
      }
      return { ...request, headers, body: JSON.stringify(body) };
    },
  };
}
