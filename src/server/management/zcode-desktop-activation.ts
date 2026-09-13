import { readAccount } from "../../adapters/zcode/accounts";
import { saveConfigPreservingClaudeCode, withConfigMutationLockSync } from "../../config";
import { readCatalog, readCodexCatalogPath, catalogModelSlug, applyProviderConfigHints, filterCatalogVisibleModels } from "../../codex/catalog";
import { clearModelCache } from "../../codex/model-cache";
import { reconcileLiveStateStores } from "../../lib/state-store-registrations";
import type { ManagementContext } from "./context";
import type { desktopStatus } from "../../adapters/zcode/desktop";

type DesktopStatus = ReturnType<typeof desktopStatus>;
export const readDesktopCatalogSlugs = (): string[] => (readCatalog(readCodexCatalogPath())?.models ?? [])
  .filter(row => row.visibility === "list").map(row => String(row.slug));

function providerNames(ctx: ManagementContext, accountId?: string): string[] {
  return Object.keys(ctx.config.providers).filter(name => ctx.config.providers[name]?.adapter === "zcode" && ctx.config.providers[name]?.zcodeAccountId === accountId);
}

function providerName(ctx: ManagementContext, accountId?: string): string | undefined {
  const matches = providerNames(ctx, accountId);
  return matches.length === 1 ? matches[0] : undefined;
}

/** Read actual persisted catalog evidence, not just a successful protocol or cache flush. */
export function desktopActivation(ctx: ManagementContext, status: DesktopStatus, readSlugs = readDesktopCatalogSlugs) {
  const name = providerName(ctx, status.accountId);
  const provider = name ? ctx.config.providers[name] : undefined;
  const registered = !!provider && provider.disabled !== true && provider.authMode === "local";
  let catalogReady = false;
  try {
    const slugs = new Set(readSlugs());
    const expected = registered ? filterCatalogVisibleModels(status.models.map(model =>
      applyProviderConfigHints(name!, provider!, { id: model.id, provider: name! })), ctx.config) : [];
    catalogReady = registered && status.models.length > 0 && expected.every(model => slugs.has(catalogModelSlug(model)));
  } catch { /* Unreadable catalog is partial, never success. */ }
  return { ...status, providerName: name, providerRegistered: registered,
    activation: !status.connected ? "disconnected" : !registered ? "provider_pending" : !catalogReady ? "catalog_pending" : "ready" };
}

export async function activateDesktopProvider(ctx: ManagementContext, status: DesktopStatus, readSlugs = readDesktopCatalogSlugs) {
  if (!status.connected) return desktopActivation(ctx, status, readSlugs);
  let name: string;
  try {
    withConfigMutationLockSync(() => {
      name = providerName(ctx, status.accountId) ?? (status.accountId ? `zcode-${status.accountId}` : "zcode");
      const existing = ctx.config.providers[name];
      if ((!providerName(ctx, status.accountId) && Object.values(ctx.config.providers).some(p => p.adapter === "zcode" && p.zcodeAccountId === status.accountId))
        || (existing && (existing.adapter !== "zcode" || existing.authMode !== "local" || existing.zcodeAccountId !== status.accountId))) throw new Error("provider conflict");
      // Reconnection only enables the existing provider. Never replace its custom settings,
      // explicit model filters, pricing, alias or defaults with a form/preset payload.
      const next = existing ? { ...existing, disabled: false }
        : { adapter: "zcode" as const, authMode: "local" as const, baseUrl: "https://zcode.z.ai", disabled: false, ...(status.accountId ? { zcodeAccountId: status.accountId, modelDisplayNames: Object.fromEntries(status.models.map(m => [m.id, `${readAccount(status.accountId!).label} / ${m.label}`])) } : {}) };
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

/** Revoke catalog visibility without deleting customized provider settings. */
export async function deactivateDesktopProvider(ctx: ManagementContext, status: DesktopStatus, readSlugs = readDesktopCatalogSlugs) {
  const names = providerNames(ctx, status.accountId);
  if (names.length) {
    try {
      const enabled = names.filter(name => ctx.config.providers[name]?.disabled !== true);
      if (enabled.length) {
        withConfigMutationLockSync(() => {
          const previous = new Map(enabled.map(name => [name, ctx.config.providers[name]!]));
          try {
            for (const [name, provider] of previous) ctx.config.providers[name] = { ...provider, disabled: true };
            (ctx.deps.saveConfigPreservingClaudeCode ?? saveConfigPreservingClaudeCode)(ctx.config);
          } catch (error) {
            for (const [name, provider] of previous) ctx.config.providers[name] = provider;
            throw error;
          }
        });
        reconcileLiveStateStores();
      }
      for (const name of names) clearModelCache(name);
    } catch {
      return { ...desktopActivation(ctx, status, readSlugs), error: "provider_registration_failed" };
    }
  }
  try {
    const result = await ctx.convergeCodexCatalog();
    if (result.status !== "committed") {
      return { ...desktopActivation(ctx, status, readSlugs), error: "catalog_update_failed" };
    }
    return desktopActivation(ctx, status, readSlugs);
  } catch {
    return { ...desktopActivation(ctx, status, readSlugs), error: "catalog_update_failed" };
  }
}
