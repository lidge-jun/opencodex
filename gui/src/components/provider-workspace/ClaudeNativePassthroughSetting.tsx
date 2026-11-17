/**
 * Claude Code's native passthrough (`claudeCode.nativePassthrough`, default on), shown under the
 * Claude account pool because it decides whether Claude Code's own traffic can reach the pool at
 * all: while it is on, a bare Claude id that arrives with Claude Code's own login goes straight to
 * Anthropic and never meets these accounts. It is one global setting, saved immediately through
 * the Claude Code settings patch, which changes only the field it is sent.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useT } from "../../i18n/shared";
import { isApiTargetCaptureCurrent, targetFetch } from "../../api";
import { useRenderTargetCapture } from "../../use-render-target-capture";

export default function ClaudeNativePassthroughSetting({ apiBase, targetKey }: { apiBase: string; targetKey?: string }) {
  const t = useT();
  const capture = useRenderTargetCapture(apiBase, targetKey);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const mountedRef = useRef(true);

  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const ac = new AbortController();
    void Promise.resolve()
      .then(() => fetch(`${apiBase}/api/claude-code`, { signal: ac.signal }))
      .then(response => {
        if (!response.ok) throw new Error("load");
        return response.json() as Promise<{ nativePassthrough?: unknown }>;
      })
      .then(json => {
        if (cancelled) return;
        // Default-on like the server: a server without the field reads as on.
        setEnabled(json.nativePassthrough !== false);
        setLoadFailed(false);
      })
      .catch(() => {
        if (cancelled || ac.signal.aborted) return;
        setLoadFailed(true);
      });
    return () => {
      cancelled = true;
      ac.abort();
    };
  }, [apiBase]);

  const toggle = async () => {
    if (enabled === null || saving) return;
    const requested = !enabled;
    setSaving(true);
    setSaveFailed(false);
    try {
      const response = await targetFetch(capture, `${apiBase}/api/claude-code`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nativePassthrough: requested }),
      });
      if (!mountedRef.current || !isApiTargetCaptureCurrent(capture)) return;
      if (!response.ok) throw new Error("save");
      const json = await response.json().catch(() => null) as { nativePassthrough?: unknown } | null;
      if (!mountedRef.current) return;
      setEnabled(typeof json?.nativePassthrough === "boolean" ? json.nativePassthrough : requested);
    } catch {
      if (mountedRef.current) setSaveFailed(true);
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  };

  const loading = enabled === null && !loadFailed;
  return (
    <div className="card anthropic-pool-card claude-native-passthrough-card" aria-busy={loading || saving}>
      <div className="card-row" style={{ alignItems: "flex-start", gap: 12 }}>
        <div style={{ flex: 1 }}>
          <strong>{t("claude.nativePassthrough")}</strong>
          <div className="card-sub" style={{ marginTop: 4 }}>
            {loadFailed ? t("claude.nativePassthroughLoadFailed") : loading ? t("common.loading") : t("claude.nativePassthroughDesc")}
          </div>
        </div>
        <button
          type="button"
          className={`toggle ${enabled ? "on" : ""}`}
          disabled={enabled === null || saving}
          aria-pressed={enabled ?? undefined}
          aria-label={t("claude.nativePassthrough")}
          onClick={() => { void toggle(); }}
        >
          <span className="toggle-knob" />
        </button>
      </div>
      {saveFailed && (
        <div role="alert" className="card-sub" style={{ marginTop: 8, color: "var(--danger, #c44)" }}>
          {t("claude.saveFailed")}
        </div>
      )}
    </div>
  );
}
