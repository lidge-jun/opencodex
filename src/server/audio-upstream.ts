import { formatErrorResponse } from "../bridge";
import {
  CodexAccountCooldownError,
  CodexMainProfileDrainingError,
  codexMainProfileDrainingResponse,
  cooldownErrorResponse,
  isCodexAuthContextUsable,
  materializeCodexUpstreamAuth,
  releaseCodexAuthContextProbeLease,
  resolveCodexAuthContext,
  type CodexAuthContext,
} from "../codex/auth-context";
import { formatCodexProviderForLog } from "../codex/routing";
import type { AdmissionLease } from "../lib/admission";
import { captureExplicitOpenAiCallerAuth, resolveFirstUsableOpenAiSidecar, selectOpenAiImagesProvider } from "../providers/openai-sidecar";
import type { OcxConfig } from "../types";
import {
  isProxyAdmissionSecret,
  resolveDataPlaneAdmissionSecret,
  validateForwardAdmissionCredential,
  type DataPlaneAdmission,
} from "./auth-cors";
import { codexAccountSelectionForTurn } from "./lifecycle";
import type { RequestLogContext } from "./request-log";

export const TRANSCRIPTION_MODEL = "gpt-4o-transcribe";
export const LIVE_AUDIO_MODEL = "gpt-live-1-codex";

/** Audio keys remain identifiable even on the otherwise unauthenticated local listener. */
export function resolveAudioAdmission(headers: Headers, config: OcxConfig): DataPlaneAdmission | null {
  const dedicated = headers.get("x-opencodex-api-key")?.trim();
  if (dedicated) return resolveDataPlaneAdmissionSecret(dedicated, config, "dedicated");
  const authorization = headers.get("authorization")?.trim();
  if (authorization) {
    const token = /^Bearer\s+([^\s,]+)$/i.exec(authorization)?.[1];
    return token ? resolveDataPlaneAdmissionSecret(token, config, "bearer") : null;
  }
  const key = headers.get("x-api-key")?.trim();
  return key ? resolveDataPlaneAdmissionSecret(key, config, "x-api-key") : null;
}

export interface AudioUpstream {
  providerName: string;
  providerBaseUrl: string;
  headers: Record<string, string>;
  keyed: boolean;
  authContext?: CodexAuthContext;
  recordOutcome?: (status: number | "timeout" | "connect_error") => void;
  release: () => void;
}

export interface AudioUpstreamOptions {
  admission: DataPlaneAdmission;
  model: string;
  lease?: AdmissionLease;
  exactAccountId?: string;
  providerName?: string;
  signal?: AbortSignal;
}

/** Keep client admission, account selection, and outbound credentials as separate values. */
export async function resolveAudioUpstream(
  incoming: Headers,
  config: OcxConfig,
  log: RequestLogContext,
  options: AudioUpstreamOptions,
): Promise<AudioUpstream | Response> {
  const candidates = selectOpenAiImagesProvider(config);
  if (options.providerName) {
    candidates.forwardCandidates = candidates.forwardCandidates.filter(candidate => candidate.providerName === options.providerName);
    if (candidates.keyed?.providerName !== options.providerName) delete candidates.keyed;
  }
  const headers = new Headers(incoming);
  const bearer = headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  if (bearer && isProxyAdmissionSecret(bearer, config)) {
    headers.delete("authorization");
    headers.delete("chatgpt-account-id");
  }
  headers.delete("x-opencodex-api-key");
  headers.delete("x-api-key");
  headers.delete("sec-websocket-protocol");
  let context: CodexAuthContext | undefined;
  try {
    options.signal?.throwIfAborted();
    const candidate = candidates.forwardCandidates[0];
    if (candidate) {
      let selected: Headers;
      let recordOutcome: AudioUpstream["recordOutcome"];
      const beginCodexAccountSelection = codexAccountSelectionForTurn(options.lease);
      if (candidate.accountMode === "direct" && options.exactAccountId === undefined
        && !captureExplicitOpenAiCallerAuth(incoming, config)) {
        context = await resolveCodexAuthContext(headers, config, "direct", {
          admission: options.admission,
          substituteMainCredentialForDirect: true,
          beginCodexAccountSelection,
          signal: options.signal,
        });
        options.signal?.throwIfAborted();
        selected = materializeCodexUpstreamAuth(headers, context, {
          config,
          admission: options.admission,
          substituteMainCredential: true,
        });
      } else {
        const resolved = await resolveFirstUsableOpenAiSidecar(candidates.forwardCandidates, headers, config, {
          admission: options.admission,
          beginCodexAccountSelection,
          signal: options.signal,
          ...(options.exactAccountId ? { exactAccount: { accountId: options.exactAccountId, modelId: options.model } } : {}),
        });
        if (!resolved) return formatErrorResponse(401, "authentication_error", "Connect a ChatGPT account to use audio");
        context = resolved.authContext;
        selected = resolved.headers;
        recordOutcome = resolved.recordOutcome;
      }
      options.signal?.throwIfAborted();
      if (!isCodexAuthContextUsable(context, config)) {
        releaseCodexAuthContextProbeLease(context);
        return formatErrorResponse(401, "authentication_error", "Selected audio account is unavailable");
      }
      validateForwardAdmissionCredential(selected, config);
      log.provider = formatCodexProviderForLog(candidate.providerName, context.accountId, config);
      log.model = options.model;
      return {
        providerName: candidate.providerName,
        providerBaseUrl: candidate.provider.baseUrl,
        headers: Object.fromEntries(selected),
        keyed: false,
        authContext: context,
        recordOutcome,
        release: () => releaseCodexAuthContextProbeLease(context),
      };
    }
    if (candidates.keyed && options.exactAccountId === undefined) {
      const { providerName, provider, apiKey } = candidates.keyed;
      const selected = new Headers(provider.headers);
      selected.set("authorization", `Bearer ${apiKey}`);
      validateForwardAdmissionCredential(selected, config);
      log.provider = providerName;
      log.model = options.model;
      return {
        providerName, providerBaseUrl: provider.baseUrl, headers: Object.fromEntries(selected),
        keyed: true, release: () => {},
      };
    }
    return formatErrorResponse(400, "invalid_request_error", "Audio requires a connected ChatGPT account or OpenAI API provider");
  } catch (error) {
    releaseCodexAuthContextProbeLease(context);
    if (error instanceof CodexAccountCooldownError) return cooldownErrorResponse(error);
    if (error instanceof CodexMainProfileDrainingError) return codexMainProfileDrainingResponse();
    return formatErrorResponse(401, "authentication_error", "Audio account authentication unavailable; reconnect the selected OpenAI account");
  }
}
