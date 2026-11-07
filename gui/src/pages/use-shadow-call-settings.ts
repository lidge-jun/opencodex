import { useCallback, useState } from "react";
import { createBoundedFetch } from "../bounded-fetch";
import { readJsonIfOk } from "../fetch-json";
import type { TFn } from "../i18n/shared";
import { shadowCallSaveErrorKey, type ShadowCallData } from "./models-shared";

/** Load and persist the Models workspace's shadow-call settings. */
export function useShadowCallSettings({
  apiBase, publishFeedback, t,
}: {
  apiBase: string;
  publishFeedback: (ok: boolean, message: string) => void;
  t: TFn;
}) {
  const [shadowCall, setShadowCall] = useState<ShadowCallData | null>(null);
  const [shadowCallSaving, setShadowCallSaving] = useState(false);

  const loadShadowCall = useCallback(async () => {
    const bounded = createBoundedFetch(15_000);
    try {
      const r = await fetch(`${apiBase}/api/shadow-call-settings`, { signal: bounded.signal });
      const data = await readJsonIfOk<ShadowCallData>(r);
      if (data) setShadowCall(data);
    } catch { /* old server / network: keep the section disabled */ }
    finally { bounded.clear(); }
  }, [apiBase]);

  const saveShadowCall = async (patch: Partial<ShadowCallData>) => {
    if (!shadowCall || shadowCallSaving) return;
    const previous = shadowCall;
    setShadowCallSaving(true);
    setShadowCall({ ...shadowCall, ...patch });
    try {
      const res = await fetch(`${apiBase}/api/shadow-call-settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        setShadowCall(previous);
        const body = await res.json().catch(() => null) as { code?: unknown } | null;
        publishFeedback(false, t(shadowCallSaveErrorKey(body?.code)));
        return;
      }
      const data = await res.json().catch(() => null) as ShadowCallData | null;
      if (data && typeof data.enabled === "boolean") setShadowCall(data);
    } catch {
      setShadowCall(previous);
      publishFeedback(false, t("models.networkError"));
    } finally {
      setShadowCallSaving(false);
    }
  };

  return { shadowCall, shadowCallSaving, loadShadowCall, saveShadowCall };
}
