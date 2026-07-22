import { randomUUID } from "node:crypto";
import { CLOUDFLARE_TUNNEL_ORIGIN_HOST, normalizeNamedPublicUrl } from "./cloudflare-tunnel";

const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";
const CLOUDFLARE_ID_PATTERN = /^[a-f0-9]{32}$/i;
const TUNNEL_NAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,98}[A-Za-z0-9])?$/;

export interface CloudflareProvisionInput {
  apiToken: string;
  accountId: string;
  zoneId: string;
  hostname: string;
  tunnelName?: string;
}

export interface CloudflareProvisionResult {
  publicUrl: string;
  tunnelToken: string;
  tunnelId: string;
  dnsRecordId: string;
}

export interface CloudflareProvisionDeps {
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

interface CloudflareEnvelope<T> {
  success?: boolean;
  result?: T;
  errors?: Array<{ message?: unknown }>;
}

export class CloudflareProvisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloudflareProvisionError";
  }
}

function safeCloudflareError(value: unknown, apiToken: string): string {
  if (typeof value !== "string") return "Cloudflare API request failed.";
  const sanitized = value
    .replaceAll(apiToken, "[redacted]")
    .replace(/[\r\n\0]/g, " ")
    .trim()
    .slice(0, 240);
  return sanitized || "Cloudflare API request failed.";
}

function normalizeApiToken(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const token = value.trim();
  return token.length >= 20 && token.length <= 4_096 && !/[\s\r\n]/.test(token) ? token : null;
}

export function validateCloudflareProvisionInput(input: CloudflareProvisionInput): {
  apiToken: string;
  accountId: string;
  zoneId: string;
  hostname: string;
  publicUrl: string;
  tunnelName: string;
} {
  const apiToken = normalizeApiToken(input.apiToken);
  const accountId = input.accountId?.trim();
  const zoneId = input.zoneId?.trim();
  const rawHostname = input.hostname?.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  const publicUrl = normalizeNamedPublicUrl(rawHostname ? `https://${rawHostname}` : undefined);
  if (!apiToken) throw new CloudflareProvisionError("A valid Cloudflare API token is required.");
  if (!CLOUDFLARE_ID_PATTERN.test(accountId)) throw new CloudflareProvisionError("Cloudflare account ID must be 32 hexadecimal characters.");
  if (!CLOUDFLARE_ID_PATTERN.test(zoneId)) throw new CloudflareProvisionError("Cloudflare zone ID must be 32 hexadecimal characters.");
  if (!publicUrl) throw new CloudflareProvisionError("Hostname must be a valid public DNS hostname.");
  const hostname = new URL(publicUrl).hostname;
  const requestedName = input.tunnelName?.trim();
  const suffix = randomUUID().replace(/-/g, "").slice(0, 8);
  const generatedName = `opencodex-${hostname.replace(/[^A-Za-z0-9]+/g, "-").slice(0, 70)}-${suffix}`;
  const tunnelName = requestedName || generatedName;
  if (!TUNNEL_NAME_PATTERN.test(tunnelName)) {
    throw new CloudflareProvisionError("Tunnel name must use letters, numbers, hyphens, or underscores.");
  }
  return { apiToken, accountId, zoneId, hostname, publicUrl, tunnelName };
}

async function cloudflareRequest<T>(
  path: string,
  apiToken: string,
  init: RequestInit,
  deps: Required<Pick<CloudflareProvisionDeps, "fetchFn" | "timeoutMs">>,
): Promise<T> {
  let response: Response;
  try {
    response = await deps.fetchFn(`${CLOUDFLARE_API_BASE}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiToken}`,
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(deps.timeoutMs),
    });
  } catch {
    throw new CloudflareProvisionError("Could not reach the Cloudflare API.");
  }
  let envelope: CloudflareEnvelope<T> | null = null;
  try {
    envelope = await response.json() as CloudflareEnvelope<T>;
  } catch {
    // Preserve a bounded generic error; Cloudflare may return an intermediary HTML page.
  }
  if (!response.ok || envelope?.success !== true || envelope.result === undefined) {
    throw new CloudflareProvisionError(safeCloudflareError(envelope?.errors?.[0]?.message, apiToken));
  }
  return envelope.result;
}

async function bestEffortDelete(
  path: string,
  apiToken: string,
  deps: Required<Pick<CloudflareProvisionDeps, "fetchFn" | "timeoutMs">>,
): Promise<void> {
  try {
    await deps.fetchFn(`${CLOUDFLARE_API_BASE}${path}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${apiToken}` },
      signal: AbortSignal.timeout(deps.timeoutMs),
    });
  } catch {
    // The original setup error is more useful. Cloudflare resources can be removed in the dashboard.
  }
}

export async function cleanupProvisionedCloudflareTunnel(
  input: Pick<CloudflareProvisionInput, "apiToken" | "accountId" | "zoneId">,
  result: Pick<CloudflareProvisionResult, "tunnelId" | "dnsRecordId">,
  options: CloudflareProvisionDeps = {},
): Promise<void> {
  const deps = {
    fetchFn: options.fetchFn ?? fetch,
    timeoutMs: options.timeoutMs ?? 15_000,
  };
  await bestEffortDelete(`/zones/${input.zoneId}/dns_records/${result.dnsRecordId}`, input.apiToken, deps);
  await bestEffortDelete(`/accounts/${input.accountId}/cfd_tunnel/${result.tunnelId}`, input.apiToken, deps);
}

export async function provisionCloudflareNamedTunnel(
  input: CloudflareProvisionInput,
  originUrl: string,
  options: CloudflareProvisionDeps = {},
): Promise<CloudflareProvisionResult> {
  const normalized = validateCloudflareProvisionInput(input);
  const deps = {
    fetchFn: options.fetchFn ?? fetch,
    timeoutMs: options.timeoutMs ?? 15_000,
  };
  let tunnelId: string | null = null;
  let dnsRecordId: string | null = null;
  try {
    const tunnel = await cloudflareRequest<{ id?: unknown }>(
      `/accounts/${normalized.accountId}/cfd_tunnel`,
      normalized.apiToken,
      { method: "POST", body: JSON.stringify({ name: normalized.tunnelName, config_src: "cloudflare" }) },
      deps,
    );
    if (typeof tunnel.id !== "string" || !/^[a-f0-9-]{36}$/i.test(tunnel.id)) {
      throw new CloudflareProvisionError("Cloudflare returned an invalid tunnel identifier.");
    }
    tunnelId = tunnel.id;

    await cloudflareRequest<unknown>(
      `/accounts/${normalized.accountId}/cfd_tunnel/${tunnelId}/configurations`,
      normalized.apiToken,
      {
        method: "PUT",
        body: JSON.stringify({
          config: {
            ingress: [
              {
                hostname: normalized.hostname,
                service: originUrl,
                originRequest: { httpHostHeader: CLOUDFLARE_TUNNEL_ORIGIN_HOST },
              },
              { service: "http_status:404" },
            ],
          },
        }),
      },
      deps,
    );

    const dns = await cloudflareRequest<{ id?: unknown }>(
      `/zones/${normalized.zoneId}/dns_records`,
      normalized.apiToken,
      {
        method: "POST",
        body: JSON.stringify({
          type: "CNAME",
          proxied: true,
          name: normalized.hostname,
          content: `${tunnelId}.cfargotunnel.com`,
        }),
      },
      deps,
    );
    if (typeof dns.id !== "string" || !CLOUDFLARE_ID_PATTERN.test(dns.id)) {
      throw new CloudflareProvisionError("Cloudflare returned an invalid DNS record identifier.");
    }
    dnsRecordId = dns.id;

    const tunnelToken = await cloudflareRequest<unknown>(
      `/accounts/${normalized.accountId}/cfd_tunnel/${tunnelId}/token`,
      normalized.apiToken,
      { method: "GET" },
      deps,
    );
    if (typeof tunnelToken !== "string" || !tunnelToken.startsWith("eyJ")) {
      throw new CloudflareProvisionError("Cloudflare returned an invalid Tunnel token.");
    }
    return {
      publicUrl: normalized.publicUrl,
      tunnelToken,
      tunnelId,
      dnsRecordId,
    };
  } catch (error) {
    if (dnsRecordId) await bestEffortDelete(`/zones/${normalized.zoneId}/dns_records/${dnsRecordId}`, normalized.apiToken, deps);
    if (tunnelId) await bestEffortDelete(`/accounts/${normalized.accountId}/cfd_tunnel/${tunnelId}`, normalized.apiToken, deps);
    throw error instanceof CloudflareProvisionError
      ? error
      : new CloudflareProvisionError("Cloudflare Tunnel setup failed.");
  }
}
