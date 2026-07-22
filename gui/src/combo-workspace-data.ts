/**
 * Pure view-model helpers for the Combos workspace.
 * No network — transforms GET /api/combos rows into rail groups + attention.
 */

export type ComboStrategy = "failover" | "round-robin";
export type ComboEffort = "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

export const COMBO_EFFORTS: ComboEffort[] = ["low", "medium", "high", "xhigh", "max", "ultra"];

export interface ComboTarget {
  provider: string;
  model: string;
  weight?: number;
}

export interface ComboItem {
  id: string;
  /** Wire id shown to clients, e.g. combo/free */
  model: string;
  /** Optional public model name replacing the default combo/<id> slug; null = default. */
  alias: string | null;
  strategy: ComboStrategy;
  stickyLimit: number;
  defaultEffort: ComboEffort | null;
  targets: ComboTarget[];
}

export interface ComboSections {
  failover: ComboItem[];
  roundRobin: ComboItem[];
}

export interface ComboAttentionItem {
  id: string;
  model: string;
  reason: "few-targets" | "empty-targets";
}

export const COMBO_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
/** One optional "/" segment, each segment id-shaped — mirrors src/combos/types.ts. */
export const COMBO_ALIAS_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}(\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,63})?$/;
const NATIVE_OPENAI_FAMILY_RE = /^(?:gpt-|o1-|o3-|o4-|codex-)/;

export function isValidComboId(id: string): boolean {
  return COMBO_ID_RE.test(id.trim());
}

export function comboModelId(id: string): string {
  return `combo/${id.trim()}`;
}

/** Public model id clients request: the alias when set, else the default combo/<id>. */
export function comboPublicModelId(id: string, alias: string | null | undefined): string {
  const trimmed = typeof alias === "string" ? alias.trim() : "";
  return trimmed || comboModelId(id);
}

function normalizeAlias(raw: unknown): string | null {
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

export function normalizeStrategy(raw: unknown): ComboStrategy {
  return raw === "round-robin" ? "round-robin" : "failover";
}

export function normalizeStickyLimit(raw: unknown): number {
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 1 && raw <= 100
    ? raw
    : 1;
}

export function normalizeDefaultEffort(raw: unknown): ComboEffort | null {
  return typeof raw === "string" && (COMBO_EFFORTS as string[]).includes(raw)
    ? (raw as ComboEffort)
    : null;
}

export function normalizeWeight(raw: unknown): number | undefined {
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 1 && raw <= 10000
    ? raw
    : undefined;
}

export function parseComboList(payload: unknown): ComboItem[] {
  if (!payload || typeof payload !== "object") return [];
  const rows = (payload as { combos?: unknown }).combos;
  if (!Array.isArray(rows)) return [];
  const out: ComboItem[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const id = typeof r.id === "string" ? r.id.trim() : "";
    if (!id) continue;
    const targetsRaw = Array.isArray(r.targets) ? r.targets : [];
    const targets: ComboTarget[] = [];
    for (const t of targetsRaw) {
      if (!t || typeof t !== "object") continue;
      const tr = t as Record<string, unknown>;
      const provider = typeof tr.provider === "string" ? tr.provider.trim() : "";
      const model = typeof tr.model === "string" ? tr.model.trim() : "";
      if (!provider || !model) continue;
      const weight = normalizeWeight(tr.weight);
      targets.push(weight !== undefined ? { provider, model, weight } : { provider, model });
    }
    out.push({
      id,
      model: typeof r.model === "string" && r.model.trim()
        ? r.model.trim()
        : comboPublicModelId(id, normalizeAlias(r.alias)),
      alias: normalizeAlias(r.alias),
      strategy: normalizeStrategy(r.strategy),
      stickyLimit: normalizeStickyLimit(r.stickyLimit),
      defaultEffort: normalizeDefaultEffort(r.defaultEffort),
      targets,
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id, undefined, { sensitivity: "base" }));
}

export function groupCombos(items: ComboItem[]): ComboSections {
  const failover: ComboItem[] = [];
  const roundRobin: ComboItem[] = [];
  for (const item of items) {
    if (item.strategy === "round-robin") roundRobin.push(item);
    else failover.push(item);
  }
  return { failover, roundRobin };
}

export function filterCombos(items: ComboItem[], query: string): ComboItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter((item) => {
    if (item.id.toLowerCase().includes(q)) return true;
    if (item.model.toLowerCase().includes(q)) return true;
    return item.targets.some(
      (t) => t.provider.toLowerCase().includes(q) || t.model.toLowerCase().includes(q),
    );
  });
}

export function buildComboAttention(items: ComboItem[]): ComboAttentionItem[] {
  const out: ComboAttentionItem[] = [];
  for (const item of items) {
    if (item.targets.length === 0) {
      out.push({ id: item.id, model: item.model, reason: "empty-targets" });
    } else if (item.targets.length < 2) {
      out.push({ id: item.id, model: item.model, reason: "few-targets" });
    }
  }
  return out;
}

export function draftEquals(a: ComboItem, b: ComboItem): boolean {
  if (
    a.id !== b.id
    || a.alias !== b.alias
    || a.strategy !== b.strategy
    || a.stickyLimit !== b.stickyLimit
    || a.defaultEffort !== b.defaultEffort
  ) return false;
  if (a.targets.length !== b.targets.length) return false;
  return a.targets.every((t, i) => {
    const o = b.targets[i]!;
    return t.provider === o.provider && t.model === o.model && (t.weight ?? 1) === (o.weight ?? 1);
  });
}

export function toPutBody(item: ComboItem, options: { renameFrom?: string } = {}): {
  id: string;
  renameFrom?: string;
  combo: {
    targets: ComboTarget[];
    strategy: ComboStrategy;
    stickyLimit?: number;
    defaultEffort: ComboEffort | null;
    alias?: string;
  };
} {
  return {
    id: item.id.trim(),
    ...(options.renameFrom ? { renameFrom: options.renameFrom } : {}),
    combo: {
      targets: item.targets.map((target) => item.strategy === "round-robin"
        ? { provider: target.provider.trim(), model: target.model.trim(), weight: target.weight ?? 1 }
        : { provider: target.provider.trim(), model: target.model.trim() }),
      strategy: item.strategy,
      defaultEffort: item.defaultEffort,
      ...(item.strategy === "round-robin" ? { stickyLimit: item.stickyLimit } : {}),
      ...(item.alias && item.alias.trim() ? { alias: item.alias.trim() } : {}),
    },
  };
}

export type ComboDraftError =
  | "missingId"
  | "invalidId"
  | "duplicateId"
  | "reservedNamespace"
  | "providerCollision"
  | "invalidAlias"
  | "aliasReservedNamespace"
  | "aliasNativeFamily"
  | "duplicateAlias"
  | "noTargets"
  | "incompleteTarget"
  | "unknownProvider"
  | "duplicateTarget"
  | "invalidStickyLimit"
  | "invalidWeight"
  | "noEnabledTarget";

export function validateComboDraft(
  item: ComboItem,
  options: {
    existingIds: readonly string[];
    /** Aliases already taken by OTHER combos (callers exclude the edited combo). */
    existingAliases?: readonly string[];
    isCreate: boolean;
    providers: Readonly<Record<string, { disabled?: boolean }>>;
  },
): ComboDraftError | null {
  const id = item.id.trim();
  if (!id) return "missingId";
  if (!isValidComboId(id)) return "invalidId";
  // Callers pass other combos' ids (create: all; edit: all but self), so a rename
  // into an occupied id is caught here too.
  if (options.existingIds.includes(id)) return "duplicateId";
  if (Object.hasOwn(options.providers, "combo")) return "reservedNamespace";
  if (Object.hasOwn(options.providers, id)) return "providerCollision";

  const alias = item.alias?.trim() ?? "";
  if (alias) {
    if (!COMBO_ALIAS_RE.test(alias)) return "invalidAlias";
    if (alias === "combo" || alias.startsWith("combo/")) return "aliasReservedNamespace";
    if (!alias.includes("/") && NATIVE_OPENAI_FAMILY_RE.test(alias)) return "aliasNativeFamily";
    if ((options.existingAliases ?? []).includes(alias)) return "duplicateAlias";
  }
  if (item.targets.length < 1) return "noTargets";

  for (const t of item.targets) {
    if (!t.provider.trim() || !t.model.trim()) return "incompleteTarget";
    if (!Object.hasOwn(options.providers, t.provider.trim())) return "unknownProvider";
  }

  const targets = new Set<string>();
  for (const target of item.targets) {
    const key = `${target.provider.trim()}/${target.model.trim()}`;
    if (targets.has(key)) return "duplicateTarget";
    targets.add(key);
  }

  if (item.strategy === "round-robin") {
    if (!Number.isInteger(item.stickyLimit) || item.stickyLimit < 1 || item.stickyLimit > 100) {
      return "invalidStickyLimit";
    }
    for (const target of item.targets) {
      const weight = target.weight ?? 1;
      if (!Number.isInteger(weight) || weight < 1 || weight > 10000) return "invalidWeight";
    }
  }

  if (!item.targets.some((target) => options.providers[target.provider.trim()]?.disabled !== true)) {
    return "noEnabledTarget";
  }
  return null;
}

export function emptyDraft(id = ""): ComboItem {
  return {
    id,
    model: id ? comboModelId(id) : "combo/",
    alias: null,
    strategy: "failover",
    stickyLimit: 1,
    defaultEffort: null,
    targets: [{ provider: "", model: "" }],
  };
}
