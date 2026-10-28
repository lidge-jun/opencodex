/**
 * Runtime verification results for the client support page.
 *
 * scripts/client-support-matrix/runtime-verified.json records that a person ran one exact client
 * product version against one opencodex version for a stated scenario, on a stated date, with a link to
 * the evidence. It is a reviewed human claim: the generator validates its shape and renders it, but it
 * cannot re-run the scenario or prove that the linked page is public or shows success. The file is
 * required and starts empty; adding a result is a reviewed change like any other.
 */

export const RUNTIME_SCHEMA_VERSION = 1;

export interface RuntimeResult {
  client: string;
  /** The product variant that was run, e.g. "Codex CLI"; one row can group several products. */
  product: string;
  clientVersion: string;
  opencodexVersion: string;
  /** Calendar date, YYYY-MM-DD. */
  verifiedOn: string;
  /** The operation that was exercised, e.g. "streamed chat with one tool call". */
  scenario: string;
  /** https URL of the evidence (a pull request, issue or CI run). */
  evidence: string;
}

export interface SelectedRuntimeResult {
  result: RuntimeResult;
  /** Other recorded results for the same client that are not shown. */
  others: number;
}

const TEXT_FIELDS = ["client", "product", "clientVersion", "opencodexVersion", "verifiedOn", "scenario", "evidence"] as const;
// Characters that would break or inject Markdown/HTML in a table cell or link label.
const UNSAFE_TEXT = /[\u0000-\u001f\u007f|[\]<>`()\\]/;

function isRealDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function evidenceProblem(value: string): string | undefined {
  if (/[\s<>()\u0000-\u001f\u007f]/.test(value)) return "contains whitespace, angle brackets, parentheses or control characters";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "is not a URL";
  }
  if (url.protocol !== "https:") return "must use https";
  if (url.username || url.password) return "must not carry credentials";
  if (!url.hostname.includes(".")) return "must name a public host";
  return undefined;
}

/**
 * Parse and validate the runtime results file. `knownIds` is the set of rows the page renders.
 * Returns every problem found rather than stopping at the first.
 */
export function parseRuntimeResults(text: string | undefined, knownIds: ReadonlySet<string>, source = "runtime-verified.json"): { results: RuntimeResult[]; problems: string[] } {
  if (text === undefined) return { results: [], problems: [`${source} is missing; it is required (an empty "results" array is valid)`] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { results: [], problems: [`${source} is not valid JSON: ${(error as Error).message}`] };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { results: [], problems: [`${source} must be an object with schemaVersion and results`] };
  }
  const root = parsed as Record<string, unknown>;
  const problems: string[] = [];
  if (root.schemaVersion !== RUNTIME_SCHEMA_VERSION) problems.push(`${source}: schemaVersion must be ${RUNTIME_SCHEMA_VERSION}`);
  const extraKeys = Object.keys(root).filter(key => key !== "schemaVersion" && key !== "results");
  if (extraKeys.length > 0) problems.push(`${source}: unknown top-level keys ${extraKeys.join(", ")}`);
  if (!Array.isArray(root.results)) {
    problems.push(`${source}: results must be an array`);
    return { results: [], problems };
  }
  const results: RuntimeResult[] = [];
  const seen = new Set<string>();
  root.results.forEach((entry, index) => {
    const at = `${source} results[${index}]`;
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      problems.push(`${at} must be an object`);
      return;
    }
    const record = entry as Record<string, unknown>;
    const unknown = Object.keys(record).filter(key => !(TEXT_FIELDS as readonly string[]).includes(key));
    if (unknown.length > 0) problems.push(`${at}: unknown keys ${unknown.join(", ")}`);
    let valid = unknown.length === 0;
    for (const field of TEXT_FIELDS) {
      const value = record[field];
      if (typeof value !== "string" || value.trim() === "" || value !== value.trim()) {
        problems.push(`${at}.${field} must be a non-empty string without surrounding whitespace`);
        valid = false;
      } else if (field !== "evidence" && UNSAFE_TEXT.test(value)) {
        problems.push(`${at}.${field} contains characters that cannot appear in the table (| [ ] < > \` ( ) \\ or control characters)`);
        valid = false;
      }
    }
    if (!valid) return;
    const result = record as unknown as RuntimeResult;
    if (!knownIds.has(result.client)) {
      problems.push(`${at}.client "${result.client}" is not a row on the client support page`);
      return;
    }
    if (!isRealDate(result.verifiedOn)) {
      problems.push(`${at}.verifiedOn "${result.verifiedOn}" is not a real YYYY-MM-DD date`);
      return;
    }
    const evidence = evidenceProblem(result.evidence);
    if (evidence) {
      problems.push(`${at}.evidence ${evidence}`);
      return;
    }
    const key = [result.client, result.product, result.clientVersion, result.opencodexVersion, result.scenario, result.verifiedOn].join("\u0000");
    if (seen.has(key)) {
      problems.push(`${at} duplicates an earlier result for ${result.client} (same product, versions, scenario and date)`);
      return;
    }
    seen.add(key);
    results.push(result);
  });
  return { results, problems };
}

/** The most recently verified result per client; ties break on product, versions and scenario. */
export function selectRuntimeResults(results: readonly RuntimeResult[]): Map<string, SelectedRuntimeResult> {
  const byClient = new Map<string, RuntimeResult[]>();
  for (const result of results) byClient.set(result.client, [...(byClient.get(result.client) ?? []), result]);
  const selected = new Map<string, SelectedRuntimeResult>();
  for (const [client, list] of byClient) {
    const ordered = [...list].sort((a, b) =>
      b.verifiedOn.localeCompare(a.verifiedOn)
      || a.product.localeCompare(b.product)
      || a.clientVersion.localeCompare(b.clientVersion)
      || a.opencodexVersion.localeCompare(b.opencodexVersion)
      || a.scenario.localeCompare(b.scenario));
    selected.set(client, { result: ordered[0]!, others: ordered.length - 1 });
  }
  return selected;
}
