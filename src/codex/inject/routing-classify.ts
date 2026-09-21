import { existsSync, readFileSync } from "node:fs";
import {
  hasInjectedCodexRouting,
  hasInjectedOpenaiBaseUrl,
  providerTableStart,
  providerTableString,
  rootTomlString,
} from "../injected-marker";
import { CODEX_CONFIG_PATH } from "../paths";

export type CodexRoutingKind =
  "native" | "opencodex-local" | "custom-local" | "custom-remote" | "unknown";

type RoutingEndpointKind = "local" | "remote" | "unknown";

function ipv4Octets(hostname: string): number[] | null {
  const dotted = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (dotted) {
    const octets = dotted.slice(1).map(Number);
    return octets.some((octet) => octet > 255) ? null : octets;
  }
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(hostname);
  if (!mapped) return null;
  const high = Number.parseInt(mapped[1], 16);
  const low = Number.parseInt(mapped[2], 16);
  return [high >>> 8, high & 0xff, low >>> 8, low & 0xff];
}

function classifyRoutingEndpoint(value: string): RoutingEndpointKind {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "unknown";
    const hostname = url.hostname
      .toLowerCase()
      .replace(/^\[|\]$/g, "")
      .replace(/\.$/, "");
    if (!hostname) return "unknown";
    if (hostname === "localhost" || hostname.endsWith(".localhost"))
      return "local";
    if (hostname === "::" || hostname === "::1" || hostname === "0.0.0.0")
      return "local";
    const octets = ipv4Octets(hostname);
    if (octets) {
      if (octets.every((octet) => octet === 0)) return "local";
      if (octets[0] === 127) return "local";
      return "remote";
    }
    if (/^::ffff:/i.test(hostname)) return "unknown";
    return "remote";
  } catch {
    return "unknown";
  }
}

/** Classify actual routing dependency separately from opencodex ownership. */
export function classifyCodexRouting(content: string): CodexRoutingKind {
  const rootBaseUrl = rootTomlString(content, "openai_base_url");
  if (rootBaseUrl) {
    const endpoint = classifyRoutingEndpoint(rootBaseUrl);
    if (endpoint === "unknown") return "unknown";
    if (hasInjectedOpenaiBaseUrl(content)) return "opencodex-local";
    return endpoint === "local" ? "custom-local" : "custom-remote";
  }
  const rootProvider = rootTomlString(content, "model_provider");
  if (rootProvider) {
    const providerTableExists =
      providerTableStart(content.split("\n"), rootProvider) !== -1;
    const providerBaseUrl = providerTableString(
      content,
      rootProvider,
      "base_url",
    );
    if (providerBaseUrl) {
      const endpoint = classifyRoutingEndpoint(providerBaseUrl);
      if (endpoint === "unknown") return "unknown";
      if (rootProvider === "opencodex") return "opencodex-local";
      return endpoint === "local" ? "custom-local" : "custom-remote";
    }
    if (
      rootProvider === "opencodex" ||
      providerTableExists ||
      rootProvider !== "openai"
    )
      return "unknown";
  }
  return "native";
}

/** Read-only probe used by status, doctor, and the dashboard. */
export function isCodexRoutingInjected(): boolean {
  const path = CODEX_CONFIG_PATH;
  if (!existsSync(path)) return false;
  try {
    return hasInjectedCodexRouting(readFileSync(path, "utf8"));
  } catch {
    return false;
  }
}

export function getCodexRoutingKind(): CodexRoutingKind {
  const path = CODEX_CONFIG_PATH;
  if (!existsSync(path)) return "native";
  try {
    return classifyCodexRouting(readFileSync(path, "utf8"));
  } catch {
    return "unknown";
  }
}

