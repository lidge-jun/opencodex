import type { OcxConfig, OcxParsedRequest, OcxProviderConfig } from "../types";

export type DeepReadonly<T> = T extends object
  ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
  : T;

export interface RequestTransformContext {
  /** The settled provider name (e.g. "anthropic", "google-antigravity", "openai"). */
  readonly providerName: string;
  /** The settled model identifier. */
  readonly modelId: string;
  /** Effective provider configuration for this route. */
  readonly providerConfig: DeepReadonly<OcxProviderConfig>;
  /** Global OpenCodeX configuration. */
  readonly config: DeepReadonly<OcxConfig>;
  /**
   * Whether the target model accepts image input (based on OpenCodeX's vision catalog & metadata).
   * Allows transforms like pxpipe to selectively convert long text blocks into images only for vision-capable models.
   */
  readonly acceptsImageInput: boolean;
}

export type RequestTransformFn = (
  parsed: OcxParsedRequest,
  context: RequestTransformContext,
) => OcxParsedRequest | Promise<OcxParsedRequest> | void | Promise<void>;

export interface RequestTransformModule {
  default?: RequestTransformFn;
  transform?: RequestTransformFn;
}
