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
  return { cookie, accountId };
}

function record(value: unknown): Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

/** Read only the main chat roster; researcher and other agent menus are different products. */
export function parseM365ModelBootstrap(html: string): { accountId: string; items: ProviderModelsApiItem[] } {
  const quoted = html.match(/window\.__staticRouterHydrationData\s*=\s*JSON\.parse\(\s*("(?:[^"\\]|\\.)*")\s*\)/)?.[1];
  if (!quoted) throw new Error("Microsoft 365 Copilot model discovery requires web sign-in");
  let root: Record<string, any>;
  try { root = record(record(record(JSON.parse(JSON.parse(quoted))).loaderData).root); }
  catch { throw new Error("Microsoft 365 Copilot returned invalid model metadata"); }
  const account = record(record(root.store).accountInfo);
  if (!guid.test(account.objectId) || !guid.test(account.tenantId)) throw new Error("Microsoft 365 Copilot returned no work-account identity");
  const queries = record(root.__queryState).queries;
  if (!Array.isArray(queries) || queries.length > 256) throw new Error("Microsoft 365 Copilot returned invalid model metadata");
  const metadata = queries.map(q => record(record(record(q).state).data).bizchatAsAgentGpt?.clientPreferences?.modelSelectorMetadata).find(Boolean);
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
      items.push({ id: row.id, name, input_modalities: ["text"], m365_disabled: row.disabled === true });
    }
  };
  walk(options, 0);
  return { accountId: account.objectId + "@" + account.tenantId, items };
}

export async function readM365ModelBootstrap(response: Response, expectedAccountId: string, signal?: AbortSignal) {
  const read = await readBoundedResponseBytes(response, { maxBytes: 2 * 1024 * 1024, signal });
  if (read.oversized) throw new Error("Microsoft 365 Copilot model metadata exceeds its limits");
  const result = parseM365ModelBootstrap(new TextDecoder().decode(read.bytes));
  if (result.accountId.toLowerCase() !== expectedAccountId.toLowerCase()) throw new Error("Microsoft 365 Copilot model discovery account mismatch");
  return result.items;
}
