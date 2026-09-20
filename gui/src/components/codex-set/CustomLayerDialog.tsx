import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useT } from "../../i18n/shared";
import type { CustomLayerDto } from "../../pages/codex-set-prompt";
import { lintPromptLayer } from "./prompt-lint";
import {
  MAX_BODY_BYTES,
  MAX_TITLE_CHARS,
  type Draft,
  normalizeBody,
  utf8Length,
  validateDraft,
} from "./custom-layer-state";

/**
 * The editable dialog for a custom layer (ask item 7).
 *
 * Same scaffolding as the read-only built-in dialog; the difference is the editor
 * and the Save action, not a separate component family.
 *
 * Escape cancels and returns focus. When the body is dirty it asks first - a
 * textarea someone has typed into is not the same as a read-only dialog they
 * glanced at.
 */
export default function CustomLayerDialog({
  layer,
  seed,
  others,
  busy,
  navigation,
  onSave,
  onClose,
}: {
  /** null means a new layer. */
  layer: CustomLayerDto | null;
  /** Pre-fills a NEW layer from a preset. Fully editable afterwards. */
  seed?: { title: string; body: string } | null;
  others: readonly CustomLayerDto[];
  /** True while a write is in flight, so Save cannot be pressed twice. */
  busy: boolean;
  /**
   * Moving between saved layers without leaving the editor. Absent for a new
   * layer, and absent when there is nothing to move between.
   *
   * This changes the EDIT TARGET only. Custom layers are not mutually exclusive -
   * every enabled one composes into the projection together - so navigating must
   * never toggle which layer is active.
   */
  navigation?: {
    position: number;
    total: number;
    onPrev: () => void;
    onNext: () => void;
  };
  onSave: (draft: Draft) => void;
  onClose: () => void;
}) {
  const t = useT();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [title, setTitle] = useState(layer?.title ?? seed?.title ?? "");
  const [body, setBody] = useState(layer?.body ?? seed?.body ?? "");

  /**
   * Unsaved edits, keyed by layer id, held while the user moves between layers.
   *
   * Navigation inside an editor is a new way to destroy someone's typing. Blocking
   * navigation whenever the draft is dirty would avoid the loss and make the
   * feature useless; keeping the drafts is what lets someone compare two layers
   * mid-edit, which is the whole point of moving between them.
   */
  const draftsRef = useRef(new Map<string, { title: string; body: string }>());
  const [parkedDirty, setParkedDirty] = useState(false);
  const othersRef = useRef(others);
  useEffect(() => { othersRef.current = others; }, [others]);
  const editingId = layer?.id ?? null;
  const lastIdRef = useRef(editingId);

  /**
   * The live draft, mirrored into a ref by its own effect.
   *
   * The park effect needs the OUTGOING title/body, but naming them as deps would
   * re-park on every keystroke. A ref carries them across without widening those
   * deps - and the write happens in an effect, not during render, because
   * mutating a ref while rendering is exactly what React Compiler rejects.
   */
  const liveRef = useRef({ title, body });
  useEffect(() => { liveRef.current = { title, body }; }, [title, body]);

  useEffect(() => {
    if (lastIdRef.current === editingId) return;
    // Park the outgoing draft before adopting the incoming one.
    if (lastIdRef.current !== null) {
      draftsRef.current.set(lastIdRef.current, liveRef.current);
    }
    lastIdRef.current = editingId;
    const parked = editingId === null ? undefined : draftsRef.current.get(editingId);
    setTitle(parked?.title ?? layer?.title ?? "");
    setBody(parked?.body ?? layer?.body ?? "");
    setParkedDirty([...draftsRef.current].some(([id, draft]) => {
      if (id === editingId) return false;
      const saved = othersRef.current.find(candidate => candidate.id === id);
      return saved !== undefined && (draft.title !== saved.title || draft.body !== saved.body);
    }));
  }, [editingId, layer]);
  const [discardAction, setDiscardAction] = useState<"close" | "save" | null>(null);
  const titleId = "codex-set-custom-dialog";

  // Compare against what the editor OPENED with, seed included. Comparing against
  // empty strings made a preset-seeded editor dirty before the user touched it, so
  // Cancel asked to discard changes nobody had made.
  const initialTitle = layer?.title ?? seed?.title ?? "";
  const initialBody = layer?.body ?? seed?.body ?? "";
  const dirty = title !== initialTitle || body !== initialBody;
  // A parked draft is still live user work. Exclude the displayed layer because
  // its inputs supersede the older parked copy when someone navigates back.

  useEffect(() => {
    const dialog = dialogRef.current;
    const opener = document.activeElement as HTMLElement | null;
    if (dialog && !dialog.open) dialog.showModal();
    return () => {
      if (dialog?.open) dialog.close();
      if (opener && typeof opener.focus === "function") opener.focus();
    };
  }, []);

  const requestClose = useCallback(() => {
    if (dirty || parkedDirty) { setDiscardAction("close"); return; }
    onClose();
  }, [dirty, parkedDirty, onClose]);

  const handleCancel = useCallback((event: React.SyntheticEvent) => {
    event.preventDefault();
    requestClose();
  }, [requestClose]);

  const draft: Draft = { id: layer?.id ?? null, title, body, enabled: layer?.enabled ?? true };
  const requestSave = () => {
    if (parkedDirty) { setDiscardAction("save"); return; }
    onSave({ ...draft, body: normalizeBody(body) });
  };
  const problem = validateDraft(draft, others);
  const normalized = normalizeBody(body);
  const normalizationApplied = normalized !== body;
  const findings = useMemo(() => lintPromptLayer(normalized), [normalized]);
  const bodyBytes = utf8Length(normalized);

  const problemMessage = !problem ? null
    : problem.kind === "title-empty" ? t("codexSet.custom.titleRequired")
    : problem.kind === "title-too-long" ? t("codexSet.custom.titleTooLong", { count: problem.length, max: MAX_TITLE_CHARS })
    : problem.kind === "title-multiline" ? t("codexSet.custom.titleMultiline")
    : problem.kind === "body-too-large" ? t("codexSet.custom.bodyTooLarge", { bytes: problem.bytes, max: MAX_BODY_BYTES })
    : problem.kind === "composed-too-large" ? t("codexSet.custom.composedTooLarge", { bytes: problem.bytes })
    : t("codexSet.custom.invalidCharacter", { position: problem.position });

  return (
    <dialog ref={dialogRef} className="modal-overlay" aria-labelledby={titleId} onCancel={handleCancel}>
      <button type="button" className="modal-backdrop-dismiss" aria-label={t("common.close")} tabIndex={-1} onClick={requestClose} />
      <div className="modal-card codex-set-custom-dialog" onClick={event => event.stopPropagation()} role="document">
        <div className="modal-head">
          <h3 id={titleId}>{layer ? t("codexSet.custom.editTitle") : t("codexSet.custom.newTitle")}</h3>
          {navigation && (
            // Arrows alone lose the user: every reference implementation pairs
            // movement with an explicit position. "3 / 7" is what makes prev/next
            // navigable rather than a guess.
            <span className="codex-set-custom-dialog__nav">
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                aria-label={t("codexSet.custom.prevLayer")}
                disabled={navigation.position <= 1 || busy}
                onClick={navigation.onPrev}
              >
                &larr;
              </button>
              <span className="codex-set-custom-dialog__nav-pos">
                {t("codexSet.custom.navPosition", { position: navigation.position, total: navigation.total })}
              </span>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                aria-label={t("codexSet.custom.nextLayer")}
                disabled={navigation.position >= navigation.total || busy}
                onClick={navigation.onNext}
              >
                &rarr;
              </button>
            </span>
          )}
        </div>

        <label className="field">
          <span className="muted text-label">{t("codexSet.custom.titleLabel")}</span>
          <input
            type="text"
            value={title}
            maxLength={MAX_TITLE_CHARS + 20}
            onChange={e => setTitle(e.target.value)}
          />
        </label>

        <label className="field">
          <span className="muted text-label">{t("codexSet.custom.bodyLabel")}</span>
          <textarea rows={10} value={body} onChange={e => setBody(e.target.value)} />
        </label>

        <p className="muted small">{t("codexSet.custom.bodySize", { bytes: bodyBytes, max: MAX_BODY_BYTES })}</p>

        {normalizationApplied && (
          // Quiet note, not an error: the text is accepted, just stored canonically.
          <p className="muted small codex-set-custom-dialog__normalized">{t("codexSet.custom.normalized")}</p>
        )}

        {problemMessage && (
          <div className="notice notice-err" role="alert">{problemMessage}</div>
        )}

        {findings.length > 0 && (
          // Warnings, never blockers. A user who means to override Codex may; the
          // linter only makes it a decision rather than an accident.
          <ul className="codex-set-custom-dialog__lint">
            {findings.map((finding, index) => (
              <li key={finding.rule + ":" + index} data-lint-rule={finding.rule} data-lint-level={finding.level}>
                {t(finding.messageKey)}
                {finding.span && (
                  <code className="codex-set-custom-dialog__span">{normalized.slice(finding.span[0], finding.span[1])}</code>
                )}
              </li>
            ))}
          </ul>
        )}

        {discardAction ? (
          // The prompt text IS the accessible name. role="alertdialog" without one
          // announces an unnamed dialog, so a screen-reader user is asked to confirm
          // something the announcement never states.
          <div
            className="modal-actions codex-set-custom-dialog__discard"
            role="alertdialog"
            aria-labelledby={titleId + "-discard"}
          >
            <span id={titleId + "-discard"} className="muted small">{t("codexSet.custom.discardPrompt")}</span>
            <button type="button" className="btn btn-sm" onClick={() => setDiscardAction(null)}>
              {t("codexSet.custom.keepEditing")}
            </button>
            <button
              type="button"
              className="btn btn-danger btn-sm"
              onClick={() => discardAction === "save" ? onSave({ ...draft, body: normalized }) : onClose()}
            >
              {t("common.discard")}
            </button>
          </div>
        ) : (
          <div className="modal-actions">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={problem !== null || busy}
              onClick={requestSave}
            >
              {t("common.save")}
            </button>
            <button type="button" className="btn btn-sm" onClick={requestClose}>{t("common.cancel")}</button>
          </div>
        )}
      </div>
    </dialog>
  );
}
