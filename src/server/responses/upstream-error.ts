/**
 * Upstream connection failures share one message shape across the three catch sites in
 * core.ts. A TLS certificate/hostname mismatch deserves its own wording: the generic
 * "Provider unreachable" reads as if opencodex built a wrong endpoint, which sent issue
 * #553 looking for an adapter URL bug that does not exist. Name the likely cause and the
 * command that settles it.
 */
import { RequestPacingQueueOverloadError } from "../../providers/request-pacing";

export function describeUpstreamConnectFailure(err: unknown, connectMs: number): string {
  // Local pacing admission is not a transport failure. Let the outer response boundary
  // preserve its retryable 429 identity instead of laundering it into a 502.
  if (err instanceof RequestPacingQueueOverloadError) throw err;
  if (err instanceof Error && err.name === "TimeoutError") {
    return `Provider connect timeout after ${connectMs}ms`;
  }
  const detail = err instanceof Error ? err.message : String(err);
  const code = err instanceof Error ? (err as { code?: unknown }).code : undefined;
  // `code` is the reliable signal. The message fallback is anchored to the head because Bun
  // renders this rejection as `ERR_TLS_CERT_ALTNAME_INVALID fetching "<url>"`; matching the
  // bare substring anywhere would also fire on text that merely quotes the code back at us.
  // Only transport failures reach these call sites, so that is defensive rather than load-bearing.
  if (code === "ERR_TLS_CERT_ALTNAME_INVALID" || detail.startsWith("ERR_TLS_CERT_ALTNAME_INVALID")) {
    const host = extractHostname(detail);
    const target = host ?? "the provider host";
    const probe = host ?? "<host>";
    return `Provider TLS certificate does not match ${target}: ${redactUrlUserinfo(detail)}. `
      + "opencodex did not rewrite this hostname — a certificate that does not cover it normally "
      + "means TLS interception (corporate proxy, VPN, or local MITM tooling) or a poisoned DNS "
      + `answer. Check with: openssl s_client -connect ${probe}:443 -servername ${probe} `
      + "</dev/null | openssl x509 -noout -subject -ext subjectAltName";
  }
  return `Provider unreachable: ${redactUrlUserinfo(detail)}`;
}

/**
 * A provider base URL may carry credentials as userinfo (`https://user:token@host/`), and the
 * runtime error echoes the URL it was fetching. Strip it before the message reaches a client
 * or a log line.
 */
function redactUrlUserinfo(detail: string): string {
  return detail.replace(/(https?:\/\/)[^/\s"'@]*@/g, "$1<redacted>@");
}

function extractHostname(detail: string): string | null {
  const match = detail.match(/https?:\/\/([^/\s"']+)/);
  if (!match?.[1]) return null;
  try {
    return new URL(`https://${match[1]}`).hostname || null;
  } catch {
    return null;
  }
}
