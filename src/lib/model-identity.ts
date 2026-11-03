import { redactSecretString } from "./redact";
import { pinnedNativeModelRows } from "../codex/catalog/pinned-models";
import { getModelMetadata, resolveMetadataProvider } from "../generated/model-metadata";

/** Longest model identity a row or relayed header may carry. */
export const MAX_MODEL_IDENTITY_LENGTH = 128;

/**
 * A model identity (served, resolved, or a relayed model header) is an identifier, never free-form
 * text to truncate into one: `[A-Za-z0-9._:/@-]`, at most 128 characters. A value the secret redactor
 * would change is dropped, because credential-shaped text can fit the identifier alphabet.
 */
export function boundedModelIdentity(value: unknown): string | undefined {
  return typeof value === "string"
    && value.length <= MAX_MODEL_IDENTITY_LENGTH
    && /^[A-Za-z0-9._:/@-]+$/.test(value)
    && redactSecretString(value) === value
    ? value
    : undefined;
}

/** Model ids this build pins for the Codex catalog; a known id a route can be served without config. */
const PINNED_MODEL_IDS: ReadonlyMap<string, string> = new Map(
  pinnedNativeModelRows().flatMap(row => typeof row.slug === "string" ? [[row.slug, row.slug] as [string, string]] : []),
);

/**
 * An upstream-reported model string is kept only when it exactly equals a model id this proxy
 * already knows: one of `known` (the requested model, the routed target, the wire model, a
 * configured target), a model the bundled Codex catalog pins, or a model in the bundled metadata
 * catalog for `provider` (the selected provider). The identity grammar still applies first. What is
 * returned is the proxy's own copy of the matched id; anything else is undefined, because no grammar
 * can tell a prefixless credential from a model name.
 */
export function knownModelIdentity(value: unknown, known: Iterable<unknown> = [], provider?: string): string | undefined {
  const bounded = boundedModelIdentity(value);
  if (bounded === undefined) return undefined;
  for (const candidate of known) {
    if (typeof candidate === "string" && candidate === bounded) return candidate;
  }
  const pinned = PINNED_MODEL_IDS.get(bounded);
  if (pinned !== undefined || !provider) return pinned;
  return getModelMetadata(resolveMetadataProvider(provider) ?? provider, bounded)?.id;
}
