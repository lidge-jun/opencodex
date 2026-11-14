import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { flushSync } from "react-dom";
import { COMBO_EFFORTS, COMBO_TARGETS_HINT_KEYS, type ComboStrategy } from "../../combo-workspace-data";
import { useT } from "../../i18n/shared";
import { formatProviderDisplayName } from "../../provider-icons";
import {
  capabilityPatch,
  channelKey,
  combineLists,
  comboContextWindow,
  withInferredGaps,
  memberFacts,
  moveChannel,
  type CapabilityPolicy,
  type ChannelQuota,
  type ComboCapabilitySettings,
  type ComboSettingsPatch,
  type MemberModel,
  type RouteChannel,
  type UnservablePolicy,
} from "../../route-board-model";
import { Select, Switch } from "../../ui";
import { ProviderIcon } from "../provider-workspace/ProviderRail";
import type { ModelOption, ProviderOption } from "../combo-workspace-types";
import type { ProbeMemberModel } from "./MemberProbe";
import { MemberTable, type SaveMemberModel } from "./MemberTable";
import { QuotaLine } from "./QuotaLine";
import { dragRows } from "./drag-rows";

export type EditableChannel = Pick<RouteChannel, "key" | "provider" | "model" | "lastResort">;

const SLIDE_MS = 160;
const MODALITY_ORDER = ["text", "image"];

/**
 * Slide rows to their new place after a reorder (FLIP): measure where each row was, let React
 * move it, then start it from the old spot and transition to zero. No library; a reorder
 * during the slide simply restarts it from wherever the row is drawn.
 */
function useSlideOnReorder(order: readonly string[]) {
  const nodes = useRef(new Map<string, HTMLElement>());
  const previous = useRef(new Map<string, number>());
  /** Set by a drag commit: the rows are already drawn where they land, so nothing slides. */
  const still = useRef(false);
  useLayoutEffect(() => {
    const next = new Map<string, number>();
    const skip = still.current;
    still.current = false;
    for (const [key, node] of nodes.current) {
      const top = node.getBoundingClientRect().top;
      next.set(key, top);
      const before = previous.current.get(key);
      if (skip || before === undefined || before === top || typeof node.animate !== "function") continue;
      node.animate([{ transform: `translateY(${before - top}px)` }, { transform: "translateY(0)" }], {
        duration: SLIDE_MS,
        easing: "ease-out",
      });
    }
    previous.current = next;
  }, [order]);
  const ref = (key: string) => (node: HTMLElement | null) => {
    if (node) nodes.current.set(key, node); else nodes.current.delete(key);
  };
  return { ref, still };
}


/**
 * Inline channel editor under an expanded row: reorder (drag, with the other rows making room
 * as you go, or the move buttons from the keyboard), mark fallback-only, remove, add, and a
 * "More settings" section that opens in place. Nothing is written until Save.
 */
export function ChannelEditor({
  comboModel,
  strategy,
  channels: initial,
  quotaFor,
  providers,
  models,
  lastResortActive,
  labels,
  capability: initialCapability,
  catalogContext,
  moreOpen: moreOpenInitially = false,
  saving,
  onSave,
  onSaveModel,
  onProbeModel,
  onCancel,
}: {
  comboModel: string;
  strategy: ComboStrategy;
  channels: readonly EditableChannel[];
  quotaFor: (provider: string) => ChannelQuota;
  providers: readonly ProviderOption[];
  models: readonly (ModelOption & MemberModel)[];
  /** The combo sets `cooldownWaitPolicy`, so fallback-only marks are in effect. */
  lastResortActive: boolean;
  /** Row-level provider labels, so two providers sharing a display name stay distinct here too. */
  labels?: ReadonlyMap<string, string>;
  capability: ComboCapabilitySettings;
  /** The context window the server advertises for this combo today. */
  catalogContext?: number;
  /** Open "More settings" and bring it into view (the row's context tag asks for this). */
  moreOpen?: boolean;
  saving: boolean;
  onSave: (channels: EditableChannel[], settings: ComboSettingsPatch) => void;
  /** Writes one member model's per-provider settings (shared by every combo using it). */
  onSaveModel?: SaveMemberModel;
  /** Probes what one member's relay accepts (image input, effort levels). */
  onProbeModel?: ProbeMemberModel;
  onCancel: () => void;
}) {
  const t = useT();
  const [channels, setChannels] = useState<EditableChannel[]>(() => [...initial]);
  const listRef = useRef<HTMLOListElement>(null);
  const [moreOpen, setMoreOpen] = useState(moreOpenInitially);
  const moreRef = useRef<HTMLDivElement>(null);
  const slide = useSlideOnReorder(channels.map((channel) => channel.key));
  const pickable = providers.filter((provider) => !provider.hiddenFromPicker);
  const [addProvider, setAddProvider] = useState(() => pickable[0]?.name ?? "");
  const used = new Set(channels.map((channel) => channel.key));
  const addModels = models.filter((model) => model.provider === addProvider && !used.has(channelKey(model.provider, model.id)));
  const [addModel, setAddModel] = useState("");
  const chosenModel = addModels.some((model) => model.id === addModel) ? addModel : addModels[0]?.id ?? "";
  const [capability, setCapability] = useState<ComboCapabilitySettings>(initialCapability);
  const [fallbackOnly, setFallbackOnly] = useState(lastResortActive);
  const settings: ComboSettingsPatch = {
    ...capabilityPatch(initialCapability, capability),
    ...(fallbackOnly !== lastResortActive ? { cooldownWaitPolicy: fallbackOnly ? "before-last-resort" as const : null } : {}),
  };
  const dirty = channels.length !== initial.length
    || channels.some((channel, index) => channel.key !== initial[index]?.key || channel.lastResort !== initial[index]?.lastResort)
    || Object.keys(settings).length > 0;
  const choice = (value: string, name: string, hint: string) => ({
    value,
    textValue: name,
    label: <span className="rb-strategy-option"><span className="rb-strategy-name">{name}</span><span className="rb-strategy-hint">{hint}</span></span>,
  });

  useEffect(() => {
    if (moreOpenInitially) moreRef.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }, [moreOpenInitially]);

  const move = (from: number, to: number) => setChannels((list) => moveChannel(list, from, to));
  /**
   * The row itself follows the pointer and the others slide aside (Magpie's sorter, `drag-rows.ts`);
   * the order changes once, on release. Presses on the row's own controls stay clicks.
   */
  const startDrag = (event: ReactPointerEvent<HTMLLIElement>, from: number) => {
    const list = listRef.current;
    const target = event.target as Element;
    if (!list || target.closest("button, input, a, [role=combobox]")) return;
    // On touch only the grip drags, so the rest of the row still scrolls the page.
    if (event.pointerType === "touch" && !target.closest(".rb-channel-grip")) return;
    const rows = Array.from(list.children) as HTMLElement[];
    dragRows(event.nativeEvent, event.currentTarget, event.currentTarget, list, rows, (to) => {
      slide.still.current = true;
      flushSync(() => setChannels((current) => moveChannel(current, from, to)));
    });
  };
  const add = () => {
    if (!addProvider || !chosenModel) return;
    setChannels((list) => [...list, { key: channelKey(addProvider, chosenModel), provider: addProvider, model: chosenModel, lastResort: false }]);
  };

  const facts = channels.map((channel) => memberFacts(models, channel.provider, channel.model));
  const policy = capability.capabilityPolicy;
  /** Estimates fill gaps in the combined row only, and the row says so; they never route. */
  const combined = withInferredGaps(facts);
  const context = comboContextWindow(combined.members, policy, catalogContext);
  const modalities = combineLists(combined.members.map((fact) => fact.inputModalities), policy, MODALITY_ORDER);
  const efforts = combineLists(combined.members.map((fact) => fact.reasoningEfforts), policy, COMBO_EFFORTS);

  return (
    <div className="rb-editor" role="group" aria-label={t("routeBoard.edit.aria", { model: comboModel })}>
      <ol
        className="rb-channels"
        ref={listRef}
      >
        {channels.map((channel, index) => {
          const providerName = labels?.get(channel.provider) ?? formatProviderDisplayName(channel.provider, t);
          const name = `${providerName} ${channel.model}`;
          return (
            <li
              key={channel.key}
              ref={slide.ref(channel.key)}
              className="rb-channel"
              onPointerDown={(event) => startDrag(event, index)}
            >
              <span className="rb-channel-grip" aria-hidden="true" title={t("routeBoard.edit.drag")}>⋮⋮</span>
              <span className="rb-channel-index">{index + 1}</span>
              <ProviderIcon name={channel.provider} cls="provider-icon provider-icon-sm" />
              <span className="rb-channel-name">
                <strong>{providerName}</strong>
                <code>{channel.model}</code>
              </span>
              <span className="rb-channel-quota">
                <QuotaLine quotas={[{ provider: channel.provider, quota: quotaFor(channel.provider) }]} labels={labels} />
              </span>
              <span className="rb-channel-actions">
                <button
                  type="button"
                  className={`btn btn-ghost btn-sm rb-last-resort${channel.lastResort ? (fallbackOnly ? " is-on" : " is-inert") : ""}`}
                  aria-pressed={channel.lastResort}
                  title={channel.lastResort && !fallbackOnly ? t("routeBoard.edit.lastResortInert") : t("routeBoard.edit.lastResortHint")}
                  onClick={() => setChannels((list) => list.map((c, i) => i === index ? { ...c, lastResort: !c.lastResort } : c))}
                >{t("routeBoard.lastResort")}</button>
                <button type="button" className="btn btn-ghost btn-sm" disabled={index === 0}
                  aria-label={t("routeBoard.edit.moveUp", { name })} onClick={() => move(index, index - 1)}>↑</button>
                <button type="button" className="btn btn-ghost btn-sm" disabled={index === channels.length - 1}
                  aria-label={t("routeBoard.edit.moveDown", { name })} onClick={() => move(index, index + 1)}>↓</button>
                <button type="button" className="btn btn-ghost btn-sm rb-remove"
                  aria-label={t("routeBoard.edit.remove", { name })}
                  onClick={() => setChannels((list) => list.filter((_, i) => i !== index))}>×</button>
              </span>
            </li>
          );
        })}
      </ol>
      <div className="rb-add">
        <Select
          size="sm"
          value={addProvider}
          label={t("routeBoard.edit.provider")}
          options={pickable.map((provider) => ({ value: provider.name, label: formatProviderDisplayName(provider.name, t) }))}
          onChange={(next) => { setAddProvider(next); setAddModel(""); }}
        />
        <Select
          size="sm"
          value={chosenModel}
          label={t("routeBoard.edit.model")}
          disabled={addModels.length === 0}
          options={addModels.length > 0
            ? addModels.map((model) => ({ value: model.id, label: model.id }))
            : [{ value: "", label: t("routeBoard.edit.noModels"), disabled: true }]}
          onChange={setAddModel}
        />
        <button type="button" className="btn btn-ghost btn-sm" disabled={!chosenModel} onClick={add}>
          {t("routeBoard.edit.add")}
        </button>
      </div>
      <p className="rb-editor-hint">{t(COMBO_TARGETS_HINT_KEYS[strategy])}</p>

      <div className="rb-more" ref={moreRef}>
        <button type="button" className="rb-more-toggle" aria-expanded={moreOpen} onClick={() => setMoreOpen((open) => !open)}>
          <span aria-hidden="true">{moreOpen ? "▾" : "▸"}</span> {t("routeBoard.edit.more")}
        </button>
        {moreOpen && (
          <div className="rb-more-body">
            <div className="rb-pref">
              <div className="rb-pref-text">
                <span className="rb-pref-name">{t("routeBoard.cap.title")}</span>
                <span className="rb-pref-hint">{t(policy === "union" ? "routeBoard.cap.unionHint" : "routeBoard.cap.intersectionHint")}</span>
              </div>
              <Select
                size="sm"
                className="rb-strategy"
                value={policy}
                label={t("routeBoard.cap.title")}
                align="right"
                dropdownStyle={{ width: 360 }}
                options={[
                  choice("intersection", t("routeBoard.cap.intersection"), t("routeBoard.cap.intersectionHint")),
                  choice("union", t("routeBoard.cap.union"), t("routeBoard.cap.unionHint")),
                ]}
                onChange={(next) => setCapability((current) => ({ ...current, capabilityPolicy: next as CapabilityPolicy }))}
              />
            </div>
            {policy === "union" && (
              <div className="rb-pref">
                <div className="rb-pref-text">
                  <span className="rb-pref-name">{t("routeBoard.cap.unservable")}</span>
                  <span className="rb-pref-hint">{t(capability.onUnservable === "reject" ? "routeBoard.cap.rejectHint" : "routeBoard.cap.degradeHint")}</span>
                </div>
                <Select
                  size="sm"
                  className="rb-strategy"
                  value={capability.onUnservable}
                  label={t("routeBoard.cap.unservable")}
                  align="right"
                  dropdownStyle={{ width: 360 }}
                  options={[
                    choice("degrade", t("routeBoard.cap.degrade"), t("routeBoard.cap.degradeHint")),
                    choice("reject", t("routeBoard.cap.reject"), t("routeBoard.cap.rejectHint")),
                  ]}
                  onChange={(next) => setCapability((current) => ({ ...current, onUnservable: next as UnservablePolicy }))}
                />
              </div>
            )}
            <div className="rb-pref">
              <div className="rb-pref-text">
                <span className="rb-pref-name">{t("routeBoard.more.fallbackOnly")}</span>
                <span className="rb-pref-hint">{t("routeBoard.more.fallbackOnlyHint")}</span>
              </div>
              <Switch on={fallbackOnly} label={t("routeBoard.more.fallbackOnly")} onClick={() => setFallbackOnly((on) => !on)} />
            </div>

            <MemberTable
              channels={channels}
              facts={facts}
              labels={labels}
              combo={{ context: context.tokens, basis: context.basis, modalities, efforts, includesInferred: combined.used }}
              onSaveModel={onSaveModel}
              onProbeModel={onProbeModel}
            />
          </div>
        )}
      </div>

      <div className="rb-editor-footer">
        <span className="rb-editor-spacer" />
        {dirty && <span className="rb-unsaved">{t("routeBoard.edit.unsaved")}</span>}
        <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>{t("common.cancel")}</button>
        <button type="button" className="btn btn-primary btn-sm" disabled={!dirty || saving} onClick={() => onSave(channels, settings)}>
          {t("common.save")}
        </button>
      </div>
    </div>
  );
}
