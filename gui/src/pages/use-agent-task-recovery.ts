import { useCallback, useEffect, useRef, useState } from "react";
import { readJsonOrThrow } from "../fetch-json";

type RecoveryResponse = { enabled?: boolean };

export function useAgentTaskRecovery(apiBase: string) {
  const [enabled, setEnabled] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const operationRef = useRef(0);
  const activeSaveRef = useRef<number | null>(null);

  const load = useCallback(async () => {
    const operation = ++operationRef.current;
    try {
      const response = await fetch(`${apiBase}/api/agent-task-recovery`);
      const data = await readJsonOrThrow<RecoveryResponse>(response);
      if (operation !== operationRef.current) return false;
      setEnabled(data?.enabled === true);
      setLoadFailed(false);
      return true;
    } catch {
      if (operation === operationRef.current) setLoadFailed(true);
      return false;
    }
  }, [apiBase]);

  useEffect(() => {
    void Promise.resolve().then(load);
    return () => { operationRef.current += 1; };
  }, [load]);

  const save = useCallback(async (next: boolean) => {
    if (activeSaveRef.current !== null) return false;
    const operation = ++operationRef.current;
    activeSaveRef.current = operation;
    setSaving(true);
    try {
      const response = await fetch(`${apiBase}/api/agent-task-recovery`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      await readJsonOrThrow<RecoveryResponse>(response);
      if (operation === operationRef.current) {
        setEnabled(next);
        setLoadFailed(false);
      }
      return true;
    } catch {
      return false;
    } finally {
      if (activeSaveRef.current === operation) {
        activeSaveRef.current = null;
        setSaving(false);
      }
    }
  }, [apiBase]);

  const retry = useCallback(() => { void load(); }, [load]);

  return { enabled, saving, loadFailed, save, retry };
}
