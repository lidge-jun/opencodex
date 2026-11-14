/**
 * The providers the suggested combos leave out, kept in config.json
 * (`comboSuggestionExcludedProviders`, `GET|PUT /api/combo-suggestions`) so the choice follows
 * the operator across browsers.
 */
import { useCallback, useEffect, useState } from "react";

export interface SuggestionExclusions {
  excluded: readonly string[];
  /** Saves the whole list; resolves false when the proxy did not take it (the list stays as it was). */
  save: (next: readonly string[]) => Promise<boolean>;
}

function parse(body: unknown): string[] | null {
  if (!body || typeof body !== "object" || !("excludedProviders" in body)) return null;
  const list = (body as { excludedProviders: unknown }).excludedProviders;
  return Array.isArray(list) ? list.filter((name): name is string => typeof name === "string") : null;
}

export function useSuggestionExclusions(apiBase: string): SuggestionExclusions {
  const [excluded, setExcluded] = useState<readonly string[]>([]);

  useEffect(() => {
    const controller = new AbortController();
    void fetch(`${apiBase}/api/combo-suggestions`, { signal: controller.signal })
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => {
        const list = parse(body);
        if (list) setExcluded(list);
      })
      // An older proxy without the route: nothing is excluded.
      .catch(() => {});
    return () => controller.abort();
  }, [apiBase]);

  const save = useCallback(async (next: readonly string[]) => {
    try {
      const response = await fetch(`${apiBase}/api/combo-suggestions`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ excludedProviders: next }),
      });
      const list = response.ok ? parse(await response.json()) : null;
      if (!list) return false;
      setExcluded(list);
      return true;
    } catch {
      return false;
    }
  }, [apiBase]);

  return { excluded, save };
}
