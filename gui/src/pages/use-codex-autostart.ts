/**
 * "Start opencodex when Codex launches" — the launcher shim's autostart preference
 * (`/api/settings` codexAutoStart). It was a dashboard card; it is startup policy, so it
 * sits with the shim and service rows on the Startup page. The read goes through the
 * shared client-resource layer (no polling); the write is an optimistic PUT.
 */
import { useCallback, useState } from "react";
import { useKeyedClientResource } from "../client-resource";

async function readAutostart(apiBase: string, signal: AbortSignal): Promise<boolean> {
  const res = await fetch(`${apiBase}/api/settings`, { signal });
  if (!res.ok) throw new Error("settings unavailable");
  const data = await res.json() as { codexAutoStart?: boolean };
  return data.codexAutoStart ?? true;
}

export function useCodexAutostart(apiBase: string) {
  const read = useKeyedClientResource(`codex-autostart:${apiBase}`, [apiBase], (signal) => readAutostart(apiBase, signal));
  const [override, setOverride] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const enabled: boolean | null = override ?? read.data ?? null;

  const toggle = useCallback(async () => {
    if (enabled === null || saving) return;
    const next = !enabled;
    setSaving(true);
    setOverride(next);
    try {
      const res = await fetch(`${apiBase}/api/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ codexAutoStart: next }),
      });
      if (!res.ok) throw new Error("save failed");
      const data = await res.json() as { codexAutoStart?: boolean };
      setOverride(data.codexAutoStart ?? next);
    } catch {
      setOverride(!next);
    } finally {
      setSaving(false);
    }
  }, [apiBase, enabled, saving]);

  return { enabled, saving, toggle };
}
