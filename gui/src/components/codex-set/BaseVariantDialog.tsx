import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "../../i18n/shared";
import { lintPromptLayer } from "./prompt-lint";
import {
  findInvalidCharacter,
  MAX_BODY_BYTES,
  normalizeBody,
  utf8Length,
} from "./custom-layer-state";

export interface BaseVariantDto {
  id: string;
  title: string;
  body: string;
  bytes: number;
}

export type BaseSelectionDto =
  | { kind: "default" }
  | { kind: "variant"; id: string }
  | { kind: "external"; path: string };

/** One step of the ring: the default, then each authored variant, then an empty slot. */
interface Slot {
  kind: "default" | "variant" | "new";
  variant?: BaseVariantDto;
}

/** Horizontal travel, in px, before a drag counts as a swipe. */
const SWIPE_THRESHOLD = 48;

/** The parked draft for a slot that has no saved value: an empty one is not dirty. */
const NEW_SLOT_KEY = "new";

/**
 * The base-prompt variant picker.
 *
 * Three ways to move, because the ask names swipe but a settings page also has to be
 * operable without it: a horizontal pointer drag, ArrowLeft/ArrowRight, and explicit
 * prev/next buttons. The buttons are also what a screen reader announces, so they are
 * the accessible surface rather than a fallback.
 *
 * Slot 1 is the DEFAULT, read-only by construction rather than by a disabled attribute:
 * there is no stored body for it, so the dialog has nothing to put in an editor. It says
 * why instead of showing greyed-out controls, which would imply the capability exists and
 * is temporarily unavailable.
 */
export default function BaseVariantDialog({
  variants,
  selection,
  maxVariants,
  busy,
  importPreview,
  importRefusal,
  onSelect,
  onSave,
  onDelete,
  onImport,
  onImportTitle,
  onClose,
}: {
  variants: readonly BaseVariantDto[];
  selection: BaseSelectionDto;
  maxVariants: number;
  busy: boolean;
  /**
   * The serialized variant once a preview landed — the exact text a confirm
   * installs, `# {title}` heading and normalized body included. `null` while
   * the import offer is just a button; the confirm below it writes nothing
   * until pressed.
   */
  importPreview: {
    rawPath: string | null;
    resolvedPath: string | null;
    serialized: string;
    serializedBytes: number;
    bodyBytes: number;
    suggestedTitle: string | null;
    /** The title the previewed text (and the hash bound to it) was built with. */
    effectiveTitle: string | null;
  } | null;
  /** Why an import was refused, when it was — shown beside the offer. */
  importRefusal: string | null;
  onSelect: (selection: BaseSelectionDto) => void;
  /**
   * Reports the write's outcome: the dialog decides what a failed save keeps —
   * drafts, the open confirmation — and an unresolved answer guesses either way.
   */
  onSave: (input: { id: string | null; title: string; body: string }) => Promise<boolean>;
  onDelete: (id: string) => void;
  onImport: (confirm: boolean, title?: string) => void;
  /** A title edit re-previews (debounced upstream) so the hash rebinds to it. */
  onImportTitle: (title: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const dialogRef = useRef<HTMLDialogElement>(null);

  /**
   * The ring. Default first because it is what a fresh install is on, then the authored
   * variants in stored order, then one empty slot while there is room - so adding a
   * variant is the same left/right gesture as choosing one.
   */
  const slots: Slot[] = [
    { kind: "default" },
    ...variants.map(variant => ({ kind: "variant" as const, variant })),
    ...(variants.length < maxVariants ? [{ kind: "new" as const }] : []),
  ];

  const liveIndex = selection.kind === "variant"
    ? Math.max(0, slots.findIndex(s => s.variant?.id === selection.id))
    : 0;
  const [index, setIndex] = useState(liveIndex);
  const slot = slots[Math.min(index, slots.length - 1)]!;

  const [title, setTitle] = useState(slot.variant?.title ?? "");
  const [body, setBody] = useState(slot.variant?.body ?? "");

  /**
   * The draft identity for the visible slot: the variant id, NEW_SLOT_KEY for the
   * empty slot, null for the read-only default which has no editor at all.
   */
  const editingKey = slot.kind === "default" ? null : (slot.variant?.id ?? NEW_SLOT_KEY);

  /**
   * Unsaved edits parked while the user swipes between slots.
   *
   * Same hazard as the custom-layer editor: ring navigation swaps the editor's
   * contents, so moving away from a half-written variant used to erase it. A draft
   * that differs from its slot's saved value is live user work - it is restored on
   * return, and it is part of what a close has to confirm.
   */
  const draftsRef = useRef(new Map<string, { title: string; body: string }>());
  const lastKeyRef = useRef(editingKey);
  /**
   * The slot the outgoing draft belongs to, kept because by the time a
   * transition runs its variant may already be gone from `variants` (a save
   * landing, or a delete), and the park check still needs its stored values.
   */
  const lastSlotRef = useRef(slot);
  /**
   * The save currently in flight, recorded so reconciliation can bind the
   * landing to a stable variant id — never to "the slot I navigated to happens
   * to carry the same text", which used to mistake an equal-content draft for
   * a completed save and drop it.
   */
  const pendingSaveRef = useRef<{ id: string | null; title: string; body: string } | null>(null);
  /**
   * Ids seen on the previous variants change. Starts empty rather than mapped
   * from `variants`: the mount effect runs before any save can be in flight,
   * and an eager initializer would pay a map+alloc on every render.
   */
  const prevIdsRef = useRef<ReadonlySet<string>>(new Set());
  const liveRef = useRef({ title, body });
  useEffect(() => { liveRef.current = { title, body }; }, [title, body]);

  /** Park outgoing work before reconciling the snapshot, in one ordered effect. */
  useEffect(() => {
    const previousIds = prevIdsRef.current;
    const nextIds = new Set(variants.map(v => v.id));
    const pendingSave = pendingSaveRef.current;
    const landed = pendingSave !== null && (pendingSave.id !== null
      ? variants.some(v => v.id === pendingSave.id && v.title === pendingSave.title && v.body === pendingSave.body)
      : variants.some(v => !previousIds.has(v.id) && v.title === pendingSave.title && v.body === pendingSave.body));

    if (lastKeyRef.current !== editingKey && lastKeyRef.current !== null) {
      const outgoing = liveRef.current;
      const saved = variants.find(v => v.id === lastKeyRef.current) ?? lastSlotRef.current.variant;
      const unedited = saved === undefined
        ? outgoing.title === "" && outgoing.body === ""
        : outgoing.title === saved.title && outgoing.body === saved.body;
      const deleted = lastKeyRef.current !== NEW_SLOT_KEY && !nextIds.has(lastKeyRef.current);
      const savedOutgoing = landed && pendingSave !== null
        && lastKeyRef.current === (pendingSave.id ?? NEW_SLOT_KEY)
        && outgoing.title === pendingSave.title && outgoing.body === pendingSave.body;
      if (unedited || deleted || savedOutgoing) draftsRef.current.delete(lastKeyRef.current);
      else draftsRef.current.set(lastKeyRef.current, outgoing);
    }

    // Reconciliation must follow parking: a removed id or the saved new slot
    // cannot be reintroduced by a later outgoing-draft effect.
    for (const key of [...draftsRef.current.keys()]) {
      if (key !== NEW_SLOT_KEY && !nextIds.has(key)) draftsRef.current.delete(key);
    }
    if (pendingSave && landed) draftsRef.current.delete(pendingSave.id ?? NEW_SLOT_KEY);
    if (pendingSave && (landed || (pendingSave.id !== null && !nextIds.has(pendingSave.id)))) {
      pendingSaveRef.current = null;
    }
    prevIdsRef.current = nextIds;

    if (lastKeyRef.current !== editingKey) {
      const parked = editingKey === null ? undefined : draftsRef.current.get(editingKey);
      setTitle(parked?.title ?? slot.variant?.title ?? "");
      setBody(parked?.body ?? slot.variant?.body ?? "");
    }
    lastKeyRef.current = editingKey;
    lastSlotRef.current = slot;
  }, [editingKey, slot, variants]);

  /**
   * A pending save-confirm pins the slot it was opened for (`targetKey`) and
   * freezes navigation until answered - otherwise the user could swipe before
   * confirming and the save would land on the wrong variant.
   */
  const [discardAction, setDiscardAction] = useState<{ kind: "close" } | { kind: "save"; targetKey: string | null } | null>(null);

  /**
   * A parked draft that differs from its slot's stored value still counts as
   * unsaved work. The visible slot is excluded: its inputs supersede the parked
   * copy the moment the user navigates back to it.
   *
   * State refreshed by an effect, not computed in render: the drafts live in a
   * ref, and reading ref.current during render is what the react-compiler rule
   * rejects.
   */
  const [parkedDirty, setParkedDirty] = useState(false);
  useEffect(() => {
    setParkedDirty([...draftsRef.current].some(([key, draft]) => {
      if (key === editingKey) return false;
      if (key === NEW_SLOT_KEY) return draft.title !== "" || draft.body !== "";
      const saved = variants.find(candidate => candidate.id === key);
      return saved === undefined || draft.title !== saved.title || draft.body !== saved.body;
    }));
  }, [editingKey, variants, title, body]);

  const dirty = parkedDirty
    || (editingKey !== null
      && (title !== (slot.variant?.title ?? "") || body !== (slot.variant?.body ?? "")));

  /**
   * The title the user picked for the import, seeded from each preview's
   * effectiveTitle. Editing it re-previews (the confirmation hash binds the
   * title as well as the body), so the confirm stays locked until the rebind
   * lands and `effectiveTitle` catches up with the field.
   */
  const [importTitle, setImportTitle] = useState(importPreview?.effectiveTitle ?? "");
  const previewedTitle = importPreview?.effectiveTitle ?? null;
  const [lastSeededTitle, setLastSeededTitle] = useState(previewedTitle);
  if (previewedTitle !== lastSeededTitle) {
    setLastSeededTitle(previewedTitle);
    setImportTitle(previewedTitle ?? "");
  }

  const step = useCallback((delta: number) => {
    setIndex(current => {
      const next = current + delta;
      // Wrap, so a ring of three does not dead-end at either edge.
      if (next < 0) return slots.length - 1;
      if (next >= slots.length) return 0;
      return next;
    });
  }, [slots.length]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  /**
   * Pointer swipe. The intent check is horizontal-DOMINANT, not merely past-threshold:
   * without it a vertical scroll inside a long prompt body registers as a swipe and
   * throws the user onto another variant mid-read.
   */
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  const onPointerDown = (event: React.PointerEvent) => {
    dragStart.current = { x: event.clientX, y: event.clientY };
  };
  const onPointerUp = (event: React.PointerEvent) => {
    const start = dragStart.current;
    dragStart.current = null;
    if (!start || busy || discardAction !== null) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (Math.abs(dx) < SWIPE_THRESHOLD) return;
    if (Math.abs(dx) <= Math.abs(dy)) return;
    step(dx < 0 ? 1 : -1);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (busy || discardAction !== null) return;
    // Only when focus is NOT in a text field, or typing in the body would navigate.
    const tag = (event.target as HTMLElement).tagName;
    if (tag === "TEXTAREA" || tag === "INPUT") return;
    if (event.key === "ArrowLeft") { event.preventDefault(); step(-1); }
    if (event.key === "ArrowRight") { event.preventDefault(); step(1); }
  };

  const requestClose = useCallback(() => {
    if (dirty) { setDiscardAction({ kind: "close" }); return; }
    onClose();
  }, [dirty, onClose]);

  /**
   * Escape arrives as `cancel`. Without a preventDefault the native close fires
   * before the dirty check can run, and a half-written variant was gone without
   * a word - the same fix the custom-layer editor needed.
   */
  const handleCancel = useCallback((event: React.SyntheticEvent) => {
    event.preventDefault();
    requestClose();
  }, [requestClose]);

  const isLive = slot.kind === "default"
    ? selection.kind === "default"
    : slot.kind === "variant" && selection.kind === "variant" && selection.id === slot.variant!.id;
  const external = selection.kind === "external";

  /**
   * Same courtesy validation the custom-layer editor gets: the route enforces
   * these limits either way, but discovering a 64 KB overflow after pressing
   * Save is worse than seeing it while typing.
   */
  const normalized = normalizeBody(body);
  const bodyBytes = utf8Length(normalized);
  const invalid = findInvalidCharacter(normalized);
  const problem: { kind: "body-too-large"; bytes: number } | { kind: "invalid-character"; position: number } | null =
    bodyBytes > MAX_BODY_BYTES
      ? { kind: "body-too-large", bytes: bodyBytes }
      : invalid !== null
        ? { kind: "invalid-character", position: invalid.position }
        : null;
  const normalizationApplied = normalized !== body;
  // No memo: the body is capped at 64 KB and the lint pass is a handful of
  // regexes, so recomputing per render is cheaper than fighting the compiler's
  // manual-memoization rules over it.
  const findings = lintPromptLayer(normalized);

  const problemMessage = !problem ? null
    : problem.kind === "body-too-large" ? t("codexSet.custom.bodyTooLarge", { bytes: problem.bytes, max: MAX_BODY_BYTES })
    : t("codexSet.custom.invalidCharacter", { position: problem.position });

  const saveNow = async (targetKey: string | null) => {
    if (busy || problem !== null || body.trim().length === 0 || targetKey !== editingKey) return;
    // Recorded BEFORE the write so the variants effect can reconcile by id
    // whichever way the snapshot arrives while the request is in flight.
    pendingSaveRef.current = { id: slot.variant?.id ?? null, title, body: normalized };
    const saved = await onSave({ id: slot.variant?.id ?? null, title, body: normalized });
    if (!saved) {
      // Nothing landed: every draft is still live work, and a pending
      // confirmation stays open so the user can retry or dismiss it.
      pendingSaveRef.current = null;
      return;
    }
    const savedKey = targetKey ?? NEW_SLOT_KEY;
    draftsRef.current.delete(savedKey);
    if (discardAction?.kind === "save") {
      // "Discard the others and save" resolves only now that the save landed:
      // the other parked drafts are the discarded ones, and the confirmation
      // closes. On failure above both are deliberately untouched.
      for (const key of [...draftsRef.current.keys()]) {
        if (key !== savedKey) draftsRef.current.delete(key);
      }
      setDiscardAction(null);
    }
  };
  const requestSave = () => {
    if (busy || problem !== null) return;
    if (parkedDirty) { setDiscardAction({ kind: "save", targetKey: editingKey }); return; }
    void saveNow(editingKey);
  };

  return (
    <dialog
      ref={dialogRef}
      className="modal-overlay codex-set-base-dialog"
      aria-label={t("codexSet.base.title")}
      onCancel={handleCancel}
      onClose={onClose}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
    >
      <div className="modal-card">
        <div className="row">
          <strong>{t("codexSet.base.title")}</strong>
          <span className="codex-set-base-dialog__nav">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              aria-label={t("codexSet.base.prev")}
              disabled={busy || slots.length < 2 || discardAction !== null}
              onClick={() => step(-1)}
            >
              &larr;
            </button>
            <span className="codex-set-base-dialog__pos" data-slot-kind={slot.kind}>
              {t("codexSet.base.position", { position: index + 1, total: slots.length })}
            </span>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              aria-label={t("codexSet.base.next")}
              disabled={busy || slots.length < 2 || discardAction !== null}
              onClick={() => step(1)}
            >
              &rarr;
            </button>
          </span>
        </div>

        <p className="card-sub">{t("codexSet.base.swipeHint")}</p>

        {/* C5: Dot indicator showing ring position — a swipe affordance the
            text "1 / 2" alone does not provide. */}
        {slots.length > 1 && (
          <div className="codex-set-base-dialog__dots" aria-hidden="true">
            {slots.map((_, i) => (
              <span
                key={i}
                className={`codex-set-base-dialog__dot${i === index ? " active" : ""}`}
              />
            ))}
          </div>
        )}

        {external && (
          // Never silently retarget a key somebody else set. The panel already reports
          // this state; the picker refuses to act while it holds.
          <div className="notice notice-err" role="alert">
            {t("codexSet.base.externalBlocked", { path: selection.path })}
          </div>
        )}

        {/*
          The refusal is about SILENT retargeting, not about importing. The
          explicit opt-in copies the file into the variant directory and points
          the key at the copy — previewed first, written only on confirm, the
          same shape as the developer_instructions adopt flow.
        */}
        {external && (
          importPreview ? (
            <>
              {importRefusal !== null && <p className="muted small">{importRefusal}</p>}
              <p className="muted small">
                {t("codexSet.base.importPreview", { path: importPreview.resolvedPath ?? importPreview.rawPath ?? "" })}
              </p>
              {/*
                The exact serialized file is shown, not just the body: the title
                becomes the `# ` heading Codex will read, and CRLF/tab
                normalization is already applied — what is previewed is what is
                installed.
              */}
              <pre className="api-code codex-set-custom__adopt-preview">{importPreview.serialized}</pre>
              <p className="muted small">
                {t("codexSet.base.importFormat", {
                  bodyBytes: importPreview.bodyBytes,
                  serializedBytes: importPreview.serializedBytes,
                })}
              </p>
              <label className="field">
                <span>{t("codexSet.base.importTitle")}</span>
                <input
                  type="text"
                  value={importTitle}
                  disabled={busy}
                  maxLength={80}
                  onChange={event => {
                    setImportTitle(event.target.value);
                    onImportTitle(event.target.value);
                  }}
                />
              </label>
              {importTitle.trim() !== importPreview.effectiveTitle && (
                // The confirm hash binds the previewed title; an edited title
                // re-previews first, so until that lands there is nothing to bind.
                <p className="muted small">{t("codexSet.base.importTitlePending")}</p>
              )}
              <div className="modal-actions">
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={busy || importTitle.trim() !== importPreview.effectiveTitle}
                  onClick={() => onImport(true, importTitle.trim() || undefined)}
                >
                  {t("codexSet.base.importConfirm")}
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={onClose}
                >
                  {t("common.cancel")}
                </button>
              </div>
            </>
          ) : (
            <>
              {importRefusal !== null && (
                <p className="muted small">{importRefusal}</p>
              )}
              <button
                type="button"
                className="btn btn-sm"
                disabled={busy}
                onClick={() => onImport(false)}
              >
                {t("codexSet.base.import")}
              </button>
            </>
          )
        )}

        {slot.kind === "default" ? (
          <div className="codex-set-base-dialog__default">
            <strong>{t("codexSet.base.defaultTitle")}</strong>
            {/*
              Read-only because there is nothing stored to edit, not because a control was
              disabled. That distinction is the difference between "you cannot change this"
              and "this is not a thing that exists".
            */}
            <p className="muted small">{t("codexSet.base.defaultBody")}</p>
          </div>
        ) : (
          <>
            <label className="field">
              <span>{t("codexSet.base.variantTitle")}</span>
              <input
                type="text"
                value={title}
                disabled={busy || external}
                onChange={event => setTitle(event.target.value)}
              />
            </label>
            <label className="field">
              <span>{t("codexSet.base.variantBody")}</span>
              <textarea
                rows={12}
                value={body}
                disabled={busy || external}
                onChange={event => setBody(event.target.value)}
              />
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
              // Warnings, never blockers - a variant that deliberately takes over the
              // base prompt is allowed to restate things it genuinely wants.
              <ul className="codex-set-custom-dialog__lint">
                {findings.map((finding, i) => (
                  <li key={finding.rule + ":" + i} data-lint-rule={finding.rule} data-lint-level={finding.level}>
                    {t(finding.messageKey)}
                    {finding.span && (
                      <code className="codex-set-custom-dialog__span">{normalized.slice(finding.span[0], finding.span[1])}</code>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {/* The whole point, stated where the user decides: a variant REPLACES Codex
                own base prompt rather than adding to it. */}
            <p className="muted small">{t("codexSet.base.replacesWarning")}</p>
          </>
        )}

        {discardAction ? (
          // role="alertdialog" + a named prompt, for the same reason as the custom
          // layer editor's discard: an unnamed one is announced as an empty dialog.
          <div
            className="modal-actions codex-set-custom-dialog__discard"
            role="alertdialog"
            aria-labelledby="codex-set-base-dialog-discard"
          >
            <span id="codex-set-base-dialog-discard" className="muted small">
              {t(discardAction.kind === "save" ? "codexSet.custom.discardOthersAndSave" : "codexSet.custom.discardPrompt")}
            </span>
            <button type="button" className="btn btn-sm" onClick={() => setDiscardAction(null)}>
              {t("codexSet.custom.keepEditing")}
            </button>
            <button
              type="button"
              className="btn btn-danger btn-sm"
              disabled={discardAction.kind === "save" && (problem !== null || busy || body.trim().length === 0 || discardAction.targetKey !== editingKey)}
              onClick={() => discardAction.kind === "save" ? void saveNow(discardAction.targetKey) : onClose()}
            >
              {t(discardAction.kind === "save" ? "common.save" : "common.discard")}
            </button>
          </div>
        ) : (
          <div className="modal-actions">
            {slot.kind !== "default" && (
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={busy || external || problem !== null || body.trim().length === 0}
                onClick={requestSave}
              >
                {t("common.save")}
              </button>
            )}
            {!isLive && slot.kind !== "new" && (
              <button
                type="button"
                className="btn btn-sm"
                disabled={busy || external}
                onClick={() => onSelect(slot.kind === "default"
                  ? { kind: "default" }
                  : { kind: "variant", id: slot.variant!.id })}
              >
                {t("codexSet.base.use")}
              </button>
            )}
            {isLive && <span className="pill">{t("codexSet.base.inUse")}</span>}
            {slot.kind === "variant" && (
              <button
                type="button"
                className="btn btn-danger btn-sm"
                disabled={busy || external}
                onClick={() => onDelete(slot.variant!.id)}
              >
                {t("common.delete")}
              </button>
            )}
            <button type="button" className="btn btn-sm" onClick={requestClose}>
              {t("common.close")}
            </button>
          </div>
        )}
      </div>
    </dialog>
  );
}
