function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Collect top-level and Responses Lite tool containers without altering their order. */
export function collectResponsesToolGroups(body: unknown): unknown[][] {
  if (!isPlainObject(body)) return [];

  const groups: unknown[][] = [];
  if (Array.isArray(body.tools)) groups.push(body.tools);
  if (!Array.isArray(body.input)) return groups;

  for (const item of body.input) {
    if (isPlainObject(item) && item.type === "additional_tools" && Array.isArray(item.tools)) {
      groups.push(item.tools);
    }
  }
  return groups;
}
