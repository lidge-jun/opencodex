/**
 * Live voice (realtime speech conversation) backend selection.
 *
 * The decision itself — reserved name / custom provider / rejection — lives in `voice-target.ts`
 * alongside the dictation, transcription and speech routes, which make the identical decision
 * about different provider fields. This module is the live-voice-shaped face of it, so the CLI,
 * the management route and `src/server/audio-live.ts` keep importing one name each.
 *
 * `configSchema` is `.passthrough()`, like `dictation`, so a malformed `liveVoice` value is
 * accepted at load and only the write boundaries (CLI `config set/import`, management
 * `PUT /api/live-voice-settings`) can refuse it.
 */
import type { OcxProviderConfig } from "../types";
import {
  resolveVoiceHeaders,
  resolveVoiceTarget,
  voiceConfigValueError,
  voiceProviderEndpointError,
  type VoiceTargetResolution,
} from "./voice-target";

export const LIVE_VOICE_OPENAI_TARGET = "openai";

export type LiveVoiceTargetResolution = VoiceTargetResolution;

/** Resolve one live voice target name against the configured providers. */
export function resolveLiveVoiceTarget(
  providers: Record<string, OcxProviderConfig> | undefined,
  target: string | undefined,
): LiveVoiceTargetResolution {
  return resolveVoiceTarget(providers, target, "live");
}

/** A custom target must actually carry a usable live voice endpoint. */
export function liveVoiceProviderEndpointError(providerName: string, provider: OcxProviderConfig): string | null {
  return voiceProviderEndpointError(providerName, provider, "live");
}

/** Resolve `${ENV_VAR}` references in configured handshake headers; drop unresolvable ones. */
export function resolveLiveVoiceHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  return resolveVoiceHeaders(headers);
}

/** Validate one `liveVoice` value against the providers it may reference. */
export function liveVoiceConfigValueError(
  value: unknown,
  providers?: Record<string, OcxProviderConfig>,
): string | null {
  return voiceConfigValueError(value, providers, "live");
}

/** Whole-config wrapper mirroring `dictationConfigError` in the CLI config command. */
export function liveVoiceConfigError(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const config = value as Record<string, unknown>;
  return liveVoiceConfigValueError(config.liveVoice, config.providers as Record<string, OcxProviderConfig> | undefined);
}
