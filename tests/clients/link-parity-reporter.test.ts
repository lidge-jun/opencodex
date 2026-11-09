/**
 * OCX-6: the linked client runtime reports its last apply and its start to the Home: soon after
 * start with backoff while the tunnel comes up, then once a minute, and never again to a Home
 * that predates the route.
 */
import { describe, expect, test } from "bun:test";
import {
  createLinkParityReporter,
  LINK_PARITY_PERIOD_MS,
  LINK_PARITY_RETRY_MS,
  linkChildParityReport,
} from "../../src/client/link-parity-reporter";
import type { HomeCodexSettingsRecord } from "../../src/client/link-home";
import type { LinkChildParityReport } from "../../src/link/child-parity";
import type { OcxClientConnectionConfig } from "../../src/types";

const LINK_ID = `lnk_${"a".repeat(16)}`;
const connection = { transport: "link", link: { linkId: LINK_ID, tunnelPort: 23457 }, apiKeyId: "k" } as OcxClientConnectionConfig;
const STARTED = "2026-10-21T01:00:05.000Z";
const record: HomeCodexSettingsRecord = {
  linkId: LINK_ID, fetchedAt: "2026-10-21T01:00:00.000Z", appliedAt: "2026-10-21T01:00:00.000Z",
  document: { version: 1, home: { name: "h", version: "2.91.0" }, settings: { fastMode: true, multiAgentMode: "v1", webSearchSidecarEnabled: false, subagentDefaults: null } },
};

function harness(outcomes: Array<"accepted" | "unsupported" | "failed">) {
  const delays: number[] = [];
  const sent: LinkChildParityReport[] = [];
  let pending: (() => void) | null = null;
  const reporter = createLinkParityReporter({
    connection,
    linkKey: () => "ocx_data_key",
    runtimeStartedAt: STARTED,
    readRecord: () => record,
    send: async (_connection, _key, report) => { sent.push(report); return outcomes.shift() ?? "accepted"; },
    setTimer: (callback, ms) => { delays.push(ms); pending = callback; return ms; },
    clearTimer: () => { pending = null; },
  });
  const fire = async () => {
    const callback = pending;
    pending = null;
    callback?.();
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  };
  return { reporter, delays, sent, fire, pending: () => pending };
}

describe("link parity reporter", () => {
  test("the report carries the apply time, digest and start as epoch ms", () => {
    expect(linkChildParityReport(connection, STARTED, record, 7)).toEqual({
      linkId: LINK_ID,
      lastApplyAt: Date.parse("2026-10-21T01:00:00.000Z"),
      runtimeStartedAt: Date.parse(STARTED),
      appliedCodexSettingsDigest: "57c751eff89844f93db71a6ee4acdac03afbc29fec52734ade80a40193e826cd",
      sequence: 7,
    });
    expect(linkChildParityReport(connection, STARTED, null, 8)).toEqual({
      linkId: LINK_ID, lastApplyAt: null, runtimeStartedAt: Date.parse(STARTED), appliedCodexSettingsDigest: null, sequence: 8,
    });
    // Without an explicit sequence each report counts up, process-wide.
    const first = linkChildParityReport(connection, STARTED, null)!.sequence;
    expect(linkChildParityReport(connection, STARTED, null)!.sequence).toBeGreaterThan(first);
  });

  test("backs off while the Home is unreachable, then reports once a minute", async () => {
    const h = harness(["failed", "failed", "accepted", "accepted"]);
    h.reporter.start();
    for (let i = 0; i < 4; i += 1) await h.fire();
    expect(h.delays).toEqual([LINK_PARITY_RETRY_MS[0], LINK_PARITY_RETRY_MS[1], LINK_PARITY_RETRY_MS[2], LINK_PARITY_PERIOD_MS, LINK_PARITY_PERIOD_MS]);
    expect(h.sent).toHaveLength(4);
  });

  test("a Home without the route is not asked again, and stop cancels the timer", async () => {
    const old = harness(["unsupported"]);
    old.reporter.start();
    await old.fire();
    expect(old.pending()).toBeNull();
    expect(old.sent).toHaveLength(1);

    const stopped = harness([]);
    stopped.reporter.start();
    stopped.reporter.stop();
    await stopped.fire();
    expect(stopped.sent).toHaveLength(0);
  });
});
