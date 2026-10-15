/** Native Messages beta schemas. One table owns caller admission and body-field pairing. */
type Rec = Record<string, unknown>;
function isRec(value: unknown): value is Rec {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export const CONTEXT_MANAGEMENT_BETA = "context-management-2025-06-27";
export const THINKING_BINDING_BETA = "thinking-binding-controls-2026-08-01";

interface BetaBodyPair {
  beta: string;
  path: readonly string[];
  nativeClientOnly: boolean;
  accepts?: (body: Rec) => boolean;
  forWire?: (value: unknown, toolNames?: ReadonlyMap<string, string>) => unknown;
}

/** Both schemas are supported on the first-party Messages endpoint (key and OAuth).
 * Cloud vendor endpoints and third-party compatible hosts have separate beta contracts.
 * https://platform.claude.com/docs/en/build-with-claude/preserved-thinking */
export const ANTHROPIC_BETA_BODY_PAIRS: readonly BetaBodyPair[] = [
  {
    beta: CONTEXT_MANAGEMENT_BETA, path: ["context_management"], nativeClientOnly: true,
    forWire: contextManagementForWire,
  },
  {
    beta: THINKING_BINDING_BETA, path: ["thinking", "block_binding"], nativeClientOnly: false,
    accepts: body => isRec(body.thinking) && (body.thinking.type === "adaptive" || body.thinking.type === "enabled"),
  },
];

/** OAuth edit exclusions name the same prefixed client tools as declarations. Copy-on-write. */
export function contextManagementForWire(value: unknown, oauthToolNames?: ReadonlyMap<string, string>): unknown {
  if (!oauthToolNames?.size || !isRec(value) || !Array.isArray(value.edits)) return value;
  const callerToWire = new Map([...oauthToolNames].map(([wire, caller]) => [caller, wire]));
  let changed = false;
  const edits = value.edits.map((edit: unknown) => {
    if (!isRec(edit) || !Array.isArray(edit.exclude_tools)) return edit;
    let renamed = false;
    const exclude_tools = edit.exclude_tools.map((name: unknown) => {
      const wire = typeof name === "string" ? callerToWire.get(name) ?? name : name;
      if (wire !== name) renamed = true;
      return wire;
    });
    if (!renamed) return edit;
    changed = true;
    return { ...edit, exclude_tools };
  });
  return changed ? { ...value, edits } : value;
}

function valueAt(body: Rec, path: readonly string[]): unknown {
  let value: unknown = body;
  for (const key of path) value = isRec(value) ? value[key] : undefined;
  return value;
}

/** Replace or omit one known schema path, cloning only changed ancestors. */
function withValue(body: Rec, path: readonly string[], value: unknown): Rec {
  const [key, ...rest] = path;
  if (key === undefined) return body;
  if (rest.length > 0) {
    if (!isRec(body[key])) return body;
    const nested = withValue(body[key], rest, value);
    return nested === body[key] ? body : { ...body, [key]: nested };
  }
  if (value === body[key]) return body;
  const out = { ...body };
  if (value === undefined) delete out[key];
  else out[key] = value;
  return out;
}

/** Apply after all header merges: no beta-gated field can outlive its effective beta.
 * A beta without its optional field is valid (e.g. thinking transformation diagnostics).
 * Operator headers remain trusted, but cannot turn a compatible host into first-party support.
 */
export function pairAnthropicBetaBody(
  wireBody: Rec,
  source: Readonly<Rec>,
  betaHeader: string | undefined,
  firstParty: boolean,
  oauthToolNames?: ReadonlyMap<string, string>,
): Rec {
  const sentBetas = new Set((betaHeader ?? "").split(",").map(beta => beta.trim().toLowerCase()));
  let out = wireBody;
  for (const pair of ANTHROPIC_BETA_BODY_PAIRS) {
    const allowed = firstParty && sentBetas.has(pair.beta) && (!pair.accepts || pair.accepts(wireBody));
    const value = allowed ? valueAt(source, pair.path) : undefined;
    out = withValue(out, pair.path, pair.forWire && value !== undefined ? pair.forWire(value, oauthToolNames) : value);
  }
  return out;
}
