import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useT } from "../../i18n/shared";
import { isApiTargetCaptureCurrent, targetFetch } from "../../api";
import { useRenderTargetCapture } from "../../use-render-target-capture";

type NativeProtocol = "claude" | "gemini";

function readPassthrough(payload: unknown, protocol: NativeProtocol): boolean | null {
  const info = payload as {
    nativePassthrough?: unknown;
    settings?: { rollout?: { geminiNativeAntigravity?: unknown } };
  } | null;
  const value = protocol === "gemini" ? info?.settings?.rollout?.geminiNativeAntigravity : info?.nativePassthrough;
  return typeof value === "boolean" ? value : null;
}

/** A provider account card that saves just its protocol's native passthrough setting. */
export default function NativePassthroughSetting({
  apiBase, targetKey, protocol,
}: { apiBase: string; targetKey?: string; protocol: NativeProtocol }) {
  const t = useT();
  const gemini = protocol === "gemini";
  const readPath = gemini ? "/api/protocols" : "/api/claude-code";
  const title = t(gemini ? "pws.geminiNativePassthrough" : "claude.nativePassthrough");
  const capture = useRenderTargetCapture(apiBase, targetKey);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [reloadVersion, setReloadVersion] = useState(0);
  const mountedRef = useRef(true);

  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const ac = new AbortController();
    void targetFetch(capture, `${apiBase}${readPath}`, { signal: ac.signal, cache: "no-store" })
      .then(response => {
        if (!response.ok) throw new Error("load");
        return response.json() as Promise<unknown>;
      })
      .then(json => {
        if (cancelled || !isApiTargetCaptureCurrent(capture)) return;
        const saved = readPassthrough(json, protocol);
        if (saved === null) throw new Error("load");
        setEnabled(saved);
        setLoadFailed(false);
      })
      .catch(() => {
        if (cancelled || ac.signal.aborted || !isApiTargetCaptureCurrent(capture)) return;
        setEnabled(null);
        setLoadFailed(true);
      });
    return () => {
      cancelled = true;
      ac.abort();
    };
  }, [apiBase, capture, protocol, readPath, reloadVersion]);

  const toggle = async () => {
    if (enabled === null || saving) return;
    const requested = !enabled;
    setSaving(true);
    setSaveFailed(false);
    try {
      const response = await targetFetch(capture, `${apiBase}${gemini ? "/api/protocols/settings" : readPath}`, {
        method: gemini ? "PATCH" : "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(gemini
          ? { rollout: { geminiNativeAntigravity: requested } }
          : { nativePassthrough: requested }),
      });
      if (!mountedRef.current || !isApiTargetCaptureCurrent(capture)) return;
      if (!response.ok) throw new Error("save");
      const json: unknown = await response.json();
      if (!mountedRef.current || !isApiTargetCaptureCurrent(capture)) return;
      const saved = readPassthrough(json, protocol);
      if (saved !== requested) throw new Error("save");
      setEnabled(saved);
    } catch {
      if (mountedRef.current && isApiTargetCaptureCurrent(capture)) {
        setEnabled(null);
        setSaveFailed(true);
        setReloadVersion(version => version + 1);
      }
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  };

  const loading = enabled === null && !loadFailed;
  return (
    <div className={`card anthropic-pool-card ${protocol}-native-passthrough-card`} aria-busy={loading || saving}>
      <div className="card-row" style={{ alignItems: "flex-start", gap: 12 }}>
        <div style={{ flex: 1 }}>
          <strong>{title}</strong>
          <div className="card-sub" style={{ marginTop: 4 }}>
            {loadFailed
              ? t(gemini ? "pws.geminiNativePassthroughLoadFailed" : "claude.nativePassthroughLoadFailed")
              : loading ? t("common.loading") : t(gemini ? "pws.geminiNativePassthroughDesc" : "claude.nativePassthroughDesc")}
          </div>
        </div>
        <button
          type="button"
          className={`toggle ${enabled ? "on" : ""}`}
          disabled={enabled === null || saving}
          aria-pressed={enabled ?? undefined}
          aria-label={title}
          onClick={() => { void toggle(); }}
        >
          <span className="toggle-knob" />
        </button>
      </div>
      {loadFailed && (
        <button type="button" className="btn btn-ghost btn-sm" style={{ marginTop: 8 }} onClick={() => {
          setLoadFailed(false);
          setReloadVersion(version => version + 1);
        }}>{t("common.retry")}</button>
      )}
      {saveFailed && (
        <div role="alert" className="card-sub" style={{ marginTop: 8, color: "var(--danger, #c44)" }}>
          {t("claude.saveFailed")}
        </div>
      )}
    </div>
  );
}
