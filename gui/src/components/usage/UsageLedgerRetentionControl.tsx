import { useCallback, useEffect, useRef, useState } from "react";
import { clampNumberDraft } from "../../clamp-draft";
import { formatBytes } from "../../format-bytes";
import { useI18n } from "../../i18n/shared";
import { Switch } from "../../ui";
import { NumberStepper } from "../NumberStepper";

const MIB = 1024 ** 2;
const MAX_MIB = Math.floor(Number.MAX_SAFE_INTEGER / MIB);

interface RetentionStatus {
  enabled: boolean;
  maxBytes: number;
  currentBytes?: number;
}

function parseStatus(value: unknown): RetentionStatus {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_status");
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.enabled !== "boolean" || typeof candidate.maxBytes !== "number"
    || !Number.isFinite(candidate.maxBytes) || candidate.maxBytes <= 0) {
    throw new Error("invalid_status");
  }
  return {
    enabled: candidate.enabled,
    maxBytes: candidate.maxBytes,
    currentBytes: typeof candidate.currentBytes === "number" && Number.isFinite(candidate.currentBytes)
      ? candidate.currentBytes
      : undefined,
  };
}

function formatMaxMiBDraft(maxBytes: number): string {
  return Number.isFinite(maxBytes) && maxBytes > 0 ? String(maxBytes / MIB) : "";
}

function parseMaxMiBDraft(raw: string): number | null {
  const mib = Number(raw.trim());
  if (!Number.isSafeInteger(mib) || mib < 1 || mib > MAX_MIB) return null;
  const bytes = mib * MIB;
  return Number.isSafeInteger(bytes) ? bytes : null;
}

/**
 * Usage-page control for the opt-in usage-ledger byte ceiling.
 *
 * The dashboard keeps the switch as the primary action and exposes a MiB-aligned
 * custom editor only while the policy is enabled. Toggling the switch always
 * sends the exact server-reported byte value, so existing non-MiB-aligned values
 * can never be rounded or silently rewritten.
 */
export default function UsageLedgerRetentionControl({ apiBase }: { apiBase: string }) {
  const { locale, t } = useI18n();
  const mibLabel = formatBytes(MIB, locale).replace(/^[\d.,]+\s*/, "");
  const [status, setStatus] = useState<RetentionStatus | null>(null);
  const [customDraft, setCustomDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadGeneration = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    const generation = ++loadGeneration.current;
    try {
      const response = await fetch(`${apiBase}/api/storage/usage-ledger-retention`, { signal });
      if (!response.ok) throw new Error("load_failed");
      const next = parseStatus(await response.json());
      if (signal?.aborted || generation !== loadGeneration.current) return;
      setError(null);
      setStatus(next);
      setCustomDraft(formatMaxMiBDraft(next.maxBytes));
    } catch (errorValue) {
      // A successful PUT invalidates reads that started under the old policy. Stale reads
      // must be silent whether they eventually succeed, fail HTTP, reject, or parse badly.
      if (signal?.aborted || generation !== loadGeneration.current
        || (errorValue as { name?: string })?.name === "AbortError") return;
      throw errorValue;
    }
  }, [apiBase]);

  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      void load(controller.signal).catch(errorValue => {
        if (!controller.signal.aborted && (errorValue as { name?: string })?.name !== "AbortError") {
          setError(t("usage.retention.error"));
        }
      });
    }, 0);
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [load, t]);

  const persist = useCallback(async (nextEnabled: boolean, maxBytes: number) => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`${apiBase}/api/storage/usage-ledger-retention`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: nextEnabled, maxBytes }),
      });
      if (!response.ok) throw new Error("save_failed");
      const next = parseStatus(await response.json());
      // A GET may have started before this authoritative mutation completed (for example,
      // after a locale change). Do not let that older snapshot repaint the saved state.
      loadGeneration.current += 1;
      setStatus(next);
      setCustomDraft(formatMaxMiBDraft(next.maxBytes));
      setEditing(false);
    } catch {
      setError(t("usage.retention.error"));
    } finally {
      setBusy(false);
    }
  }, [apiBase, t]);

  const toggle = () => {
    if (!status || busy) return;
    void persist(!status.enabled, status.maxBytes);
  };

  const saveCustom = () => {
    if (!status || busy) return;
    // If the saved value is not MiB-aligned, leaving the field untouched must
    // not force an unrelated rounding write; the switch path remains exact.
    if (customDraft === formatMaxMiBDraft(status.maxBytes)) {
      setEditing(false);
      return;
    }
    const nextMaxBytes = parseMaxMiBDraft(customDraft);
    if (nextMaxBytes === null) {
      setError(t("usage.retention.error"));
      return;
    }
    void persist(true, nextMaxBytes);
  };

  const resetCustom = () => {
    if (!status) return;
    setCustomDraft(formatMaxMiBDraft(status.maxBytes));
    setEditing(false);
    setError(null);
  };

  return (
    <section className="usage-retention-control" data-testid="usage-ledger-retention" aria-labelledby="usage-retention-title">
      <div className="usage-retention-heading">
        <div>
          <h3 id="usage-retention-title" className="h-section">{t("usage.retention.title")}</h3>
          <p className="muted text-control">{t("usage.retention.help")}</p>
        </div>
        <Switch
          on={status?.enabled === true}
          onClick={toggle}
          disabled={busy || status === null}
          label={t("usage.retention.enabled")}
        />
      </div>

      {status?.enabled && (
        <div className="usage-retention-editor" aria-busy={busy}>
          <label className="usage-retention-limit">
            <span className="field-label">{t("usage.retention.limit")}</span>
            <span
              className="codex-auto-switch-input-wrap"
              onBlur={event => {
                if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
                if ((event.relatedTarget as HTMLElement | null)?.closest("button.switch")) {
                  setEditing(false);
                  return;
                }
                if (editing) saveCustom();
              }}
            >
              <input
                ref={inputRef}
                className="input mono codex-auto-switch-input"
                type="number"
                min={1}
                max={MAX_MIB}
                step={1}
                inputMode="numeric"
                value={customDraft}
                placeholder={mibLabel}
                disabled={busy}
                aria-label={t("usage.retention.limit")}
                onFocus={() => setEditing(true)}
                onChange={event => {
                  setError(null);
                  setCustomDraft(event.target.value);
                }}
                onKeyDown={event => {
                  if (event.nativeEvent.isComposing || busy) return;
                  if (event.key === "Enter") {
                    event.preventDefault();
                    saveCustom();
                  } else if (event.key === "Escape") {
                    event.preventDefault();
                    resetCustom();
                  }
                }}
              />
              <span className="codex-auto-switch-unit" aria-hidden="true">{mibLabel}</span>
              <NumberStepper
                disabled={busy}
                incrementLabel={t("usage.retention.increase")}
                decrementLabel={t("usage.retention.decrease")}
                onIncrement={() => {
                  inputRef.current?.focus();
                  setEditing(true);
                  setCustomDraft(clampNumberDraft(customDraft, 1, 1, MAX_MIB));
                }}
                onDecrement={() => {
                  inputRef.current?.focus();
                  setEditing(true);
                  setCustomDraft(clampNumberDraft(customDraft, -1, 1, MAX_MIB));
                }}
              />
            </span>
          </label>
        </div>
      )}

      <p className="muted text-caption usage-retention-current">
        {t("usage.retention.current")}: {status?.currentBytes === undefined ? "—" : formatBytes(status.currentBytes, locale)}
        {status && (
          <>
            {" · "}
            {!status.enabled && <><span className="usage-retention-state">{t("usage.retention.unlimited")}</span>{" · "}</>}
            <span className={`usage-retention-limit${status.enabled ? "" : " is-disabled"}`}>
              {t("usage.retention.limit")}: {formatBytes(status.maxBytes, locale)}
            </span>
          </>
        )}
      </p>
      {error && <p className="err" role="alert">{error}</p>}
    </section>
  );
}
