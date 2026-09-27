import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProtocolTraceV1 } from "../../src/protocols/dto";
import { ProtocolBadge } from "../src/components/protocols/ProtocolBadge";
import { ProtocolTracePanel } from "../src/components/protocols/ProtocolTracePanel";
import { DICTS, interpolate, type TFn } from "../src/i18n/shared";
import { DEFAULT_LOG_FILTER_STATE, filterLogs, hasActiveLogFilters } from "../src/pages/logs-filter";

const t: TFn = (key, vars) => interpolate(DICTS.en[key], vars);

const bridge: ProtocolTraceV1 = {
  v: 1,
  inbound: "chat",
  mode: "legacy-bridge",
  upstream: "messages",
  requestPath: ["chat", "responses-internal", "ir", "messages"],
  responsePath: ["messages", "ir", "responses-internal", "chat"],
  reasonCodes: ["cross-wire-ir", "not-migrated"],
  featureEffects: [{ feature: "request.seed", disposition: "unsupported" }],
  attempts: [{ ordinal: 1, upstream: "messages", mode: "legacy-bridge", requestPath: ["chat", "responses-internal", "ir", "messages"] }],
  contractVersion: "2026-09-24.1",
};
const native: ProtocolTraceV1 = {
  ...bridge,
  mode: "native",
  upstream: "chat",
  requestPath: ["chat", "chat"],
  responsePath: ["chat", "chat"],
  reasonCodes: ["same-wire-native"],
  featureEffects: undefined,
  attempts: undefined,
};

describe("ProtocolBadge", () => {
  test("writes the path and the mode as text", () => {
    const html = renderToStaticMarkup(<ProtocolBadge trace={native} t={t} />);
    expect(html).toContain("Chat → Chat · Native");
    expect(html).toContain('data-protocol-mode="native"');
  });

  test("renders nothing for a row without a valid trace", () => {
    expect(renderToStaticMarkup(<ProtocolBadge trace={undefined} t={t} />)).toBe("");
    expect(renderToStaticMarkup(<ProtocolBadge trace={{ ...bridge, v: 2 }} t={t} />)).toBe("");
  });
});

describe("ProtocolTracePanel", () => {
  test("labels the internal Responses hop and lists reasons, features and attempts", () => {
    const html = renderToStaticMarkup(<ProtocolTracePanel trace={bridge} t={t} />);
    expect(html).toContain("Chat → Responses (internal) → IR → Messages");
    expect(html).toContain("Legacy bridge");
    expect(html).toContain("cross-wire-ir, not-migrated");
    expect(html).toContain("<code>request.seed</code>: Dropped");
    expect(html).toContain("Attempt 1");
  });

  test("says there is no path data instead of guessing", () => {
    const html = renderToStaticMarkup(<ProtocolTracePanel trace={undefined} t={t} />);
    expect(html).toContain(DICTS.en["logs.detail.protocol.none"]);
  });
});

describe("protocol mode filter", () => {
  const logs = [
    { id: "bridge", protocolTrace: bridge },
    { id: "native", protocolTrace: native },
    { id: "old" },
    { id: "corrupt", protocolTrace: { mode: "native" } },
  ];
  const ids = (protocolMode: typeof DEFAULT_LOG_FILTER_STATE.protocolMode) =>
    filterLogs(logs, { ...DEFAULT_LOG_FILTER_STATE, protocolMode }).map(log => log.id);

  test("selects by final mode, and none selects rows the panel reports as no path data", () => {
    expect(ids(undefined)).toEqual(["bridge", "native", "old", "corrupt"]);
    expect(ids("all")).toEqual(["bridge", "native", "old", "corrupt"]);
    expect(ids("native")).toEqual(["native"]);
    expect(ids("legacy-bridge")).toEqual(["bridge"]);
    expect(ids("blocked")).toEqual([]);
    expect(ids("none")).toEqual(["old", "corrupt"]);
  });

  test("counts as an active filter only when narrowed", () => {
    expect(hasActiveLogFilters(DEFAULT_LOG_FILTER_STATE)).toBe(false);
    expect(hasActiveLogFilters({ ...DEFAULT_LOG_FILTER_STATE, protocolMode: "all" })).toBe(false);
    expect(hasActiveLogFilters({ ...DEFAULT_LOG_FILTER_STATE, protocolMode: "none" })).toBe(true);
  });
});
