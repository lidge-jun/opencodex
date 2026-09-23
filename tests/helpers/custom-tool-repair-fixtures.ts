/**
 * Shared fixtures for the routed custom-tool repair suites.
 *
 * Both halves of that suite read the same SSE data line, build the same event block and compare
 * the same decorated and canonical apply_patch bodies. They live here because the suite was split
 * in two and duplicating a fixture is how two copies of it drift apart.
 */
export function dataPayload(block: string): Record<string, unknown> {
  const line = block.split(/\r?\n/).find(entry => entry.startsWith("data:"));
  if (!line) throw new Error("missing SSE data line");
  return JSON.parse(line.slice(5).trim()) as Record<string, unknown>;
}

export function frame(event: string, payload: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify({ type: event, ...payload })}`;
}

export const DECORATED_PATCH = "*** Begin Patch ***\n*** Update File: README.md\n@@\n-old\n+new\n*** End Patch ***";
export const CANONICAL_PATCH = "*** Begin Patch\n*** Update File: README.md\n@@\n-old\n+new\n*** End Patch";
export const WRAPPED_DECORATED_PATCH = JSON.stringify({ input: DECORATED_PATCH });
