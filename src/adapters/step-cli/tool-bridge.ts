import { buildCodingAgentToolCatalog, CodingAgentToolCatalogError } from "../coding-agent/tool-catalog";
import type { OcxParsedRequest } from "../../types";
import { STEP_CLI_TOOL_SERVER } from "./constants";

/**
 * Namespace StepCode registers this proxy's tools under.
 *
 * Re-exported from `constants.ts` so the emitted wire names, the model-id projection and the tool
 * bridge can never disagree about the prefix: two copies of "ocx" that drift apart would silently
 * turn every captured call into an unresolvable name.
 */
export { STEP_CLI_TOOL_SERVER };

/** One declared SDK tool, exactly the descriptor shape `query.start.options.sdkTools` accepts. */
export interface StepSdkToolDescriptor {
  readonly serverName: string;
  readonly toolName: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

/** A tool call the client owns, recovered from a `${serverName}__${toolName}` wire name. */
export interface StepCapturedToolCall {
  /** Name the client originally declared, without the StepCode namespace prefix. */
  readonly wireName: string;
  /** Call id the client uses when it reports the result on the next request. */
  readonly callId: string;
  readonly input: Record<string, unknown>;
}

export class StepToolCatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StepToolCatalogError";
  }
}

/**
 * Project the client's tool catalog into StepCode's `sdkTools` option.
 *
 * The client's tool schemas travel inline, which is the whole reason this family needs no capture
 * MCP server: StepCode registers each descriptor as a real tool on the session and calls the peer
 * back over stdio. Limits, name validation and tool_choice filtering are reused from the shared
 * coding-agent catalog builder so a route cannot accept a catalog the sibling CLI routes reject.
 */
export function buildStepSdkTools(
  parsed: OcxParsedRequest,
  serverName: string = STEP_CLI_TOOL_SERVER,
): {
  sdkTools: StepSdkToolDescriptor[];
  /** `${serverName}__${toolName}` → the client's own tool name. */
  emittedNameMap: Map<string, string>;
  requireToolCall: boolean;
} {
  let catalog: ReturnType<typeof buildCodingAgentToolCatalog>;
  try {
    catalog = buildCodingAgentToolCatalog(parsed, serverName);
  } catch (error) {
    if (!(error instanceof CodingAgentToolCatalogError)) throw error;
    throw new StepToolCatalogError(error.message);
  }
  const emittedNameMap = new Map<string, string>();
  const sdkTools = catalog.tools.map(tool => {
    const emittedName = `${serverName}__${tool.name}`;
    emittedNameMap.set(emittedName, tool.name);
    return {
      serverName,
      toolName: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    } satisfies StepSdkToolDescriptor;
  });
  return { sdkTools, emittedNameMap, requireToolCall: catalog.requireToolCall };
}

/**
 * Recover the client's tool name from a StepCode tool name.
 *
 * Returns undefined for anything this proxy did not declare — a StepCode built-in, a host MCP tool,
 * or a malformed name. Callers must fail closed on undefined rather than forward the call, because a
 * name that round-trips to nothing is a call the client can never satisfy.
 */
export function resolveStepToolName(
  emittedName: string,
  emittedNameMap: ReadonlyMap<string, string>,
): string | undefined {
  const direct = emittedNameMap.get(emittedName);
  if (direct) return direct;
  const separator = emittedName.indexOf("__");
  if (separator <= 0) return undefined;
  return emittedNameMap.get(emittedName.slice(separator + 2));
}
