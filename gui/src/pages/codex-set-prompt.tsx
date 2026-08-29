import { useCallback, useEffect, useState } from "react";
import { useT } from "../i18n/shared";
import { useDataSurface } from "../data-surface";
import { setClientResourceData } from "../client-resource";
import { DataSurfaceSkeleton, DataSurfaceStatus } from "../components/data-surface";
import PromptLayerRow from "../components/codex-set/PromptLayerRow";
import PromptLayerDialog from "../components/codex-set/PromptLayerDialog";
import type { LayerId } from "../components/codex-set/prompt-layer-copy";
import type { TKey } from "../i18n/en";
import CustomLayerRow from "../components/codex-set/CustomLayerRow";
import CustomLayerDialog from "../components/codex-set/CustomLayerDialog";
import PresetPicker from "../components/codex-set/PresetPicker";
import BaseVariantDialog, { type BaseSelectionDto, type BaseVariantDto } from "../components/codex-set/BaseVariantDialog";
import { MAX_LAYERS, moveLayer, newLayerId, type Draft } from "../components/codex-set/custom-layer-state";

/**
 * The Prompt panel of Codex Set (WP3).
 *
 * This phase renders the five config-toggle rows and nothing else. The other
 * four layer classes are deliberately ABSENT rather than stubbed: a panel that
 * renders half a taxonomy invites a reader to assume the rest does not exist.
 * WP4 adds them together with the read-only dialog.
 *
 * No polling. The file changes when the user changes it, and a 30s timer would
 * fight the editor for no gain.
 */
export type LayerClass =
  | "base"
  | "config-toggle"
  | "feature-gated"
  | "runtime-conditional"
  | "extension-unknown";

export interface LayerDescriptorDto {
  /**
   * Narrowed to the ids the GUI has copy for. The server projects LAYER_INVENTORY,
   * so a value outside this union means the runtime shipped a layer this build does
   * not know about - handled explicitly at the render site rather than surfacing as
   * a blank row.
   */
  id: LayerId;
  class: LayerClass;
  key: string | null;
  default: boolean | null;
  order: number | null;
}

export interface ToggleStateDto {
  id: string;
  key: string;
  userFileValue: boolean | null;
  defaultedUserValue: boolean;
  default: boolean;
}

export interface CustomLayerDto {
  id: string;
  title: string;
  body: string;
  enabled: boolean;
}

export interface PromptSnapshotDto {
  configPath: string;
  storePath: string;
  configExists: boolean;
  readable: boolean;
  developerInstructionsOwned: boolean;
  /**
   * The precise ownership state. `developerInstructionsOwned: false` conflates an
   * ABSENT key (ordinary first run) with an EXTERNAL one (someone else wrote it),
   * and treating both as external hides + from every new user.
   */
  developerInstructionsState: "absent" | "owned" | "owned-malformed" | "external";
  drift: "journal-present" | "projection-stale" | "store-missing" | "owned-malformed" | null;
  revision: string;
  inventory: LayerDescriptorDto[];
  toggles: ToggleStateDto[];
  extensionLayersEnumerable: boolean;
  custom: CustomLayerDto[];
  modelInstructionsFile: string | null;
  baseVariants: BaseVariantDto[];
  /**
   * Three-valued. `external` is NOT folded into `default`: the key being set to a file
   * we did not write means the base prompt IS replaced, and showing that as "Codex's own
   * prompt" would be the panel lying about what the model reads.
   */
  baseSelection: BaseSelectionDto;
  maxBaseVariants: number;
}

/**
 * Module-private: exporting it broke the Fast Refresh rule this repository
 * lints for, and nothing outside this file ever called it. The exported types
 * above are erased at build time, so they do not trip the same rule.
 */
function codexPromptResourceKey(apiBase: string): string {
  return "codex-prompt:" + apiBase;
}

/** One message per drift state; a new state upstream breaks the build here. */
const DRIFT_KEYS: Record<Exclude<PromptSnapshotDto["drift"], null>, TKey> = {
  "journal-present": "codexSet.drift.journalPresent",
  "projection-stale": "codexSet.drift.projectionStale",
  "store-missing": "codexSet.drift.storeMissing",
  "owned-malformed": "codexSet.drift.ownedMalformed",
};

export default function CodexSetPrompt({ apiBase }: { apiBase: string }) {
  const t = useT();
  const resourceKey = codexPromptResourceKey(apiBase);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [openLayerId, setOpenLayerId] = useState<string | null>(null);
  // null = closed, "new" = the + flow, otherwise the id being edited.
  const [editing, setEditing] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [adoptPreview, setAdoptPreview] = useState<{ rawLine: string | null; decodedBody: string | null } | null>(null);
  /**
   * A refused adopt has to say WHERE. "The existing value could not be imported"
   * leaves the user with no way to act; the file path and line number are what let
   * them move the text by hand.
   */
  const [adoptRefusal, setAdoptRefusal] = useState<{ path?: string; line?: number | null; rawLine?: string | null } | null>(null);
  const [repairBusy, setRepairBusy] = useState(false);
  /**
   * A preset chosen from the picker seeds the ordinary editor. It is a starting
   * point, not a locked artifact, so it travels as a draft rather than being saved
   * directly.
   */
  const [presetSeed, setPresetSeed] = useState<{ title: string; body: string } | null>(null);
  /**
   * Rendered layer text, fetched lazily on first dialog open. It shells out to
   * `codex debug prompt-input`, so it is not part of the panel load - a user who
   * never opens a layer never pays for it.
   */
  const [layerText, setLayerText] = useState<{ ok: boolean; layers?: Record<string, { text: string | null; reason: string; bytes: number; sourcePath?: string }> } | null>(null);

  /**
   * Drop the measured text after any write. It describes the configuration that
   * just changed, so keeping it would show a layer's old body and old byte count
   * beside a switch that now reads off. Nulling it re-triggers the fetch.
   */
  const invalidateLayerText = useCallback(() => { setLayerText(null); }, []);

  const load = useCallback(async (signal: AbortSignal): Promise<PromptSnapshotDto> => {
    const res = await fetch(apiBase + "/api/codex-prompt", { signal });
    if (!res.ok) throw new Error(String(res.status));
    return await res.json() as PromptSnapshotDto;
  }, [apiBase]);

  const resource = useDataSurface<PromptSnapshotDto>(resourceKey, [apiBase], load, {
    isEmpty: snapshot => snapshot.inventory.length === 0,
  });
  const snapshot = resource.data;
  const state = resource.state;

  const onToggle = async (id: string, enabled: boolean) => {
    if (!snapshot) return;
    setBusyId(id);
    setError("");
    try {
      const res = await fetch(apiBase + "/api/codex-prompt/toggle", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, enabled, revision: snapshot.revision }),
      });
      const body = await res.json() as { ok?: boolean; code?: string; message?: string; snapshot?: PromptSnapshotDto };
      if (!res.ok || !body.ok || !body.snapshot) {
        // A stale revision means another tab or a hand edit moved the file. Re-read
        // rather than retrying blindly: a retry would overwrite whatever moved it.
        if (body.code === "stale_revision") {
          resource.refresh();
          setError(t("codexSet.prompt.staleRevision"));
          return;
        }
        setError(body.message ?? t("codexSet.prompt.writeFailed"));
        // Never leave a switch showing a state the file does not have.
        resource.refresh();
        return;
      }
      setClientResourceData(resourceKey, body.snapshot);
      invalidateLayerText();
      // The measured text belongs to the configuration that just changed. Keeping
      // it would show a layer's old body next to a switch that now says off.
      setLayerText(null);
    } catch {
      setError(t("codexSet.prompt.writeFailed"));
      resource.refresh();
    } finally {
      setBusyId(null);
    }
  };

  /**
   * One writer for all three base-variant verbs.
   *
   * They share a failure contract worth writing once: a stale revision means another
   * tab or a hand edit moved the file, so re-read rather than retry - a retry would
   * overwrite whatever moved it.
   */
  const writeBase = async (path: string, payload: Record<string, unknown>): Promise<void> => {
    if (!snapshot || busyId !== null) return;
    setBusyId("base");
    setError("");
    try {
      const res = await fetch(apiBase + path, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...payload, revision: snapshot.revision }),
      });
      const body = await res.json() as { ok?: boolean; code?: string; message?: string; snapshot?: PromptSnapshotDto };
      if (!res.ok || !body.ok || !body.snapshot) {
        if (body.code === "stale_revision") {
          resource.refresh();
          setError(t("codexSet.prompt.staleRevision"));
          return;
        }
        setError(body.message ?? t("codexSet.prompt.writeFailed"));
        resource.refresh();
        return;
      }
      setClientResourceData(resourceKey, body.snapshot);
      // The base prompt is a prompt layer like any other, so the measured text that
      // described the old one is no longer about this configuration.
      invalidateLayerText();
      setLayerText(null);
    } catch {
      setError(t("codexSet.prompt.writeFailed"));
      resource.refresh();
    } finally {
      setBusyId(null);
    }
  };

  /**
   * Full-replacement write. The route is shaped that way on purpose: order is
   * composition order, so a reorder needs no separate verb and a delete is just
   * the remaining list.
   */
  const writeCustom = async (layers: CustomLayerDto[], busyKey: string): Promise<boolean> => {
    if (!snapshot) return false;
    // Keeping the editor open until the write lands (so a refusal cannot discard a
    // draft) also means Save stays reachable while a PUT is in flight. Without this
    // guard two full-replacement writes can leave with the same revision: one lands,
    // the other comes back stale, and the user sees an error for work that succeeded.
    if (busyId !== null) return false;
    setBusyId(busyKey);
    setError("");
    const previous = snapshot.custom;
    try {
      const res = await fetch(apiBase + "/api/codex-prompt/custom", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ layers, revision: snapshot.revision }),
      });
      const body = await res.json() as { ok?: boolean; code?: string; message?: string; snapshot?: PromptSnapshotDto };
      if (!res.ok || !body.ok || !body.snapshot) {
        if (body.code === "stale_revision") {
          resource.refresh();
          setError(t("codexSet.prompt.staleRevision"));
          return false;
        }
        setError(body.message ?? t("codexSet.prompt.writeFailed"));
        // Restore the previous list rather than leaving the UI showing an edit
        // the file never accepted.
        setClientResourceData(resourceKey, { ...snapshot, custom: previous });
        resource.refresh();
        return false;
      }
      setClientResourceData(resourceKey, body.snapshot);
      invalidateLayerText();
      return true;
    } catch {
      setError(t("codexSet.prompt.writeFailed"));
      resource.refresh();
      return false;
    } finally {
      setBusyId(null);
    }
  };

  const saveDraft = async (draft: Draft) => {
    if (!snapshot) return;
    const existing = snapshot.custom;
    const next = draft.id === null
      ? [...existing, { id: newLayerId(existing), title: draft.title, body: draft.body, enabled: true }]
      // Editing keeps the id: it is stable across edits, which is what lets the
      // store and the projection stay in agreement.
      : existing.map(l => (l.id === draft.id ? { ...l, title: draft.title, body: draft.body } : l));
    // Close only after the write lands. Closing first threw away the text the user
    // just typed whenever the write was refused - a stale revision, a transient
    // failure - and the re-read that follows can restore the file but not a draft
    // that no longer exists anywhere.
    const saved = await writeCustom(next, draft.id ?? "new");
    if (saved) setEditing(null);
  };

  const adopt = async (confirm: boolean) => {
    if (!snapshot) return;
    setBusyId("adopt");
    setError("");
    try {
      const res = await fetch(apiBase + "/api/codex-prompt/adopt", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(confirm ? { confirm: true, revision: snapshot.revision } : { confirm: false }),
      });
      const body = await res.json() as {
        ok?: boolean; code?: string; message?: string;
        snapshot?: PromptSnapshotDto;
        preview?: { rawLine: string | null; decodedBody: string | null };
        path?: string; line?: number | null; rawLine?: string | null;
      };
      if (!res.ok || !body.ok) {
        setError(body.message ?? t("codexSet.custom.adoptRefused"));
        setAdoptPreview(null);
        // Only an unsupported FORM has a place to point at; other refusals do not.
        setAdoptRefusal(body.code === "adopt_unsupported_form"
          ? { path: body.path, line: body.line, rawLine: body.rawLine }
          : null);
        return;
      }
      if (body.snapshot) {
        setClientResourceData(resourceKey, body.snapshot);
        invalidateLayerText();
        setAdoptPreview(null);
        return;
      }
      // Preview only: nothing has been written, and the user still has to confirm.
      setAdoptPreview(body.preview ?? null);
    } catch {
      setError(t("codexSet.prompt.writeFailed"));
    } finally {
      setBusyId(null);
    }
  };

  /**
   * Drift is REPORTED by GET and resolved only here, on an explicit,
   * revision-checked POST. Two of the four states are repairable from WP1 exports;
   * the route refuses the other two by name rather than duplicating its journal
   * transaction, and the panel surfaces whatever it says.
   */
  const repair = async (confirm: boolean) => {
    if (!snapshot || snapshot.drift === null) return;
    setRepairBusy(true);
    setError("");
    try {
      const res = await fetch(apiBase + "/api/codex-prompt/repair", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(confirm ? { confirm: true, revision: snapshot.revision } : { confirm: false }),
      });
      const body = await res.json() as { ok?: boolean; message?: string; snapshot?: PromptSnapshotDto };
      if (!res.ok || !body.ok) {
        setError(body.message ?? t("codexSet.prompt.repairFailed"));
        return;
      }
      if (body.snapshot) setClientResourceData(resourceKey, body.snapshot);
      else resource.refresh();
      invalidateLayerText();
    } catch {
      setError(t("codexSet.prompt.repairFailed"));
    } finally {
      setRepairBusy(false);
    }
  };
  // Assembly order, so the list reads the way the prompt is actually built.
  // Every class renders; the row decides what each one gets.
  //
  // A null order means the position is registration-order dependent rather than fixed
  // in world_state.rs - an extension-contributed section. Those sort AFTER every known
  // position instead of collapsing to 0, which would have put them at the very top and
  // claimed they are assembled first. The stable fallback keeps two such layers in
  // inventory order relative to each other rather than swapping unpredictably.
  const rows = [...(snapshot?.inventory ?? [])]
    .filter(d => d.class !== "extension-unknown")
    .sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER));

  /**
   * Two kinds of layer, split by what they ARE rather than by a scope flag.
   *
   * A transition notice exists only to announce a change - entering realtime,
   * switching model mid-conversation. There is no steady state for it to describe,
   * so it never appears in an ordinary turn. Every other layer describes
   * configuration or context and renders when its snapshot first appears or
   * changes.
   *
   * Note what this is NOT: "ships every turn" versus "sometimes". Sections are
   * diff-rendered, so an unchanged layer of either kind sends nothing.
   */
  const TRANSITION_ONLY = new Set(["realtime", "model-switch"]);
  const stateRows = rows.filter(d => !TRANSITION_ONLY.has(d.id));
  const transitionRows = rows.filter(d => TRANSITION_ONLY.has(d.id));
  const openDescriptor = rows.find(d => d.id === openLayerId) ?? null;

  /**
   * The layer under the open editor, and where it sits.
   *
   * A refresh can delete it out from under the dialog - another tab, a hand edit.
   * Falling back to `null` silently turned the editor into a NEW-layer form
   * carrying the deleted layer's text, so Save would have recreated a layer the
   * user had just removed. Index -1 is the signal that this happened.
   */
  const editingIndex = editing === null || editing === "new"
    ? -1
    : (snapshot?.custom.findIndex(l => l.id === editing) ?? -1);
  const editingLayer = editingIndex >= 0 ? snapshot!.custom[editingIndex]! : null;

  /**
   * The layer vanished while its editor was open - another tab, a hand edit.
   *
   * Keeping the dialog would let Save recreate what the user just deleted, and
   * silently swapping to a neighbour would put someone else's text under their
   * cursor. So the editor closes and the panel says why.
   *
   * Derived, not written from an effect. Calling setState synchronously in an
   * effect body cascades an extra render - which is what lint rejects - and
   * every input here is already known while rendering.
   */
  const layerGone = editing !== null && editing !== "new" && snapshot !== undefined && editingIndex < 0;

  useEffect(() => {
    // Fetch on panel mount, not on first dialog open: size is what a user needs to
    // DECIDE with, and a prompt-budget page that hides which layer costs 15 KB is
    // asking them to guess.
    if (layerText !== null) return;
    const controller = new AbortController();
    // Two mechanisms, two jobs. The controller aborts the in-flight request so the server can
    // cancel the probe child it spawned for us; the flag is what guards `setState` after an
    // await. `signal.aborted` would read the same at runtime, but the lint rule that catches
    // post-await state updates does not follow it, and losing that check on this effect is a
    // worse trade than carrying one extra variable.
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(apiBase + "/api/codex-prompt/text", { signal: controller.signal });
        // Status first. A 500 body still parses as JSON, and `{}` deserialized
        // into this shape reads as a probe that succeeded and found no layers -
        // so every row would silently lose its byte count and every dialog would
        // claim the layer sent nothing.
        if (!res.ok) {
          if (!cancelled) setLayerText({ ok: false });
          return;
        }
        const body = await res.json() as { ok: boolean; layers?: Record<string, { text: string | null; reason: string; bytes: number }> };
        if (!cancelled) setLayerText(body);
      } catch {
        // A failed probe is a missing body, not a broken page. An abort lands here too, and the
        // flag is what keeps it from writing state into an unmounted panel.
        if (!cancelled) setLayerText({ ok: false });
      }
    })();
    return () => { cancelled = true; controller.abort(); };
  }, [layerText, apiBase]);

  return (
    <div className="panel codex-set-prompt">
      <div className="row">
        <strong>{t("codexSet.prompt.title")}</strong>
      </div>
      {/*
        Fixed copy from devlog 003 section 3. Neither "applies immediately" nor
        "restart required" is proven, and the frontend reload path is UNKNOWN
        upstream, so the panel promises only what the runtime actually does.
      */}
      <p className="card-sub">{t("codexSet.prompt.timing")}</p>

      {/*
        One announcement per transition: the status line yields its live region to
        the error notice so a screen reader is not told the same thing twice.
      */}
      {state.refreshing && (
        <DataSurfaceStatus live={!state.showError}>
          {t("common.loading")}
        </DataSurfaceStatus>
      )}

      {state.showSkeleton && (
        <DataSurfaceSkeleton label={t("common.loading")} rows={5} />
      )}

      {snapshot && !snapshot.readable && (
        <div className="notice notice-err" role="alert">{t("codexSet.prompt.unreadable")}</div>
      )}
      {/*
        A failed read must be visible. Without this the cold failure rendered as a
        title and an empty list, and a failed refresh over existing rows read as
        settled - the two states the loading contract exists to keep apart.
      */}
      {state.showError && (
        <div className="notice notice-err" role="alert">{t("codexSet.prompt.loadFailed")}</div>
      )}
      {(error || layerGone) && (
        <div className="notice notice-err" role="alert">
          {layerGone ? t("codexSet.custom.layerGone") : error}
        </div>
      )}

      {/*
        Drift is never silently self-healed: the user is told what state the file
        is in and repairs it deliberately, because two of the four branches
        rewrite content they authored.
      */}
      {snapshot?.drift && (
        <div className="notice codex-set-prompt__drift" role="alert" data-drift={snapshot.drift}>
          <span>{t(DRIFT_KEYS[snapshot.drift])}</span>
          <button
            type="button"
            className="btn btn-sm"
            disabled={repairBusy}
            onClick={() => { void repair(true); }}
          >
            {t("codexSet.prompt.repair")}
          </button>
        </div>
      )}

      <ul className="codex-set-prompt__rows">
        {stateRows.map(descriptor => (
          <PromptLayerRow
            key={descriptor.id}
            descriptor={descriptor}
            toggle={snapshot?.toggles.find(s => s.id === descriptor.id)}
            bytes={layerText?.layers?.[descriptor.id]?.bytes ?? null}
            busy={busyId === descriptor.id}
            writesRefused={snapshot?.readable === false}
            onToggle={(id, enabled) => { void onToggle(id, enabled); }}
            onSelectBase={descriptor.class === "base" && snapshot ? (useDefault => {
              // Turning it OFF has to pick something concrete. With no variant yet the
              // switch cannot act, so it opens the picker instead of writing a key that
              // would name a file the user has not written.
              if (useDefault) {
                void writeBase("/api/codex-prompt/base/select", { kind: "default" });
                return;
              }
              const first = snapshot.baseVariants[0];
              if (!first) { setOpenLayerId(descriptor.id); return; }
              void writeBase("/api/codex-prompt/base/select", { kind: "variant", id: first.id });
            }) : undefined}
            baseSelection={snapshot?.baseSelection}
            onOpen={setOpenLayerId}
          />
        ))}
      </ul>

      {/*
        Kept in the list rather than hidden, because a user auditing their prompt
        needs to know these exist. They are separated because they are a different
        kind of thing: a notice about a change, not a description of state.
      */}
      {transitionRows.length > 0 && (
        <>
          <div className="row codex-set-prompt__group">
            <strong>{t("codexSet.group.transition")}</strong>
          </div>
          <p className="muted small">{t("codexSet.group.transitionDesc")}</p>
          <ul className="codex-set-prompt__rows">
            {transitionRows.map(descriptor => (
              <PromptLayerRow
                key={descriptor.id}
                descriptor={descriptor}
                toggle={snapshot?.toggles.find(s => s.id === descriptor.id)}
                bytes={layerText?.layers?.[descriptor.id]?.bytes ?? null}
                transitionOnly
                busy={busyId === descriptor.id}
                writesRefused={snapshot?.readable === false}
                onToggle={(id, enabled) => { void onToggle(id, enabled); }}
                onOpen={setOpenLayerId}
              />
            ))}
          </ul>
        </>
      )}

      {/*
        Third-party extension layers cannot be enumerated (devlog 001 class E), so
        the panel says so rather than implying the list above is exhaustive. A count
        is the honest shape: rows would claim knowledge we do not have.
      */}
      {snapshot && !snapshot.extensionLayersEnumerable && (
        <p className="muted small codex-set-prompt__extensions">{t("codexSet.prompt.extensionsUnknown")}</p>
      )}

      {openDescriptor && (
        // The base row opens the VARIANT picker, not the read-only dialog: it is the
        // one layer with something to choose between.
        openDescriptor.class === "base" && snapshot ? (
          <BaseVariantDialog
            variants={snapshot.baseVariants}
            selection={snapshot.baseSelection}
            maxVariants={snapshot.maxBaseVariants}
            busy={busyId !== null || !snapshot.readable}
            onSelect={sel => { void writeBase("/api/codex-prompt/base/select", sel); }}
            onSave={input => { void writeBase("/api/codex-prompt/base", input); }}
            onDelete={id => { void writeBase("/api/codex-prompt/base", { id, delete: true }); }}
            onClose={() => setOpenLayerId(null)}
          />
        ) : (
        <PromptLayerDialog
          descriptor={openDescriptor}
          toggle={snapshot?.toggles.find(s => s.id === openDescriptor.id)}
          text={layerText?.layers?.[openDescriptor.id]}
          busy={busyId !== null}
          onToggle={(id, enabled) => { void onToggle(id, enabled); }}
          onClose={() => setOpenLayerId(null)}
        />
        )
      )}

      {/*
        Custom layers compose into developer_instructions, NEVER into
        model_instructions_file: that key REPLACES the entire base prompt, so
        wiring + to it would delete Codex's own instructions on first save.
        devlog 000 records this as the deliberate deviation from the literal ask.
      */}
      {snapshot && (
        <section className="codex-set-custom">
          <div className="row">
            <strong>{t("codexSet.custom.heading")}</strong>
            {snapshot.developerInstructionsState !== "external" ? (
              <PresetPicker
                // Same refusal as the built-in switches. Offering an editor over a
                // file we cannot read only trades a disabled control for a server
                // rejection after the user has typed.
                disabled={snapshot.custom.length >= MAX_LAYERS || busyId !== null || !snapshot.readable}
                onBlank={() => { setPresetSeed(null); setEditing("new"); }}
                onPreset={(body, title) => { setPresetSeed({ body, title }); setEditing("new"); }}
              />
            ) : null}
          </div>

          {snapshot.custom.length >= MAX_LAYERS && (
            <p className="muted small">{t("codexSet.custom.limitReached", { max: MAX_LAYERS })}</p>
          )}

          {/*
            An externally authored key is not ours to rewrite. Rather than telling
            the user to go delete their own instructions by hand, the panel offers
            to import them - previewed first, written only on confirmation.
          */}
          {snapshot.developerInstructionsState === "external" && snapshot.modelInstructionsFile === null && (
            <div className="codex-set-custom__adopt">
              <p className="muted small">{t("codexSet.custom.notOwned")}</p>
              {adoptRefusal && (
                // Path and line, so the user can go find the text and move it by hand.
                // "Could not be imported" alone leaves them with nothing to act on.
                <p className="muted small codex-set-custom__adopt-refusal">
                  {t("codexSet.custom.adoptUnsupported", {
                    path: adoptRefusal.path ?? "",
                    line: adoptRefusal.line ?? 0,
                  })}
                </p>
              )}
              {adoptPreview ? (
                <>
                  <pre className="api-code codex-set-custom__adopt-preview">{adoptPreview.decodedBody}</pre>
                  <div className="modal-actions">
                    <button type="button" className="btn btn-primary btn-sm" disabled={busyId !== null} onClick={() => { void adopt(true); }}>
                      {t("codexSet.custom.adoptConfirm")}
                    </button>
                    <button type="button" className="btn btn-sm" onClick={() => setAdoptPreview(null)}>
                      {t("common.cancel")}
                    </button>
                  </div>
                </>
              ) : (
                <button type="button" className="btn btn-sm" disabled={busyId !== null} onClick={() => { void adopt(false); }}>
                  {t("codexSet.custom.adopt")}
                </button>
              )}
            </div>
          )}

          {/*
            model_instructions_file is reported, never written: it replaces the base
            prompt outright, so the panel states that something outside opencodex
            has taken it over.
          */}
          {snapshot.modelInstructionsFile !== null && (
            <p className="muted small codex-set-custom__replaced">
              {t("codexSet.custom.baseReplaced", { path: snapshot.modelInstructionsFile })}
            </p>
          )}

          <ul className="codex-set-prompt__rows">
            {snapshot.custom.map((layer, index) => (
              <CustomLayerRow
                key={layer.id}
                layer={layer}
                index={index}
                total={snapshot.custom.length}
                busy={busyId !== null || !snapshot.readable}
                onToggle={(id, enabled) => {
                  void writeCustom(snapshot.custom.map(l => (l.id === id ? { ...l, enabled } : l)), id);
                }}
                onEdit={setEditing}
                onDelete={setConfirmingDelete}
                onMove={(id, delta) => { void writeCustom(moveLayer(snapshot.custom, id, delta), id); }}
              />
            ))}
          </ul>

          {confirmingDelete && (
            // Confirm first: a body can be long and there is no undo.
            // The named prompt below is also the accessible name: an alertdialog
            // without one is announced as an unnamed dialog, which defeats the point
            // of naming the row in the first place.
            <div
              className="notice codex-set-custom__confirm"
              role="alertdialog"
              aria-labelledby="codex-set-delete-confirm"
            >
              {/*
                Name the row. A generic "delete this layer?" sitting under a list of
                long titles leaves the user guessing which one is pending.
              */}
              <span id="codex-set-delete-confirm">{t("codexSet.custom.deleteConfirmNamed", {
                title: snapshot.custom.find(l => l.id === confirmingDelete)?.title ?? "",
              })}</span>
              <button
                type="button"
                className="btn btn-danger btn-sm"
                onClick={() => {
                  const id = confirmingDelete;
                  setConfirmingDelete(null);
                  void writeCustom(snapshot.custom.filter(l => l.id !== id), id);
                }}
              >
                {t("common.delete")}
              </button>
              <button type="button" className="btn btn-sm" onClick={() => setConfirmingDelete(null)}>
                {t("common.cancel")}
              </button>
            </div>
          )}
        </section>
      )}

      {editing && snapshot && !layerGone && (
        <CustomLayerDialog
          layer={editing === "new" ? null : editingLayer}
          seed={editing === "new" ? presetSeed : null}
          others={snapshot.custom}
          busy={busyId !== null}
          // Navigation only exists while the edited layer is still in the list.
          // Deriving the position from a findIndex that can return -1 produced
          // "0 / 3" for a layer another tab had just deleted.
          navigation={editingIndex >= 0 && snapshot.custom.length > 1 ? {
            position: editingIndex + 1,
            total: snapshot.custom.length,
            onPrev: () => { if (editingIndex > 0) setEditing(snapshot.custom[editingIndex - 1]!.id); },
            onNext: () => {
              if (editingIndex < snapshot.custom.length - 1) setEditing(snapshot.custom[editingIndex + 1]!.id);
            },
          } : undefined}
          onSave={saveDraft}
          onClose={() => { setEditing(null); setPresetSeed(null); }}
        />
      )}
    </div>
  );
}
