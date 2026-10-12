import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { DICTS, I18nContext, interpolate, type TFn } from "../src/i18n/shared";
import {
  buildMatrixRows,
  filterMatrixRowsByProtocol,
  protocolPairEvidence,
  subjectProtocolPair,
  type SubjectProtocolPair,
  type VerdictDto,
} from "../src/pages/compatibility-matrix-shared";
import { ProtocolPairStatus } from "../src/pages/compatibility-protocol-filter";
import { EMPTY_PROTOCOL_PAIR, type ProtocolPairFilter } from "../src/protocol-deep-links";

const t: TFn = (key, vars) => interpolate(DICTS.en[key], vars);
function LanguageProvider({ children }: { children: ReactNode }) {
  return <I18nContext.Provider value={{ locale: "en", setLocale: () => {}, t }}>{children}</I18nContext.Provider>;
}

function verdict(subjectId: string, value: VerdictDto["verdict"] = "VERIFIED"): VerdictDto {
  return {
    projectionKey: `${subjectId}:protocol_conformance`,
    subjectId,
    evidenceLayer: "protocol_conformance",
    suiteId: "suite",
    suiteVersion: "1",
    suiteManifestDigest: "d",
    projectionSpecVersion: "1",
    verdict: value,
    asOf: 1,
    scenarioManifestDigests: [],
    claimSourceDigest: null,
    contributingEventIds: [],
    contradictingEventIds: [],
    notes: [],
  };
}

const rows = buildMatrixRows([verdict("chat-to-messages"), verdict("responses-native")], []);
const pairs = new Map<string, SubjectProtocolPair>([
  ["chat-to-messages", { inbound: "chat", upstream: "messages" }],
  ["responses-native", { inbound: "responses", upstream: "responses" }],
]);

describe("subjectProtocolPair", () => {
  test("maps Lab protocol identities onto the public vocabulary", () => {
    expect(subjectProtocolPair({ subjectKind: "protocol", inboundProtocol: "openai-chat", upstreamProtocol: "anthropic-messages" }))
      .toEqual({ inbound: "chat", upstream: "messages" });
    expect(subjectProtocolPair({ subjectKind: "route", inboundProtocol: "openai-responses", upstreamProtocol: "openai-responses" }))
      .toEqual({ inbound: "responses", upstream: "responses" });
  });

  test("an identity with no public protocol stays unknown instead of guessed", () => {
    expect(subjectProtocolPair({ subjectKind: "protocol", inboundProtocol: "gemini-native", upstreamProtocol: 3 })).toEqual({});
    expect(subjectProtocolPair(null)).toEqual({});
  });
});

describe("filterMatrixRowsByProtocol", () => {
  test("an empty filter keeps every row", () => {
    expect(filterMatrixRowsByProtocol(rows, pairs, EMPTY_PROTOCOL_PAIR)).toBe(rows);
  });

  test("filters by inbound, upstream, or both", () => {
    const ids = (filter: ProtocolPairFilter) => filterMatrixRowsByProtocol(rows, pairs, filter).map(row => row.subjectId);
    expect(ids({ inbound: "chat", upstream: "" })).toEqual(["chat-to-messages"]);
    expect(ids({ inbound: "", upstream: "responses" })).toEqual(["responses-native"]);
    expect(ids({ inbound: "chat", upstream: "messages" })).toEqual(["chat-to-messages"]);
    expect(ids({ inbound: "messages", upstream: "chat" })).toEqual([]);
  });

  test("a subject whose pair is unknown is left out of an active filter", () => {
    expect(filterMatrixRowsByProtocol(rows, new Map(), { inbound: "chat", upstream: "" })).toEqual([]);
  });
});

describe("absent Lab evidence", () => {
  test("a filtered pair with no rows is unverified", () => {
    expect(protocolPairEvidence({ inbound: "messages", upstream: "chat" }, [])).toBe("unverified");
    expect(protocolPairEvidence({ inbound: "chat", upstream: "messages" }, rows.slice(0, 1))).toBe("evidence");
    expect(protocolPairEvidence(EMPTY_PROTOCOL_PAIR, [])).toBe("any");
  });

  test("the status line says unverified, never failed or unsupported", () => {
    const html = renderToStaticMarkup(
      <LanguageProvider>
        <ProtocolPairStatus
          filter={{ inbound: "messages", upstream: "chat" }}
          evidence="unverified"
          resolution={{ loading: false, unresolved: 0 }}
        />
      </LanguageProvider>,
    );
    expect(html).toContain('data-pair-evidence="unverified"');
    expect(html).toContain("unverified, not failed");
    expect(html).not.toContain(DICTS.en["lab.verdict.UNSUPPORTED"]);
    expect(html).not.toContain(DICTS.en["lab.verdict.BLOCKED"]);
    expect(html).not.toContain("notice-err");
  });

  test("delivery mode never shares the status line with a verdict", () => {
    const html = renderToStaticMarkup(
      <LanguageProvider>
        <ProtocolPairStatus filter={{ inbound: "chat", upstream: "" }} evidence="evidence" resolution={{ loading: false, unresolved: 0 }} />
      </LanguageProvider>,
    );
    expect(html).not.toContain(DICTS.en["api.plan.mode.native"]);
    expect(html).not.toContain(DICTS.en["lab.verdict.VERIFIED"]);
    expect(html).toContain(DICTS.en["compatProtocol.axisNote"]);
  });

  test("no filter renders nothing", () => {
    const html = renderToStaticMarkup(
      <LanguageProvider>
        <ProtocolPairStatus filter={EMPTY_PROTOCOL_PAIR} evidence="any" resolution={{ loading: false, unresolved: 0 }} />
      </LanguageProvider>,
    );
    expect(html).toBe("");
  });
});
