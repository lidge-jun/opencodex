import { readBoundedResponseBytes } from "../lib/bounded-body";
import type { M365CopilotWebSession } from "../oauth/types";
import type { ProviderModelsApiItem } from "./model-discovery";

export const M365_COPILOT_WEB_URL = "https://copilot.cloud.microsoft/chat/";
export const M365_COPILOT_WEB_COOKIE_NAMES = /^(?:OhpAuth(?:C\d+)?|OhpToken|SSRUserType)$/;
const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const M365_NATIVE_MODEL_ID = /^[A-Z][A-Za-z0-9_]{0,159}$/;

export function normalizeM365WebSession(value: unknown): M365CopilotWebSession | undefined {
  if (!value || typeof value !== "object") return;
  const { cookie, accountId } = value as M365CopilotWebSession;
  if (typeof accountId !== "string" || accountId.split("@").length !== 2 || !accountId.split("@").every(id => guid.test(id))) return;
  if (typeof cookie !== "string" || !cookie || cookie.length > 32_768 || /[\x00-\x1f\x7f]/.test(cookie)) return;
  const parts = cookie.split("; ");
  if (parts.length > 16 || !parts.some(p => p.startsWith("OhpAuth=")) || parts.some(p => {
    const i = p.indexOf("=");
    return i < 1 || !M365_COPILOT_WEB_COOKIE_NAMES.test(p.slice(0, i)) || !/^[\x21-\x2b\x2d-\x3a\x3c-\x7e]+$/.test(p.slice(i + 1));
  })) return;
  const roster = normalizeM365Roster((value as M365CopilotWebSession).roster);
  return roster ? { cookie, accountId, roster } : { cookie, accountId };
}

function record(value: unknown): Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

/** The hydration global Microsoft's chat shell embeds in its server HTML. */
function hydrationRoot(html: string): Record<string, any> {
  const quoted = html.match(/window\.__staticRouterHydrationData\s*=\s*JSON\.parse\(\s*("(?:[^"\\]|\\.)*")\s*\)/)?.[1];
  if (!quoted) throw new Error("Microsoft 365 Copilot model discovery requires web sign-in");
  try { return record(record(record(JSON.parse(JSON.parse(quoted))).loaderData).root); }
  catch { throw new Error("Microsoft 365 Copilot returned invalid model metadata"); }
}

/** Read only the main chat roster; researcher and other agent menus are different products. */
function m365RosterFromMetadata(metadata: unknown): ProviderModelsApiItem[] {
  const options = record(metadata).availableModelSelectionOptions;
  if (!Array.isArray(options)) throw new Error("Microsoft 365 Copilot returned no chat model roster");
  const items: ProviderModelsApiItem[] = [], seen = new Set<string>();
  let count = 0;
  const walk = (rows: unknown[], depth: number) => {
    if (depth > 8) throw new Error("Microsoft 365 Copilot model metadata exceeds its limits");
    for (const raw of rows) {
      if (++count > 256) throw new Error("Microsoft 365 Copilot model metadata exceeds its limits");
      const row = record(raw);
      if (row.type === "itemGroup" && Array.isArray(row.itemGroup)) { walk(row.itemGroup, depth + 1); continue; }
      if (row.type !== "item" || typeof row.id !== "string" || row.id.length > 160 || !M365_NATIVE_MODEL_ID.test(row.id)) throw new Error("Microsoft 365 Copilot returned an invalid model selector");
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      const name = typeof row.menuItemTitle === "string" && row.menuItemTitle.length <= 256 && !/[\x00-\x1f\x7f]/.test(row.menuItemTitle) ? row.menuItemTitle : row.id;
      // A daily quota block does not remove the model from the account's entitlement roster.
      // The picker has no per-model modality field; chat selectors share the image attachment protocol.
      items.push({ id: row.id, name, input_modalities: ["text", "image"], m365_disabled: row.disabled === true });
    }
  };
  walk(options, 0);
  return items;
}

/** Identity-only read for sign-in: no roster requirement, so a changed picker never blocks login. */
export function m365BootstrapAccountId(html: string): string {
  try {
    const account = record(record(hydrationRoot(html)).store).accountInfo;
    return guid.test(account.objectId) && guid.test(account.tenantId) ? account.objectId + "@" + account.tenantId : "";
  } catch { return ""; }
}

export function parseM365ModelBootstrap(html: string): { accountId: string; items: ProviderModelsApiItem[] } {
  const root = hydrationRoot(html);
  const account = record(record(root.store).accountInfo);
  if (!guid.test(account.objectId) || !guid.test(account.tenantId)) throw new Error("Microsoft 365 Copilot returned no work-account identity");
  const queries = record(root.__queryState).queries;
  if (!Array.isArray(queries) || queries.length > 256) throw new Error("Microsoft 365 Copilot returned invalid model metadata");
  const metadata = queries.map(q => record(record(record(q).state).data).bizchatAsAgentGpt?.clientPreferences?.modelSelectorMetadata).find(Boolean);
  return { accountId: account.objectId + "@" + account.tenantId, items: m365RosterFromMetadata(metadata) };
}

function findSelectorMetadata(value: unknown, depth: number, fromBizchat: boolean, requireBizchat: boolean): Record<string, any> | undefined {
  if (depth > 12) return undefined;
  if (Array.isArray(value)) {
    if (value.length > 4_096) return undefined;
    for (const entry of value) { const found = findSelectorMetadata(entry, depth + 1, fromBizchat, requireBizchat); if (found) return found; }
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const row = value as Record<string, any>;
  if (Array.isArray(row.availableModelSelectionOptions) && (!requireBizchat || fromBizchat)) return row;
  const keys = Object.keys(row);
  if (keys.length > 4_096) return undefined;
  for (const key of keys) {
    const found = findSelectorMetadata(row[key], depth + 1, fromBizchat || key === "bizchatAsAgentGpt", requireBizchat);
    if (found) return found;
  }
  return undefined;
}

/** Roster read for bodies captured live in the sign-in browser: raw API JSON or the hydrated HTML shell. */
export function parseM365RosterBody(text: string): ProviderModelsApiItem[] | undefined {
  let value: unknown;
  try { value = JSON.parse(text); }
  catch {
    const quoted = text.match(/window\.__staticRouterHydrationData\s*=\s*JSON\.parse\(\s*("(?:[^"\\]|\\.)*")\s*\)/)?.[1];
    if (!quoted) return undefined;
    try { value = JSON.parse(JSON.parse(quoted)); } catch { return undefined; }
  }
  const metadata = findSelectorMetadata(value, 0, false, true) ?? findSelectorMetadata(value, 0, false, false);
  if (!metadata) return undefined;
  try { return m365RosterFromMetadata(metadata); } catch { return undefined; }
}

/** Stored rosters keep the bootstrap item shape so both discovery sources feed the catalog identically. */
export function normalizeM365Roster(value: unknown): ProviderModelsApiItem[] | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > 256) return undefined;
  const items: ProviderModelsApiItem[] = [], seen = new Set<string>();
  for (const raw of value) {
    const row = record(raw);
    if (typeof row.id !== "string" || row.id.length > 160 || !M365_NATIVE_MODEL_ID.test(row.id) || seen.has(row.id)) return undefined;
    if (typeof row.name !== "string" || row.name.length > 256 || /[\x00-\x1f\x7f]/.test(row.name)) return undefined;
    if (row.m365_disabled !== undefined && row.m365_disabled !== true && row.m365_disabled !== false) return undefined;
    seen.add(row.id);
    items.push({ id: row.id, name: row.name, input_modalities: ["text", "image"], m365_disabled: row.m365_disabled === true });
  }
  return items;
}

export async function readM365ModelBootstrap(response: Response, expectedAccountId: string, signal?: AbortSignal) {
  const read = await readBoundedResponseBytes(response, { maxBytes: 2 * 1024 * 1024, signal });
  if (read.oversized) throw new Error("Microsoft 365 Copilot model metadata exceeds its limits");
  const result = parseM365ModelBootstrap(new TextDecoder().decode(read.bytes));
  if (result.accountId.toLowerCase() !== expectedAccountId.toLowerCase()) throw new Error("Microsoft 365 Copilot model discovery account mismatch");
  return result.items;
}
