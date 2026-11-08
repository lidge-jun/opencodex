/** Schema diagnostics are closed tokens, never upstream messages, inputs or arbitrary location keys. */
const ROOT_FIELDS = [
  "max_completion_tokens", "max_tokens", "user", "store", "thinking", "include_reasoning", "reasoning",
  "reasoning_effort", "top_k", "messages", "tools", "response_format", "temperature",
  "top_p", "stream_options", "parallel_tool_calls", "metadata", "service_tier", "prompt_cache_key",
] as const;
const NESTED_FIELDS = ["messages.role", "messages.content", "tools.function", "tools.function.strict",
  "stream_options.include_usage", "reasoning.effort", "reasoning.enabled", "thinking.type"] as const;
const FIELDS = [...ROOT_FIELDS, ...NESTED_FIELDS, ...ROOT_FIELDS.map(field => `${field}.*` as const)] as const;
const TYPES = ["extra_forbidden", "union_tag_invalid", "literal_error", "enum", "value_error"] as const;
export interface ValidationIssue { field: typeof FIELDS[number]; type: typeof TYPES[number] }
export const MAX_VALIDATION_ISSUES = 8;
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** Revalidate on append, hydration and UI rendering, including edited or legacy usage rows. */
export function boundedValidationIssues(value: unknown): ValidationIssue[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const issues: ValidationIssue[] = [];
  for (const item of value.slice(0, 64)) {
    if (!isRecord(item)) continue;
    const field = FIELDS.find(field => field === item.field);
    const type = TYPES.find(type => type === item.type);
    if (!field || !type || issues.some(issue => issue.field === field && issue.type === type)) continue;
    issues.push({ field, type });
    if (issues.length === MAX_VALIDATION_ISSUES) break;
  }
  if (!issues.length) return undefined;
  if (issues.length === value.length && value.every((item, i) => isRecord(item)
    && Object.keys(item).length === 2 && item.field === issues[i]!.field && item.type === issues[i]!.type)) return value as ValidationIssue[];
  return issues;
}

/** Extract only schema field identities, collapsing message locations without retaining values. */
export function upstreamValidationIssues(payload: unknown): ValidationIssue[] | undefined {
  if (!isRecord(payload) || !Array.isArray(payload.detail)) return undefined;
  return boundedValidationIssues(payload.detail.slice(0, 64).map(item => {
    if (!isRecord(item) || !Array.isArray(item.loc)) return undefined;
    const loc = item.loc;
    const start = loc[0] === "body" ? 1 : 0;
    const root = ROOT_FIELDS.find(field => field === loc[start]);
    if (!root) return undefined;
    const nested = loc.length > start + 1;
    const path = loc.slice(start, start + 16).filter(part => typeof part !== "number").join(".");
    const field = nested ? NESTED_FIELDS.find(field => field === path) ?? `${root}.*` : root;
    return { field, type: item.type };
  }));
}
