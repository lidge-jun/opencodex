import { useCallback, useEffect, useState } from "react";
import { readJsonOrThrow } from "../fetch-json";

type RecoveryResponse = { enabled?: boolean };

export function useAgentTaskRecovery(apiBase: string) {
  const [enabled, setEnabled] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);

  const load = useCallback(async () => {
    const response = await fetch(`${apiBase}/api/agent-task-recovery`);
    const data = await readJsonOrThrow<RecoveryResponse>(response);
    setEnabled(data?.enabled === true);
    setLoadFailed(false);
  }, [apiBase]);

  useEffect(() => {
    let active = true;
    void fetch(`${apiBase}/api/agent-task-recovery`)
      .then(response => readJsonOrThrow<RecoveryResponse>(response))
      .then(data => {
        if (!active) return;
        setEnabled(data?.enabled === true);
        setLoadFailed(false);
      })
      .catch(() => { if (active) setLoadFailed(true); });
    return () => { active = false; };
  }, [apiBase]);

  const save = useCallback(async (next: boolean) => {
    if (saving) return false;
    setSaving(true);
    try {
      const response = await fetch(`${apiBase}/api/agent-task-recovery`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      await readJsonOrThrow<RecoveryResponse>(response);
      setEnabled(next);
      setLoadFailed(false);
      return true;
    } catch {
      return false;
    } finally {
      setSaving(false);
    }
  }, [apiBase, saving]);

  return { enabled, saving, loadFailed, save, retry: load };
}
