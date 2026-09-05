import type { OcxConfig, OcxParsedRequest, OcxProviderConfig } from "../types";

export interface RequestTransformContext {
  /** The settled provider name (e.g. "anthropic", "google-antigravity", "openai"). */
  providerName: string;
  /** The settled model identifier. */
  modelId: string;
  /** Effective provider configuration for this route. */
  providerConfig: OcxProviderConfig;
  /** Global OpenCodeX configuration. */
  config: OcxConfig;
  /**
   * Whether the target model accepts image input (based on OpenCodeX's vision catalog & metadata).
   * Allows transforms like pxpipe to selectively convert long text blocks into images only for vision-capable models.
   */
  acceptsImageInput: boolean;
}

export type RequestTransformFn = (
  parsed: OcxParsedRequest,
  context: RequestTransformContext,
) => OcxParsedRequest | Promise<OcxParsedRequest> | void | Promise<void>;

export interface RequestTransformModule {
  default?: RequestTransformFn;
  transform?: RequestTransformFn;
}

