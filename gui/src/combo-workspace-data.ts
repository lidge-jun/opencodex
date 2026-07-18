/**
 * Pure view-model helpers for the Combos workspace.
 * No network — transforms GET /api/combos rows into rail groups + attention.
 */

export type ComboStrategy = "failover" | "round-robin";
export type ComboEffort = "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

export const COMBO_EFFORTS: ComboEffort[] = ["low", "medium", "high", "xhigh", "max", "ultra"];
export const COMBO_DEFAULT_EFFORT: ComboEffort = "medium";

export interface ComboTarget {
  provider: string;
  model: string;
  weight?: number;
}

export interface ComboItem {
  id: string;
  /** Wire id shown to clients, e.g. combo/free */
  model: string;
  strategy: ComboStrategy;
  stickyLimit: number;
  defaultEffort: ComboEffort;
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

export function isValidComboId(id: string): boolean {
  return COMBO_ID_RE.test(id.trim());
}

export function comboModelId(id: string): string {
  return `combo/${id.trim()}`;
}

export function normalizeStrategy(raw: unknown): ComboStrategy {
  return raw === "round-robin" ? "round-robin" : "failover";
}

export function normalizeStickyLimit(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(100, Math.floor(n));
}

export function normalizeDefaultEffort(raw: unknown): ComboEffort {
  return typeof raw === "string" && (COMBO_EFFORTS as string[]).includes(raw)
    ? (raw as ComboEffort)
    : COMBO_DEFAULT_EFFORT;
}

export function normalizeWeight(raw: unknown): number | undefined {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n < 1) return undefined;
  return Math.min(10000, Math.floor(n));
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
      model: typeof r.model === "string" && r.model.trim() ? r.model.trim() : comboModelId(id),
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

export function toPutBody(item: ComboItem): {
  id: string;
  combo: {
    targets: ComboTarget[];
    strategy: ComboStrategy;
    stickyLimit?: number;
    defaultEffort: ComboEffort;
  };
} {
  const targets = item.targets.map((t) => {
    const weight = item.strategy === "round-robin" ? normalizeWeight(t.weight ?? 1) : undefined;
    return weight !== undefined
      ? { provider: t.provider.trim(), model: t.model.trim(), weight }
      : { provider: t.provider.trim(), model: t.model.trim() };
  });
  return {
    id: item.id.trim(),
    combo: {
      targets,
      strategy: item.strategy,
      defaultEffort: normalizeDefaultEffort(item.defaultEffort),
      ...(item.strategy === "round-robin" ? { stickyLimit: normalizeStickyLimit(item.stickyLimit) } : {}),
    },
  };
}

export type ComboDraftError =
  | "missingId"
  | "invalidId"
  | "duplicateId"
  | "noTargets"
  | "incompleteTarget";

export function validateComboDraft(
  item: ComboItem,
  existingIds: string[],
  isCreate: boolean,
): ComboDraftError | null {
  const id = item.id.trim();
  if (!id) return "missingId";
  if (!isValidComboId(id)) return "invalidId";
  if (isCreate && existingIds.includes(id)) return "duplicateId";
  if (item.targets.length < 1) return "noTargets";
  for (const t of item.targets) {
    if (!t.provider.trim() || !t.model.trim()) return "incompleteTarget";
  }
  return null;
}

export function emptyDraft(id = ""): ComboItem {
  return {
    id,
    model: id ? comboModelId(id) : "combo/",
    strategy: "failover",
    stickyLimit: 1,
    defaultEffort: COMBO_DEFAULT_EFFORT,
    targets: [{ provider: "", model: "" }],
  };
}

type ProviderLike = {
  authMode?: string;
  adapter?: string;
  baseUrl?: string;
};

/** True for the built-in ChatGPT passthrough (Codex login) surface. */
function isChatGptForwardProvider(name: string, p: ProviderLike): boolean {
  const id = name.toLowerCase();
  if (id !== "openai" && id !== "chatgpt") return false;
  if ((p.authMode ?? "").toLowerCase() !== "forward") return false;
  if ((p.adapter ?? "").toLowerCase() !== "openai-responses") return false;
  try {
    const u = new URL(p.baseUrl ?? "");
    const base = u.origin + u.pathname.replace(/\/+$/, "");
    return base === "https://chatgpt.com/backend-api/codex";
  } catch {
    return (p.baseUrl ?? "").replace(/\/+$/, "") === "https://chatgpt.com/backend-api/codex";
  }
}

/**
 * Hide redundant `chatgpt` when canonical `openai` already covers the same
 * ChatGPT passthrough — Combos target picker should show one ChatGPT row.
 */
export function hideRedundantChatGptForwardProviders<T extends ProviderLike>(
  providers: Record<string, T>,
): Record<string, T> {
  const openai = providers.openai;
  const chatgpt = providers.chatgpt;
  if (!openai || !chatgpt) return providers;
  if (!isChatGptForwardProvider("openai", openai)) return providers;
  if (!isChatGptForwardProvider("chatgpt", chatgpt)) return providers;
  const rest = { ...providers };
  delete rest.chatgpt;
  return rest;
}
