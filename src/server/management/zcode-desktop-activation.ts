import { saveConfigPreservingClaudeCode, withConfigMutationLockSync } from "../../config";
import { readCatalog, readCodexCatalogPath, catalogModelSlug, applyProviderConfigHints } from "../../codex/catalog";
import { clearModelCache } from "../../codex/model-cache";
import { reconcileLiveStateStores } from "../../lib/state-store-registrations";
import type { ManagementContext } from "./context";
import type { desktopStatus } from "../../adapters/zcode/desktop";

type DesktopStatus = ReturnType<typeof desktopStatus>;
export const readDesktopCatalogSlugs = (): string[] => (readCatalog(readCodexCatalogPath())?.models ?? [])
  .filter(row => row.visibility === "list").map(row => String(row.slug));

function providerName(ctx: ManagementContext): string | undefined {
  const matches = Object.keys(ctx.config.providers).filter(name => ctx.config.providers[name]?.adapter === "zcode");
  if (matches.includes("zcode")) return "zcode";
  return matches.length === 1 ? matches[0] : undefined;
}

/** Read actual persisted catalog evidence, not just a successful protocol or cache flush. */
export function desktopActivation(ctx: ManagementContext, status: DesktopStatus, readSlugs = readDesktopCatalogSlugs) {
  const name = providerName(ctx);
  const provider = name ? ctx.config.providers[name] : undefined;
  const registered = !!provider && provider.disabled !== true && provider.authMode === "local";
  let catalogReady = false;
  try {
    const slugs = new Set(readSlugs());
    catalogReady = registered && status.models.length > 0 && status.models.every(model => slugs.has(
      catalogModelSlug(applyProviderConfigHints(name!, provider!, { id: model.id, provider: name! })),
    ));
  } catch { /* Unreadable catalog is partial, never success. */ }
  return { ...status, providerName: name, providerRegistered: registered,
    activation: !status.connected ? "disconnected" : !registered ? "provider_pending" : !catalogReady ? "catalog_pending" : "ready" };
}

export async function activateDesktopProvider(ctx: ManagementContext, status: DesktopStatus, readSlugs = readDesktopCatalogSlugs) {
  if (!status.connected) return desktopActivation(ctx, status, readSlugs);
  let name: string;
  try {
    withConfigMutationLockSync(() => {
      name = providerName(ctx) ?? "zcode";
      const existing = ctx.config.providers[name];
      if ((!providerName(ctx) && Object.values(ctx.config.providers).some(p => p.adapter === "zcode"))
        || (existing && (existing.adapter !== "zcode" || existing.authMode !== "local"))) throw new Error("provider conflict");
      // Reconnection only enables the existing provider. Never replace its custom settings,
      // explicit model filters, pricing, alias or defaults with a form/preset payload.
      const next = existing ? { ...existing, disabled: false }
        : { adapter: "zcode" as const, authMode: "local" as const, baseUrl: "https://zcode.z.ai", disabled: false };
      try {
        ctx.config.providers[name] = next;
        (ctx.deps.saveConfigPreservingClaudeCode ?? saveConfigPreservingClaudeCode)(ctx.config);
      } catch (error) {
        if (existing) ctx.config.providers[name] = existing; else delete ctx.config.providers[name];
        throw error;
      }
    });
    reconcileLiveStateStores();
    clearModelCache(name!);
  } catch {
    return { ...desktopActivation(ctx, status, readSlugs), activation: "provider_pending", error: "provider_registration_failed" };
  }
  try {
    const result = await ctx.convergeCodexCatalog();
    const current = desktopActivation(ctx, status, readSlugs);
    if (result.status !== "committed" || current.activation !== "ready") {
      return { ...current, activation: "catalog_pending", error: "catalog_update_failed" };
    }
    return current;
  } catch {
    return { ...desktopActivation(ctx, status, readSlugs), activation: "catalog_pending", error: "catalog_update_failed" };
  }
}
