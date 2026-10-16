import { useT } from "../../i18n/shared";
import { navigateHash } from "../../hash-routing";
import type { LayerDescriptorDto, ToggleStateDto } from "../../pages/codex-set-prompt";
import { LAYER_CONDITION_KEYS, LAYER_LABEL_KEYS } from "./prompt-layer-copy";

/**
 * One row of the prompt-layer list.
 *
 * Row kind comes from `descriptor.class`, which is LAYER_INVENTORY, which is the
 * taxonomy in devlog 001 section 4. That is the whole mapping - there is no
 * heuristic and no second table, so a row can never be classified two ways.
 *
 * A layer with no upstream off-switch renders with NO switch element at all:
 * not a disabled checkbox, not a greyed toggle. A disabled control claims the
 * capability exists and is temporarily unavailable, which is false for these
 * layers - Codex has no way to suppress them anywhere. This is ask item 9 at the
 * rendering layer; the API refuses the same ids independently.
 *
 * The wording distinction matters too. `base` and `runtime-conditional` rows have
 * no off-switch anywhere. `feature-gated` rows ARE disableable - through
 * [features], not from this page. Applying the stronger sentence to both would
 * tell a user a setting does not exist when it does.
 */
export default function PromptLayerRow({
  descriptor,
  toggle,
  bytes,
  transitionOnly = false,
  busy,
  writesRefused,
  onToggle,
  onReset,
  onSelectBase,
  baseSelection,
  onOpen,
}: {
  descriptor: LayerDescriptorDto;
  toggle: ToggleStateDto | undefined;
  /** Measured size of what this layer actually sent, when known. */
  bytes: number | null;
  /** A notice about a change has no steady state to be "on" in. */
  transitionOnly?: boolean;
  busy: boolean;
  writesRefused: boolean;
  onToggle: (id: string, enabled: boolean) => void;
  /**
   * Deletes the key line rather than writing the default back as a literal, so
   * the row follows Codex's built-in default again. Only rendered when the file
   * carries an explicit value.
   */
  onReset?: (id: string) => void;
  /**
   * The base row's switch. A SEPARATE prop from `onToggle` on purpose: base is not a
   * boolean key in config.toml, it is a variant selection, and `isToggleId` still
   * returns false for it. Reusing onToggle would let a future edit route this through
   * the toggle endpoint, which refuses the id - correctly, but only after the click.
   *
   * `on` means Codex's own base prompt; `off` means the selected variant replaces it.
   * Base cannot be EMPTIED - a model with no base prompt is not a working agent - so
   * the switch substitutes rather than removes, and the dialog says so.
   */
  onSelectBase?: (useDefault: boolean) => void;
  /** Which base prompt is live, so the switch can show the truth. */
  baseSelection?: { kind: "default" } | { kind: "variant"; id: string } | { kind: "external"; path: string };
  onOpen: (id: string) => void;
}) {
  const t = useT();
  const labelKey = LAYER_LABEL_KEYS[descriptor.id];
  // An id this build has no copy for is shown verbatim rather than blank: a newer
  // runtime listing a layer we do not know about is information, not an error.
  const label = labelKey ? t(labelKey) : descriptor.id;
  // A layer that only appears under a condition has one; the rest do not (the map is
  // deliberately partial). Read here as well as in the dialog so a conditional row
  // never claims to be unconditional.
  const conditionKey = LAYER_CONDITION_KEYS[descriptor.id];
  const checked = toggle?.defaultedUserValue ?? descriptor.default ?? true;
  // `external` counts as NOT default: something outside opencodex replaced the base
  // prompt, and showing the switch as on would claim Codex's own prompt is in force.
  const baseUsesDefault = baseSelection?.kind === "default";

  return (
    <li className="codex-set-prompt__row" data-layer-id={descriptor.id} data-layer-class={descriptor.class}>
      {/*
        The CANONICAL assembly index, gaps included. Renumbering per visual group
        would invent an order the runtime does not have: these positions come from
        world_state.rs and are not user-reorderable, which is also why there is no
        drag handle here.
      */}
      <span className="codex-set-prompt__pos" aria-hidden="true">
        {descriptor.order === null ? "\u00b7" : descriptor.order + 1}
      </span>
      <button
        type="button"
        className="link-btn codex-set-prompt__name"
        onClick={() => onOpen(descriptor.id)}
      >
        {label}
      </button>

      {descriptor.key && <code className="codex-set-prompt__key">{descriptor.key}</code>}

      {/*
        Weight, shown where the decision happens. This is a prompt-budget page: a
        layer that costs 15 KB and one that costs 300 bytes should not look
        identical while the user decides which to keep.
      */}
      {bytes !== null && bytes > 0 && (
        <span className="codex-set-prompt__bytes" title={t("codexSet.dialog.sourceBytes", { bytes })}>
          {bytes >= 1024 ? Math.round(bytes / 1024) + " KB" : bytes + " B"}
        </span>
      )}

      {descriptor.class === "base" && onSelectBase ? (
        // A REAL switch, because after the variant work base genuinely has an
        // off-position. The class rule above is honoured rather than relaxed: a layer
        // with no off-switch gets no control, and this one now has one.
        <button
          type="button"
          role="switch"
          className={`toggle ${baseUsesDefault ? "on" : ""}`}
          aria-checked={baseUsesDefault}
          aria-label={label}
          disabled={busy || writesRefused || baseSelection?.kind === "external"}
          onClick={() => { onSelectBase(!baseUsesDefault); }}
        >
          <span className="toggle-knob" />
        </button>
      ) : descriptor.class === "config-toggle" ? (
        <>
          {/* The dashboard's switch is a button with a knob, not a checkbox. A raw
              <input type="checkbox"> renders as an actual checkbox here because the
              .switch class it was reaching for styles a different element. */}
          <button
            type="button"
            role="switch"
            className={`toggle ${checked ? "on" : ""}`}
            aria-checked={checked}
            aria-label={label}
            disabled={busy || writesRefused}
            onClick={() => { onToggle(descriptor.id, !checked); }}
          >
            <span className="toggle-knob" />
          </button>
          {/*
            An explicit value in the file can be removed so the built-in default
            applies again — writing `true` for a default-true toggle would freeze
            the override. Offered only when there IS an override to remove.
          */}
          {toggle !== undefined && toggle.userFileValue !== null && onReset && (
            <button
              type="button"
              className="link-btn codex-set-prompt__reset"
              disabled={busy || writesRefused}
              onClick={() => { onReset(descriptor.id); }}
            >
              {t("codexSet.row.resetDefault", { value: String(toggle.default) })}
            </button>
          )}
        </>
      ) : descriptor.class === "feature-gated" ? (
        // Configurable, just not here. Naming the governing key is the whole point -
        // "always on" would be a lie about a setting the user can actually change -
        // and the link is what turns that from a dead end into a destination.
        <span className="codex-set-prompt__note">
          {t("codexSet.row.featureGated")}{" "}
          {/*
            A button through `navigateHash`, not a bare fragment href. Nothing in
            the document carries `id="integrations/codex"` - it is a route, so the
            anchor pointed at a target that does not exist and the app router had
            to rescue the click.
          */}
          <button
            type="button"
            className="link-btn"
            onClick={() => navigateHash("integrations/codex")}
          >
            {t("codexSet.row.openFeatures")}
          </button>
        </span>
      ) : (
        // base and runtime-conditional: no off-switch exists anywhere in Codex.
        <span className="codex-set-prompt__note codex-set-prompt__note--locked">
          {/*
            "Always on" is false for a transition notice: it is not on, it fires.
            Reusing the locked label would tell the user this text is in every
            prompt when it appears only at a change.

            It is equally false for a layer with a CONDITION. `plugins` is emitted
            when a plugin is selected or advertises a capability, and
            `git-attribution` follows the account's attribution policy - neither is
            unconditionally present, and the dialog has always said so while the row
            said "Always on". The row now prefers the condition when one exists, so
            the two surfaces cannot disagree about the same layer.
          */}
          {transitionOnly
            ? t("codexSet.row.onChange")
            : conditionKey
              ? t(conditionKey)
              : t("codexSet.row.alwaysOn")}
        </span>
      )}
    </li>
  );
}
