import { defineCompatibilityManifest } from "./manifest";

const FIXTURE_ID = "openai-codex-forward-gpt56-sol-v1";

/**
 * First deliberately narrow compatibility slice: one exact native Codex-login model.
 * Broader model/provider claims require their own fixtures instead of inheriting this row.
 */
export const OPENAI_CODEX_FORWARD_GPT56_SOL_MANIFEST = defineCompatibilityManifest({
  schemaVersion: 1,
  id: "openai.codex-forward.gpt-5-6-sol.responses",
  version: "1.0.0",
  subject: {
    providerId: "openai",
    adapterId: "openai-responses",
    authMode: "forward",
    inboundProtocol: "responses",
    upstreamProtocol: "openai-responses",
    modelIds: ["gpt-5.6-sol"],
  },
  claims: [
    {
      id: "custom-tools",
      feature: "request.custom_tools",
      disposition: "passthrough",
      summary: "Native custom-tool declarations retain their Responses representation.",
      evidence: [{ kind: "fixture", id: FIXTURE_ID, assertionIds: ["custom-tool-preserved"] }],
    },
    {
      id: "prompt-cache-key",
      feature: "request.prompt_cache_key",
      disposition: "passthrough",
      summary: "The caller's prompt cache key is forwarded unchanged.",
      evidence: [{ kind: "fixture", id: FIXTURE_ID, assertionIds: ["prompt-cache-key-preserved"] }],
    },
    {
      id: "previous-response-id",
      feature: "request.previous_response_id",
      disposition: "translated",
      summary: "Continuation is owned by the proxy rather than the ChatGPT backend field.",
      limitation: "OpenCodex expands remembered input locally and removes previous_response_id before dispatch.",
      evidence: [
        { kind: "fixture", id: FIXTURE_ID, assertionIds: ["previous-response-id-removed"] },
        { kind: "lab-scenario", id: "codex-core.protocol.previous-response-replay" },
      ],
    },
    {
      id: "orphan-tool-output",
      feature: "continuation.orphan_tool_output",
      disposition: "degraded",
      summary: "An output whose prior call is unavailable remains visible to the model.",
      limitation: "The orphan output is converted to user text because the forward backend cannot accept the unmatched item.",
      evidence: [{ kind: "fixture", id: FIXTURE_ID, assertionIds: ["orphan-output-converted"] }],
    },
    {
      id: "max-output-tokens",
      feature: "request.max_output_tokens",
      disposition: "unsupported",
      summary: "The ChatGPT Codex forward route does not receive max_output_tokens.",
      limitation: "The field is removed before dispatch to avoid a backend parameter rejection.",
      evidence: [{ kind: "fixture", id: FIXTURE_ID, assertionIds: ["max-output-tokens-removed"] }],
    },
    {
      id: "metadata",
      feature: "request.metadata",
      disposition: "unsupported",
      summary: "Caller metadata is not forwarded to the ChatGPT Codex backend.",
      limitation: "The field is removed before dispatch.",
      evidence: [{ kind: "fixture", id: FIXTURE_ID, assertionIds: ["metadata-removed"] }],
    },
    {
      id: "prompt-cache-retention",
      feature: "request.prompt_cache_retention",
      disposition: "unsupported",
      summary: "The retired retention field is not sent for gpt-5.6-sol.",
      limitation: "The field is removed without inventing a replacement prompt_cache_options value.",
      evidence: [{ kind: "fixture", id: FIXTURE_ID, assertionIds: ["prompt-cache-retention-removed"] }],
    },
  ],
} as const);
