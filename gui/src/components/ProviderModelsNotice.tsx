import { useEffect, useId, useRef } from "react";
import { useT } from "../i18n/shared";

export interface ProviderModelsNoticeProps {
  provider: string;
  loading: boolean;
  failed: boolean;
  providerKnown: boolean;
  initialRegistration: boolean;
  selection?: { status: "pending" | "ready" | "all-off"; modelCount?: number };
  catalogRefreshPending?: boolean;
  onClose: () => void;
  onOpenModels: () => void;
  onRetry?: () => void;
}

export default function ProviderModelsNotice(props: ProviderModelsNoticeProps) {
  const t = useT();
  const titleId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const primary = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    primary.current?.focus();
    return () => { if (previous?.isConnected && typeof previous.focus === "function") previous.focus(); };
  }, []);
  const pending = props.selection?.status === "pending";
  const unavailable = props.failed || !props.providerKnown;
  const message = props.loading ? t("prov.modelsNoticeChecking")
    : unavailable ? t("prov.modelsNoticeFailed")
      : pending ? t("prov.modelsNoticePending")
        : props.initialRegistration && props.selection?.status === "all-off" ? t("prov.modelsNoticeOff")
          : t("prov.modelsNoticeReady");

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby={titleId}
      onKeyDown={event => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); props.onClose(); }
        if (event.key !== "Tab") return;
        const buttons = dialog.current?.querySelectorAll<HTMLButtonElement>("button:not([disabled])");
        const first = buttons?.[0], last = buttons?.[buttons.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }}>
      <div className="modal-card" ref={dialog}>
        <div className="modal-head"><h2 id={titleId} style={{ fontSize: "var(--text-subtitle)", margin: 0 }}>{t("prov.modelsNoticeTitle")}</h2></div>
        <p><strong style={{ overflowWrap: "anywhere" }}>{props.provider}</strong></p>
        <p role="status" aria-live="polite">{message}</p>
        {props.initialRegistration && props.selection?.modelCount !== undefined && (
          <p className="muted">{t("prov.modelsNoticeCount", { count: props.selection.modelCount })}</p>
        )}
        {props.catalogRefreshPending && <p className="muted" role="status">{t("codexAuth.catalogRefreshPending")}</p>}
        {!props.loading && (pending || unavailable) && props.onRetry && (
          <button type="button" className="btn btn-ghost" onClick={() => { props.onRetry?.(); primary.current?.focus(); }}>{t("common.retry")}</button>
        )}
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={props.onClose}>{t("common.close")}</button>
          <button type="button" className="btn btn-primary" ref={primary} onClick={props.onOpenModels}>{t("prov.modelsNoticeOpen")}</button>
        </div>
      </div>
    </div>
  );
}
