/**
 * "Start opencodex when Codex launches" — the launcher shim's autostart preference
 * (`/api/settings` codexAutoStart). It was a dashboard card; it is startup policy, so it
 * sits with the shim and service rows on the Startup page. Self-contained fetch + PUT.
 */
import { useCallback, useEffect, useState } from "react";

export function useCodexAutostart(apiBase: string) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetch(`${apiBase}/api/settings`, { signal: controller.signal });
        if (!res.ok) return;
        const data = await res.json() as { codexAutoStart?: boolean };
        if (controller.signal.aborted) return;
        setEnabled(data.codexAutoStart ?? true);
      } catch { /* unknown until the next fetch */ }
    })();
    return () => controller.abort();
  }, [apiBase]);

  const toggle = useCallback(async () => {
    if (enabled === null || saving) return;
    const next = !enabled;
    setSaving(true);
    setEnabled(next);
    try {
      const res = await fetch(`${apiBase}/api/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ codexAutoStart: next }),
      });
      if (!res.ok) throw new Error("save failed");
      const data = await res.json() as { codexAutoStart?: boolean };
      setEnabled(data.codexAutoStart ?? next);
    } catch {
      setEnabled(!next);
    } finally {
      setSaving(false);
    }
  }, [apiBase, enabled, saving]);

  return { enabled, saving, toggle };
}
