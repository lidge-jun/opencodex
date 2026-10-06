import {
  AdmissionModelDeniedError, routeAllowedByScope, UNNAMED_DESTINATION_MODEL, type AdmissionModelScope,
} from "./admission-model-scope";

type Rec = Record<string, unknown>;
const isRec = (value: unknown): value is Rec => value !== null && typeof value === "object" && !Array.isArray(value);
const isAdvisor = (tool: Rec): boolean => typeof tool.type === "string" && /^advisor_\d{8}$/.test(tool.type);

/** Only executable declarations are policy inputs; schemas, arguments and results stay opaque. */
export function nativeMessagesToolScopeDenial(
  scope: AdmissionModelScope | undefined,
  providerName: string,
  requestedModel: string,
  body: Readonly<Rec>,
): AdmissionModelDeniedError | undefined {
  if (!scope || scope.models.length === 0) return undefined;
  const definitions = new Map<string, Rec[]>();
  const withdrawn = new Set<string>();
  const anonymous: Rec[] = [];
  if (Array.isArray(body.tools)) for (const tool of body.tools) {
    if (!isRec(tool)) continue;
    if (typeof tool.name !== "string") { anonymous.push(tool); continue; }
    const declarations = definitions.get(tool.name) ?? [];
    declarations.push(tool);
    definitions.set(tool.name, declarations);
  }
  if (Array.isArray(body.messages)) for (const message of body.messages) {
    if (!isRec(message) || message.role !== "system" || !Array.isArray(message.content)) continue;
    // Upstream rejects tool changes in turn-scoped messages; do not depend on that. An addition
    // always counts, and only a permanent removal withdraws a declaration (fail closed).
    const permanent = message.clear_at === undefined || message.clear_at === "never";
    for (const block of message.content) {
      if (!isRec(block) || !isRec(block.tool)) continue;
      const tool = block.tool;
      if (block.type === "tool_addition" && tool.type === "tool_definition" && isRec(tool.definition)) {
        const definition = tool.definition;
        if (typeof definition.name !== "string") { anonymous.push(definition); continue; }
        // A temporary replacement keeps the declaration it shadows in scope as well.
        // These arrays belong to this check, not to the caller's declarations.
        const declarations = permanent ? [] : definitions.get(definition.name) ?? [];
        declarations.push(definition);
        definitions.set(definition.name, declarations);
        withdrawn.delete(definition.name);
      } else if (tool.type === "tool_reference" && typeof tool.name === "string") {
        if (block.type === "tool_removal" && permanent) withdrawn.add(tool.name);
        if (block.type === "tool_addition") withdrawn.delete(tool.name);
      }
    }
  }
  // Deferred definitions can still be loaded by tool search in the current turn.
  const active = [...anonymous, ...[...definitions].flatMap(([name, tools]) => withdrawn.has(name) ? [] : tools)];
  for (const tool of active) {
    if (!isAdvisor(tool)) continue;
    const modelId = typeof tool.model === "string" && tool.model.trim() ? tool.model : undefined;
    if (modelId === undefined || !routeAllowedByScope(scope, { providerName, modelId })) {
      return new AdmissionModelDeniedError(requestedModel, { providerName, modelId: modelId ?? UNNAMED_DESTINATION_MODEL });
    }
  }
  return undefined;
}
