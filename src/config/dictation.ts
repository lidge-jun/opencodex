/**
 * Dictation backend selection.
 *
 * The decision itself — reserved name / custom provider / rejection — lives in `voice-target.ts`
 * alongside the transcription and speech routes, which make the identical decision about
 * different provider fields. This module is the dictation-shaped face of it, so the CLI, the
 * management route and `src/server/audio-dictation.ts` keep importing one name each.
 *
 * `configSchema` is `.passthrough()`, like `images` and `visionSidecar`, so a malformed
 * `dictation` value is accepted at load and only the write boundaries (CLI `config set/import`,
 * management `PUT /api/dictation-settings`) can refuse it.
 */
import type { OcxProviderConfig } from "../types";
import {
  resolveVoiceHeaders,
  resolveVoiceTarget,
  voiceConfigValueError,
  voiceProviderEndpointError,
  type VoiceTargetResolution,
} from "./voice-target";

export const DICTATION_OPENAI_TARGET = "openai";

export type DictationTargetResolution = VoiceTargetResolution;

/** Resolve one dictation target name against the configured providers. */
export function resolveDictationTarget(
  providers: Record<string, OcxProviderConfig> | undefined,
  target: string | undefined,
): DictationTargetResolution {
  return resolveVoiceTarget(providers, target, "dictation");
}

/** A custom target must actually carry a usable dictation endpoint. */
export function dictationProviderEndpointError(providerName: string, provider: OcxProviderConfig): string | null {
  return voiceProviderEndpointError(providerName, provider, "dictation");
}

/** Resolve `${ENV_VAR}` references in configured handshake headers; drop unresolvable ones. */
export function resolveDictationHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  return resolveVoiceHeaders(headers);
}

/** Validate one `dictation` value against the providers it may reference. */
export function dictationConfigValueError(
  value: unknown,
  providers?: Record<string, OcxProviderConfig>,
): string | null {
  return voiceConfigValueError(value, providers, "dictation");
}

/** Whole-config wrapper mirroring `visionReasoningError` in the CLI config command. */
export function dictationConfigError(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const config = value as Record<string, unknown>;
  return dictationConfigValueError(config.dictation, config.providers as Record<string, OcxProviderConfig> | undefined);
}
