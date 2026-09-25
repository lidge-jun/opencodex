import type { OcxClaudeCodeConfig } from "../../types";

/**
 * First-party model bindings for Claude Code traffic that reaches opencodex through the local
 * intercept pair (Claude Desktop's Code tab and the standalone `claude` CLI in first-party mode).
 *
 * In first-party mode Claude Desktop's Code tab picker is owned by claude.ai: its rows come from
 * the account's model selector config and no local setting can add one. What opencodex does see
 * is the picker's Anthropic model id on every Messages request. A binding maps such an id
 * (`claude-sonnet-4-6`) to an opencodex route (`xai/grok-4.7`), so picking that row in Desktop is
 * served by the bound model. The picker keeps Anthropic's label; the binding only changes which
 * model answers.
 *
 * Bindings live in `claudeCode.intercept.modelMap` and apply ONLY to requests that arrived on the
 * `claude-intercept` ingress. They are overlaid on the global `claudeCode.modelMap` for that one
 * request (binding wins per key), so every existing resolution rule still applies: alias first,
 * Desktop 3P alias, exact key, date-suffix-stripped key, `[1m]` strip and `--fast` decode. The
 * overlay is a request-scoped view of `claudeCode`; the live config object is never copied or
 * persisted with the merged map.
 */

/** Anthropic picker id shape. Desktop only ever sends `claude-*` ids from its picker. */
const BINDING_ID_PATTERN = /^claude-[a-z0-9][a-z0-9.\-]*$/i;
const MAX_BINDING_ID_LENGTH = 128;
const MAX_BINDING_ROUTE_LENGTH = 256;
const NATIVE_ROUTE_PREFIX = "native/";

/**
 * Picker ids Claude Desktop's Code tab offered on 2026-09-23 (the claude.ai model selector config
 * for a Max account). claude.ai owns this list; it is a suggestion for the dashboard, never a
 * restriction, so any `claude-` id is accepted.
 */
export const DESKTOP_PICKER_ID_SUGGESTIONS: readonly string[] = [
  "claude-opus-5-5",
  "claude-sonnet-5",
  "claude-fable-5-1",
  "claude-haiku-4-5",
  "claude-opus-5",
  "claude-fable-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-4-6",
];

export function isInterceptBindingId(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_BINDING_ID_LENGTH && BINDING_ID_PATTERN.test(value);
}

export function isInterceptBindingRoute(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_BINDING_ROUTE_LENGTH && !/\s/.test(value);
}

/**
 * Router model id for a binding target written in the Desktop route vocabulary. `native/<slug>`
 * is the native OpenAI pool's pseudo-provider and resolves to the bare slug, exactly like a
 * Desktop 3P alias does (src/claude/inbound-model-options.ts); every other route is used as is.
 */
export function normalizeBindingTarget(route: string): string {
  return route.startsWith(NATIVE_ROUTE_PREFIX) && route.length > NATIVE_ROUTE_PREFIX.length
    ? route.slice(NATIVE_ROUTE_PREFIX.length)
    : route;
}

/** Valid bindings from a config value; malformed entries are ignored rather than routed. */
export function readInterceptBindings(cc: OcxClaudeCodeConfig | undefined): Record<string, string> {
  const raw = cc?.intercept?.modelMap;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [id, route] of Object.entries(raw)) {
    if (isInterceptBindingId(id) && isInterceptBindingRoute(route)) out[id] = route;
  }
  return out;
}

/**
 * The `claudeCode` view a Messages or count_tokens handler resolves models against. Requests on
 * any other ingress, or with no bindings, get the live object back unchanged. Only binding
 * targets are normalized; global `modelMap` values keep their verbatim semantics.
 */
export function claudeCodeForIngress(
  cc: OcxClaudeCodeConfig | undefined,
  claudeIntercept: boolean,
): OcxClaudeCodeConfig | undefined {
  if (!claudeIntercept) return cc;
  const bindings = readInterceptBindings(cc);
  const ids = Object.keys(bindings);
  if (ids.length === 0) return cc;
  const overlay: Record<string, string> = { ...(cc?.modelMap ?? {}) };
  for (const id of ids) overlay[id] = normalizeBindingTarget(bindings[id]!);
  return { ...(cc ?? {}), modelMap: overlay };
}

export interface InterceptBindingPatch {
  set?: Record<string, string>;
  remove?: string[];
}

export type InterceptBindingPatchResult =
  | { ok: true; bindings: Record<string, string>; changed: boolean }
  | { ok: false; error: string };

/** Parse an untrusted PUT body into a patch. */
export function parseInterceptBindingPatch(body: unknown): InterceptBindingPatch | { error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "body must be an object" };
  const { set, remove, ...rest } = body as Record<string, unknown>;
  const unknown = Object.keys(rest);
  if (unknown.length > 0) return { error: `unknown field: ${unknown[0]}` };
  if (set === undefined && remove === undefined) return { error: "set or remove is required" };
  const patch: InterceptBindingPatch = {};
  if (set !== undefined) {
    if (!set || typeof set !== "object" || Array.isArray(set)) return { error: "set must be an object of picker id to route" };
    const entries: Record<string, string> = {};
    for (const [id, route] of Object.entries(set as Record<string, unknown>)) {
      if (!isInterceptBindingId(id)) return { error: `invalid picker id: ${id} (expected a claude- model id)` };
      if (!isInterceptBindingRoute(route)) return { error: `invalid route for ${id}` };
      entries[id] = route;
    }
    patch.set = entries;
  }
  if (remove !== undefined) {
    if (!Array.isArray(remove) || remove.some(id => typeof id !== "string")) return { error: "remove must be an array of picker ids" };
    patch.remove = remove as string[];
  }
  return patch;
}

/**
 * Apply a patch to the current bindings. Routes must be in `availableRoutes` (the Desktop route
 * vocabulary, native routes included); removing an unbound id is a no-op.
 */
export function applyInterceptBindingPatch(
  current: Record<string, string>,
  patch: InterceptBindingPatch,
  availableRoutes: ReadonlySet<string>,
): InterceptBindingPatchResult {
  const next: Record<string, string> = { ...current };
  for (const [id, route] of Object.entries(patch.set ?? {})) {
    if (!availableRoutes.has(route)) return { ok: false, error: `route is not available: ${route}` };
    next[id] = route;
  }
  for (const id of patch.remove ?? []) delete next[id];
  const changed = JSON.stringify(Object.entries(next).sort()) !== JSON.stringify(Object.entries(current).sort());
  return { ok: true, bindings: next, changed };
}
