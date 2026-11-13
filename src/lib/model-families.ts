// Model family registry: the one table that says which family a model belongs to and where that
// family sits in a grouped picker. Pure and dependency-free so the proxy, the CLI and the GUI
// bundle all import this same file instead of keeping their own copy of the rules.

export const MODEL_FAMILY_IDS = [
  "gpt", "gemini", "claude", "grok", "deepseek",
  "qwen", "kimi", "glm", "minimax", "llama", "mistral",
  "other",
] as const;
export type ModelFamilyId = (typeof MODEL_FAMILY_IDS)[number];

export interface ModelFamily {
  readonly id: ModelFamilyId;
  /** Brand name. Brands are not translated; the GUI localizes only the `other` label. */
  readonly label: string;
  readonly test: RegExp;
}

/**
 * Table order is both the display order of the families and the precedence of the rules: the
 * first match wins, so `deepseek-r1-distill-qwen` is DeepSeek, not Qwen. `other` matches
 * nothing by test and is the fallback; it stays last.
 */
export const MODEL_FAMILIES: readonly ModelFamily[] = [
  { id: "gpt", label: "GPT", test: /\bgpt|\bo[134](?:\b|-)|\bchatgpt/ },
  { id: "gemini", label: "Gemini", test: /gemini/ },
  { id: "claude", label: "Claude", test: /claude|\b(?:opus|sonnet|haiku|fable)\b/ },
  { id: "grok", label: "Grok", test: /grok/ },
  { id: "deepseek", label: "DeepSeek", test: /deepseek/ },
  { id: "qwen", label: "Qwen", test: /qwen|\bqwq\b/ },
  { id: "kimi", label: "Kimi", test: /kimi|moonshot/ },
  { id: "glm", label: "GLM", test: /glm/ },
  { id: "minimax", label: "MiniMax", test: /minimax/ },
  { id: "llama", label: "Llama", test: /\bllama/ },
  { id: "mistral", label: "Mistral", test: /mistral|mixtral|codestral|devstral|magistral/ },
  { id: "other", label: "Other", test: /(?!)/ },
];

const RANK = new Map<ModelFamilyId, number>(MODEL_FAMILIES.map((family, index) => [family.id, index]));
const OTHER = MODEL_FAMILIES[MODEL_FAMILIES.length - 1]!;

function firstMatch(text: string): ModelFamily | undefined {
  return MODEL_FAMILIES.find(family => family.test.test(text));
}

/**
 * Family of a model slug. The part after the first `/` is tested first, so a provider prefix
 * such as `claude-sub/` cannot decide the family of `claude-sub/gpt-6`. Only when that part
 * names no family is the whole slug tried, which lets a provider named for a family
 * (`kimi-coding/turbo`) place its otherwise anonymous models. A combo classifies by its own
 * name, so a name that mentions no family lands in `other`.
 */
export function modelFamily(slug: string): ModelFamily {
  const text = slug.toLowerCase();
  const slash = text.indexOf("/");
  return (slash >= 0 ? firstMatch(text.slice(slash + 1)) : undefined) ?? firstMatch(text) ?? OTHER;
}

/** Position of the slug's family in the display order; lower sorts first. */
export function modelFamilyRank(slug: string): number {
  return RANK.get(modelFamily(slug).id)!;
}

/** Families in display order, with each family's models in their original order. Empty families are omitted. */
export function groupByModelFamily<T>(items: readonly T[], slugOf: (item: T) => string): { family: ModelFamily; items: T[] }[] {
  const buckets = new Map<ModelFamilyId, T[]>();
  for (const item of items) {
    const id = modelFamily(slugOf(item)).id;
    const bucket = buckets.get(id);
    if (bucket) bucket.push(item); else buckets.set(id, [item]);
  }
  return MODEL_FAMILIES.flatMap(family => {
    const bucket = buckets.get(family.id);
    return bucket ? [{ family, items: bucket }] : [];
  });
}
