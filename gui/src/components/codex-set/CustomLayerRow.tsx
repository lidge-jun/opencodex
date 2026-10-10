import { useT } from "../../i18n/shared";
import { utf8Length } from "./custom-layer-state";
import type { CustomLayerDto } from "../../pages/codex-set-prompt";

/**
 * One custom layer row: switch, edit, delete, and keyboard-reachable reorder.
 *
 * All three actions, unlike built-in rows which never get delete (ask item 6).
 * Reorder has up/down buttons rather than a drag handle alone - a drag-only
 * affordance is not reachable.
 */
export default function CustomLayerRow({
  layer,
  index,
  total,
  busy,
  onToggle,
  onEdit,
  onDelete,
  onMove,
}: {
  layer: CustomLayerDto;
  index: number;
  total: number;
  busy: boolean;
  onToggle: (id: string, enabled: boolean) => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  onMove: (id: string, delta: -1 | 1) => void;
}) {
  const t = useT();
  return (
    <li
      className="codex-set-prompt__row codex-set-custom__row"
      data-custom-id={layer.id}
      // Alt+Arrow reorders from anywhere in the row, per the W3C rearrangeable
      // listbox pattern. The up/down buttons stay: a shortcut nobody discovers is
      // not an affordance, and a button is what makes the capability visible.
      onKeyDown={event => {
        if (!event.altKey || busy) return;
        if (event.key === "ArrowUp" && index > 0) {
          event.preventDefault();
          onMove(layer.id, -1);
        } else if (event.key === "ArrowDown" && index < total - 1) {
          event.preventDefault();
          onMove(layer.id, 1);
        }
      }}
    >
      {/*
        Numbered among themselves, not continuing the built-in sequence. Custom
        layers concatenate into ONE developer_instructions section, so sharing a
        sequence with the built-ins would draw a stack that does not exist.
      */}
      <span className="codex-set-prompt__pos" aria-hidden="true">{index + 1}</span>
      <button type="button" className="link-btn codex-set-prompt__name" onClick={() => onEdit(layer.id)}>
        {layer.title}
      </button>

      {/*
        The same byte budget the built-in rows get. A custom layer is composed
        text like any other, so hiding its size here asked the user to guess what
        their own layer costs.
      */}
      <span
        className="codex-set-prompt__bytes"
        title={t("codexSet.dialog.sourceBytes", { bytes: utf8Length(layer.body) })}
      >
        {utf8Length(layer.body) >= 1024
          ? Math.round(utf8Length(layer.body) / 1024) + " KB"
          : utf8Length(layer.body) + " B"}
      </span>

      <span className="codex-set-custom__reorder">
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          aria-label={t("codexSet.custom.moveUp", { title: layer.title })}
          disabled={index === 0 || busy}
          onClick={() => onMove(layer.id, -1)}
        >
          &uarr;
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          aria-label={t("codexSet.custom.moveDown", { title: layer.title })}
          disabled={index === total - 1 || busy}
          onClick={() => onMove(layer.id, 1)}
        >
          &darr;
        </button>
      </span>

      <button
        type="button"
        role="switch"
        className={`toggle ${layer.enabled ? "on" : ""}`}
        aria-checked={layer.enabled}
        aria-label={layer.title}
        disabled={busy}
        onClick={() => onToggle(layer.id, !layer.enabled)}
      >
        <span className="toggle-knob" />
      </button>

      <button
        type="button"
        className="btn btn-ghost btn-sm codex-set-custom__delete"
        aria-label={t("codexSet.custom.delete", { title: layer.title })}
        disabled={busy}
        onClick={() => onDelete(layer.id)}
      >
        &times;
      </button>
    </li>
  );
}
