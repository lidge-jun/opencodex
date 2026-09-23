import { useCallback, useEffect, useRef } from "react";
import { useT } from "../../i18n/shared";
import type { LayerDescriptorDto, ToggleStateDto } from "../../pages/codex-set-prompt";
import { CLASS_LABEL_KEYS, LAYER_ABOUT_KEYS, LAYER_CONDITION_KEYS, LAYER_LABEL_KEYS } from "./prompt-layer-copy";

/**
 * Read-only detail for a built-in layer (ask item 8).
 *
 * There is no rendered prompt text here, and that is deliberate. Codex exposes
 * no API for a layer's assembled body, and reconstructing one would mean
 * reimplementing world_state.rs against a moving target. The dialog explains the
 * layer, names its key, and shows this file's value - the honest scope. Saying so
 * plainly beats an empty panel the reader has to interpret.
 *
 * No textarea, no Save. Escape closes and returns focus to the trigger.
 */
export default function PromptLayerDialog({
  descriptor,
  toggle,
  text,
  busy,
  onToggle,
  onClose,
}: {
  descriptor: LayerDescriptorDto;
  toggle: ToggleStateDto | undefined;
  /** Rendered source text for this layer, when the probe could read it. */
  text: { text: string | null; reason: string; bytes: number; sourcePath?: string } | undefined;
  busy: boolean;
  onToggle: (id: string, enabled: boolean) => void;
  onClose: () => void;
}) {
  const t = useT();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = "codex-set-layer-dialog-" + descriptor.id;

  useEffect(() => {
    const dialog = dialogRef.current;
    // Remember who opened this. A modal that closes to the document root strands a
    // keyboard user, and the row they were reading is the only sensible return.
    const opener = document.activeElement as HTMLElement | null;
    if (dialog && !dialog.open) dialog.showModal();
    // A parent re-render that drops this node while the dialog is open would
    // otherwise leave the top layer occupied.
    return () => {
      if (dialog?.open) dialog.close();
      if (opener && typeof opener.focus === "function") opener.focus();
    };
  }, []);

  const handleCancel = useCallback((event: React.SyntheticEvent) => {
    // Escape arrives as `cancel`. Prevent the default close so React owns the
    // unmount and the caller can restore focus to the row that opened this.
    event.preventDefault();
    onClose();
  }, [onClose]);

  const classKey = CLASS_LABEL_KEYS[descriptor.class];
  // Same fallback the row uses. The wire response is cast, not validated, so a
  // newer runtime CAN send an id this build has no copy for - and a dialog whose
  // title and body silently render blank is worse than one that admits the gap.
  const labelKey = LAYER_LABEL_KEYS[descriptor.id];
  const aboutKey = LAYER_ABOUT_KEYS[descriptor.id];
  const conditionKey = LAYER_CONDITION_KEYS[descriptor.id];

  return (
    <dialog ref={dialogRef} className="modal-overlay" aria-labelledby={titleId} onCancel={handleCancel}>
      <button type="button" className="modal-backdrop-dismiss" aria-label={t("common.close")} tabIndex={-1} onClick={onClose} />
      <div className="modal-card codex-set-layer-dialog" onClick={event => event.stopPropagation()} role="document">
        <div className="modal-head">
          <h3 id={titleId}>{labelKey ? t(labelKey) : descriptor.id}</h3>
          {/*
            The switch belongs here too. Opening a layer to read it and then having
            to close the dialog to act on it is a dead end, and the row and the
            dialog are the same control over the same key.
          */}
          {descriptor.class === "config-toggle" && toggle && (
            <button
              type="button"
              role="switch"
              className={`toggle ${toggle.defaultedUserValue ? "on" : ""}`}
              aria-checked={toggle.defaultedUserValue}
              aria-label={labelKey ? t(labelKey) : descriptor.id}
              disabled={busy}
              onClick={() => { onToggle(descriptor.id, !toggle.defaultedUserValue); }}
            >
              <span className="toggle-knob" />
            </button>
          )}
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>{t("common.close")}</button>
        </div>

        <p className="muted small">{aboutKey ? t(aboutKey) : t("codexSet.dialog.unknownLayer")}</p>

        <div className="codex-set-layer-dialog__line">
          <span className="muted text-label">{t("codexSet.dialog.class")}</span>
          <span>{t(classKey)}</span>
        </div>

        {descriptor.key && (
          <div className="codex-set-layer-dialog__line">
            <span className="muted text-label">{t("codexSet.dialog.key")}</span>
            <code className="api-code">{descriptor.key}</code>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => { void navigator.clipboard?.writeText(descriptor.key ?? ""); }}
            >
              {t("codexSet.dialog.copyKey")}
            </button>
          </div>
        )}

        {descriptor.class === "config-toggle" && toggle && (
          <div className="codex-set-layer-dialog__line">
            <span className="muted text-label">{t("codexSet.dialog.fileValue")}</span>
            <span>
              {toggle.userFileValue === null
                ? t("codexSet.dialog.absentDefault", { value: String(toggle.default) })
                // The default travels with an explicit value too: knowing the file says
                // false is only half the answer without knowing what it would be otherwise.
                : t("codexSet.dialog.setValue", {
                  value: String(toggle.userFileValue),
                  fallback: String(toggle.default),
                })}
            </span>
          </div>
        )}

        {descriptor.class === "runtime-conditional" && conditionKey && (
          <p className="muted small">{t(conditionKey)}</p>
        )}

        {/*
          Stated, not implied. A dialog that simply omitted the body would read as
          a loading failure to anyone who expected one.
        */}
        {text?.reason === "ok" && text.text ? (
          <>
            <div className="codex-set-layer-dialog__line">
              <span className="muted text-label">{t("codexSet.dialog.sourceText")}</span>
              <span className="muted small">{t("codexSet.dialog.sourceBytes", { bytes: text.bytes })}</span>
            </div>
            <pre className="api-code codex-set-layer-dialog__text">{text.text}</pre>
          </>
        ) : (
          // Each absent case has a different cause, and saying which one is the
          // difference between a limit and a bug.
          <p className="muted small codex-set-layer-dialog__no-text">
            {text?.reason === "empty-source"
              // An existing but empty file is a fourth state. Reporting it as
              // "sent nothing" would describe the layer as idle when the real
              // answer is that the file the user wrote is blank.
              ? t("codexSet.dialog.emptySource", { path: text.sourcePath ?? "" })
              : text?.reason === "not-rendered"
                ? t("codexSet.dialog.notRendered")
                : text?.reason === "unmapped"
                  ? t("codexSet.dialog.unmapped")
                  : text?.reason === "not-exposed"
                    ? t("codexSet.dialog.notExposed")
                    : t("codexSet.dialog.textUnavailable")}
          </p>
        )}
      </div>
    </dialog>
  );
}
