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

export function useSuggestionExclusions(apiBase: string, combos?: readonly ComboItem[]) {
  const retry = () => setAttempt((value) => value + 1);
  const [saving, setSaving] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<{ base: string; attempt: number; combos?: readonly ComboItem[]; policy: SuggestionPolicy | null }>();
  const cached = loaded?.base === apiBase ? loaded : undefined;
  const current = cached?.attempt === attempt && cached.combos === combos ? cached : undefined;
  // Only the latest policy read can publish.
  const generation = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    const started = ++generation.current;
    void fetch(`${apiBase}/api/combo-suggestions`, { signal: controller.signal })
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => {
        const list = parse(body);
        if (controller.signal.aborted || generation.current !== started) return;
        setLoaded({ base: apiBase, attempt, combos, policy: list });
      })
      .catch(() => {
        if (!controller.signal.aborted && generation.current === started) {
          setLoaded({ base: apiBase, attempt, combos, policy: null });
        }
      });
    return () => controller.abort();
  }, [apiBase, attempt, combos]);

  const save = async (provider: string, excluded: boolean) => {
    if (saving || !current?.policy) return false;
    setSaving(true);
    try {
      const response = await fetch(`${apiBase}/api/combo-suggestions`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, excluded }),
      });
      return response.ok;
    } catch {
      return false;
    } finally {
      retry();
      setSaving(false);
    }
  };

  return {
    excluded: cached?.policy?.excludedProviders ?? [],
    meteredComboIds: cached?.policy?.meteredComboIds ?? [],
    available: cached?.policy != null,
    ready: !saving && current?.policy != null,
    failed: !saving && current?.policy === null,
    retry,
    save,
  };
}
