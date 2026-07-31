import { describe, expect, test } from "bun:test";
import { handleManagementAPI } from "../src/server/management-api";
import { ManagementRequest as Request } from "./helpers/management-auth";
import type { OcxConfig } from "../src/types";

const config = { providers: [] } as unknown as OcxConfig;

/**
 * #725: the dashboard rendered request-log timestamps in the BROWSER's zone, so a proxy
 * running in KST viewed from a UTC browser reported every request nine hours off.
 *
 * The zone is on /api/settings and also on the /api/logs envelope (`{ timeZone, total, logs }`,
 * #726). Consumers that still need the row list go through `logsFromApiBody`.
 */
describe("log timestamp timezone (#725)", () => {
  test("/api/settings reports the server's IANA zone", async () => {
    const url = new URL("http://localhost/api/settings");
    const response = await handleManagementAPI(new Request(url), url, config);
    expect(response?.status).toBe(200);
    const body = await response!.json() as { timeZone?: unknown };
    expect(typeof body.timeZone).toBe("string");
    // Must be a zone Intl accepts, not just any string: the GUI feeds it straight to
    // toLocaleTimeString, where an unknown zone throws RangeError.
    expect(() => new Intl.DateTimeFormat("en-US", { timeZone: body.timeZone as string })).not.toThrow();
  });

  test("/api/logs envelope includes a usable timeZone", async () => {
    const url = new URL("http://localhost/api/logs");
    const response = await handleManagementAPI(new Request(url), url, config);
    expect(response?.status).toBe(200);
    const body = await response!.json() as {
      timeZone?: unknown;
      total?: unknown;
      logs?: unknown;
    };
    expect(typeof body.timeZone).toBe("string");
    expect(typeof body.total).toBe("number");
    expect(Array.isArray(body.logs)).toBe(true);
    expect(() => new Intl.DateTimeFormat("en-US", { timeZone: body.timeZone as string })).not.toThrow();
  });
});

/**
 * The GUI-side formatters, mirrored here because Logs.tsx is not importable from a Bun test.
 * The behavior under test is the timeZone argument being threaded through at all -- passing
 * `undefined` reproduces the pre-fix rendering exactly.
 */
function formatLogTimestamp(ts: number, localeTag?: string, timeZone?: string): string {
  try {
    return new Date(ts).toLocaleTimeString(localeTag, timeZone ? { timeZone } : undefined);
  } catch {
    return new Date(ts).toLocaleTimeString(localeTag);
  }
}

describe("timestamp formatting", () => {
  // 2026-07-31T00:30:00Z -- deliberately across a date line for most zones, so a zone that
  // is ignored shows up as a different hour rather than a subtle offset.
  const ts = Date.parse("2026-07-31T00:30:00Z");

  test("renders in the server zone, not the viewer's", () => {
    const seoul = formatLogTimestamp(ts, "en-US", "Asia/Seoul");
    const utc = formatLogTimestamp(ts, "en-US", "UTC");
    // 00:30 UTC is 09:30 KST. If the argument were dropped both calls would agree, which is
    // exactly the failure #790's own test could not catch -- it compared a value to itself.
    expect(seoul).not.toBe(utc);
    expect(seoul).toContain("9:30");
    expect(utc).toContain("12:30");
  });

  test("falls back to browser-local for a zone the runtime does not know", () => {
    // An ICU build without this zone throws RangeError, which would take the whole row
    // render down. A wrong hour beats an empty log list.
    expect(() => formatLogTimestamp(ts, "en-US", "Mars/Olympus_Mons")).not.toThrow();
    expect(formatLogTimestamp(ts, "en-US", "Mars/Olympus_Mons"))
      .toBe(formatLogTimestamp(ts, "en-US", undefined));
  });

  test("no zone keeps the previous behavior", () => {
    expect(formatLogTimestamp(ts, "en-US", undefined)).toBe(new Date(ts).toLocaleTimeString("en-US"));
  });
});
