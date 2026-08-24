import { parseReplitPairInstallSuccess } from "../../../../src/providers/replit/pair-install-response";
export type { ReplitPairInstallSuccessResponse } from "../../../../src/providers/replit/pair-install-response";
export { parseReplitPairInstallSuccess } from "../../../../src/providers/replit/pair-install-response";

export type ReplitPairProbeSuccess = import("../../../../src/providers/replit/pair-install-response").ReplitPairInstallSuccessResponse["probe"];

export interface ReplitPairRequest {
  origin: string;
  gatewayKey: string;
  allowCustomDomain?: boolean;
  replace?: boolean;
  setDefault?: boolean;
}

export type ReplitPairSuccessResponse = import("../../../../src/providers/replit/pair-install-response").ReplitPairInstallSuccessResponse;

export type ReplitPairFailureResponse = {
  success?: false;
  error: string;
  code?: string;
  collisions?: string[];
  probe?: unknown;
};

export type ReplitPairResponse = ReplitPairSuccessResponse | ReplitPairFailureResponse;

export type ReplitPairInstallFailureKind = "http" | "network" | "malformed" | "aborted";

export const REPLIT_PAIR_INSTALL_TIMEOUT_MS = 30_000;

function mergeSignals(signals: AbortSignal[]): AbortSignal {
  if (signals.length === 0) return new AbortController().signal;
  if (signals.length === 1) return signals[0]!;
  const merged = new AbortController();
  const abort = () => merged.abort();
  for (const signal of signals) {
    if (signal.aborted) {
      abort();
      break;
    }
    signal.addEventListener("abort", abort, { once: true });
  }
  return merged.signal;
}

export async function installReplitGatewayPair(
  apiBase: string,
  body: ReplitPairRequest,
  options: {
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {},
): Promise<
  | { ok: true; data: ReplitPairSuccessResponse }
  | { ok: false; status: number; kind: ReplitPairInstallFailureKind; data: ReplitPairFailureResponse }
> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? REPLIT_PAIR_INSTALL_TIMEOUT_MS;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = options.signal
    ? mergeSignals([options.signal, timeout])
    : timeout;

  let response: Response;
  try {
    response = await fetchImpl(`${apiBase}/api/providers/replit-pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch {
    if (signal.aborted && options.signal?.aborted) {
      return {
        ok: false,
        status: 0,
        kind: "aborted",
        data: { error: "request aborted" },
      };
    }
    return {
      ok: false,
      status: 0,
      kind: "network",
      data: { error: "network request failed" },
    };
  }

  const text = await response.text();
  let data: ReplitPairResponse;
  try {
    data = text ? JSON.parse(text) as ReplitPairResponse : { error: "empty response" };
  } catch {
    return {
      ok: false,
      status: response.status,
      kind: "malformed",
      data: { error: "invalid response" },
    };
  }

  if (!response.ok || !("success" in data) || data.success !== true) {
    return {
      ok: false,
      status: response.status,
      kind: "http",
      data: data as ReplitPairFailureResponse,
    };
  }

  const parsed = parseReplitPairInstallSuccess(data);
  if (!parsed) {
    return {
      ok: false,
      status: response.status,
      kind: "malformed",
      data: { error: "invalid response" },
    };
  }
  return { ok: true, data: parsed };
}
