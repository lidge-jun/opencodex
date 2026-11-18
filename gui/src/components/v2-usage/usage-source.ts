export const SOURCE_CLIENTS = ["all", "codex", "claude_code", "claude_desktop", "grok", "opencode", "aside", "other", "unknown"] as const;
export type SourceClient = typeof SOURCE_CLIENTS[number];
export type SourceDevice = { kind: "all" | "no-key" | "unconfigured" } | { kind: "key"; id: string };
export type SourceFilter = { client: SourceClient; device: SourceDevice };

export function sourceQuery(filter: SourceFilter): URLSearchParams {
  const query = new URLSearchParams({ client: filter.client, device: filter.device.kind });
  if (filter.device.kind === "key") query.set("apiKeyId", filter.device.id);
  return query;
}

export function matchesSource(value: unknown, expected: SourceFilter): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const filter = value as Record<string, unknown>;
  const device = filter.device;
  if (Object.keys(filter).sort().join(",") !== "client,device" || filter.client !== expected.client || !device || typeof device !== "object" || Array.isArray(device)) return false;
  const actual = device as Record<string, unknown>;
  return actual.kind === expected.device.kind && (expected.device.kind === "key"
    ? Object.keys(actual).sort().join(",") === "id,kind" && actual.id === expected.device.id
    : Object.keys(actual).join(",") === "kind");
}

export function noStore(response: Response): boolean {
  return /(?:^|,)\s*no-store\s*(?:,|$)/i.test(response.headers.get("cache-control") ?? "");
}

/** Verify the daemon's 30-civil-day window, including time-zone transitions at midnight. */
export function matchesFacetWindow(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const { since, until, timeZone } = value as Record<string, unknown>;
  if (typeof since !== "number" || !Number.isSafeInteger(since) || typeof until !== "number" || !Number.isSafeInteger(until)
    || since > until || typeof timeZone !== "string" || !timeZone) return false;
  try {
    const formatter = new Intl.DateTimeFormat("en-US-u-ca-gregory", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
    const civilDay = (instant: number) => {
      const parts = formatter.formatToParts(new Date(instant));
      const part = (name: string) => Number(parts.find(item => item.type === name)?.value);
      return Date.UTC(part("year"), part("month") - 1, part("day"));
    };
    const start = civilDay(since);
    return Number.isFinite(start) && civilDay(until) - start === 29 * 86_400_000 && civilDay(since - 1) < start;
  } catch { return false; }
}
