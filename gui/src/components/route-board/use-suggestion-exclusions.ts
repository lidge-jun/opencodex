/**
 * The providers the suggested combos leave out, kept in config.json
 * (`comboSuggestionExcludedProviders`, `GET|PUT /api/combo-suggestions`) so the choice follows
 * the operator across browsers.
 */
import { useEffect, useRef, useState } from "react";
import type { ComboItem } from "../../combo-workspace-data";

interface SuggestionPolicy {
  excludedProviders: string[];
  meteredComboIds: string[];
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function parse(body: unknown): SuggestionPolicy | null {
  if (!body || typeof body !== "object" || !("excludedProviders" in body) || !("meteredComboIds" in body)) return null;
  const { excludedProviders, meteredComboIds } = body;
  return isStringList(excludedProviders) && isStringList(meteredComboIds) ? { excludedProviders, meteredComboIds } : null;
}

export function useSuggestionExclusions(apiBase: string, active = true, combos?: readonly ComboItem[]) {
  const retry = () => setAttempt((value) => value + 1);
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<{ base: string; attempt: number; policy: SuggestionPolicy | null }>();
  const current = active && loaded?.base === apiBase && loaded.attempt === attempt ? loaded : undefined;
  // Bumped by every save, so a read that started earlier cannot overwrite what was saved.
  const generation = useRef(0);

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    const started = generation.current;
    void fetch(`${apiBase}/api/combo-suggestions`, { signal: controller.signal })
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => {
        const list = parse(body);
        if (controller.signal.aborted || generation.current !== started) return;
        setLoaded({ base: apiBase, attempt, policy: list });
      })
      .catch(() => {
        if (!controller.signal.aborted && generation.current === started) {
          setLoaded({ base: apiBase, attempt, policy: null });
        }
      });
    return () => controller.abort();
  }, [apiBase, active, attempt, combos]);

  const save = async (provider: string, excluded: boolean) => {
    if (!current?.policy) return false;
    const started = ++generation.current;
    try {
      const response = await fetch(`${apiBase}/api/combo-suggestions`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, excluded }),
      });
      if (response.status === 409 && generation.current === started) {
        setAttempt((value) => value + 1);
        return false;
      }
      const list = response.ok ? parse(await response.json()) : null;
      if (!list || generation.current !== started) return false;
      setLoaded({ base: apiBase, attempt, policy: list });
      return true;
    } catch {
      return false;
    }
  };

  return {
    excluded: current?.policy?.excludedProviders ?? [],
    meteredComboIds: current?.policy?.meteredComboIds ?? [],
    ready: current?.policy != null,
    failed: current?.policy === null,
    retry,
    save,
  };
}
