import { useState, type DragEvent } from "react";
import { COMBO_TARGETS_HINT_KEYS, type ComboStrategy } from "../../combo-workspace-data";
import { useT } from "../../i18n/shared";
import { formatProviderDisplayName } from "../../provider-icons";
import {
  capabilityPatch,
  channelKey,
  moveChannel,
  type CapabilityPolicy,
  type ChannelQuota,
  type ComboCapabilitySettings,
  type RouteChannel,
  type UnservablePolicy,
} from "../../route-board-model";
import { Select } from "../../ui";
import { ProviderIcon } from "../provider-workspace/ProviderRail";
import type { ModelOption, ProviderOption } from "../combo-workspace-types";
import { QuotaLine } from "./QuotaLine";

export type EditableChannel = Pick<RouteChannel, "key" | "provider" | "model" | "lastResort">;

/**
 * Inline channel editor under an expanded row: reorder (drag, or the move buttons from the
 * keyboard), mark last resort, remove, add. Nothing is written until Save.
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
  saving,
  onSave,
  onCancel,
  onOpenAdvanced,
}: {
  comboModel: string;
  strategy: ComboStrategy;
  channels: readonly EditableChannel[];
  quotaFor: (provider: string) => ChannelQuota;
  providers: readonly ProviderOption[];
  models: readonly ModelOption[];
  /** The combo defers last-resort channels (`cooldownWaitPolicy`); otherwise the mark is inert. */
  lastResortActive: boolean;
  /** Row-level provider labels, so two providers sharing a display name stay distinct here too. */
  labels?: ReadonlyMap<string, string>;
  capability: ComboCapabilitySettings;
  saving: boolean;
  onSave: (channels: EditableChannel[], capability: Partial<ComboCapabilitySettings>) => void;
  onCancel: () => void;
  onOpenAdvanced: () => void;
}) {
  const t = useT();
  const [channels, setChannels] = useState<EditableChannel[]>(() => [...initial]);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const pickable = providers.filter((provider) => !provider.hiddenFromPicker);
  const [addProvider, setAddProvider] = useState(() => pickable[0]?.name ?? "");
  const used = new Set(channels.map((channel) => channel.key));
  const addModels = models.filter((model) => model.provider === addProvider && !used.has(channelKey(model.provider, model.id)));
  const [addModel, setAddModel] = useState("");
  const chosenModel = addModels.some((model) => model.id === addModel) ? addModel : addModels[0]?.id ?? "";
  const [capability, setCapability] = useState<ComboCapabilitySettings>(initialCapability);
  const capabilityChanges = capabilityPatch(initialCapability, capability);
  const dirty = channels.length !== initial.length
    || channels.some((channel, index) => channel.key !== initial[index]?.key || channel.lastResort !== initial[index]?.lastResort)
    || Object.keys(capabilityChanges).length > 0;
  const choice = (value: string, name: string, hint: string) => ({
    value,
    textValue: name,
    label: <span className="rb-strategy-option"><span className="rb-strategy-name">{name}</span><span className="rb-strategy-hint">{hint}</span></span>,
  });

  const move = (from: number, to: number) => setChannels((list) => moveChannel(list, from, to));
  const onDrop = (event: DragEvent, to: number) => {
    event.preventDefault();
    if (dragIndex !== null) move(dragIndex, to);
    setDragIndex(null);
  };
  const add = () => {
    if (!addProvider || !chosenModel) return;
    setChannels((list) => [...list, { key: channelKey(addProvider, chosenModel), provider: addProvider, model: chosenModel, lastResort: false }]);
  };

  return (
    <div className="rb-editor" role="group" aria-label={t("routeBoard.edit.aria", { model: comboModel })}>
      <ol className="rb-channels">
        {channels.map((channel, index) => {
          const providerName = labels?.get(channel.provider) ?? formatProviderDisplayName(channel.provider, t);
          const name = `${providerName} ${channel.model}`;
          return (
          <li
            key={channel.key}
            className={`rb-channel${dragIndex === index ? " rb-channel--dragging" : ""}`}
            draggable
            onDragStart={() => setDragIndex(index)}
            onDragEnd={() => setDragIndex(null)}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => onDrop(event, index)}
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
                className={`btn btn-ghost btn-sm rb-last-resort${channel.lastResort ? " is-on" : ""}`}
                aria-pressed={channel.lastResort}
                title={t("routeBoard.edit.lastResortHint")}
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
      <div className="rb-capability">
        <span className="rb-capability-title">{t("routeBoard.cap.title")}</span>
        <Select
          size="sm"
          className="rb-strategy"
          value={capability.capabilityPolicy}
          label={t("routeBoard.cap.title")}
          dropdownStyle={{ width: 340 }}
          options={[
            choice("intersection", t("routeBoard.cap.intersection"), t("routeBoard.cap.intersectionHint")),
            choice("union", t("routeBoard.cap.union"), t("routeBoard.cap.unionHint")),
          ]}
          onChange={(next) => setCapability((current) => ({ ...current, capabilityPolicy: next as CapabilityPolicy }))}
        />
        {capability.capabilityPolicy === "union" && (
          <>
            <span className="rb-capability-title">{t("routeBoard.cap.unservable")}</span>
            <Select
              size="sm"
              className="rb-strategy"
              value={capability.onUnservable}
              label={t("routeBoard.cap.unservable")}
              dropdownStyle={{ width: 340 }}
              options={[
                choice("degrade", t("routeBoard.cap.degrade"), t("routeBoard.cap.degradeHint")),
                choice("reject", t("routeBoard.cap.reject"), t("routeBoard.cap.rejectHint")),
              ]}
              onChange={(next) => setCapability((current) => ({ ...current, onUnservable: next as UnservablePolicy }))}
            />
          </>
        )}
        <span className="rb-capability-hint">
          {t(capability.capabilityPolicy === "union" ? "routeBoard.cap.unionHint" : "routeBoard.cap.intersectionHint")}
        </span>
      </div>
      {!lastResortActive && channels.some((channel) => channel.lastResort) && (
        <p className="rb-editor-hint rb-editor-warn">{t("routeBoard.edit.lastResortInert")}</p>
      )}
      <div className="rb-editor-footer">
        <button type="button" className="btn btn-ghost btn-sm" onClick={onOpenAdvanced}>{t("routeBoard.edit.more")}</button>
        <span className="rb-editor-spacer" />
        {dirty && <span className="rb-unsaved">{t("routeBoard.edit.unsaved")}</span>}
        <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>{t("common.cancel")}</button>
        <button type="button" className="btn btn-primary btn-sm" disabled={!dirty || saving} onClick={() => onSave(channels, capabilityChanges)}>
          {t("common.save")}
        </button>
      </div>
    </div>
  );
}
