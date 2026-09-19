type Schema = Record<string, unknown>;

// Google documents this function-schema subset: type, nullable, required, format, description,
// properties, items, enum, anyOf, $ref, and $defs. We inline local refs and normalize anyOf, so
// only the eight scalar/container keywords below are ever emitted. Building from an allowlist
// prevents new MCP/JSON-Schema annotations from turning into provider-wide 400 responses.
const ALLOWED_TYPES = new Set(["string", "integer", "number", "boolean", "array", "object"]);
const MAX_SCHEMA_DEPTH = 24; // Google's documented nesting limit is 32; leave headroom for CCA.
const MAX_DEREF_DEPTH = 16;
const MAX_SCHEMA_NODES = 1_024;
export const GOOGLE_TOOL_SCHEMA_LOSS_COUNT_LIMIT = 255;
const BUDGET_EXHAUSTED = Symbol("schema-budget-exhausted");
const NUMERIC_BOUND_KEYS = ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"] as const;
const SIZE_BOUND_KEYS = ["minLength", "maxLength", "minItems", "maxItems", "minProperties", "maxProperties"] as const;
const UNSUPPORTED_CONSTRAINT_KEYS = [
  "allOf",
  "oneOf",
  "not",
  "multipleOf",
  "pattern",
  "$dynamicRef",
  "$recursiveRef",
  "additionalProperties",
  "additionalItems",
  "uniqueItems",
  "contains",
  "minContains",
  "maxContains",
  "dependencies",
  "dependentRequired",
  "dependentSchemas",
  "patternProperties",
  "propertyNames",
  "unevaluatedProperties",
  "unevaluatedItems",
] as const;
const CONDITIONAL_KEYS = ["if", "then", "else"] as const;
const BOUNDED_VALUE_KEYS = new Set(["enum", "properties", "required", "items", "anyOf"]);
const RETAINED_UNION_KEYS = ["type", "nullable", "format", "enum", "properties", "items", "required"] as const;
// Annotation-only keywords do not change the accepted value set. The sanitizer intentionally
// drops title, default, examples, $comment, deprecated, readOnly, writeOnly, contentEncoding,
// contentMediaType, contentSchema, externalDocs, and example without loss.
const MERGED_SCHEMA_KEYS = [
  "type",
  "nullable",
  "description",
  "format",
  "enum",
  "const",
  "properties",
  "items",
  "required",
  "anyOf",
] as const;

type SanitizeResult = Schema | typeof BUDGET_EXHAUSTED;

export type GoogleToolSchemaEndpointClass = "ai-studio" | "vertex" | "cloud-code-assist";

export interface GoogleToolSchemaProfile {
  endpointClass: GoogleToolSchemaEndpointClass;
}

export type GoogleToolSchemaLossCategory =
  | "enum-value-filtered"
  | "enum-constraint-dropped"
  | "const-value-filtered"
  | "numeric-bound-dropped"
  | "size-bound-dropped"
  | "type-union-collapsed"
  | "unsupported-type-widened"
  | "nullability-overridden"
  | "conditional-dropped"
  | "tuple-prefix-dropped"
  | "ref-overlay-replaced"
  | "union-sibling-replaced"
  | "root-object-coerced"
  | "union-widened"
  | "recursive-ref-widened"
  | "dereference-limit-widened"
  | "depth-limit-widened"
  | "node-budget-widened"
  | "unsupported-constraint-dropped"
  | "invalid-schema-widened";

export interface GoogleToolSchemaLossReport {
  version: 1;
  endpointClass: GoogleToolSchemaEndpointClass;
  lossy: boolean;
  truncated: boolean;
  /** Bounded comparisons that exhausted their allowance; uncertainty is not proven loss. */
  uncertainComparisons: number;
  /** Saturating proven-loss counts only; capped/unknown structural comparisons add no category. */
  categories: Partial<Record<GoogleToolSchemaLossCategory, number>>;
}

export interface GoogleToolSchemaSanitizeResult {
  parameters: Record<string, unknown>;
  lossReport: GoogleToolSchemaLossReport;
}

interface SanitizeState {
  activeRefs: Set<string>;
  remainingNodes: number;
  budgetReported: boolean;
  enumFilterLossOverrides: WeakMap<Schema, number>;
  report: GoogleToolSchemaLossReport;
}

export function createGoogleToolSchemaLossReport(
  profile: GoogleToolSchemaProfile,
): GoogleToolSchemaLossReport {
  return {
    version: 1,
    endpointClass: profile.endpointClass,
    lossy: false,
    truncated: false,
    uncertainComparisons: 0,
    categories: {},
  };
}

function addGoogleToolSchemaUncertainty(report: GoogleToolSchemaLossReport): void {
  if (report.uncertainComparisons >= GOOGLE_TOOL_SCHEMA_LOSS_COUNT_LIMIT) {
    report.truncated = true;
    return;
  }
  report.uncertainComparisons++;
}

export function addGoogleToolSchemaLoss(
  report: GoogleToolSchemaLossReport,
  category: GoogleToolSchemaLossCategory,
  amount = 1,
): void {
  if (!Number.isFinite(amount) || amount <= 0) return;
  report.lossy = true;
  const increment = Math.floor(amount);
  const current = report.categories[category] ?? 0;
  const next = current + increment;
  if (next >= GOOGLE_TOOL_SCHEMA_LOSS_COUNT_LIMIT) {
    report.categories[category] = GOOGLE_TOOL_SCHEMA_LOSS_COUNT_LIMIT;
    if (next > GOOGLE_TOOL_SCHEMA_LOSS_COUNT_LIMIT) report.truncated = true;
    return;
  }
  report.categories[category] = next;
}

export function mergeGoogleToolSchemaLossReport(
  target: GoogleToolSchemaLossReport,
  source: GoogleToolSchemaLossReport,
): void {
  for (const [category, count] of Object.entries(source.categories)) {
    addGoogleToolSchemaLoss(target, category as GoogleToolSchemaLossCategory, count);
  }
  const uncertainty = target.uncertainComparisons + source.uncertainComparisons;
  target.uncertainComparisons = Math.min(uncertainty, GOOGLE_TOOL_SCHEMA_LOSS_COUNT_LIMIT);
  if (uncertainty > GOOGLE_TOOL_SCHEMA_LOSS_COUNT_LIMIT) target.truncated = true;
  if (source.truncated) target.truncated = true;
}

function reportBudgetExhausted(state: SanitizeState): void {
  if (state.budgetReported) return;
  state.budgetReported = true;
  addGoogleToolSchemaLoss(state.report, "node-budget-widened");
}

function reportDroppedConstraints(node: Schema, state: SanitizeState): void {
  let numericBounds = 0;
  for (const key of NUMERIC_BOUND_KEYS) {
    if (Object.hasOwn(node, key)) numericBounds++;
  }
  addGoogleToolSchemaLoss(state.report, "numeric-bound-dropped", numericBounds);

  let sizeBounds = 0;
  for (const key of SIZE_BOUND_KEYS) {
    if (!Object.hasOwn(node, key)) continue;
    if ((key === "minLength" || key === "minItems" || key === "minProperties") && node[key] === 0) continue;
    sizeBounds++;
  }
  addGoogleToolSchemaLoss(state.report, "size-bound-dropped", sizeBounds);

  let unsupported = 0;
  for (const key of UNSUPPORTED_CONSTRAINT_KEYS) {
    if (!Object.hasOwn(node, key)) continue;
    if (key === "additionalProperties" && node[key] === true) continue;
    if (key === "uniqueItems" && node[key] === false) continue;
    unsupported++;
  }
  addGoogleToolSchemaLoss(state.report, "unsupported-constraint-dropped", unsupported);

  let conditionals = 0;
  for (const key of CONDITIONAL_KEYS) {
    if (Object.hasOwn(node, key)) conditionals++;
  }
  addGoogleToolSchemaLoss(state.report, "conditional-dropped", conditionals);
  if (Object.hasOwn(node, "prefixItems") && !(Array.isArray(node.prefixItems) && node.prefixItems.length === 0)) {
    addGoogleToolSchemaLoss(state.report, "tuple-prefix-dropped");
  }
}

function isRecord(value: unknown): value is Schema {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function resolveRef(ref: string, defs: Map<string, unknown>): unknown {
  // Only local pointers into the schema's own $defs/definitions are safe to inline.
  const match = /^#\/(?:\$defs|definitions)\/(.+)$/.exec(ref);
  if (!match) return undefined;
  try {
    return defs.get(decodeURIComponent(match[1].replace(/~1/g, "/").replace(/~0/g, "~")));
  } catch {
    return undefined;
  }
}

function collectDefs(root: unknown, defs: Map<string, unknown>): void {
  if (!isRecord(root)) return;
  for (const bag of ["$defs", "definitions"] as const) {
    const group = root[bag];
    if (!isRecord(group)) continue;
    for (const [name, value] of Object.entries(group)) {
      if (!defs.has(name)) defs.set(name, value);
    }
  }
}

interface BoundedEqualityState {
  remainingNodes: number;
}

/**
 * Exact JSON-value comparison with the sanitizer's own depth/node ceilings.
 * `unknown` means the cap prevented a proof; report-only mode does not count it as proven loss.
 */
type BoundedEquality = "equal" | "different" | "unknown";

function boundedJsonEqual(
  left: unknown,
  right: unknown,
  state: BoundedEqualityState = { remainingNodes: MAX_SCHEMA_NODES },
  depth = 0,
): BoundedEquality {
  if (Object.is(left, right)) return "equal";
  if (depth >= MAX_SCHEMA_DEPTH || state.remainingNodes <= 0) return "unknown";
  state.remainingNodes--;

  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return "different";
    for (let index = 0; index < left.length; index++) {
      if (state.remainingNodes <= 0) return "unknown";
      state.remainingNodes--;
      const comparison = boundedJsonEqual(left[index], right[index], state, depth + 1);
      if (comparison !== "equal") return comparison;
    }
    return "equal";
  }
  if (!isRecord(left) || !isRecord(right)) return "different";

  let leftCount = 0;
  for (const key in left) {
    if (!Object.hasOwn(left, key)) continue;
    if (state.remainingNodes <= 0) return "unknown";
    state.remainingNodes--;
    leftCount++;
    if (!Object.hasOwn(right, key)) return "different";
    const comparison = boundedJsonEqual(left[key], right[key], state, depth + 1);
    if (comparison !== "equal") return comparison;
  }
  let rightCount = 0;
  for (const key in right) {
    if (!Object.hasOwn(right, key)) continue;
    if (state.remainingNodes <= 0) return "unknown";
    state.remainingNodes--;
    rightCount++;
    if (rightCount > leftCount) return "different";
  }
  return leftCount === rightCount ? "equal" : "different";
}

function boundedStringSetEqual(
  left: unknown,
  right: unknown,
  normalize: (value: string) => string,
  state: BoundedEqualityState = { remainingNodes: MAX_SCHEMA_NODES },
): BoundedEquality {
  const leftValues = Array.isArray(left) ? left : [left];
  const rightValues = Array.isArray(right) ? right : [right];
  const collect = (values: unknown[]): Set<string> | undefined => {
    const result = new Set<string>();
    for (const value of values) {
      if (state.remainingNodes <= 0) return undefined;
      state.remainingNodes--;
      if (typeof value === "string") result.add(normalize(value));
    }
    return result;
  };
  const leftSet = collect(leftValues);
  const rightSet = collect(rightValues);
  if (!leftSet || !rightSet) return "unknown";
  if (leftSet.size !== rightSet.size) return "different";
  for (const value of leftSet) {
    if (!rightSet.has(value)) return "different";
  }
  return "equal";
}

function boundedJsonSetEqual(
  left: unknown[],
  right: unknown[],
  state: BoundedEqualityState = { remainingNodes: MAX_SCHEMA_NODES },
): BoundedEquality {
  const unique = (values: unknown[]): { comparison: BoundedEquality; values: unknown[] } => {
    const result: unknown[] = [];
    for (const value of values) {
      if (state.remainingNodes <= 0) return { comparison: "unknown", values: result };
      state.remainingNodes--;
      let duplicate = false;
      for (const candidate of result) {
        const comparison = boundedJsonEqual(value, candidate, state);
        if (comparison === "unknown") return { comparison, values: result };
        if (comparison === "equal") {
          duplicate = true;
          break;
        }
      }
      if (!duplicate) result.push(value);
    }
    return { comparison: "equal", values: result };
  };
  const leftUnique = unique(left);
  if (leftUnique.comparison !== "equal") return leftUnique.comparison;
  const rightUnique = unique(right);
  if (rightUnique.comparison !== "equal") return rightUnique.comparison;
  if (leftUnique.values.length !== rightUnique.values.length) return "different";
  const unmatched = [...rightUnique.values];
  for (const value of leftUnique.values) {
    let matched = -1;
    for (let index = 0; index < unmatched.length; index++) {
      const comparison = boundedJsonEqual(value, unmatched[index], state);
      if (comparison === "unknown") return comparison;
      if (comparison === "equal") {
        matched = index;
        break;
      }
    }
    if (matched < 0) return "different";
    unmatched.splice(matched, 1);
  }
  return "equal";
}

interface BoundedEnumOverlayAccounting {
  comparison: BoundedEquality;
  emittedWidensIntersection: boolean;
  filteredIntersectionValues: number;
}

function boundedEnumOverlayAccounting(
  target: unknown[],
  overlay: unknown[],
): BoundedEnumOverlayAccounting {
  const state: BoundedEqualityState = { remainingNodes: MAX_SCHEMA_NODES };
  const stringSet = (values: unknown[]): Set<string> | undefined => {
    const result = new Set<string>();
    for (const value of values) {
      if (state.remainingNodes <= 0) return undefined;
      state.remainingNodes--;
      if (typeof value === "string") result.add(value);
    }
    return result;
  };
  const targetStrings = stringSet(target);
  const emittedStrings = stringSet(overlay);
  if (!targetStrings || !emittedStrings) {
    return { comparison: "unknown", emittedWidensIntersection: false, filteredIntersectionValues: 0 };
  }

  let emittedWidensIntersection = false;
  for (const value of emittedStrings) {
    if (!targetStrings.has(value)) {
      emittedWidensIntersection = true;
      break;
    }
  }

  const uniqueFiltered: unknown[] = [];
  for (const value of overlay) {
    if (typeof value === "string") continue;
    if (state.remainingNodes <= 0) {
      return { comparison: "unknown", emittedWidensIntersection: false, filteredIntersectionValues: 0 };
    }
    state.remainingNodes--;
    let duplicate = false;
    for (const candidate of uniqueFiltered) {
      const comparison = boundedJsonEqual(value, candidate, state);
      if (comparison === "unknown") {
        return { comparison, emittedWidensIntersection: false, filteredIntersectionValues: 0 };
      }
      if (comparison === "equal") {
        duplicate = true;
        break;
      }
    }
    if (!duplicate) uniqueFiltered.push(value);
  }

  let filteredIntersectionValues = 0;
  for (const value of uniqueFiltered) {
    for (const candidate of target) {
      const comparison = boundedJsonEqual(value, candidate, state);
      if (comparison === "unknown") {
        return { comparison, emittedWidensIntersection: false, filteredIntersectionValues: 0 };
      }
      if (comparison === "equal") {
        filteredIntersectionValues++;
        break;
      }
    }
  }
  return { comparison: "equal", emittedWidensIntersection, filteredIntersectionValues };
}

function compareMergedValue(key: string, left: unknown, right: unknown): BoundedEquality {
  if (key === "enum" && Array.isArray(left) && Array.isArray(right)) {
    return boundedJsonSetEqual(left, right);
  }
  if (key === "required" && Array.isArray(left) && Array.isArray(right)) {
    if (left.every(value => typeof value === "string") && right.every(value => typeof value === "string")) {
      return boundedStringSetEqual(left, right, value => value);
    }
    return boundedJsonEqual(left, right);
  }
  if (key === "type") {
    const leftValues = Array.isArray(left) ? left : [left];
    const rightValues = Array.isArray(right) ? right : [right];
    if (leftValues.every(value => typeof value === "string")
      && rightValues.every(value => typeof value === "string")) {
      return boundedStringSetEqual(left, right, value => value.toLowerCase());
    }
    return boundedJsonEqual(left, right);
  }
  if (BOUNDED_VALUE_KEYS.has(key)) return boundedJsonEqual(left, right);
  return Object.is(left, right) ? "equal" : "different";
}

function mergeRefTarget(target: Schema, overlay: Schema, state: SanitizeState): Schema {
  const merged: Schema = {};
  if (Object.hasOwn(target, "$ref")) merged.$ref = target.$ref;
  for (const key of MERGED_SCHEMA_KEYS) {
    if (Object.hasOwn(overlay, key)) {
      if (key !== "description" && Object.hasOwn(target, key)) {
        if (key === "enum" && Array.isArray(target[key]) && Array.isArray(overlay[key])) {
          const accounting = boundedEnumOverlayAccounting(target[key], overlay[key]);
          if (accounting.comparison === "unknown") {
            addGoogleToolSchemaUncertainty(state.report);
          } else {
            if (accounting.emittedWidensIntersection) {
              addGoogleToolSchemaLoss(state.report, "ref-overlay-replaced");
            }
            addGoogleToolSchemaLoss(
              state.report,
              "enum-value-filtered",
              accounting.filteredIntersectionValues,
            );
          }
          // The intersection-aware accounting above owns this merged enum's filtering report.
          state.enumFilterLossOverrides.set(merged, 0);
        } else {
          const comparison = compareMergedValue(key, overlay[key], target[key]);
          if (comparison === "different") addGoogleToolSchemaLoss(state.report, "ref-overlay-replaced");
          else if (comparison === "unknown") addGoogleToolSchemaUncertainty(state.report);
        }
      }
      merged[key] = overlay[key];
    } else if (Object.hasOwn(target, key)) merged[key] = target[key];
  }
  return merged;
}

function normalizeType(
  value: unknown,
  out: Schema,
  preserveNullType: boolean,
  state: SanitizeState,
): void {
  const candidates = Array.isArray(value) ? value : [value];
  let sawNull = false;
  const nonNullTypes = new Set<string>();
  let unsupported = 0;
  if (Array.isArray(value) && value.length === 0) unsupported++;

  for (const candidate of candidates) {
    if (typeof candidate !== "string") {
      if (candidate !== undefined) unsupported++;
      continue;
    }
    const type = candidate.toLowerCase();
    if (type === "null") {
      sawNull = true;
    } else if (ALLOWED_TYPES.has(type)) {
      nonNullTypes.add(type);
      if (out.type === undefined) out.type = type;
    } else {
      unsupported++;
    }
  }

  addGoogleToolSchemaLoss(state.report, "unsupported-type-widened", unsupported);
  if (nonNullTypes.size > 1) addGoogleToolSchemaLoss(state.report, "type-union-collapsed");

  if (!sawNull) return;
  if (out.type !== undefined) out.nullable = true;
  else if (preserveNullType) out.type = "null";
  else {
    out.nullable = true;
    addGoogleToolSchemaLoss(state.report, "unsupported-type-widened");
  }
}

function sanitizeEnum(value: unknown, state?: SanitizeState, filteredLossOverride?: number): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const stringValues = value.filter((item): item is string => typeof item === "string");
  if (state) addGoogleToolSchemaLoss(
    state.report,
    "enum-value-filtered",
    filteredLossOverride ?? (value.length - stringValues.length),
  );
  const values = [...new Set(stringValues)];
  return values.length > 0 ? values : undefined;
}

function normalizeAnyOf(
  value: unknown,
  defs: Map<string, unknown>,
  depth: number,
  refDepth: number,
  state: SanitizeState,
): Schema {
  if (!Array.isArray(value) || value.length === 0) {
    addGoogleToolSchemaLoss(state.report, "invalid-schema-widened");
    return {};
  }
  const schemas: Schema[] = [];
  for (let index = 0; index < value.length; index++) {
    if (state.remainingNodes <= 0) {
      reportBudgetExhausted(state);
      return {};
    }
    const schema = sanitizeSchema(value[index], defs, depth + 1, refDepth, true, state);
    if (schema === BUDGET_EXHAUSTED) return {};
    schemas.push(schema);
  }

  const nonNullSchemas = schemas.filter(schema => schema.type !== "null");
  const nullSchemas = schemas.filter(schema => schema.type === "null");
  if (
    nonNullSchemas.length === 1
    && nullSchemas.length > 0
    && nullSchemas.every(schema => Object.keys(schema).every(key => key === "type"))
  ) {
    return { ...nonNullSchemas[0], nullable: true };
  }

  const type = schemas[0]?.type;
  const sameType = schemas.length > 0 && schemas.every(schema => schema.type === type);
  const enumOnly = schemas.every(schema => {
    const allowedKeys = type === undefined ? new Set(["enum"]) : new Set(["type", "enum"]);
    return Array.isArray(schema.enum) && Object.keys(schema).every(key => allowedKeys.has(key));
  });
  if (sameType && enumOnly && type !== "null") {
    const values = sanitizeEnum(schemas.flatMap(schema => schema.enum as unknown[]));
    if (values) return { ...(typeof type === "string" ? { type } : {}), enum: values };
  }

  // CCA's Claude bridge turns typed anyOf branches into an invalid input_schema. Widen only this
  // node when a union cannot be collapsed losslessly; parent annotations and structure survive.
  addGoogleToolSchemaLoss(state.report, "union-widened");
  return {};
}

function sanitizeProperties(
  value: unknown,
  defs: Map<string, unknown>,
  depth: number,
  refDepth: number,
  state: SanitizeState,
): Record<string, Schema> | undefined {
  if (!isRecord(value)) return undefined;
  const properties: Record<string, Schema> = Object.create(null) as Record<string, Schema>;
  for (const name in value) {
    if (!Object.hasOwn(value, name)) continue;
    if (state.remainingNodes <= 0) {
      reportBudgetExhausted(state);
      break;
    }
    // Property names form a name bag and must never be interpreted as schema keywords.
    const schema = sanitizeSchema(value[name], defs, depth + 1, refDepth, false, state);
    if (schema === BUDGET_EXHAUSTED) break;
    properties[name] = schema;
  }
  return properties;
}

function sanitizeSchema(
  node: unknown,
  defs: Map<string, unknown>,
  depth: number,
  refDepth: number,
  preserveNullType: boolean,
  state: SanitizeState,
): SanitizeResult {
  if (state.remainingNodes <= 0) {
    reportBudgetExhausted(state);
    return BUDGET_EXHAUSTED;
  }
  state.remainingNodes -= 1;
  if (depth >= MAX_SCHEMA_DEPTH) {
    addGoogleToolSchemaLoss(state.report, "depth-limit-widened");
    return {};
  }
  if (!isRecord(node)) {
    addGoogleToolSchemaLoss(state.report, "invalid-schema-widened");
    return {};
  }

  reportDroppedConstraints(node, state);

  if (Object.hasOwn(node, "$ref") && typeof node.$ref !== "string") {
    addGoogleToolSchemaLoss(state.report, "invalid-schema-widened");
  } else if (typeof node.$ref === "string" && refDepth >= MAX_DEREF_DEPTH) {
    addGoogleToolSchemaLoss(state.report, "dereference-limit-widened");
  } else if (typeof node.$ref === "string") {
    const target = resolveRef(node.$ref, defs);
    if (isRecord(target)) {
      if (state.activeRefs.has(node.$ref)) {
        addGoogleToolSchemaLoss(state.report, "recursive-ref-widened");
        return {};
      }
      state.activeRefs.add(node.$ref);
      // Constraints outside the merge allowlist are discarded here and must be counted before
      // selecting the safe view. Copied keys are deliberately excluded to avoid double counting.
      reportDroppedConstraints(target, state);
      // Select only inputs the sanitizer can consume. Spreading an untrusted definition here would
      // enumerate and allocate every unsupported annotation before the node budget can stop work.
      const merged = mergeRefTarget(target, node, state);
      try {
        return sanitizeSchema(merged, defs, depth, refDepth + 1, preserveNullType, state);
      } finally {
        state.activeRefs.delete(node.$ref);
      }
    } else {
      addGoogleToolSchemaLoss(state.report, "invalid-schema-widened");
    }
  }

  const out: Schema = {};
  if (Object.hasOwn(node, "type") && node.type === undefined) {
    addGoogleToolSchemaLoss(state.report, "unsupported-type-widened");
  }
  normalizeType(node.type, out, preserveNullType, state);

  const typeIncludesNull = (Array.isArray(node.type) ? node.type : [node.type])
    .some(candidate => typeof candidate === "string" && candidate.toLowerCase() === "null");
  if (node.nullable === false && typeIncludesNull) {
    addGoogleToolSchemaLoss(state.report, "nullability-overridden");
  }
  if (typeof node.nullable === "boolean") out.nullable = node.nullable;
  else if (Object.hasOwn(node, "nullable")) addGoogleToolSchemaLoss(state.report, "invalid-schema-widened");
  if (typeof node.description === "string") out.description = node.description;
  if (typeof node.format === "string") out.format = node.format;
  else if (Object.hasOwn(node, "format")) addGoogleToolSchemaLoss(state.report, "invalid-schema-widened");

  if (Object.hasOwn(node, "enum") && !Array.isArray(node.enum)) {
    addGoogleToolSchemaLoss(state.report, "invalid-schema-widened");
  } else if (Array.isArray(node.enum) && node.enum.length === 0) {
    addGoogleToolSchemaLoss(state.report, "enum-constraint-dropped");
  }
  if (Object.hasOwn(node, "const")) {
    if (typeof node.const !== "string") {
      addGoogleToolSchemaLoss(state.report, "const-value-filtered");
    } else if (Object.hasOwn(node, "enum")) {
      const enumValues = Array.isArray(node.enum)
        ? [...new Set(node.enum.filter((item): item is string => typeof item === "string"))]
        : [];
      if (enumValues.length !== 1 || enumValues[0] !== node.const) {
        addGoogleToolSchemaLoss(state.report, "const-value-filtered");
      }
    }
  }
  const enumValues = sanitizeEnum(
    node.enum ?? (typeof node.const === "string" ? [node.const] : undefined),
    state,
    state.enumFilterLossOverrides.get(node),
  );
  if (enumValues) out.enum = enumValues;

  if (Object.hasOwn(node, "properties") && !isRecord(node.properties)) {
    addGoogleToolSchemaLoss(state.report, "invalid-schema-widened");
  }
  const properties = sanitizeProperties(node.properties, defs, depth, refDepth, state);
  if (properties) out.properties = properties;

  if (properties && Array.isArray(node.required)) {
    const stringRequired = node.required.filter((item): item is string => typeof item === "string");
    const uniqueRequired = [...new Set(stringRequired)];
    const required = uniqueRequired.filter(item => Object.hasOwn(properties, item));
    addGoogleToolSchemaLoss(
      state.report,
      "unsupported-constraint-dropped",
      uniqueRequired.length - required.length,
    );
    addGoogleToolSchemaLoss(state.report, "invalid-schema-widened", node.required.length - stringRequired.length);
    if (required.length > 0) out.required = required;
  } else if (!properties && Array.isArray(node.required)) {
    const stringRequired = node.required.filter((item): item is string => typeof item === "string");
    const required = new Set(stringRequired);
    addGoogleToolSchemaLoss(state.report, "unsupported-constraint-dropped", required.size);
    addGoogleToolSchemaLoss(state.report, "invalid-schema-widened", node.required.length - stringRequired.length);
  } else if (Object.hasOwn(node, "required") && !Array.isArray(node.required)) {
    addGoogleToolSchemaLoss(state.report, "invalid-schema-widened");
  }

  if (state.remainingNodes <= 0) {
    if (Object.hasOwn(node, "items") || Object.hasOwn(node, "anyOf")) reportBudgetExhausted(state);
    return out;
  }

  if (Array.isArray(node.items)) {
    addGoogleToolSchemaLoss(state.report, "tuple-prefix-dropped");
  } else if (isRecord(node.items)) {
    const items = sanitizeSchema(node.items, defs, depth + 1, refDepth, false, state);
    if (items !== BUDGET_EXHAUSTED) out.items = items;
  } else if (Object.hasOwn(node, "items")) {
    addGoogleToolSchemaLoss(state.report, "invalid-schema-widened");
  }

  if (state.remainingNodes <= 0) {
    if (Object.hasOwn(node, "anyOf")) reportBudgetExhausted(state);
    return out;
  }
  if (Object.hasOwn(node, "anyOf")) {
    const normalized = normalizeAnyOf(node.anyOf, defs, depth, refDepth, state);
    for (const key of RETAINED_UNION_KEYS) {
      if (Object.hasOwn(out, key) && Object.hasOwn(normalized, key)
      ) {
        const comparison = compareMergedValue(key, out[key], normalized[key]);
        if (comparison === "different") addGoogleToolSchemaLoss(state.report, "union-sibling-replaced");
        else if (comparison === "unknown") addGoogleToolSchemaUncertainty(state.report);
      }
    }
    Object.assign(out, normalized);
  }
  return out;
}

export function sanitizeGeminiToolParametersWithReport(
  parameters: unknown,
  profile: GoogleToolSchemaProfile,
): GoogleToolSchemaSanitizeResult {
  const report = createGoogleToolSchemaLossReport(profile);
  if (parameters === undefined) {
    return { parameters: { type: "object", properties: {} }, lossReport: report };
  }
  try {
    const defs = new Map<string, unknown>();
    collectDefs(parameters, defs);
    const state: SanitizeState = {
      activeRefs: new Set(),
      remainingNodes: MAX_SCHEMA_NODES,
      budgetReported: false,
      enumFilterLossOverrides: new WeakMap(),
      report,
    };
    if (isRecord(parameters)) {
      for (const bag of ["$defs", "definitions"] as const) {
        if (Object.hasOwn(parameters, bag) && !isRecord(parameters[bag])) {
          addGoogleToolSchemaLoss(report, "invalid-schema-widened");
        }
      }
    }
    const sanitized = sanitizeSchema(parameters, defs, 0, 0, false, state);
    const root = sanitized === BUDGET_EXHAUSTED ? {} : sanitized;

    // Function arguments are always an object. Claude additionally rejects root composition and a
    // missing root type even when those forms are valid general-purpose JSON Schema.
    if (root.type !== "object") addGoogleToolSchemaLoss(report, "root-object-coerced");
    root.type = "object";
    if (!isRecord(root.properties)) root.properties = {};
    return { parameters: root, lossReport: report };
  } catch {
    // Last-resort containment: no third-party schema may break every tool in the request.
    addGoogleToolSchemaLoss(report, "invalid-schema-widened");
    return { parameters: { type: "object", properties: {} }, lossReport: report };
  }
}

export function sanitizeGeminiToolParameters(parameters: unknown): Record<string, unknown> {
  return sanitizeGeminiToolParametersWithReport(parameters, { endpointClass: "ai-studio" }).parameters;
}
