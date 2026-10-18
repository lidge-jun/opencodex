import { defineCompatibilityManifest } from "./manifest";

const FIXTURE_ID = "opengateway-key-glm53-responses-v1";

/**
 * A routed Responses subject whose destination rejects native custom tools, so OpenCodex lowers
 * them to functions before dispatch. The claims describe that local wire transformation only;
 * they do not certify how the upstream model treats the lowered declaration.
 */
export const OPENGATEWAY_KEY_GLM53_RESPONSES_MANIFEST = defineCompatibilityManifest({
  schemaVersion: 1,
  id: "opengateway.key.glm-5-3-flash-ultrafast.responses",
  version: "1.0.0",
  subject: {
    providerId: "opengateway",
    baseUrl: "https://apis.opengateway.ai/v1",
    adapterId: "openai-responses",
    authMode: "key",
    inboundProtocol: "responses",
    upstreamProtocol: "openai-responses",
    modelIds: ["z-ai/glm-5.3-flash-ultrafast"],
  },
  claims: [
    {
      id: "custom-tools",
      feature: "request.custom_tools",
      disposition: "translated",
      summary: "Custom tool declarations are sent as functions that take one raw string input.",
      limitation: "The destination rejects native custom tools, so each declaration is lowered to a function with a single required string parameter named input.",
      evidence: [{ kind: "fixture", id: FIXTURE_ID, assertionIds: ["custom-tool-lowered-to-function"] }],
    },
    {
      id: "custom-tool-grammar",
      feature: "request.custom_tools.grammar",
      disposition: "degraded",
      summary: "The tool and its description survive, but its grammar does not reach the destination.",
      limitation: "The format, including any grammar definition, is removed during lowering, so the upstream model is not constrained by it; only the string input type remains.",
      evidence: [{
        kind: "fixture",
        id: FIXTURE_ID,
        assertionIds: ["custom-tool-grammar-removed", "custom-tool-lowered-to-function"],
      }],
    },
    {
      id: "custom-tool-call-history",
      feature: "continuation.custom_tool_call",
      disposition: "translated",
      summary: "Replayed custom tool calls are sent as function calls with the same call_id and name.",
      limitation: "The raw input is wrapped as the JSON arguments object {\"input\": <raw input>}.",
      evidence: [{ kind: "fixture", id: FIXTURE_ID, assertionIds: ["custom-tool-call-lowered"] }],
    },
    {
      id: "custom-tool-output-history",
      feature: "continuation.custom_tool_call_output",
      disposition: "translated",
      summary: "Replayed custom tool outputs are sent as function call outputs with the same call_id and output.",
      limitation: "Only the item type changes from custom_tool_call_output to function_call_output.",
      evidence: [{ kind: "fixture", id: FIXTURE_ID, assertionIds: ["custom-tool-output-lowered"] }],
    },
  ],
} as const);
