import type { OcxConfig } from "../types/config";
import { buildPeerFeatures } from "./features";

export const REMOTE_HUB_PROTOCOL = 1;
export const MINIMUM_REMOTE_CLIENT_PROTOCOL = 1;

export interface RemoteReadyMetadata {
  protocol: number;
  minimumClientProtocol: number;
  managementUrl: string;
  features?: string[];
}

export type RemoteProtocolCompatibility =
  | { ok: true; metadata: RemoteReadyMetadata; features: Set<string> }
  | { ok: false; reason: "invalid" | "hub-too-new" | "hub-too-old"; message: string };

const INVALID_REMOTE_PROTOCOL_MESSAGE =
  "OpenCodex hub returned invalid remote protocol metadata; upgrade or repair ocx on the hub.";

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function managementOrigin(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function observedManagementOrigin(req: Request): string | null {
  try {
    const requestUrl = new URL(req.url);
    const host = req.headers.get("Host") ?? requestUrl.host;
    return managementOrigin(`${requestUrl.protocol}//${host}`);
  } catch {
    return null;
  }
}

export function readyProtocolMetadata(config: OcxConfig, req: Request): RemoteReadyMetadata {
  const configured = config.runtimeRole === "hub"
    ? managementOrigin(config.hub?.managementPublicOrigin)
    : null;
  const managementUrl = configured ?? observedManagementOrigin(req);
  if (!managementUrl) throw new Error("Readiness request does not have an HTTP(S) management origin");
  return {
    protocol: REMOTE_HUB_PROTOCOL,
    minimumClientProtocol: MINIMUM_REMOTE_CLIENT_PROTOCOL,
    managementUrl,
    features: buildPeerFeatures(),
  };
}

export function parseRemoteReadyMetadata(value: unknown): RemoteReadyMetadata | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (!positiveSafeInteger(raw.protocol) || !positiveSafeInteger(raw.minimumClientProtocol)) return null;
  if (raw.minimumClientProtocol > raw.protocol) return null;
  const parsedManagementOrigin = managementOrigin(raw.managementUrl);
  if (!parsedManagementOrigin) return null;
  const features = raw.features;
  if (features !== undefined && (
    !Array.isArray(features)
    || features.length > 64
    || features.some(feature => typeof feature !== "string" || !feature || feature.length > 80 || /[\x00-\x1f\x7f]/.test(feature))
    || new Set(features).size !== features.length
  )) return null;
  return {
    protocol: raw.protocol,
    minimumClientProtocol: raw.minimumClientProtocol,
    managementUrl: parsedManagementOrigin,
    ...(Array.isArray(features) ? { features: [...features] as string[] } : {}),
  };
}

export function checkRemoteProtocolCompatibility(
  value: unknown,
  client: { protocol: number; minimumHubProtocol: number; features?: readonly string[] } = {
    protocol: REMOTE_HUB_PROTOCOL,
    minimumHubProtocol: MINIMUM_REMOTE_CLIENT_PROTOCOL,
  },
): RemoteProtocolCompatibility {
  const metadata = parseRemoteReadyMetadata(value);
  if (!metadata || !positiveSafeInteger(client.protocol) || !positiveSafeInteger(client.minimumHubProtocol)) {
    return { ok: false, reason: "invalid", message: INVALID_REMOTE_PROTOCOL_MESSAGE };
  }
  if (client.protocol < metadata.minimumClientProtocol) {
    return {
      ok: false,
      reason: "hub-too-new",
      message: `OpenCodex hub requires remote protocol ${metadata.minimumClientProtocol}; this client supports protocol ${client.protocol}. Upgrade ocx on this client.`,
    };
  }
  if (metadata.protocol < client.minimumHubProtocol) {
    return {
      ok: false,
      reason: "hub-too-old",
      message: `OpenCodex hub provides remote protocol ${metadata.protocol}; this client requires at least ${client.minimumHubProtocol}. Upgrade ocx on the hub.`,
    };
  }
  const supported = new Set(client.features ?? []);
  const features = new Set((metadata.features ?? []).filter(feature => supported.has(feature)));
  return { ok: true, metadata, features };
}
