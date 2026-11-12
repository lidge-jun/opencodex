import type { LinkTrafficCounters } from "../link/traffic";
import type { LinkPath } from "../link/ssh-route";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function count(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

const TRAFFIC_KEYS = ["since", "requests", "incomplete", "toHomeBytes", "fromHomeBytes", "toHomeSource", "toHomeUncounted"] as const;
const VIA = new Set(["proxy-command", "proxy-jump", "direct", "unknown"]);

/** A row's `traffic` block from `?traffic=1` (#3023), validated key by key like the rest of the row. */
export function validateLinkTraffic(value: unknown, index: number): LinkTrafficCounters {
  if (!isRecord(value) || !exactKeys(value, TRAFFIC_KEYS) || typeof value.since !== "string" || Number.isNaN(Date.parse(value.since))
    || !count(value.requests) || !count(value.incomplete) || !count(value.toHomeBytes) || !count(value.fromHomeBytes)
    || (value.toHomeSource !== "relayed" && value.toHomeSource !== "content-length") || !count(value.toHomeUncounted)) {
    throw new Error(`invalid link API response: link ${index} traffic`);
  }
  return {
    since: value.since, requests: value.requests, incomplete: value.incomplete, toHomeBytes: value.toHomeBytes,
    fromHomeBytes: value.fromHomeBytes, toHomeSource: value.toHomeSource, toHomeUncounted: value.toHomeUncounted,
  };
}

export function validateLinkPath(value: unknown, index: number): LinkPath {
  if (!isRecord(value) || !exactKeys(value, ["via"]) || typeof value.via !== "string" || !VIA.has(value.via)) {
    throw new Error(`invalid link API response: link ${index} path`);
  }
  return { via: value.via as LinkPath["via"] };
}
