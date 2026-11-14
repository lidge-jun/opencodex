import { useState } from "react";
import type { ComboDraftError, ComboItem, ComboStrategy } from "../../combo-workspace-data";
import { useT } from "../../i18n/shared";
import { formatProviderDisplayName } from "../../provider-icons";
import {
  buildRouteRows,
  distinctProviderLabels,
  channelQuota,
  quotaWindowsByProvider,
  planStrategyChange,
  DEFAULT_CAPABILITY_SETTINGS,
  type AccountCount,
  type ComboCapabilitySettings,
  type ComboCatalogMeta,
  type ComboSettingsPatch,
  type RouteBoardProvider,
} from "../../route-board-model";
import type { ModelOption, ProviderOption } from "../combo-workspace-types";
import { ChannelEditor, type EditableChannel } from "./ChannelEditor";
import type { SaveMemberModel } from "./MemberTable";
import type { ProbeMemberModel } from "./MemberProbe";
import { ModelRouteRow } from "./ModelRouteRow";

type SaveResult = { ok: boolean; error?: string };

export interface RouteBoardProps {
  combos: readonly ComboItem[];
  catalog: Readonly<Record<string, ComboCatalogMeta>>;
  lastResort: Readonly<Record<string, readonly string[]>>;
  /** Combo ids that defer last-resort channels (`cooldownWaitPolicy: "before-last-resort"`). */
  lastResortActive: ReadonlySet<string>;
  providers: readonly (ProviderOption & RouteBoardProvider)[];
  models: readonly ModelOption[];
  quotaReports: unknown;
  accountCounts?: Readonly<Record<string, AccountCount>>;
  capability?: Readonly<Record<string, ComboCapabilitySettings>>;
  validate: (item: ComboItem) => ComboDraftError | null;
  errorText: (code: ComboDraftError, item: ComboItem) => string;
  onSave: (
    item: ComboItem,
    channels?: readonly EditableChannel[],
    settings?: ComboSettingsPatch,
  ) => Promise<SaveResult>;
  onSetEnabled: (id: string, enabled: boolean) => Promise<SaveResult>;
  /** Open the full workspace, optionally on one combo. */
  onOpenAdvanced: (id?: string, reason?: "jev") => void;
  /** Combo with an unsaved draft in the advanced editor: read-only here until it is saved there. */
  lockedId?: string | null;
  /** Writes one member model's per-provider settings from the editor's member table. */
  onSaveModel?: SaveMemberModel;
  onProbeModel?: ProbeMemberModel;
}

/** Combos overview: one row per combo, inline strategy and on/off, click a row to edit its channels. */
export function RouteBoard(props: RouteBoardProps) {
  const t = useT();
  const [expanded, setExpanded] = useState<string | null>(null);
  /** Row whose editor opened from its context tag, with "More settings" already open. */
  const [moreFor, setMoreFor] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [messages, setMessages] = useState<Record<string, string>>({});
  const rows = buildRouteRows({
    combos: props.combos,
    catalog: props.catalog,
    lastResort: props.lastResort,
    providers: props.providers,
    quotaReports: props.quotaReports,
    accountCounts: props.accountCounts,
    models: props.models,
    capability: props.capability,
  });
  const reported = quotaWindowsByProvider(props.quotaReports);
  const providerByName = new Map(props.providers.map((provider) => [provider.name, provider]));

  const setMessage = (id: string, text: string | null) => setMessages((current) => {
    const next = { ...current };
    if (text) next[id] = text; else delete next[id];
    return next;
  });

  const run = async (id: string, work: () => Promise<SaveResult>): Promise<boolean> => {
    setBusy(id);
    setMessage(id, null);
    try {
      const result = await work();
      if (!result.ok) setMessage(id, result.error ?? t("cws.saveFailed"));
      return result.ok;
    } finally {
      setBusy(null);
    }
  };

  const changeStrategy = (combo: ComboItem, next: ComboStrategy) => {
    const plan = planStrategyChange(combo, next, props.validate);
    if (plan.kind === "unchanged") return;
    if (plan.kind === "open-advanced") return props.onOpenAdvanced(combo.id, "jev");
    if (plan.kind === "invalid") return setMessage(combo.id, t("routeBoard.notSaved", { reason: props.errorText(plan.error, plan.item) }));
    void run(combo.id, () => props.onSave(plan.item));
  };

  const saveChannels = async (combo: ComboItem, channels: EditableChannel[], settings: ComboSettingsPatch) => {
    const targets = channels.map((channel) => {
      const existing = combo.targets.find((target) => target.provider === channel.provider && target.model === channel.model);
      return existing ?? { provider: channel.provider, model: channel.model };
    });
    const item = { ...combo, targets };
    const error = props.validate(item);
    if (error) return setMessage(combo.id, t("routeBoard.notSaved", { reason: props.errorText(error, item) }));
    if (await run(combo.id, () => props.onSave(item, channels, settings))) setExpanded(null);
  };

  if (rows.length === 0) {
    return (
      <div className="rb-empty">
        <p>{t("routeBoard.empty")}</p>
        <button type="button" className="btn btn-primary btn-sm" onClick={() => props.onOpenAdvanced()}>{t("cws.add")}</button>
      </div>
    );
  }

  return (
    <ul className="rb-list" aria-label={t("routeBoard.listAria")}>
      {rows.map((row) => (
        <ModelRouteRow
          key={row.combo.id}
          row={row}
          expanded={expanded === row.combo.id}
          lastResortActive={props.lastResortActive.has(row.combo.id)}
          onOpenContext={() => { setMoreFor(row.combo.id); setExpanded(row.combo.id); }}
          busy={busy === row.combo.id}
          locked={props.lockedId === row.combo.id}
          message={messages[row.combo.id] ?? null}
          onToggleExpanded={() => { setMoreFor(null); setExpanded((current) => current === row.combo.id ? null : row.combo.id); }}
          onStrategy={(next) => changeStrategy(row.combo, next)}
          onEnabled={(next) => void run(row.combo.id, () => props.onSetEnabled(row.combo.id, next))}
        >
          <ChannelEditor
            key={`${row.combo.id}:${moreFor === row.combo.id ? "more" : "plain"}`}
            moreOpen={moreFor === row.combo.id}
            catalogContext={props.catalog[row.combo.id]?.contextWindow}
            comboModel={row.publicId}
            strategy={row.combo.strategy}
            channels={row.channels}
            quotaFor={(provider) => channelQuota(
              providerByName.get(provider),
              reported.get(provider),
              row.channels.filter((channel) => channel.provider === provider).map((channel) => channel.model),
            )}
            providers={props.providers}
            models={props.models}
            lastResortActive={props.lastResortActive.has(row.combo.id)}
            labels={distinctProviderLabels(row.channels.map((channel) => channel.provider), (provider) => formatProviderDisplayName(provider, t))}
            capability={props.capability?.[row.combo.id] ?? DEFAULT_CAPABILITY_SETTINGS}
            saving={busy === row.combo.id || props.lockedId === row.combo.id}
            onSave={(channels, settings) => void saveChannels(row.combo, channels, settings)}
            onSaveModel={props.onSaveModel}
            onProbeModel={props.onProbeModel}
            onCancel={() => setExpanded(null)}
          />
        </ModelRouteRow>
      ))}
    </ul>
  );
}
