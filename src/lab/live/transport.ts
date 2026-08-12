import type { FailureClassification } from "../conformance/types";
import { assertLeaseScope, LabCredentialError } from "./credential-lease";
import type {
  LabCredentialLeaseV1, LabDestinationV1, LabPinnedSender, LabTransport, LabTransportRequest,
  LabTransportResponse, LiveRunConfig, TransportErrorCode,
} from "./types";

export interface MockTransportEntry {
  matchPath?: string | RegExp;
  status: number;
  headers?: Record<string, string>;
  body: string;
  error?: TransportErrorCode;
}
export interface MockTransportOptions { entries?: MockTransportEntry[]; onRequest?: (req: LabTransportRequest) => void }

/** Test seam only. No live runner path creates this implicitly. */
export function createMockTransport(opts: MockTransportOptions = {}): LabTransport {
  let callIndex = 0;
  return {
    async request(req): Promise<LabTransportResponse> {
      opts.onRequest?.(req);
      const entry = opts.entries?.[callIndex] ?? opts.entries?.[opts.entries.length - 1];
      callIndex += 1;
      if (!entry) throw new TransportError("harness_failure", "no mock transport entry");
      if (entry.error) throw new TransportError(entry.error, entry.error);
      if (entry.matchPath) {
        const ok = typeof entry.matchPath === "string" ? req.path.includes(entry.matchPath) : entry.matchPath.test(req.path);
        if (!ok) throw new TransportError("harness_failure", "mock path mismatch");
      }
      if (entry.status >= 300 && entry.status < 400) throw new TransportError("redirect_blocked", "redirect response");
      return { status: entry.status, headers: { "content-type": "application/json", ...(entry.headers ?? {}) }, body: entry.body };
    },
  };
}

export interface PinnedTransportOptions {
  destination: LabDestinationV1;
  lease: LabCredentialLeaseV1;
  sender: LabPinnedSender;
  limits: LiveRunConfig;
  transportId?: string;
}

function assertRelativeRequestPath(path: string): void {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("://") || /[\r\n]/.test(path)) {
    throw new TransportError("harness_failure", "request path attempted to widen destination");
  }
}

function selectedPinnedAddress(destination: LabDestinationV1): { address: string; family: 4 | 6 } {
  const row = destination.addresses.find((a) => a.family === 4) ?? destination.addresses[0];
  if (!row) throw new TransportError("harness_failure", "approved destination has no address");
  return { address: row.address, family: row.family };
}

/** Uses only the frozen approved address set. Secret injection is owned by the trusted sender, outside Lab. */
export function createPinnedTransport(opts: PinnedTransportOptions): LabTransport {
  const transportId = opts.transportId ?? "default";
  return {
    async request(req): Promise<LabTransportResponse> {
      assertRelativeRequestPath(req.path);
      assertLeaseScope(opts.lease, opts.destination, transportId);
      const inputBytes = new TextEncoder().encode(req.body ?? "").byteLength;
      if (inputBytes > opts.limits.maxInputBytes) throw new TransportError("input_byte_limit", "request exceeds input byte budget");
      opts.lease.consume();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new TransportError("total_timeout", "live request total timeout")), opts.limits.totalTimeoutMs);
      const onAbort = () => controller.abort(req.signal?.reason);
      req.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const response = await opts.sender(opts.lease, opts.destination, selectedPinnedAddress(opts.destination), req, controller.signal, opts.limits);
        const outputBytes = new TextEncoder().encode(response.body).byteLength;
        if (outputBytes > opts.limits.maxOutputBytes) throw new TransportError("output_byte_limit", "response exceeds output byte budget");
        if (response.status >= 300 && response.status < 400) throw new TransportError("redirect_blocked", "redirect response");
        if (response.status === 401 || response.status === 403) throw new TransportError("auth_blocked", `HTTP ${response.status}`);
        if (response.status === 429) throw new TransportError("quota_blocked", "HTTP 429");
        if (response.status === 451) throw new TransportError("region_blocked", "HTTP 451");
        if (response.status >= 500) throw new TransportError("provider_transient", `HTTP ${response.status}`);
        return response;
      } catch (error) {
        if (error instanceof LabCredentialError) {
          throw new TransportError(error.code === "budget_exhausted" ? "request_limit" : "harness_failure", error.message);
        }
        throw error;
      } finally {
        clearTimeout(timer);
        req.signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}

export class TransportError extends Error {
  override readonly name = "TransportError";
  constructor(readonly code: TransportErrorCode, message: string) { super(message); }
}

export function classifyTransportError(error: unknown): { classification: FailureClassification; secondaryCode: string } {
  const code = error instanceof TransportError ? error.code : undefined;
  switch (code) {
    case "auth_blocked": return { classification: "authentication_blocked", secondaryCode: code };
    case "quota_blocked": return { classification: "quota_blocked", secondaryCode: code };
    case "network_blocked": return { classification: "network_failure", secondaryCode: code };
    case "region_blocked": return { classification: "region_blocked", secondaryCode: code };
    case "provider_transient": return { classification: "provider_transient", secondaryCode: code };
    case "connect_timeout": case "first_byte_timeout": case "total_timeout":
      return { classification: "timeout", secondaryCode: code };
    case "inactivity_timeout":
      return { classification: "inactivity_timeout", secondaryCode: code };
    case "request_limit": case "input_byte_limit": case "output_byte_limit": case "output_token_limit":
    case "tool_call_limit": case "artifact_byte_limit": case "memory_limit": case "child_process_limit":
      return { classification: "budget_exhausted", secondaryCode: code };
    case "live_transport_required": case "untrusted_route_executor": case "redirect_blocked": case "destination_mismatch": case "host_sni_mismatch": case "harness_failure":
      return { classification: "harness_failure", secondaryCode: code };
    default: return { classification: "harness_failure", secondaryCode: "execution_error" };
  }
}
