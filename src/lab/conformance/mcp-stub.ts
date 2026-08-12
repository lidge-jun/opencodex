import type { CaseRecord, NormalizedObservation } from "./types";
import { emptyObservation, projectMcpCalls, setClientResponse } from "./observation";

export const MCP_ACTION_TOKENS = [
  "mcp_namespace_round_trip_v1",
  "mcp_schema_bounds_v1",
  "mcp_call_result_v1",
  "mcp_resource_round_trip_v1",
] as const;

export type McpActionToken = typeof MCP_ACTION_TOKENS[number];

export function mcpActionToken(caseRecord: CaseRecord): McpActionToken | null {
  const features = caseRecord.requirements.requiredHarnessFeatures;
  const tokens = features.filter((f) => MCP_ACTION_TOKENS.includes(f as McpActionToken));
  if (tokens.length !== 1) return null;
  return tokens[0] as McpActionToken;
}

export function executeMcpSyntheticAction(caseRecord: CaseRecord): NormalizedObservation {
  const token = mcpActionToken(caseRecord);
  if (!token) throw new Error(`invalid_manifest: missing or ambiguous MCP action token for ${caseRecord.id}`);
  const decoded = JSON.parse(caseRecord.fixture.bytesUtf8) as Record<string, unknown>;
  switch (token) {
    case "mcp_namespace_round_trip_v1":
      return runNamespaceRoundTrip(decoded);
    case "mcp_schema_bounds_v1":
      return runSchemaBounds(decoded);
    case "mcp_call_result_v1":
      return runCallResult(decoded);
    case "mcp_resource_round_trip_v1":
      return runResourceRoundTrip(decoded);
  }
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function runNamespaceRoundTrip(decoded: Record<string, unknown>): NormalizedObservation {
  if (!nonEmptyString(decoded.namespace) || !nonEmptyString(decoded.name)) {
    throw new Error("invalid_manifest: MCP namespace/name must be non-empty strings");
  }
  const namespace = decoded.namespace;
  const name = decoded.name;
  const wireName = `${namespace}__${name}`;
  const observation = emptyObservation();
  observation.upstream.requests.push({
    status: 0,
    headers: {},
    json: {
      model: "fixture-model",
      tools: [{
        name: wireName,
        description: decoded.description,
        inputSchema: decoded.inputSchema,
      }],
    },
    rawBytes: 0,
  });
  const toolCalls = [{
    id: "call_fixture",
    name: wireName,
    arguments: {},
    kind: "function" as const,
    ordinal: 0,
  }];
  setClientResponse(observation, {
    toolCalls,
    mcpCalls: projectMcpCalls(toolCalls),
    status: 200,
  });
  return observation;
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function parsesJson(value: string): boolean {
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

function runSchemaBounds(decoded: Record<string, unknown>): NormalizedObservation {
  const observation = emptyObservation();
  const limitBytes = decoded.limitBytes;
  const exactSchema = decoded.exactSchema;
  const overSchema = decoded.overSchema;
  if (!Number.isInteger(limitBytes) || (limitBytes as number) <= 0
    || typeof exactSchema !== "string" || typeof overSchema !== "string") {
    observation.verifiers = {
      exact_bound: "fail",
      one_over_rejected: "fail",
      partial_commit: false,
    };
    return observation;
  }

  const limit = limitBytes as number;
  const exactValid = utf8ByteLength(exactSchema) === limit && parsesJson(exactSchema);
  // The inert stub models two isolated catalogue transactions. The over-bound transaction
  // is rejected before commit; its validity matters so this tests the byte ceiling rather
  // than malformed JSON.
  const overRejected = utf8ByteLength(overSchema) === limit + 1 && parsesJson(overSchema);
  observation.verifiers = {
    exact_bound: exactValid ? "pass" : "fail",
    one_over_rejected: overRejected ? "pass" : "fail",
    partial_commit: false,
  };
  return observation;
}

function runCallResult(decoded: Record<string, unknown>): NormalizedObservation {
  if (!nonEmptyString(decoded.namespace) || !nonEmptyString(decoded.name)) {
    throw new Error("invalid_manifest: MCP namespace/name must be non-empty strings");
  }
  const namespace = decoded.namespace;
  const name = decoded.name;
  const argumentsValue = decoded.arguments ?? {};
  const result = decoded.result;
  const wireName = `${namespace}__${name}`;
  const observation = emptyObservation();
  const toolCalls = [{
    id: "call_fixture",
    name: wireName,
    arguments: argumentsValue,
    kind: "function" as const,
    ordinal: 0,
  }];
  setClientResponse(observation, {
    toolCalls,
    mcpCalls: projectMcpCalls(toolCalls),
    json: result,
    status: 200,
  });
  observation.verifiers = {
    stub_received: { namespace, name, arguments: argumentsValue },
  };
  return observation;
}

function runResourceRoundTrip(decoded: Record<string, unknown>): NormalizedObservation {
  if (!Array.isArray(decoded.resources) || !decoded.read || typeof decoded.read !== "object") {
    throw new Error("invalid_manifest: invalid MCP resource fixture");
  }
  const read = decoded.read as { uri?: unknown; contents?: unknown[] };
  if (!nonEmptyString(read.uri) || !Array.isArray(read.contents)) {
    throw new Error("invalid_manifest: invalid MCP resource read fixture");
  }
  const matching = decoded.resources.filter((resource) =>
    resource && typeof resource === "object" && (resource as { uri?: unknown }).uri === read.uri
  );
  if (matching.length !== 1) throw new Error("invalid_manifest: MCP resource URI must resolve exactly once");
  const observation = emptyObservation();
  setClientResponse(observation, {
    json: {
      resources: decoded.resources,
      contents: read.contents,
    },
    status: 200,
  });
  return observation;
}

export function attachMcpVerifiers(observation: NormalizedObservation, caseRecord: CaseRecord): void {
  if (caseRecord.id === "mcp-core.protocol.namespace-mapping") {
    const toolCalls = observation.client.response.toolCalls;
    if (toolCalls.length === 1) {
      observation.client.response.mcpCalls = projectMcpCalls(toolCalls);
    }
  }
  // runCallResult records the literal one-invocation receipt. Do not reconstruct it here:
  // assertions must inspect the action result that actually ran.
}
