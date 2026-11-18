import type { LinkTrafficCounters } from "../link/traffic";

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

const TRAFFIC_KEYS = ["since", "epoch", "generation", "requests", "incomplete", "toHomeBytes", "fromHomeBytes", "toHomeSource", "toHomeUncounted", "untrackedRequests"] as const;

function epoch(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{1,64}$/.test(value);
}

/** A row's `traffic` block from `?traffic=1` (#3023), validated key by key like the rest of the row. */
export function validateLinkTraffic(value: unknown, index: number): LinkTrafficCounters {
  if (!isRecord(value) || !exactKeys(value, TRAFFIC_KEYS) || typeof value.since !== "string" || Number.isNaN(Date.parse(value.since))
    || !epoch(value.epoch) || !count(value.generation) || !count(value.requests) || !count(value.incomplete) || !count(value.toHomeBytes) || !count(value.fromHomeBytes)
    || (value.toHomeSource !== "relayed" && value.toHomeSource !== "content-length") || !count(value.toHomeUncounted) || !count(value.untrackedRequests)) {
    throw new Error(`invalid link API response: link ${index} traffic`);
  }
  return {
    since: value.since, epoch: value.epoch, generation: value.generation, requests: value.requests, incomplete: value.incomplete, toHomeBytes: value.toHomeBytes,
    fromHomeBytes: value.fromHomeBytes, toHomeSource: value.toHomeSource, toHomeUncounted: value.toHomeUncounted,
    untrackedRequests: value.untrackedRequests,
  };
}
