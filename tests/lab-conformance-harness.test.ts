import { describe, expect, test } from "bun:test";
import { evaluateAssertion } from "../src/lab/conformance/assertion";
import { fixtureDigest, scenarioManifestDigest } from "../src/lab/conformance/digest";
import { jcsEqual, jcsStringify } from "../src/lab/conformance/jcs";
import { resolveJsonPointer } from "../src/lab/conformance/json-pointer";
import { runScenario } from "../src/lab/conformance/executor";
import {
  discoverScenarios,
  expandScenario,
  loadCaseAuthority,
  validateExpandedFixtureRef,
  validateFixtureDigests,
} from "../src/lab/conformance/manifest";
import { buildNegativeControls, NEGATIVE_CONTROL_FIXTURES } from "../src/lab/conformance/negative-controls";
import { emptyObservation } from "../src/lab/conformance/observation";
import {
  listScenarioIds,
  runConformanceSuite,
  runNegativeControls,
} from "../src/lab/conformance/runner";
import { CL01_SUITES, SYNTHETIC_MARKER } from "../src/lab/conformance/types";
import { normalizeSseBytes } from "../src/lab/conformance/sse-normalize";

describe("CL-01 conformance harness infrastructure", () => {
  test("loads the frozen 35-case authority and validates fixture digests", () => {
    const authority = loadCaseAuthority();
    expect(authority.cases.length).toBe(35);
    for (const caseRecord of authority.cases) {
      expect(validateFixtureDigests(caseRecord)).toEqual([]);
    }
  });

  test("discovers all eight CL-01 protocol suites with stable IDs", () => {
    const authority = loadCaseAuthority();
    const scenarios = discoverScenarios(authority, CL01_SUITES);
    expect(scenarios.length).toBe(35);
    const ids = scenarios.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("responses-core.protocol.request-shape");
    expect(ids).toContain("vision-core.protocol.input-image");
    expect(ids).toContain("reasoning-core.protocol.effort-mapping");
    expect(ids).toContain("mcp-core.protocol.namespace-mapping");
  });

  test("json pointer and JCS equality are deterministic and fail closed", () => {
    const observation = emptyObservation();
    observation.client.response.status = 200;
    const resolved = resolveJsonPointer(observation, "/client/response/status");
    expect(resolved.ok).toBe(true);
    expect(resolved.ok && jcsEqual(resolved.value, 200)).toBe(true);
    expect(jcsEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(resolveJsonPointer({}, "/constructor").ok).toBe(false);
    expect(() => jcsStringify(undefined)).toThrow();
    expect(() => jcsStringify(Number.NaN)).toThrow();
  });

  test("identifier operators reject vacuous and null correlations", () => {
    const observation = emptyObservation();
    const vacuous = evaluateAssertion({
      id: "stable",
      operator: "id_stable_across_events",
      selector: "/client",
      expected: ["/client/response/status"],
      required: true,
    }, observation);
    expect(vacuous.passed).toBe(false);
    expect(vacuous.reason).toBe("invalid_expected");

    observation.client.response.json = { left: null, right: null };
    const nullCorrelation = evaluateAssertion({
      id: "correlation",
      operator: "id_correlates",
      selector: "/client/response/json",
      expected: ["/client/response/json/left", "/client/response/json/right"],
      required: true,
    }, observation);
    expect(nullCorrelation.passed).toBe(false);
  });

  test("fixture digest matches contract domain separation", () => {
    const bytes = new TextEncoder().encode("PING");
    expect(fixtureDigest(bytes)).toHaveLength(64);
    expect(fixtureDigest(bytes)).not.toEqual(fixtureDigest(new TextEncoder().encode("PING2")));
  });

  test("assertion evaluator reports selector_missing", () => {
    const observation = emptyObservation();
    const result = evaluateAssertion({
      id: "missing",
      operator: "json_path_equals",
      selector: "/upstream/requests/0/json/model",
      expected: "fixture-model",
      required: true,
    }, observation);
    expect(result.passed).toBe(false);
    expect(result.reason).toBe("selector_missing");
  });

  test("expanded scenario manifests include normative synthetic provenance", () => {
    const authority = loadCaseAuthority();
    const scenario = discoverScenarios(authority)[0];
    const expanded = expandScenario(scenario, authority);
    const fixtures = expanded.fixtures as Array<Record<string, unknown>>;
    expect(fixtures[0].syntheticMarker).toBe(SYNTHETIC_MARKER);
    expect((fixtures[0].provenance as { kind: string }).kind).toBe("lab_authored");
    expect((fixtures[0].provenance as { authority: string }).authority).toBe("022_protocol_v1_cases.json");
    expect((fixtures[0].provenance as { sourceCommit: string }).sourceCommit).toBe(authority.sourceCommit);
    expect(scenarioManifestDigest(expanded)).toHaveLength(64);
  });

  test("rejects forged synthetic provenance metadata", () => {
    const authority = loadCaseAuthority();
    const scenario = discoverScenarios(authority)[0];
    const expanded = expandScenario(scenario, authority);
    const fixtures = expanded.fixtures as Array<Record<string, unknown>>;
    const forged = { ...fixtures[0], syntheticMarker: "forged" };
    expect(validateExpandedFixtureRef(forged, authority, scenario.fixture.bytesUtf8)
      .some((e) => e.includes("syntheticMarker"))).toBe(true);
    const badCommit = {
      ...fixtures[0],
      provenance: { ...(fixtures[0].provenance as object), sourceCommit: "deadbeef" },
    };
    expect(validateExpandedFixtureRef(badCommit, authority, scenario.fixture.bytesUtf8).length).toBeGreaterThan(0);
  });
});

describe("CL-01 SSE normalization", () => {
  test("openai-chat recognizes [DONE] sentinel only for chat protocol", () => {
    const bytes = new TextEncoder().encode("data: {\"choices\":[]}\n\ndata: [DONE]\n\n");
    const chatEvents = normalizeSseBytes(bytes, "openai-chat");
    expect(chatEvents.some((e) => e.event === "[DONE]")).toBe(true);
    const responsesEvents = normalizeSseBytes(bytes, "openai-responses");
    expect(responsesEvents.some((e) => e.event === "[DONE]")).toBe(false);
    const anthropicEvents = normalizeSseBytes(bytes, "anthropic-messages");
    expect(anthropicEvents.some((e) => e.event === "[DONE]")).toBe(false);
  });

  test("normalizes BOM/CRLF, comments, multiline data, and malformed JSON", () => {
    const bytes = new TextEncoder().encode(
      "\uFEFF: keep-alive\r\nevent: response.completed\r\ndata: {\"type\":\"response.completed\",\r\ndata: \"response\":{\"status\":\"completed\"}}\r\n\r\n"
      + "data: {not-json}\r\n\r\n",
    );
    const events = normalizeSseBytes(bytes, "openai-responses");
    expect(events).toHaveLength(2);
    expect(events[0].event).toBe("response.completed");
    expect(events[0].ordinal).toBe(0);
    expect(events[1].event).toBe("malformed");
    expect(events[1].ordinal).toBe(1);
  });

  test("drops scalar/null/array data frames as Protocol V1 padding", () => {
    const bytes = new TextEncoder().encode("data: null\n\ndata: 1\n\ndata: []\n\n");
    expect(normalizeSseBytes(bytes, "openai-responses")).toEqual([]);
  });
});

describe("CL-01 MCP deterministic actions", () => {
  test("all four MCP scenarios pass through the full runner path", async () => {
    const authority = loadCaseAuthority();
    const mcpScenarios = authority.cases.filter((c) => c.suite === "mcp-core");
    expect(mcpScenarios.length).toBe(4);
    for (const scenario of mcpScenarios) {
      const result = await runScenario(scenario);
      if (!result.passed) {
        throw new Error(`${scenario.id}: ${result.diagnostics.join(";")} ${result.assertionResults.filter((a) => !a.passed).map((a) => `${a.id}:${a.reason ?? ""}`).join(",")}`);
      }
    }
  });
});

describe("CL-01 expanded scenario manifests are stable", () => {
  test("expanded scenario manifests are stable", () => {
    const authority = loadCaseAuthority();
    const scenario = discoverScenarios(authority)[0];
    const a = expandScenario(scenario, authority);
    const b = expandScenario(scenario, authority);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(scenarioManifestDigest(a)).toBe(scenarioManifestDigest(b));
  });
});

describe("CL-01 canonical protocol scenarios", () => {
  test("all 35 CL-01 protocol scenarios pass", async () => {
    const summary = await runConformanceSuite();
    const failures = summary.results.filter((r) => !r.passed);
    if (failures.length > 0) {
      const detail = failures.map((f) => `${f.scenarioId}: ${f.classification} ${f.secondaryCode ?? ""} ${f.diagnostics.join(";")} ${f.assertionResults.filter((a) => !a.passed).map((a) => `${a.id}:${a.reason ?? ""}`).join(",")}`).join("\n");
      throw new Error(`scenario failures:\n${detail}`);
    }
    expect(summary.total).toBe(35);
    expect(summary.passed).toBe(35);
  }, 120000);
});

describe("CL-01 negative controls", () => {
  test("negative controls are rejected by the harness", async () => {
    expect(NEGATIVE_CONTROL_FIXTURES.length).toBeGreaterThanOrEqual(8);
    const authority = loadCaseAuthority();
    const controls = buildNegativeControls(discoverScenarios(authority, CL01_SUITES));
    expect(controls.length).toBe(NEGATIVE_CONTROL_FIXTURES.length);
    for (const control of controls) {
      const result = await runScenario(control);
      expect(result.passed).toBe(false);
      expect(result.classification).not.toBe("inconclusive");
    }
  }, 120000);

  test("runNegativeControls summary names rejected controls explicitly", async () => {
    const summary = await runNegativeControls();
    expect(summary.total).toBe(NEGATIVE_CONTROL_FIXTURES.length);
    expect(summary.rejected).toBe(summary.total);
    expect(summary.passed).toBe(summary.rejected);
  }, 120000);
});

describe("CL-01 scenario discovery API", () => {
  test("listScenarioIds returns stable mapping", () => {
    const ids = listScenarioIds();
    const again = listScenarioIds();
    expect(ids.length).toBe(35);
    expect(again).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
