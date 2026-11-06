import type { AdapterRequest } from "../../adapters/base";
import { collectResponsesToolGroups } from "../../responses/tool-groups";
import { requiredToolContractOf, type RequiredToolContract } from "./combo-required-tool-contract";
import { parseOutboundRequestBody } from "./passthrough-completion";

type Item = Record<string, unknown>;
const record = (value: unknown): Item | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Item : undefined;
const namespaceOf = (item: Item) => item.namespace === "functions" ? undefined : item.namespace;
const sameIdentity = (a: Item, b: Item) => a.name === b.name && namespaceOf(a) === namespaceOf(b);

function declarations(body: unknown, normalize: (item: unknown) => unknown) {
  const clients: Item[] = [];
  const hosted = new Set<string>();
  const visit = (value: unknown, namespace?: string) => {
    const tool = record(value);
    if (!tool) return;
    if (tool.type === "namespace" && typeof tool.name === "string" && Array.isArray(tool.tools)) {
      for (const inner of tool.tools) visit(inner, tool.name);
    } else if ((tool.type === "function" || tool.type === "custom") && typeof tool.name === "string") {
      const item = record(normalize({ ...tool, ...(namespace ? { namespace } : {}),
        type: tool.type === "custom" ? "custom_tool_call" : "function_call" }));
      if (item) clients.push(item);
    } else {
      const contract = requiredToolContractOf({ tools: [tool], tool_choice: "required" });
      if (contract?.kind === "any") for (const type of contract.hostedCallTypes) hosted.add(type);
    }
  };
  for (const group of collectResponsesToolGroups(body)) for (const tool of group) visit(tool);
  return { clients, hosted };
}

/** Caller intent never depends on capability filtering. Only this physical build grants substitutions. */
export function requiredToolFulfillments(
  callerBody: unknown, contract: RequiredToolContract, normalize: (item: unknown) => unknown,
  request?: AdapterRequest,
): (item: Item, clientCall: boolean) => boolean {
  const caller = declarations(callerBody, normalize);
  const choice = record(record(callerBody)?.tool_choice);
  const selected = record(normalize({ ...choice, type: choice?.type === "custom" ? "custom_tool_call" : "function_call" }));
  const intendedClient = (item: Item) => contract.kind === "any"
    ? caller.clients.some(tool => sameIdentity(item, tool))
    : selected !== undefined && sameIdentity(item, selected) && caller.clients.some(tool => sameIdentity(item, tool));
  const hosted = new Set(contract.kind === "any" ? contract.hostedCallTypes : []);
  // request is the same object oauthDispatch replaces in place after queued revalidation.
  const outbound = request ? parseOutboundRequestBody(request.body) : undefined;
  const wire = request ? declarations(outbound, normalize) : undefined;
  for (const substitution of request?.hostedToolSubstitutions ?? []) {
    const identity = record(normalize({ ...substitution, type: "function_call" }));
    if (identity && intendedClient(identity) && wire?.hosted.has(substitution.callType)) hosted.add(substitution.callType);
  }
  return (item, clientCall) => {
    if (request && (outbound?.tool_choice === "none" || !outbound)) return false;
    if (!clientCall) return hosted.has(String(item.type)) && (!wire || wire.hosted.has(String(item.type)));
    // Sparse calls keep the existing uncertain-name policy; explicit identities must be declared.
    if (typeof item.name !== "string") return !wire || wire.clients.length > 0;
    return intendedClient(item) && (!wire || wire.clients.some(tool => sameIdentity(item, tool)));
  };
}
