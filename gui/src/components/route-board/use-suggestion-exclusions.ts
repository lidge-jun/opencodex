/**
 * The providers the suggested combos leave out, kept in config.json
 * (`comboSuggestionExcludedProviders`, `GET|PUT /api/combo-suggestions`) so the choice follows
 * the operator across browsers.
 */
import { useCallback, useEffect, useRef, useState } from "react";

export interface SuggestionExclusions {
  excluded: readonly string[];
  /** True once the stored list is known; a save before that would replace it with a partial one. */
  ready: boolean;
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
  const [ready, setReady] = useState(false);
  // Bumped by every save, so a read that started earlier cannot overwrite what was saved.
  const generation = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    const started = generation.current;
    void fetch(`${apiBase}/api/combo-suggestions`, { signal: controller.signal })
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => {
        const list = parse(body);
        if (!list || generation.current !== started) return;
        setExcluded(list);
        setReady(true);
      })
      // An older proxy without the route: nothing is excluded and the control stays hidden.
      .catch(() => {});
    return () => controller.abort();
  }, [apiBase]);

  const save = useCallback(async (next: readonly string[]) => {
    generation.current += 1;
    try {
      const response = await fetch(`${apiBase}/api/combo-suggestions`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ excludedProviders: next }),
      });
      const list = response.ok ? parse(await response.json()) : null;
      if (!list) return false;
      setExcluded(list);
      setReady(true);
      return true;
    } catch {
      return false;
    }
  }, [apiBase]);

  return { excluded, ready, save };
}
