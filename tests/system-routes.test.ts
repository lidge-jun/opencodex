/**
 * GET /api/system/windows-replace-retries.
 *
 * The Windows atomic replace retries EBUSY/EPERM/EACCES twice, about 75ms of
 * tolerance in total. Both plan audits wanted that envelope widened; neither
 * could show it failing in the field. These counters exist to answer that with
 * evidence instead of intuition, so the endpoint's whole job is to report
 * whether the retry path ever fires, and under which error.
 *
 * Scope note: the counters are process-local. A CI assertion that they stay
 * zero across the suite would need a finalizer that aggregates many short-lived
 * sharded processes, which does not exist. This file covers the route.
 */
import { afterEach, describe, expect, test } from "bun:test";

import { handleManagementAPI } from "../src/server/management-api";
import {
  readWindowsReplaceRetryCounters,
  renameAtomicFile,
  resetWindowsReplaceRetryCountersForTests,
  type ReplacePublisher,
} from "../src/lib/windows-atomic-replace";
import type { OcxConfig } from "../src/types";

function config(): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "openai",
    providers: {
      openai: {
        adapter: "openai-chat",
        baseUrl: "https://api.example.test/v1",
        apiKey: "sk-secret-value",
        defaultModel: "gpt-test",
      },
    },
  } as unknown as OcxConfig;
}

const url = "http://127.0.0.1:10100/api/system/windows-replace-retries";
const get = (method = "GET") =>
  new Request(url, { method, headers: { Host: "127.0.0.1:10100" } });

/** A rename that fails `failures` times with `code`, then succeeds. */
function flakyIo(failures: number, code = "EBUSY", platform: NodeJS.Platform = "win32") {
  let seen = 0;
  return {
    platform,
    rename: () => {
      if (seen++ < failures) {
        const error = new Error(code) as NodeJS.ErrnoException;
        error.code = code;
        throw error;
      }
    },
    sleep: () => {},
  };
}

afterEach(() => {
  resetWindowsReplaceRetryCountersForTests();
});

describe("windows replace retry counters", () => {
  test("a clean replace records nothing", () => {
    renameAtomicFile("a", "b", flakyIo(0), "config");
    expect(readWindowsReplaceRetryCounters()).toEqual({});
  });

  test("a transient sharing violation is counted under its own code", () => {
    renameAtomicFile("a", "b", flakyIo(1, "EBUSY"), "prompt-journal");
    expect(readWindowsReplaceRetryCounters()).toEqual({
      "prompt-journal:EBUSY": { retried: 1, exhausted: 0 },
    });
  });

  test("the three codes stay distinguishable", () => {
    // EBUSY from a scanner, EACCES from permissions and EPERM from a lock are
    // three different stories. Collapsing them would leave the counters unable
    // to answer the question they exist for.
    renameAtomicFile("a", "b", flakyIo(1, "EBUSY"), "config");
    renameAtomicFile("a", "b", flakyIo(1, "EPERM"), "config");
    renameAtomicFile("a", "b", flakyIo(1, "EACCES"), "config");
    expect(readWindowsReplaceRetryCounters()).toEqual({
      "config:EBUSY": { retried: 1, exhausted: 0 },
      "config:EPERM": { retried: 1, exhausted: 0 },
      "config:EACCES": { retried: 1, exhausted: 0 },
    });
  });

  test("exhausting the envelope rethrows and is counted separately", () => {
    expect(() => renameAtomicFile("a", "b", flakyIo(99), "config-ownership")).toThrow();
    // Two retries then the throw: the envelope is 2, not unbounded.
    expect(readWindowsReplaceRetryCounters()).toEqual({
      "config-ownership:EBUSY": { retried: 2, exhausted: 1 },
    });
  });

  test("a non-Windows error is not retried and not counted", () => {
    expect(() => renameAtomicFile("a", "b", flakyIo(99, "ENOENT"), "config")).toThrow();
    expect(readWindowsReplaceRetryCounters()).toEqual({});
  });

  test("POSIX never retries even on a matching code", () => {
    expect(() => renameAtomicFile("a", "b", flakyIo(99, "EBUSY", "linux"), "config")).toThrow();
    expect(readWindowsReplaceRetryCounters()).toEqual({});
  });

  test("publisher labels are a closed set, so a path can never become a key", () => {
    // The union is the privacy enforcement: privacy:scan reads file text and
    // cannot tell that a runtime string came from a path. If this list ever
    // grows, it grows deliberately and in review.
    const publishers: ReplacePublisher[] = [
      "config",
      "prompt-journal",
      "config-ownership",
      "claude-agents",
      "lab-automation",
      "lab-ledger",
      "storage-cleanup",
      "tray",
    ];
    for (const publisher of publishers) renameAtomicFile("a", "b", flakyIo(1), publisher);
    expect(Object.keys(readWindowsReplaceRetryCounters()).sort()).toEqual([
      "claude-agents:EBUSY",
      "config-ownership:EBUSY",
      "config:EBUSY",
      "lab-automation:EBUSY",
      "lab-ledger:EBUSY",
      "prompt-journal:EBUSY",
      "storage-cleanup:EBUSY",
      "tray:EBUSY",
    ]);
    // @ts-expect-error a path is not a ReplacePublisher
    renameAtomicFile("a", "b", flakyIo(0), "C:\\Users\\someone\\.opencodex");
  });
});

describe("GET /api/system/windows-replace-retries", () => {
  test("reports the snapshot", async () => {
    renameAtomicFile("a", "b", flakyIo(1, "EACCES"), "config");
    const res = await handleManagementAPI(get(), new URL(url), config());
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = await res!.json() as { counters: Record<string, { retried: number; exhausted: number }> };
    expect(body.counters).toEqual({ "config:EACCES": { retried: 1, exhausted: 0 } });
  });

  test("an empty snapshot is an empty object, not an error", async () => {
    const res = await handleManagementAPI(get(), new URL(url), config());
    expect(res!.status).toBe(200);
    expect(await res!.json()).toEqual({ counters: {} });
  });

  test("the route does not answer non-GET methods", async () => {
    for (const method of ["POST", "PUT", "DELETE"]) {
      const res = await handleManagementAPI(get(method), new URL(url), config());
      // Unmatched by this route: either no management route claims it, or a
      // different handler answers. Either way it must not return the snapshot.
      if (res !== null && res.status === 200) {
        expect(await res.json()).not.toHaveProperty("counters");
      }
    }
  });
});
